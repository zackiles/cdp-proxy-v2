/**
 * @module proxy-connection
 * @description Per-connection CDP transport (§6). Owns one client socket paired
 * with one upstream browser socket in flatten mode, remaps message ids between
 * the client and proxy id-spaces, maintains the target registry, drives the
 * plugin {@link Pipeline}, answers proxy-originated `ctx.send` calls without
 * leaking them to the client, and reaps the session when either socket dies.
 */

import type {
  CDPError,
  CDPEvent,
  CDPRequest,
  CDPResponse,
  CDPTarget,
  ConfiguredPlugin,
  ConnectionId,
  Draw,
  InjectOptions,
  LaunchSpec,
  PluginContext,
  Profile,
  Send,
  SessionId,
  SessionToken,
} from './types.ts'
import { PROXY_METHOD_PREFIX } from './types.ts'
import { Pipeline } from './plugin.ts'
import { Logger } from './logger.ts'
import { Debug } from './debug.ts'
import { Ledger } from './coverage.ts'
import { burn, draw, type Facts, reconcile, seal } from './profile.ts'
import { compile, type Compiled } from './surface.ts'
import { deliver } from './realms.ts'
import { Broker } from './broker.ts'
import { Actors } from './actor.ts'
import { generate } from './core/generate.ts'
import { asError } from './utils.ts'

const CTX_SEND_TIMEOUT_MS = 30_000
const log = Logger.get('connection')

/** What a connection needs to serve one client: its upstream and plugin set. */
export interface SessionSpec {
  sessionToken: SessionToken
  connectionId: ConnectionId
  upstreamWsUrl: string
  plugins: ConfiguredPlugin[]
  /**
   * The candidate identity from the loader chain. Reconciled against this
   * browser and sealed before any plugin is installed, so no plugin can read a
   * field the process is about to contradict (§2.6).
   */
  profile?: Draw
  /** The session's `surface` plugins, compiled once the profile is sealed (§4). */
  surfaces?: ConfiguredPlugin[]
  /** The `profile` chain, kept so `Proxy.burn` can withdraw the row (§2.7). */
  loaders?: ConfiguredPlugin[]
  /** The session's `actor` plugins, instantiated per page (§6). */
  actors?: ConfiguredPlugin[]
  /** How this session's own process was started, for the trace (§3.1). */
  launch?: LaunchSpec
  /** What the `launch` plugins read of the profile, resolved before this connection. */
  reads?: Record<string, string[]>
  /** What `onStart` already corrected about the candidate, for the trace (§3.2). */
  corrections?: string[]
  /** What the browser this connection landed on reported at `/json/version`. */
  facts?: Facts
  /**
   * Trace filter for this session alone. Absent falls back to `CDP_DEBUG`, which
   * is what a standalone proxy uses; tracing one session must not retune every
   * other session sharing the process.
   */
  debug?: string
  /** Invoked exactly once when the connection is torn down (for reaping). */
  onClose?: (connectionId: ConnectionId) => void
  /**
   * `browserContextId` → the connection that created it, shared by every
   * connection on the same browser.
   *
   * Chrome's browser-level auto-attach is browser-wide: it reports *every* page
   * target, including ones opened by other clients of the same browser. Without
   * this map a plugin would happily configure another session's pages — a stealth
   * session was observed rewriting the User-Agent of a concurrent `plugins: []`
   * session, which is meant to be an untouched browser.
   */
  contextOwners?: Map<string, ConnectionId>
}

/** What a response needs to carry back into ownership tracking. */
interface Claimable {
  method: string
  /** Set only for commands that name an existing context, e.g. disposal. */
  context?: string
}

interface PluginRequest extends Claimable {
  timer: number
  settle: (msg: CDPResponse) => void
  /** Kept for tracing and for naming who was left waiting at teardown. */
  plugin: string
  startedAt: number
}

/**
 * The methods the runtime answers itself, declared the same way a plugin's are
 * so `Proxy.hello` lists one set rather than two (§7.3).
 */
const RUNTIME_RPC = [
  'Proxy.hello',
  'Proxy.debug',
  'Proxy.profile',
  'Proxy.burn',
] as const

export class ProxyConnection {
  readonly connectionId: ConnectionId
  readonly sessionToken: SessionToken

  readonly #clientSocket: WebSocket
  readonly #browserSocket: WebSocket
  readonly #spec: SessionSpec

