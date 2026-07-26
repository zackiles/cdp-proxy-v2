/**
 * @module browser-pool
 * @description Browser sourcing (§5): resolves the upstream CDP endpoint the
 * proxy fronts. Supports a **remote/preconfigured** endpoint and one or more
 * **managed** local browsers, exposed uniformly as `{ host, port }`. A single
 * proxy fronts many upstreams (proxy-as-router); flatten stays intact because
 * each client connection opens exactly one upstream socket.
 */

import { getAvailablePort } from '@std/net'
import { BrowserManager } from './browser-manager.ts'
import { Logger } from './logger.ts'
import { asError } from './utils.ts'
import { satisfies } from './profile.ts'
import type { BrowserInfo, Constraint, Draw, LaunchSpec } from './types.ts'

const log = Logger.get('pool')

export interface Upstream {
  host: string
  port: number
  /** What the binary reported at `/json/version`, for reconciliation (§2.6). */
  product?: string
  userAgent?: string
}

/** One process's identity and the launch contribution it starts from (§2.7). */
export interface Plan {
  profile: Draw
  spec: LaunchSpec
  /** Which profile fields the `launch` plugins read, for coverage (§2.8). */
  reads?: Record<string, string[]>
}

export interface BrowserPoolOptions {
  /** A preconfigured remote CDP endpoint (`ws://host:port/...` or `host:port`). */
  remoteEndpoint?: string
  /** How many managed browsers to launch when no remote endpoint is given. */
  size?: number
  /**
   * How many identities the fleet draws (§2.7). Defaults to `size` — one per
   * slot — because the failure of drawing too few is silent: a fleet with more
   * identities than it needed costs nothing, and a fleet with fewer has been
   * linking sessions since the day it was configured. A smaller number is a
   * deliberate choice to run a narrower anonymity set.
   */
  profiles?: number
  /** Draw one fleet identity and resolve what it launches with. */
  plan?: (seed: string) => Promise<Plan>
  browserHost: string
  browserPort: number
  browserExecutablePath: string
}

interface Slot {
  upstream: Upstream
  manager?: BrowserManager
  /** The identity this process was launched with; shared by every session on it. */
  plan?: Plan
}

export class BrowserPool {
  readonly #options: BrowserPoolOptions
  #slots: Slot[] = []
  #cursor = 0

  constructor(options: BrowserPoolOptions) {
    this.#options = options
  }

