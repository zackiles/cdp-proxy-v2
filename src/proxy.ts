/**
 * @module proxy
 * @description The proxy core orchestrator (§2/§5). A single process fronts many
 * upstreams: it serves the CDP HTTP/WS surface, resolves each client connection's
 * upstream + plugin set from its session token, and hands the socket to a
 * {@link ProxyConnection}. Usable standalone (`main.ts`) or embedded in-process
 * by the client SDK.
 */

import { Config } from './config.ts'
import { BrowserPool } from './browser-pool.ts'
import { SessionManager } from './session-manager.ts'
import { HttpHandler } from './http-handler.ts'
import { WebSocketHandler } from './websocket-handler.ts'
import { createRouterHandler } from './router.ts'
import { ProxyConnection } from './proxy-connection.ts'
import { ShutdownManager } from './shutdown-manager.ts'
import { Logger } from './logger.ts'
import { asError } from './utils.ts'
import { basename, resolve, toFileUrl } from '@std/path'
import { SESSION_TOKEN_HEADER } from './types.ts'
import type {
  ConfiguredPlugin,
  ConnectionId,
  IsolationMode,
  PluginFactory,
  SessionToken,
} from './types.ts'

export interface ProxyOptions {
  /** Install OS-signal handlers that exit the process. False for in-process/SDK use. */
  handleSignals?: boolean
  /** Managed browser pool size (ignored when a remote endpoint is configured). */
  poolSize?: number
}

export class Proxy {
  readonly #pool: BrowserPool
  readonly #sessions: SessionManager
  readonly #shutdown: ShutdownManager
  readonly #registry = new Map<string, PluginFactory<Record<string, unknown>>>()
  readonly #connections = new Map<ConnectionId, ProxyConnection>()
  /** Per browser: which connection owns each browser context it hosts. */
  readonly #contextOwners = new Map<string, Map<string, ConnectionId>>()
  #server: Deno.HttpServer | undefined
  #started = false

  constructor(options: ProxyOptions = {}) {
    this.#pool = new BrowserPool({
      remoteEndpoint: Config.get('browserWsEndpoint') || undefined,
      size: options.poolSize,
      browserHost: Config.get('browserHost'),
      browserPort: Config.get('browserPort'),
      browserExecutablePath: Config.get('browserExecutablePath'),
    })
    this.#sessions = new SessionManager({
      defaultIsolation: Config.get('isolation'),
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

  /** Make a server-side plugin available for by-name registration (control API). */
  registerPluginFactory(factory: PluginFactory<Record<string, unknown>>): void {
    this.#registry.set(factory.pluginName, factory)
  }

  /**
   * Load every plugin in a directory so remote clients can ask for them by name
   * over the control endpoint (§7.4). `*.disabled.*` files are skipped, which is
   * how you park a plugin without deleting it.
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
      if (!entry.isFile || !/\.[tj]s$/.test(entry.name)) continue
      if (entry.name.includes('.disabled.')) continue
      try {
        const url = toFileUrl(resolve(directory, entry.name)).href
        const mod = await import(url)
        const factory = (mod.default ?? mod[basename(entry.name, '.ts')]) as
          | PluginFactory<Record<string, unknown>>
          | undefined
        if (typeof factory !== 'function' || !factory.pluginName) {
          log.warn(`${entry.name} exports no plugin factory`)
          continue
        }
        this.registerPluginFactory(factory)
        loaded.push(factory.pluginName)
      } catch (cause) {
        log.error(`failed to load ${entry.name}`, { error: asError(cause) })
      }
    }
    return loaded
  }

  /** Register a plugin set in-process and get a session token to connect with. */
  async register(
    plugins: ConfiguredPlugin[],
    isolation?: IsolationMode,
    debug?: string,
  ): Promise<SessionToken> {
    const token = this.#sessions.register(plugins, isolation, debug)
    if (this.#sessions.resolve(token)?.isolation === 'browser') {
      await this.#pool.reserve(token)
    }
    return token
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
        plugins.push(factory(entry.options))
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
      plugins: record?.plugins ?? [],
      debug: record?.debug,
      contextOwners,
      onClose: (id) => {
        const c = this.#connections.get(id)
        if (c) {
          this.#shutdown.removeClosable(c)
          this.#connections.delete(id)
        }
        if (token) {
          this.#sessions.release(token)
          this.#pool.releaseToken(token)
        }
      },
    })
    this.#connections.set(connectionId, conn)
    this.#shutdown.addClosable(conn)
  }
}

function displayHost(host: string): string {
  if (host === '0.0.0.0' || host === '::' || host === '::1') return 'localhost'
  return host
}
