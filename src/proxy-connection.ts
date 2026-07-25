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
  InjectOptions,
  PluginContext,
  SessionId,
  SessionToken,
} from './types.ts'
import { PROXY_METHOD_PREFIX } from './types.ts'
import { Pipeline } from './plugin.ts'
import { Logger } from './logger.ts'
import { Debug } from './debug.ts'
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
  /** Proxy-originated ids whose replies belong to nobody and must not be sent on. */
  readonly #swallow = new Set<number>()
  /** `ctx.state`, keyed by target first so a detach drops every plugin's at once. */
  readonly #state = new Map<SessionId, Map<string, unknown>>()

  readonly #abort = new AbortController()
  readonly #debug: Debug
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

    this.#wireClient()
    this.#wireBrowser()
    this.#initDone = this.#init()
  }

  /** Build the context for one plugin, with everything attributed to it by name. */
  #ctx(plugin: string): PluginContext {
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
    this.#clientSocket.onclose = () => this.#reap('client socket closed')
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

    const clientId = req.id
    const proxyId = this.#nextId++
    this.#clientRequests.set(proxyId, {
      clientId,
      method: req.method,
      context: req.params?.browserContextId as string | undefined,
    })
    req.id = proxyId
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
      if (typeof msg.id === 'number' && this.#swallow.delete(msg.id)) return
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
    await this.#derive(msg, pipeline)
    const out = await pipeline.onEvent(msg)
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
      this.#swallow.add(detach)
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
        await pipeline.onDocument({
          sessionId: evt.sessionId,
          frameId: frame.id,
          loaderId: frame.loaderId,
          url: frame.url,
          isMain: !frame.parentId,
        })
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
        await pipeline.onTargetAttached(target)
      }
    } else if (evt.method === 'Target.detachedFromTarget') {
      const sessionId = params.sessionId as string | undefined
      if (sessionId) {
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

  // ─── custom RPC (§6.5) ──────────────────────────────────────────────────────
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
      })
      return
    }
    if (req.method === 'Proxy.debug') {
      this.#respondToClient(req.id, req.sessionId, this.#debug.snapshot())
      return
    }
    this.#respondToClient(req.id, req.sessionId, {
      error: { code: -32601, message: `Unknown proxy method: ${req.method}` },
    })
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

  async #reap(reason: string): Promise<void> {
    if (this.#reaped) return
    this.#reaped = true
    log.debug(`${this.connectionId.slice(0, 8)} reaped: ${reason}`)

    // Abort before settling so a plugin awaiting a send can tell that its
    // rejection is teardown rather than a genuine failure.
    this.#abort.abort(new Error(reason))

    // A command still in flight at teardown usually means a plugin is awaiting
    // something that will never arrive, so name them before they are settled.
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
    this.#debug.summary(outstanding)
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
    return this.#reap('shutdown')
  }
}