  #nextId = 1
  // proxyId → the client's own id plus what the response needs: the method names
  // it in traces and, with the context, drives ownership tracking.
  readonly #clientRequests = new Map<
    number,
    Claimable & { clientId: number }
  >()
  readonly #pluginRequests = new Map<number, PluginRequest>() // proxyId → waiter
  readonly #targets = new Map<SessionId, CDPTarget>()
  readonly #contextOwners: Map<string, ConnectionId>
  /** CDP sessions belonging to another connection's targets; never forwarded. */
  readonly #foreignSessions = new Set<SessionId>()
  /**
   * Proxy-originated ids whose replies belong to nobody and must not be sent on.
   * The value reads the reply on its way to the bin, for the commands whose
   * failure would otherwise be invisible.
   */
  readonly #swallow = new Map<number, (msg: CDPResponse) => void>()
  /** `ctx.state`, keyed by target first so a detach drops every plugin's at once. */
  readonly #state = new Map<SessionId, Map<string, unknown>>()

  readonly #abort = new AbortController()
  readonly #debug: Debug
  readonly #broker: Broker
  readonly #coverage = new Ledger()
  #profile: Profile | undefined
  #surfaces: Compiled | undefined
  #actors: Actors | undefined
  #pipeline: Pipeline | undefined
  readonly #browserChains = new Map<string, Promise<void>>()
  readonly #clientChains = new Map<string, Promise<void>>()
  #reaped = false