  async start(): Promise<void> {
    if (this.#options.remoteEndpoint) {
      this.#slots = [{ upstream: parseEndpoint(this.#options.remoteEndpoint) }]
      // The health check reads `/json/version` anyway, so a remote browser's
      // identity facts arrive on the same request as its reachability.
      Object.assign(
        this.#slots[0].upstream,
        await this.#checkHealth(this.#slots[0].upstream),
      )
      return
    }

    const size = Math.max(1, this.#options.size ?? 1)
    // More identities than processes would draw rows nothing ever runs.
    const identities = Math.min(
      size,
      Math.max(1, this.#options.profiles ?? size),
    )
    const plans: Plan[] = []
    for (let i = 0; this.#options.plan && i < identities; i++) {
      plans.push(await this.#options.plan(`fleet-${i}`))
    }

    for (let i = 0; i < size; i++) {
      const port = i === 0
        ? this.#options.browserPort
        : this.#options.browserPort + i
      // Round-robin rather than "first N slots get one each": with fewer
      // identities than slots, this spreads each persona over the same number of
      // processes instead of leaving some persona with all the load.
      const plan = plans[i % plans.length] as Plan | undefined
      const manager = new BrowserManager(
        this.#options.browserHost,
        port,
        this.#options.browserExecutablePath,
        plan?.spec,
      )
      await manager.start()
      this.#slots.push({
        upstream: {
          host: this.#options.browserHost,
          port,
          ...manager.version,
        },
        manager,
        plan,
      })
      if (plan) {
        log.info(`slot ${i} on port ${port} is ${plan.profile.id}`)
      }
    }
  }

  readonly #sticky = new Map<string, Upstream>()
  readonly #reserved = new Map<string, BrowserManager>()
  readonly #stopping = new Map<
    string,
    (browser: BrowserInfo) => Promise<void>
  >()

  /**
   * Give a session a browser process of its own (`isolation: 'browser'`), so two
   * sites share no profile, cache, or process-level fingerprint and cannot be
   * correlated. Launched here rather than at connect time because a client's
   * first CDP messages would be dropped while we waited for the browser.
   */
  async reserve(
    token: string,
    spec?: LaunchSpec,
    onStop?: (browser: BrowserInfo) => Promise<void>,
  ): Promise<Upstream> {
    const existing = this.#sticky.get(token)
    if (existing) return existing
    if (this.#options.remoteEndpoint) {
      log.warn(
        'browser isolation ignored: a remote endpoint cannot be launched',
      )
      return this.primary()
    }

    const port = await getAvailablePort()
    const manager = new BrowserManager(
      this.#options.browserHost,
      port,
      this.#options.browserExecutablePath,
      spec,
    )
    await manager.start()
    const upstream = {
      host: this.#options.browserHost,
      port,
      ...manager.version,
    }
    this.#reserved.set(token, manager)
    if (onStop) this.#stopping.set(token, onStop)
    this.#sticky.set(token, upstream)
    return upstream
  }

  /** What the process a session reserved turned out to be (§3.2). */
  info(token: string): BrowserInfo | undefined {
    return this.#reserved.get(token)?.info
  }

  /**
   * Put a session on a slot whose identity answers its constraint, and tell the
   * caller which identity that is (§2.7).
   *
   * `undefined` is not a failure: it means no process the fleet is running can
   * honestly claim what this session asked for, which is what promotes it to a
   * browser of its own (§3.3). Deciding here rather than at connect time is what
   * lets that promotion launch a process before the client's first message.
   */
  place(
    token: string,
    constraint: Constraint,
  ): { upstream: Upstream; plan?: Plan } | undefined {
    if (this.#slots.length === 0) throw new Error('BrowserPool not started')
    const existing = this.#sticky.get(token)
    if (existing) {
      const slot = this.#slots.find((s) => s.upstream === existing)
      return { upstream: existing, plan: slot?.plan }
    }
    for (let i = 0; i < this.#slots.length; i++) {
      const slot = this.#slots[(this.#cursor + i) % this.#slots.length]
      // A slot with no plan is one nothing was drawn for — a remote endpoint, or
      // a pool started without one — and it constrains nothing.
      if (slot.plan && !satisfies(slot.plan.profile, constraint)) continue
      this.#cursor += i + 1
      this.#sticky.set(token, slot.upstream)
      return { upstream: slot.upstream, plan: slot.plan }
    }
    return undefined
  }

  /** Round-robin the next upstream (pool policy hook lives here). */
  next(): Upstream {
    if (this.#slots.length === 0) throw new Error('BrowserPool not started')
    const slot = this.#slots[this.#cursor % this.#slots.length]
    this.#cursor++
    return slot.upstream
  }

  /**
   * Resolve the upstream for a session token, pinning it so a session's
   * `/json/version` discovery and its subsequent WS connect hit the SAME
   * browser (the flatten guid in the path must match). Tokenless callers get
   * the primary upstream.
   */
  upstreamFor(token?: string | null): Upstream {
    if (!token) return this.primary()
    const existing = this.#sticky.get(token)
    if (existing) return existing
    const chosen = this.next()
    this.#sticky.set(token, chosen)
    return chosen
  }

  releaseToken(token?: string | null): void {
    if (!token) return
    this.#sticky.delete(token)
    const reserved = this.#reserved.get(token)
    if (!reserved) return
    this.#reserved.delete(token)
    const stopped = this.#stopping.get(token)
    this.#stopping.delete(token)
    // Called from a socket-close callback, which cannot await. `onStop` runs
    // before the kill, while the process it describes still exists.
    Promise.resolve(stopped?.(reserved.info))
      .catch((e) => log.warn('onStop failed', { error: asError(e) }))
      .then(() => reserved.close())
      .catch((e) =>
        log.warn('reserved browser failed to close', { error: asError(e) })
      )
  }

  /** The upstream used for tokenless HTTP `/json/*` discovery forwarding. */
  primary(): Upstream {
    if (this.#slots.length === 0) throw new Error('BrowserPool not started')
    return this.#slots[0].upstream
  }

  async #checkHealth(
    upstream: Upstream,
  ): Promise<{ product?: string; userAgent?: string }> {
    const endpoint = `http://${upstream.host}:${upstream.port}/json/version`
    const res = await fetch(endpoint).catch(() => undefined)
    if (!res?.ok) {
      throw new Error(`Upstream browser not reachable at ${endpoint}`)
    }
    const info = await res.json().catch(() => ({}))
    return { product: info.Browser, userAgent: info['User-Agent'] }
  }

  async close(): Promise<void> {
    const closing = [
      ...this.#slots.map((s) => s.manager?.close()),
      ...[...this.#reserved.values()].map((m) => m.close()),
    ].filter(Boolean) as Promise<void>[]
    await Promise.allSettled(closing)
    this.#slots = []
    this.#reserved.clear()
    this.#sticky.clear()
  }
}

function parseEndpoint(endpoint: string): Upstream {
  const withScheme = endpoint.includes('://') ? endpoint : `ws://${endpoint}`
  const url = new URL(withScheme)
  return {
    host: url.hostname,
    port: Number(url.port) || (url.protocol === 'wss:' ? 443 : 80),
  }
}
