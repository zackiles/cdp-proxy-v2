/**
 * @module proxy
 * @description The proxy core orchestrator (§2/§5). A single process fronts many
 * upstreams: it serves the CDP HTTP/WS surface, resolves each client connection's
 * upstream + plugin set from its session token, and hands the socket to a
 * {@link ProxyConnection}. Usable standalone (`main.ts`) or embedded in-process
 * by the client SDK.
 */

import { Config } from './config.ts'
import { BrowserPool, type Plan } from './browser-pool.ts'
import { SessionManager } from './session-manager.ts'
import { HttpHandler } from './http-handler.ts'
import { WebSocketHandler } from './websocket-handler.ts'
import { createRouterHandler } from './router.ts'
import { ProxyConnection } from './proxy-connection.ts'
import { ShutdownManager } from './shutdown-manager.ts'
import { Logger } from './logger.ts'
import { asError } from './utils.ts'
import { basename, join, resolve, toFileUrl } from '@std/path'
import { SESSION_TOKEN_HEADER } from './types.ts'
import { flatten, partition } from './plugin.ts'
import { core } from './core/mod.ts'
import { draw, seal } from './profile.ts'
import { Ledger } from './coverage.ts'
import { Debug } from './debug.ts'
import {
  pair,
  PLATFORM,
  resolve as resolveLaunch,
  type Resolved,
} from './launch.ts'
import type {
  ConfiguredPlugin,
  ConnectionId,
  Constraint,
  IsolationMode,
  PluginFactory,
  PluginList,
  PluginSet,
  PresetFactory,
  SessionToken,
} from './types.ts'

export interface ProxyOptions {
  /** Install OS-signal handlers that exit the process. False for in-process/SDK use. */
  handleSignals?: boolean
  /** Managed browser pool size (ignored when a remote endpoint is configured). */
  poolSize?: number
  /**
   * How many identities the fleet draws (§2.7). Defaults to `poolSize`, one per
   * slot: `profiles` sets how many identities the fleet has, and
   * `isolation: 'browser'` is how a session guarantees one to itself.
   */
  profiles?: number
}

export class Proxy {
  readonly #pool: BrowserPool
  readonly #sessions: SessionManager
  readonly #shutdown: ShutdownManager
  /**
   * Name → what that name expands to. A preset sits here beside a plugin because
   * `stealth` is one now (§8.5) and a remote client naming it over the control
   * endpoint should not have to know which it got.
   */
  readonly #registry = new Map<
    string,
    (options?: Record<string, unknown>) => ConfiguredPlugin[]
  >()
  readonly #connections = new Map<ConnectionId, ProxyConnection>()
  /** Per browser: which connection owns each browser context it hosts. */
  readonly #contextOwners = new Map<string, Map<string, ConnectionId>>()
  #server: Deno.HttpServer | undefined
  #started = false