  #resolveBrowserOpen!: () => void
  #rejectBrowserOpen!: (e: unknown) => void
  readonly #browserOpen = new Promise<void>((res, rej) => {
    this.#resolveBrowserOpen = res
    this.#rejectBrowserOpen = rej
  })
  readonly #initDone: Promise<void>

  constructor(clientSocket: WebSocket, spec: SessionSpec) {
    this.connectionId = spec.connectionId
    this.sessionToken = spec.sessionToken
    this.#spec = spec
    this.#contextOwners = spec.contextOwners ?? new Map()
    this.#debug = spec.debug === undefined
      ? Debug.for(spec.sessionToken)
      : Debug.using(spec.debug, spec.sessionToken)
    this.#clientSocket = clientSocket
    this.#browserSocket = new WebSocket(spec.upstreamWsUrl)
    this.#broker = new Broker({
      send: this.#sender('broker'),
      emit: (evt) => this.#sendToClient(JSON.stringify(evt)),
      respond: (id, sessionId, result) =>
        this.#respondToClient(id, sessionId, result as Record<string, unknown>),
    }, this.#debug)

    this.#wireClient()
    this.#wireBrowser()
    this.#initDone = this.#init()
  }

  /**
   * One plugin's view of the sealed identity, recording what it reads (§2.8).
   *
   * Installation happens after sealing, so the profile is always there by the
   * time a plugin exists. The guard is for the one way that can stop being true:
   * a caller building a pipeline without a profile at all, which would otherwise
   * fail somewhere inside a `Proxy` handler rather than here.
   */
  #view(plugin: string): Profile {
    if (!this.#profile) {
      throw new Error(
        `${plugin}: no profile was resolved for this session, so there is no ` +
          'identity to read; a session with plugins must have a profile',
      )
    }
    return this.#coverage.view(this.#profile, plugin)
  }

  /**
   * A `send` attributed to one name, with the reply resolved to the caller and
   * never leaked to the client.
   *
   * Separate from {@link #ctx} because the broker and the runtime's own traffic
   * need to talk to the browser without being plugins: a full `PluginContext`
   * reads the profile to build its recording view, which would attribute the
   * runtime's reads to a plugin and fail outright on a session that has no
   * identity to read (`plugins: 'none'`).
   */
  #sender(plugin: string): Send {
    const send = <M extends string>(
      method: M,
      params?: unknown,
      sessionId?: SessionId,
    ): Promise<unknown> =>
      this.#browserOpen.then(
        () =>
          new Promise<unknown>((resolve, reject) => {
            const proxyId = this.#nextId++
            const timer = setTimeout(() => {
              if (this.#pluginRequests.delete(proxyId)) {
                // Name the plugin and the session: a bare method name is not
                // enough to find the culprit when several plugins are in play.
                reject(
                  new Error(
                    `${plugin}: ctx.send('${method}'${
                      sessionId ? `, session ${sessionId}` : ''
                    }) got no response in ${CTX_SEND_TIMEOUT_MS}ms`,
                  ),
                )
              }
            }, CTX_SEND_TIMEOUT_MS)
            this.#pluginRequests.set(proxyId, {
              timer,
              plugin,
              method,
              context: (params as { browserContextId?: string } | undefined)
                ?.browserContextId,
              startedAt: performance.now(),
              settle: (msg) => {
                clearTimeout(timer)
                if (msg.error) {
                  reject(new Error(`${plugin}: ${msg.error.message}`))
                } else resolve(msg.result ?? {})
              },
            })
            const payload: CDPRequest = {
              id: proxyId,
              method,
              params: (params ?? {}) as Record<string, unknown>,
            }
            if (sessionId) payload.sessionId = sessionId
            this.#debug.trace(
              plugin,
              method,
              `⇢ ${plugin} send ${method} #${proxyId}`,
            )
            this.#browserSocket.send(JSON.stringify(payload))
          }),
      )
    return send as Send
  }

  /** Build the context for one plugin, with everything attributed to it by name. */
  #ctx(plugin: string): PluginContext {
    const send = this.#sender(plugin) as <M extends string>(
      method: M,
      params?: unknown,
      sessionId?: SessionId,
    ) => Promise<unknown>

    const emit = (method: string, params: unknown, sessionId?: SessionId) => {
      const evt: CDPEvent = {
        method,
        params: params as Record<string, unknown>,
      }
      if (sessionId) evt.sessionId = sessionId
      this.#debug.trace(plugin, method, `⇠ ${plugin} emit ${method}`)
      this.#sendToClient(JSON.stringify(evt))
    }

    const inject = async (
      source: string,
      sessionId: SessionId,
      options: InjectOptions = {},
    ): Promise<() => Promise<void>> => {
      // DANGER: without the Page domain enabled on *this* session the script is
      // accepted and then silently never runs — no error, and the world it names
      // is never created. Domain state is per-session, so a plugin cannot rely on
      // the client having enabled it.
      await send('Page.enable', undefined, sessionId)
      const { identifier } = await send(
        'Page.addScriptToEvaluateOnNewDocument',
        {
          source,
          worldName: options.world,
          runImmediately: options.immediately ?? false,
        },
        sessionId,
      ) as { identifier: string }
      return () =>
        send(
          'Page.removeScriptToEvaluateOnNewDocument',
          { identifier },
          sessionId,
        ).then(() => {}, () => {})
    }

    const state = <T>(sessionId: SessionId, init: () => T): T => {
      let byPlugin = this.#state.get(sessionId)
      if (!byPlugin) this.#state.set(sessionId, byPlugin = new Map())
      if (!byPlugin.has(plugin)) byPlugin.set(plugin, init())
      return byPlugin.get(plugin) as T
    }

    const pluginLog = Logger.get(`plugin:${plugin}`)
    const session = this.sessionToken.slice(0, 8)

    return {
      sessionToken: this.sessionToken,
      connectionId: this.connectionId,
      targets: this.#targets,
      signal: this.#abort.signal,
      profile: this.#view(plugin),
      // deno-lint-ignore no-explicit-any
      send: send as any,
      // deno-lint-ignore no-explicit-any
      emit: emit as any,
      inject,
      state,
      log: (...args: unknown[]) => {
        const error = args.find((a) => a instanceof Error) as Error | undefined
        const message = args
          .filter((a) => a !== error)
          .map((a) => typeof a === 'string' ? a : Deno.inspect(a))
          .join(' ')
        pluginLog.debug(
          `[${session}] ${message}`,
          error ? { error } : undefined,
        )
      },
    }
  }

  async #init(): Promise<void> {
    try {
      await this.#browserOpen
    } catch {
      this.#reap('upstream connect failed')
      return
    }
    try {
      if (this.#spec.launch) this.#debug.launched(this.#spec.launch)
      if (this.#spec.reads) this.#coverage.adopt(this.#spec.reads)
      await this.#sealProfile()
      await this.#compileSurfaces()
      if (this.#spec.launch?.auth) this.#broker.auth(this.#spec.launch.auth)
      this.#installActors()
      this.#pipeline = await Pipeline.install(
        this.#spec.plugins,
        (plugin) => this.#ctx(plugin),
        this.#debug,
      )
    } catch (err) {
      this.#reap(asError(err).message)
      return
    }
    await this.#pipeline.onSessionStart()
    if (this.#profile) this.#debug.profile(this.#profile, this.#coverage)
  }

  /**
   * Correct the drawn identity against the browser that actually started, then
   * freeze it (§2.6).
   *
   * The version is the case that matters: a page can feature-detect, so a profile
   * claiming Chrome 148 on a 147 binary is caught by one missing API. No loader
   * can know which binary the pool handed out, so the profile learns it here —
   * before any plugin is installed, because a plugin that read the claim first
   * would go on asserting a version the binary does not have.
   *
   * The facts come from the pool's `/json/version` discovery rather than from a
   * `Browser.getVersion` of our own, which would put an extra round trip in front
   * of every connection to learn something already known.
   */
  async #sealProfile(): Promise<void> {
    // A session with plugins always has an identity: they read `ctx.profile`
    // unconditionally, and the terminal loader exists so the answer is never
    // "none". A caller that supplied no candidate gets the same answer the chain
    // would have ended at. `plugins: 'none'` claims nothing and so has none.
    const installed = this.#spec.plugins.length +
      (this.#spec.surfaces?.length ?? 0) + (this.#spec.actors?.length ?? 0)
    const candidate = this.#spec.profile ??
      (installed > 0
        ? await draw([generate()], {}, this.sessionToken)
        : undefined)
    if (!candidate) return

    const { draw: corrected, corrections } = reconcile(
      candidate,
      this.#spec.facts ?? {},
    )
    this.#profile = seal(corrected)
    for (const correction of this.#spec.corrections ?? []) {
      this.#debug.reconciled(correction)
    }
    for (const correction of corrections) this.#debug.reconciled(correction)
  }

  /**
   * Resolve the session's surfaces into one payload, after sealing so every
   * surface reads a profile the browser has already agreed with.
   */
  async #compileSurfaces(): Promise<void> {
    const surfaces = this.#spec.surfaces ?? []
    if (surfaces.length === 0 || !this.#profile) return
    this.#surfaces = await compile(
      surfaces,
      (name) => ({
        profile: this.#view(name),
        signal: this.#abort.signal,
        log: (...args) =>
          Logger.get(`plugin:${name}`).debug(args.map(String).join(' ')),
      }),
      this.#profile,
      this.#debug,
    )
    this.#debug.surfaces(this.#surfaces.names)
    // Headers leave the surface layer here and become the broker's, so a client
    // that sets its own on the same session merges with them rather than
    // replacing them (§7.2).
    this.#broker.headers('surfaces', this.#surfaces.headers)
    // So does the display: the client's own viewport call is whole-state, and the
    // broker is what folds the monitor back into it (§7.2).
    this.#broker.display('surfaces', this.#surfaces.display)
    // Every realm a surface still claims beyond the document tree needs the
    // target paused at start, which is a browser-wide setting the client also
    // uses (§7.1).
    if (this.#surfaces.realms.some((r) => r !== 'page' && r !== 'iframe')) {
      this.#broker.pause()
    }
  }

  /**
   * Stand up the session's actors (§6).
   *
   * Nothing is instantiated here: an actor's lifetime is one page, so the
   * instances arrive with the pages. What this builds is the scheduler they run
   * on, which is deliberately not the transport's — the whole point of the kind
   * is that an actor awaiting a solver for ten seconds does not stop the page's
   * CDP traffic (§6.1).
   */
  #installActors(): void {
    const actors = this.#spec.actors ?? []
    const profile = this.#profile
    if (actors.length === 0 || !profile) return
    this.#actors = new Actors(actors, (target) => ({
      // Named per page rather than per plugin, because the handle is what sends
      // and a trace that said `actor` would not say which page it acted on.
      send: this.#sender(`actor@${target.sessionId.slice(0, 6)}`),
      profile: this.#coverage.view(profile, 'actors'),
      signal: this.#abort.signal,
    }), this.#debug)
  }

  /** Install the compiled surfaces on a target as it attaches (§4.5). */
  async #deliverSurfaces(target: CDPTarget): Promise<void> {
    if (!this.#surfaces) return
    const wire = this.#ctx('surfaces')
    await deliver(this.#surfaces, target, {
      inject: (source, sessionId) =>
        wire.inject(source, sessionId, { immediately: true }),
      send: wire.send,
      evaluate: (source, sessionId) => {
        const id = this.#nextId++
        // The reply cannot be awaited (see `Wire.evaluate`), and dropping it
        // unread is what made a worker the one realm where a broken bundle
        // installed nothing and said nothing. Read on the way past instead.
        this.#swallow.set(id, (msg) => {
          const thrown = (msg.result as {
            exceptionDetails?: { exception?: { description?: string } }
          })?.exceptionDetails
          const failed = msg.error?.message ??
            thrown?.exception?.description?.split('\n')[0]
          if (!failed) return
          wire.log(`${target.type} bundle failed: ${failed}`)
          // Recorded as well as logged, because this is the one delivery whose
          // failure nothing else can report: `Proxy.debug` is where a test or an
          // author finds out that a realm went unpatched.
          this.#debug.conflict(
            `the surface bundle failed in a ${target.type}: ${failed}`,
          )
        })
        this.#debug.trace(
          'surfaces',
          'Runtime.evaluate',
          `⇢ surfaces bundle → ${target.type} @${sessionId.slice(0, 6)}`,
        )
        this.#sendToBrowser(JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression: source, silent: true },
          sessionId,
        }))
      },
      log: (text) => wire.log(text),
    })
  }

  /**
   * Queue work so that order holds *within* a CDP session rather than across the
   * whole connection. Two pages are independent, so a plugin that awaits while
   * handling one should not stall every other page. Browser-level messages, which
   * have no session, share the root chain.
   *
   * DANGER: a session's chain is seeded from the root chain as it is created, not
   * from a fresh promise. Everything a session depends on having happened first —
   * the `Target.attachedToTarget` that registers it in `#targets`, the
   * `onTargetAttached` hooks that let plugins set up for it, and the ownership check
   * that decides whether it is even ours — is handled on the root chain. Seed from
   * `Promise.resolve()` and a page's first event can overtake its own attach, at
   * which point a plugin reading `ctx.targets` finds nothing there.
   */
  #order(
    chains: Map<string, Promise<void>>,
    sessionId: SessionId | undefined,
    run: () => Promise<void>,
  ): void {
    const key = sessionId ?? ''
    const previous = chains.get(key) ?? chains.get('') ?? Promise.resolve()
    chains.set(
      key,
      previous.then(run).catch((err) =>
        log.error('message failed', { error: asError(err) })
      ),
    )
  }

  /** Forget a target's queue once it is gone, so a long connection stays flat. */
  #retire(sessionId: SessionId): void {
    this.#browserChains.delete(sessionId)
    this.#clientChains.delete(sessionId)
  }

  // ─── client socket ────────────────────────────────────────────────────────
  #wireClient(): void {
    this.#clientSocket.onmessage = (e) => {
      const raw = typeof e.data === 'string' ? e.data : String(e.data)
      let msg: CDPRequest | undefined
      try {
        msg = JSON.parse(raw) as CDPRequest
      } catch { /* not ours to rewrite; passed through in order below */ }

      this.#order(
        this.#clientChains,
        msg?.sessionId,
        msg && typeof msg.id === 'number'
          ? () => this.#forwardClientMessage(msg)
          : async () => {
            await this.#initDone
            if (!this.#reaped) this.#sendToBrowser(raw)
          },
      )
    }
    this.#clientSocket.onclose = () => this.#reap('client socket closed', true)
    this.#clientSocket.onerror = () => {
      /* close will follow */
    }
  }

  async #forwardClientMessage(msg: CDPRequest): Promise<void> {
    await this.#initDone
    if (this.#reaped) return

    const at = this.#session(msg.sessionId)
    this.#debug.trace('proxy', msg.method, `→ ${msg.method} #${msg.id}${at}`)

    const outcome = await this.#pipeline!.onRequest(msg)
    if (outcome === null) {
      this.#debug.trace(
        'proxy',
        msg.method,
        `· ${msg.method} #${msg.id} dropped`,
      )
      return
    }
    if (outcome && typeof outcome === 'object' && 'respond' in outcome) {
      this.#debug.trace(
        'proxy',
        msg.method,
        `↩ ${msg.method} #${msg.id} answered without the browser`,
      )
      this.#respondToClient(msg.id, msg.sessionId, outcome.respond)
      return
    }
    const req = outcome && typeof outcome === 'object' ? outcome : msg

    if (req.method.startsWith(PROXY_METHOD_PREFIX)) {
      this.#answerProxyMethod(req)
      return
    }

    // After the pipeline, so a `protocol` plugin can still rewrite a brokered
    // command before it is merged, and before the wire, so the merge is what
    // actually goes out (§7.2).
    if (await this.#broker.request(req)) return

    const clientId = req.id
    const proxyId = this.#nextId++
    this.#clientRequests.set(proxyId, {
      clientId,
      method: req.method,
      context: req.params?.browserContextId as string | undefined,
    })
    req.id = proxyId
    this.#debug.forwarded(req.method)
    this.#debug.trace(
      'proxy',
      req.method,
      `⇒ ${req.method} #${clientId} forwarded as #${proxyId}`,
    )
    this.#sendToBrowser(JSON.stringify(req))
  }

  // ─── browser socket ─────────────────────────────────────────────────────────
  #wireBrowser(): void {
    this.#browserSocket.onopen = () => this.#resolveBrowserOpen()
    this.#browserSocket.onerror = () =>
      this.#rejectBrowserOpen(new Error('browser socket error'))
    this.#browserSocket.onclose = () => this.#reap('upstream socket closed')
    this.#browserSocket.onmessage = (e) => {
      const raw = typeof e.data === 'string' ? e.data : String(e.data)
      let msg: CDPResponse & CDPEvent
      try {
        msg = JSON.parse(raw)
      } catch {
        this.#sendToClient(raw)
        return
      }
      // Proxy-originated responses are resolved immediately and never forwarded
      // (and must not wait on pipeline install — that could deadlock startup).
      if (typeof msg.id === 'number' && this.#pluginRequests.has(msg.id)) {
        const entry = this.#pluginRequests.get(msg.id)!
        this.#pluginRequests.delete(msg.id)
        this.#debug.trace(
          entry.plugin,
          entry.method,
          `⇠ ${entry.plugin} ${entry.method} #${msg.id} ${
            msg.error ? `failed: ${msg.error.message}` : 'ok'
          } ${(performance.now() - entry.startedAt).toFixed(1)}ms`,
        )
        this.#claim(entry, msg)
        entry.settle(msg)
        return
      }
      if (typeof msg.id === 'number' && this.#swallow.has(msg.id)) {
        const read = this.#swallow.get(msg.id)!
        this.#swallow.delete(msg.id)
        read(msg)
        return
      }
      this.#order(
        this.#browserChains,
        msg.sessionId,
        () => this.#forwardBrowserMessage(msg, raw),
      )
    }
  }

  async #forwardBrowserMessage(
    msg: CDPResponse & CDPEvent,
    raw: string,
  ): Promise<void> {
    if (this.#reaped) return
    if (!this.#pipeline) await this.#initDone
    const pipeline = this.#pipeline!

    if (typeof msg.id === 'number') {
      const pending = this.#clientRequests.get(msg.id)
      if (pending === undefined) {
        this.#sendToClient(raw)
        return
      }
      this.#clientRequests.delete(msg.id)
      this.#claim(pending, msg)
      this.#debug.trace(
        'proxy',
        pending.method,
        `← ${pending.method} #${msg.id} → #${pending.clientId} ${
          msg.error ? 'error' : 'ok'
        }`,
      )
      msg.id = pending.clientId
      msg.method = pending.method
      const out = await pipeline.onResponse(msg)
      if (out === null) return
      // `method` is the proxy's own addition, not part of the reply format.
      delete out.method
      this.#sendToClient(JSON.stringify(out))
      return
    }

    // event
    if (this.#isForeign(msg)) return
    this.#debug.trace(
      'proxy',
      msg.method,
      `← ${msg.method}${this.#session(msg.sessionId)}`,
    )
    // Before the pipeline: an auth challenge the client never asked for, or a
    // request paused only so the broker could see it, is the broker's own
    // traffic and no plugin should have to learn to ignore it (§7.2).
    if (await this.#broker.event(msg)) return
    await this.#derive(msg, pipeline)
    const out = await pipeline.onEvent(msg)
    // After the pipeline has decided, and observe-only: `cdp()` hands an actor a
    // copy of what already happened, so it cannot suppress or rewrite anything
    // (§6.4). A suppressed event is still delivered, because the actor asked to
    // watch the session rather than to watch the client.
    this.#actors?.event(msg)
    if (out === null) return
    this.#sendToClient(JSON.stringify(out))
  }

  /**
   * Record or release a context this connection owns, from either response path.
   *
   * A plugin acts for its own session, so a context it opens belongs to this
   * connection exactly as a client-opened one does. Both paths must claim, or
   * #isForeign reads `owner === undefined` and hands every target in that context
   * to every other client of the browser.
   */
  #claim(request: Claimable, msg: CDPResponse): void {
    if (msg.error) return
    if (request.method === 'Target.createBrowserContext') {
      const created = (msg.result as { browserContextId?: string } | undefined)
        ?.browserContextId
      if (created) this.#contextOwners.set(created, this.connectionId)
      return
    }
    // Releasing on disposal keeps the shared map proportional to live contexts
    // rather than to every context this connection has ever opened.
    if (request.method === 'Target.disposeBrowserContext' && request.context) {
      this.#contextOwners.delete(request.context)
    }
  }

  /**
   * Is this event about a target another connection owns?
   *
   * Chrome auto-attaches browser-wide, so a shared browser reports every client's
   * targets to every client. Anything owned elsewhere is dropped here, before the
   * pipeline and before the client: a plugin that configured a neighbour's page
   * would be corrupting a session it knows nothing about.
   *
   * A target in a context nobody claimed — the browser's default context, which
   * every client sees on connect — stays visible. Sessions that must not share
   * even that need `isolation: 'browser'`.
   *
   * IMPORTANT: do not invert this into "foreign unless known" by snapshotting the
   * browser's contexts on connect. Chrome keeps several implicit contexts that
   * `Target.getBrowserContexts` never lists even while their targets carry a
   * `browserContextId`, and a fresh one appears the first time a client opens a
   * page in the default context — after any snapshot was taken. Only explicitly
   * created contexts are enumerable, which is exactly what #claim tracks; a
   * snapshot of either call would strand `browser.contexts()[0]`.
   */
  #isForeign(evt: CDPEvent): boolean {
    const params = (evt.params ?? {}) as Record<string, unknown>

    if (evt.method === 'Target.attachedToTarget') {
      const info = params.targetInfo as
        | { browserContextId?: string }
        | undefined
      const session = params.sessionId as SessionId | undefined
      const owner = info?.browserContextId
        ? this.#contextOwners.get(info.browserContextId)
        : undefined
      if (!session || !owner || owner === this.connectionId) return false
      this.#foreignSessions.add(session)

      // DANGER: hiding a target is not enough, it has to be given up. Clients
      // auto-attach with `waitForDebuggerOnStart`, so Chrome holds every new
      // target paused until each attached session releases it — including this
      // one, which is about to pretend the target does not exist. Staying silent
      // strands it: its real owner sees `newPage()` succeed and then every
      // navigation time out.
      //
      // Detaching rather than resuming is deliberate. Resuming would work, but it
      // means one session deciding when another session's page starts running,
      // and the owner wanted that pause to inject before any page script does.
      const detach = this.#nextId++
      this.#swallow.set(detach, () => {})
      this.#sendToBrowser(JSON.stringify({
        id: detach,
        method: 'Target.detachFromTarget',
        params: { sessionId: session },
      }))

      this.#debug.trace(
        'proxy',
        evt.method,
        `· ${evt.method}${this.#session(session)} dropped: owned by ${
          owner.slice(0, 8)
        }`,
      )
      return true
    }

    // Detach arrives on the parent session, so the target it refers to is in the
    // params rather than on the envelope.
    if (evt.method === 'Target.detachedFromTarget') {
      const session = params.sessionId as SessionId | undefined
      if (!session) return false
      this.#retire(session)
      return this.#foreignSessions.delete(session)
    }

    return !!evt.sessionId && this.#foreignSessions.has(evt.sessionId)
  }

  /**
   * Maintain the target registry and turn raw traffic into the higher-level
   * lifecycle hooks plugins actually want (§7.2), so they never have to
   * reverse-engineer `Target.*`/`Page.*` sequencing themselves.
   */
  async #derive(evt: CDPEvent, pipeline: Pipeline): Promise<void> {
    const params = (evt.params ?? {}) as Record<string, unknown>
    if (evt.method === 'Page.frameNavigated' && evt.sessionId) {
      const frame = params.frame as
        | { id: string; loaderId: string; url: string; parentId?: string }
        | undefined
      if (frame) {
        if (!frame.parentId) {
          // The last moment the client can still be said not to want a viewport,
          // which is what decides whether the broker claims the display itself
          // (§7.2).
          await this.#broker.document(evt.sessionId)
        }
        await pipeline.onDocument({
          sessionId: evt.sessionId,
          frameId: frame.id,
          loaderId: frame.loaderId,
          url: frame.url,
          isMain: !frame.parentId,
        })
        // Not awaited: an actor's whole reason to be a kind is that it runs off
        // this queue, so handing it the document must not block the event (§6.1).
        this.#actors?.document(evt.sessionId, frame.url, !frame.parentId)
      }
    } else if (evt.method === 'Target.attachedToTarget') {
      const info = params.targetInfo as Record<string, string> | undefined
      const sessionId = params.sessionId as string | undefined
      if (info && sessionId) {
        const target: CDPTarget = {
          sessionId,
          targetId: info.targetId,
          type: info.type,
          browserContextId: info.browserContextId,
        }
        this.#targets.set(sessionId, target)
        this.#actors?.attached(target)
        await pipeline.onTargetAttached(target)
        // A worker that is not waiting for the debugger was already running when
        // this session arrived — a service worker from a persisted registration,
        // typically — so the bundle reaches its globals only in time for the next
        // handler, not for the code that already ran. Nothing can fix that from
        // here; it is said out loud instead of being silently half true.
        if (
          params.waitingForDebugger === false &&
          (info.type === 'service_worker' || info.type === 'shared_worker')
        ) {
          this.#debug.conflict(
            `the ${info.type} at ${info.url ?? info.targetId} was already ` +
              'running: its own code ran before the surface bundle did',
          )
        }
        await this.#deliverSurfaces(target)
        await this.#broker.attach(target)
        // Last, and only for a target the client did not ask to pause: the
        // bundle is already in by here, so releasing it is safe, and a target
        // the client paused is the client's to release (§7.1).
        await this.#broker.resume(sessionId, evt.sessionId)
      }
    } else if (evt.method === 'Target.detachedFromTarget') {
      const sessionId = params.sessionId as string | undefined
      if (sessionId) {
        this.#broker.detach(sessionId)
        this.#actors?.detached(sessionId)
        const target = this.#targets.get(sessionId)
        if (target) {
          this.#targets.delete(sessionId)
          await pipeline.onTargetDetached(target)
          // After the hook, so a plugin winding down can still read what it kept.
          this.#state.delete(sessionId)
        }
      }
    }
  }

  // ─── declared RPC (§7.3) ────────────────────────────────────────────────────
  #answerProxyMethod(req: CDPRequest): void {
    if (req.method === 'Proxy.hello') {
      this.#respondToClient(req.id, req.sessionId, {
        connectionId: this.connectionId,
        sessionToken: this.sessionToken,
        // What is installed, not what was asked for: reporting the request would
        // name a plugin that failed to set up and is doing nothing.
        plugins: this.#pipeline?.names ?? [],
        // Which browser this session landed on — the answer to "is my pooled or
        // per-site isolation actually doing anything?".
        upstream: new URL(this.#spec.upstreamWsUrl).host,
        // The point of declaring rather than string-matching: a custom method
        // is discoverable instead of being folklore in a plugin's README (§7.3).
        rpc: [...RUNTIME_RPC, ...this.#pipeline?.rpc ?? []],
      })
      return
    }
    if (req.method === 'Proxy.debug') {
      this.#respondToClient(req.id, req.sessionId, this.#debug.snapshot())
      return
    }
    if (req.method === 'Proxy.profile') {
      // The raw row, not a recording view: answering this must not make the
      // runtime look like a plugin that read every field.
      const profile = this.#profile
      this.#respondToClient(req.id, req.sessionId, {
        profile: profile ? { ...profile, noise: undefined } : null,
        coverage: profile ? this.#coverage.report(profile) : null,
      })
      return
    }
    if (req.method === 'Proxy.burn') {
      // Retiring an identity is the automator's call, not the runtime's: only
      // the code driving the page knows a block when it sees one (§2.7).
      const profile = this.#profile
      const reason = (req.params as { reason?: string })?.reason ??
        'unspecified'
      if (!profile) {
        this.#respondToClient(req.id, req.sessionId, { burnt: false, told: [] })
        return
      }
      burn(
        this.#spec.loaders ?? [],
        profile.id,
        reason,
        profile.seed,
        this.#abort.signal,
      ).then((told) =>
        this.#respondToClient(req.id, req.sessionId, { burnt: true, told })
      )
      return
    }
    // Declared last, so the runtime's four cannot be taken over by a plugin.
    this.#pipeline?.answer(req.method, req.params ?? {}).then((answer) =>
      this.#respondToClient(
        req.id,
        req.sessionId,
        answer ?? {
          error: {
            code: -32601,
            message: `Unknown proxy method: ${req.method}. This session ` +
              `answers ${
                [...RUNTIME_RPC, ...this.#pipeline?.rpc ?? []].join(', ')
              }`,
          },
        },
      )
    )
  }

  // ─── helpers ────────────────────────────────────────────────────────────────
  #respondToClient(
    id: number,
    sessionId: SessionId | undefined,
    body: Record<string, unknown> | { error: CDPError },
  ): void {
    const resp: CDPResponse = { id }
    if (sessionId) resp.sessionId = sessionId
    if ('error' in body && body.error) resp.error = body.error as CDPError
    else resp.result = body as Record<string, unknown>
    this.#sendToClient(JSON.stringify(resp))
  }

  /** A short target tag for traces; CDP session ids are far too long to read. */
  #session(sessionId: SessionId | undefined): string {
    return sessionId ? ` @${sessionId.slice(0, 6)}` : ''
  }

  #sendToClient(data: string): void {
    if (this.#clientSocket.readyState === WebSocket.OPEN) {
      this.#clientSocket.send(data)
    }
  }

  #sendToBrowser(data: string): void {
    if (this.#browserSocket.readyState === WebSocket.OPEN) {
      this.#browserSocket.send(data)
    }
  }

  /** `asked` is whether somebody asked for this, rather than something failing. */
  async #reap(reason: string, asked = false): Promise<void> {
    if (this.#reaped) return
    this.#reaped = true
    log.debug(`${this.connectionId.slice(0, 8)} reaped: ${reason}`)

    // Abort before settling so a plugin awaiting a send can tell that its
    // rejection is teardown rather than a genuine failure.
    this.#abort.abort(new Error(reason))

    // A command still in flight when something *failed* is usually the reason it
    // failed, so name them before they are settled. On a disconnect somebody
    // asked for it is just the shape of a disconnect, and the summary keeps it to
    // the trace.
    const outstanding = [...this.#pluginRequests.values()].map((e) => ({
      plugin: e.plugin,
      method: e.method,
    }))

    for (const [, entry] of this.#pluginRequests) {
      clearTimeout(entry.timer)
      entry.settle({ id: -1, error: { code: -32000, message: reason } })
    }
    this.#pluginRequests.clear()
    this.#browserChains.clear()
    this.#clientChains.clear()

    // Chrome discards this connection's contexts with its socket, so holding the
    // claims would only make their ids look owned to whoever connects next.
    for (const [context, owner] of this.#contextOwners) {
      if (owner === this.connectionId) this.#contextOwners.delete(context)
    }

    if (this.#pipeline) {
      await this.#pipeline.onSessionEnd().catch((e) =>
        log.error('onSessionEnd failed', { error: asError(e) })
      )
    }
    this.#state.clear()
    // After onSessionEnd so its own cost is accounted for.
    this.#debug.summary(outstanding, asked)
    try {
      if (this.#clientSocket.readyState === WebSocket.OPEN) {
        this.#clientSocket.close(1000, reason.slice(0, 120))
      }
    } catch { /* ignore */ }
    try {
      if (this.#browserSocket.readyState === WebSocket.OPEN) {
        this.#browserSocket.close(1000, reason.slice(0, 120))
      }
    } catch { /* ignore */ }

    this.#spec.onClose?.(this.connectionId)
  }

  /** Closable — invoked by the shutdown manager. */
  close(): Promise<void> {
    return this.#reap('shutdown', true)
  }
}
