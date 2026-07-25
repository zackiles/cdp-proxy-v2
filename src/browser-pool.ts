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

const log = Logger.get('pool')

export interface Upstream {
  host: string
  port: number
}

export interface BrowserPoolOptions {
  /** A preconfigured remote CDP endpoint (`ws://host:port/...` or `host:port`). */
  remoteEndpoint?: string
  /** How many managed browsers to launch when no remote endpoint is given. */
  size?: number
  browserHost: string
  browserPort: number
  browserExecutablePath: string
}

interface Slot {
  upstream: Upstream
  manager?: BrowserManager
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
      await this.#checkHealth(this.#slots[0].upstream)
      return
    }

    const size = Math.max(1, this.#options.size ?? 1)
    for (let i = 0; i < size; i++) {
      const port = i === 0
        ? this.#options.browserPort
        : this.#options.browserPort + i
      const manager = new BrowserManager(
        this.#options.browserHost,
        port,
        this.#options.browserExecutablePath,
      )
      await manager.start()
      this.#slots.push({
        upstream: { host: this.#options.browserHost, port },
        manager,
      })
    }
  }

  readonly #sticky = new Map<string, Upstream>()
  readonly #reserved = new Map<string, BrowserManager>()

  /**
   * Give a session a browser process of its own (`isolation: 'browser'`), so two
   * sites share no profile, cache, or process-level fingerprint and cannot be
   * correlated. Launched here rather than at connect time because a client's
   * first CDP messages would be dropped while we waited for the browser.
   */
  async reserve(token: string): Promise<Upstream> {
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
    )
    await manager.start()
    const upstream = { host: this.#options.browserHost, port }
    this.#reserved.set(token, manager)
    this.#sticky.set(token, upstream)
    return upstream
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
    // Called from a socket-close callback, which cannot await.
    reserved.close().catch((e) =>
      log.warn('reserved browser failed to close', { error: asError(e) })
    )
  }

  /** The upstream used for tokenless HTTP `/json/*` discovery forwarding. */
  primary(): Upstream {
    if (this.#slots.length === 0) throw new Error('BrowserPool not started')
    return this.#slots[0].upstream
  }

  async #checkHealth(upstream: Upstream): Promise<void> {
    const endpoint = `http://${upstream.host}:${upstream.port}/json/version`
    const res = await fetch(endpoint).catch(() => undefined)
    if (!res?.ok) {
      throw new Error(`Upstream browser not reachable at ${endpoint}`)
    }
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