  constructor(options: ProxyOptions = {}) {
    this.#pool = new BrowserPool({
      remoteEndpoint: Config.get('browserWsEndpoint') || undefined,
      size: options.poolSize,
      profiles: options.profiles ?? (Config.get('profiles') || undefined),
      // The fleet's identities are drawn from core alone: a shared process
      // cannot run on one session's authored loader, since the next session on
      // it never asked for that machine (§2.7).
      plan: (seed) => this.#plan(partition(core()), {}, seed),
      browserHost: Config.get('browserHost'),
      browserPort: Config.get('browserPort'),
      browserExecutablePath: Config.get('browserExecutablePath'),
    })
    this.#sessions = new SessionManager({
      defaultIsolation: Config.get('isolation'),
      onRelease: (token) => this.#pool.releaseToken(token),
    })
    this.#shutdown = new ShutdownManager({
      handleSignals: options.handleSignals ?? true,
    })
    this.#shutdown.onCleanup(() => this.#pool.close())
  }

  /** Base HTTP endpoint an SDK connects to, e.g. `http://localhost:9994`. */
  get endpoint(): string {
    return `http://${displayHost(Config.get('proxyHost'))}:${
      Config.get('proxyPort')
    }`
  }

  get sessions(): SessionManager {
    return this.#sessions
  }

  /** Make a server-side plugin or preset available by name (control API). */
  registerPluginFactory(
    factory:
      | PluginFactory<Record<string, unknown>>
      | PresetFactory<Record<string, unknown>>,
  ): void {
    const name = 'pluginName' in factory
      ? factory.pluginName
      : factory.presetName
    this.#registry.set(name, (options) => {
      const made = factory(options)
      return Array.isArray(made) ? made : [made]
    })
  }

  /**
   * Load every plugin under a directory so remote clients can ask for them by
   * name over the control endpoint (§7.4). Recurses to any depth, because a path
   * is inert (§10.1): `surface/graphics/webgl.ts` and `surface/webgl.ts` produce
   * the identical plugin, so the tree is an organizational convenience rather
   * than part of a plugin's identity. `*.disabled.*` files and dotfiles are
   * skipped, which is how you park a plugin without deleting it.
   */
  async loadPlugins(directory: string): Promise<string[]> {
    const log = Logger.get('proxy')
    const loaded: string[] = []
    let entries: Deno.DirEntry[]
    try {
      entries = await Array.fromAsync(Deno.readDir(directory))
    } catch (cause) {
      log.warn(`no plugins loaded from ${directory}`, { error: asError(cause) })
      return loaded
    }

    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue
      if (entry.isDirectory) {
        loaded.push(...await this.loadPlugins(join(directory, entry.name)))
        continue
      }
      if (!entry.isFile || !/\.[tj]s$/.test(entry.name)) continue
      if (entry.name.includes('.disabled.')) continue
      try {
        const url = toFileUrl(resolve(directory, entry.name)).href
        const mod = await import(url)
        const factory = (mod.default ?? mod[basename(entry.name, '.ts')]) as
          | PluginFactory<Record<string, unknown>>
          | PresetFactory<Record<string, unknown>>
          | undefined
        const name = typeof factory === 'function'
          ? ('pluginName' in factory ? factory.pluginName : factory.presetName)
          : undefined
        if (!factory || !name) {
          log.warn(`${entry.name} exports no plugin factory`)
          continue
        }
        this.registerPluginFactory(factory)
        loaded.push(name)
      } catch (cause) {
        log.error(`failed to load ${entry.name}`, { error: asError(cause) })
      }
    }
    return loaded
  }

  /**
   * Register a plugin set in-process and get a session token to connect with.
   *
   * `plugins` is the automator's list: presets are flattened, the core tier is
   * added unless the caller asked for `'none'`, and the result is grouped by kind
   * so each partition can be resolved in phase order.
   */
  async register(
    plugins: PluginList,
    isolation?: IsolationMode,
    debug?: string,
    constraint: Constraint = {},
  ): Promise<SessionToken> {
    const log = Logger.get('proxy')
    const set = resolvePlugins(plugins)
    // `CDP_PROFILE` is an id, and an id is a constraint like any other (§2.4):
    // routing it through the constraint rather than past it means the env var and
    // `profile: { id }` cannot disagree about which one wins.
    const pinned = Config.get('profile')
    const asked = pinned && !constraint.id
      ? { ...constraint, id: pinned }
      : constraint
    const token = this.#sessions.register(set, isolation, debug, {
      constraint: asked,
    })
    const record = this.#sessions.resolve(token)!
    const session = token.slice(0, 8)

    // Core's `flags` is pinned and always present, so "has a launch plugin"
    // means an authored one: only those carry a policy some other session on the
    // same process would not have asked for (§3.3).
    const authored = set.launch.filter((p) => !p.pinned)
    // A pooled slot can answer for a session that claims nothing of its own.
    const placed = authored.length === 0 && record.isolation !== 'browser'
      ? this.#pool.place(token, asked)
      : undefined

    if (placed) {
      // Sessions on one process share its identity, including its canvas hash
      // (§2.7). `isolation: 'browser'` is how a session says it must not be.
      if (set.profile.length > 0) {
        record.profile = placed.plan?.profile
        record.launch = placed.plan?.spec
        record.reads = placed.plan?.reads
      }
      return token
    }

    const why = authored.length > 0
      ? `launch plugin ${authored.map((p) => p.name).join(', ')}`
      : record.isolation === 'browser'
      ? 'isolation: browser'
      : 'no pool slot satisfies its profile constraint'
    if (record.isolation !== 'browser') {
      log.info(`session ${session} promoted to its own browser: ${why}`)
      record.isolation = 'browser'
    }

    // `plugins: 'none'` claims nothing, so there is nothing to plan: the process
    // starts from the baseline and the session gets no identity at all.
    if (set.profile.length === 0 && set.launch.length === 0) {
      await this.#pool.reserve(token)
      return token
    }

    const plan = await this.#plan(set, asked, token, debug)
    record.profile = plan.profile
    record.launch = plan.spec
    record.reads = plan.reads
    await this.#pool.reserve(token, plan.spec, plan.stopped)
    const info = this.#pool.info(token)
    if (info) {
      // The second half of reconciliation (§2.6): the first is what the binary
      // turned out to be, this is what the process turned out to have done with
      // the flags. Both land before the profile seals, so no other kind ever
      // sees a value the running browser has already contradicted.
      for (const { by, fields } of await plan.started(info)) {
        for (const [field, value] of Object.entries(fields)) {
          record.corrections.push(
            `${field}: ${by} found the process using ${JSON.stringify(value)}`,
          )
        }
        record.profile = { ...record.profile!, ...fields }
      }
    }
    return token
  }

  /**
   * Draw the identity a process will run as and resolve what it launches with
   * (§2.6). Launch plugins read the *candidate*: the process does not exist yet,
   * so there is nothing to reconcile against, and the flags are half of what
   * produces the thing they would be reconciled against.
   */
  async #plan(
    set: PluginSet,
    constraint: Constraint,
    seed: string,
    debug?: string,
  ): Promise<
    Plan & {
      reads: Record<string, string[]>
      started: Resolved['started']
      stopped: Resolved['stopped']
    }
  > {
    const profile = await draw(set.profile, constraint, constraint.id ?? seed)
    const candidate = seal(profile)
    const ledger = new Ledger()
    const resolved = await resolveLaunch(
      set.launch,
      (plugin) => ({
        profile: ledger.view(candidate, plugin),
        platform: PLATFORM,
        signal: this.#shutdown.signal,
        log: (...args: unknown[]) =>
          Logger.get(`plugin:${plugin}`).debug(args.map(String).join(' ')),
      }),
      debug === undefined ? undefined : Debug.using(debug, seed),
    )
    if (resolved.spec.userDataDir) {
      // A persona is a profile plus its storage (§2.7). The constraint is what
      // makes the pairing reproducible across runs; the marker in the directory
      // is what makes it enforceable.
      if (!constraint.id) {
        throw new Error(
          `a launch plugin pinned userDataDir "${resolved.spec.userDataDir}" ` +
            'without pinning a profile id: the storage would come back under a ' +
            'newly drawn machine. Pass `profile: { id }` alongside it',
        )
      }
      await pair(resolved.spec.userDataDir, profile.id)
    }
    return {
      profile,
      spec: resolved.spec,
      started: resolved.started,
      stopped: resolved.stopped,
      // Carried to the connection so a `--lang` the profile decided shows up as
      // coverage of `locale` rather than as a field nothing read (§2.8).
      reads: ledger.reads(),
    }
  }

  async start(): Promise<void> {
    if (this.#started) return
    await this.#pool.start()

    const pluginsDirectory = Config.get('pluginsDirectory')
    if (pluginsDirectory) {
      const loaded = await this.loadPlugins(pluginsDirectory)
      Logger.get('proxy').info(
        `plugins available by name: ${loaded.join(', ') || 'none'}`,
      )
    }

    const httpHandler = new HttpHandler((req) =>
      this.#pool.upstreamFor(req.headers.get(SESSION_TOKEN_HEADER))
    )
    const wsHandler = new WebSocketHandler((req, socket) =>
      this.#onSocket(req, socket)
    )
    const router = createRouterHandler(httpHandler, wsHandler)

    const port = Config.get('proxyPort')
    const hostname = Config.get('proxyHost')

    this.#server = Deno.serve({
      port,
      hostname,
      signal: this.#shutdown.signal,
      handler: (req) => {
        const url = new URL(req.url)
        if (url.pathname.startsWith('/proxy/')) {
          return this.#handleControl(req, url)
        }
        return router(req)
      },
      onListen: () => Logger.get('proxy').info(`listening at ${this.endpoint}`),
    })
    this.#started = true
  }

  async stop(): Promise<void> {
    await this.#shutdown.shutdownNow()
    await this.#server?.finished.catch(() => {})
    this.#started = false
  }

  // ─── control endpoint (§4, decision 3) ──────────────────────────────────────
  async #handleControl(req: Request, url: URL): Promise<Response> {
    if (req.method === 'POST' && url.pathname === '/proxy/register') {
      let body: {
        plugins?: { name: string; options?: Record<string, unknown> }[]
        isolation?: IsolationMode
      }
      try {
        body = await req.json()
      } catch {
        return Response.json({ error: 'invalid JSON body' }, { status: 400 })
      }
      const plugins: ConfiguredPlugin[] = []
      for (const entry of body.plugins ?? []) {
        const factory = this.#registry.get(entry.name)
        if (!factory) {
          return Response.json(
            { error: `unknown plugin: ${entry.name}` },
            { status: 400 },
          )
        }
        plugins.push(...factory(entry.options))
      }
      return Response.json({
        token: await this.register(plugins, body.isolation),
      })
    }
    return new Response('Not found', { status: 404 })
  }

  // ─── WS upgrade → ProxyConnection ────────────────────────────────────────────
  #onSocket(req: Request, socket: WebSocket): void {
    const token = req.headers.get(SESSION_TOKEN_HEADER)
    const record = this.#sessions.resolve(token)
    const connectionId = crypto.randomUUID()
    const sessionToken = token ?? connectionId

    if (token) {
      // A socket can only be closed once it has opened, which in Deno happens
      // after the upgrade response is returned.
      const reject = (code: number, reason: string) =>
        socket.addEventListener('open', () => socket.close(code, reason))
      if (!record) {
        reject(1008, 'unknown or expired session token')
        return
      }
      if (!this.#sessions.acquire(token)) {
        reject(1013, 'proxy at capacity')
        return
      }
    }

    const path = new URL(req.url).pathname
    const upstream = this.#pool.upstreamFor(token)
    const browser = `${upstream.host}:${upstream.port}`

    // Context ownership is only meaningful among the clients of one browser, so
    // each browser gets its own map.
    let contextOwners = this.#contextOwners.get(browser)
    if (!contextOwners) {
      contextOwners = new Map()
      this.#contextOwners.set(browser, contextOwners)
    }

    const conn = new ProxyConnection(socket, {
      sessionToken,
      connectionId,
      upstreamWsUrl: `ws://${browser}${path}`,
      plugins: record?.plugins.protocol ?? [],
      surfaces: record?.plugins.surface ?? [],
      loaders: record?.plugins.profile ?? [],
      actors: record?.plugins.actor ?? [],
      profile: record?.profile,
      launch: record?.launch,
      reads: record?.reads,
      corrections: record?.corrections,
      facts: { product: upstream.product, userAgent: upstream.userAgent },
      debug: record?.debug,
      contextOwners,
      onClose: (id) => {
        const c = this.#connections.get(id)
        if (c) {
          this.#shutdown.removeClosable(c)
          this.#connections.delete(id)
        }
        // Releasing the session releases what the pool held for it, whether the
        // last connection just closed or the token expired unused.
        if (token) this.#sessions.release(token)
      },
    })
    this.#connections.set(connectionId, conn)
    this.#shutdown.addClosable(conn)
  }
}

/**
 * Flatten presets, add the core tier, and group by kind (§8.6).
 *
 * `plugins: []` means **core only** — no surfaces, no actors, no authored
 * loaders — because core is defined by presence rather than by opt-in, so
 * `plugins` never controlled it: it controls the *authored* set, and an empty
 * authored set is exactly what `[]` says. `plugins: 'none'` is the pass-through
 * that drops core too, for comparing against unmodified Playwright and for
 * observing the unmodified wire.
 */
export function resolvePlugins(plugins: PluginList): PluginSet {
  if (plugins === 'none') return partition([])
  const authored: ConfiguredPlugin[] = flatten(plugins)
  return partition([...core(), ...authored])
}

function displayHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === '::1') return 'localhost'
  return host
}
