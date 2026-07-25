/**
 * @module types
 * @description Shared types for the CDP proxy: identifiers, CDP message shapes,
 * the plugin platform, and the typed CDP surface backed by `devtools-protocol`.
 */

import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.d.ts'

/** A CDP target id (page, iframe, worker, …). */
export type TargetId = string
/** A CDP flatten session id, present on messages routed to a child target. */
export type SessionId = string
/** A proxy connection id — one client socket paired with one upstream socket. */
export type ConnectionId = string
/** An opaque, short-lived token identifying a registered proxy session. */
export type SessionToken = string

/** Isolation granularity for a session (see §4 of the plan). */
export type IsolationMode = 'context' | 'browser'

/** Header carrying the session token on the client's WS upgrade request. */
export const SESSION_TOKEN_HEADER = 'x-cdp-session'

/** Namespace reserved for proxy/plugin custom RPC methods (§6.5). */
export const PROXY_METHOD_PREFIX = 'Proxy.'

export interface HandlerOptions {
  browserHost: string
  browserPort: number
}

export interface HandlerInterface {
  handle(request: Request): Promise<Response>
}

export interface CDPTarget {
  sessionId: SessionId
  targetId: TargetId
  type: string
  browserContextId?: string
}

export interface CDPError {
  code: number
  message: string
  data?: unknown
}

export interface CDPRequest {
  id: number
  method: string
  params?: Record<string, unknown>
  sessionId?: SessionId
}

export interface CDPResponse {
  id: number
  result?: Record<string, unknown>
  error?: CDPError
  sessionId?: SessionId
}

export interface CDPEvent {
  method: string
  params?: Record<string, unknown>
  sessionId?: SessionId
}

export type CDPMessage = CDPRequest | CDPResponse | CDPEvent

/**
 * A frame that has committed a new document — the moment init scripts, execution
 * contexts and per-document state belong to. Derived by the runtime from raw
 * `Page.*` traffic so plugins never have to sequence it themselves.
 */
export interface CDPDocument {
  sessionId: SessionId
  frameId: string
  loaderId: string
  url: string
  /** True for the page's top-level frame, false for a subframe. */
  isMain: boolean
}

type MaybePromise<T> = T | Promise<T>

type Commands = ProtocolMapping.Commands
type Events = ProtocolMapping.Events

/** Params type for a typed CDP command (may be optional/absent). */
type CommandParams<M extends keyof Commands> = Commands[M]['paramsType'][0]
/** Return type for a typed CDP command. */
type CommandReturn<M extends keyof Commands> = Commands[M]['returnType']

/**
 * Per-invocation context handed to every plugin hook. Replaces v1's injected
 * `sendCommand` + hand-rolled session maps with a rich, typed surface.
 */
export interface PluginContext {
  readonly sessionToken: SessionToken
  readonly connectionId: ConnectionId
  /** Live view of attached targets keyed by CDP session id. */
  readonly targets: ReadonlyMap<SessionId, CDPTarget>
  /**
   * Aborted when the connection is torn down. Pass it to timers, fetches and
   * loops, and check it before reporting a failure — once a session ends, every
   * in-flight `send` rejects, and that is expected rather than an error.
   */
  readonly signal: AbortSignal
  /**
   * Send a typed CDP command to the upstream browser on behalf of the plugin.
   * The response is resolved to the plugin and never leaked to the client.
   */
  send<M extends keyof Commands>(
    method: M,
    params?: CommandParams<M>,
    sessionId?: SessionId,
  ): Promise<CommandReturn<M>>
  /** Emit a typed synthetic CDP event to the client, in order. */
  emit<M extends keyof Events>(
    method: M,
    params: Events[M] extends [infer P] ? P : Record<string, never>,
    sessionId?: SessionId,
  ): void
  /** Per-plugin scoped logger. */
  log(...args: unknown[]): void
}

/** Result of an `onRequest` hook. */
export type RequestOutcome =
  | CDPRequest // forward (possibly modified)
  | null // drop silently
  | { respond: Record<string, unknown> | { error: CDPError } } // short-circuit
  | void // unmodified forward

export interface PluginHooks {
  onRequest?(msg: CDPRequest, ctx: PluginContext): MaybePromise<RequestOutcome>
  onResponse?(
    msg: CDPResponse,
    ctx: PluginContext,
  ): MaybePromise<CDPResponse | null | void>
  onEvent?(
    evt: CDPEvent,
    ctx: PluginContext,
  ): MaybePromise<CDPEvent | null | void>
  onSessionStart?(ctx: PluginContext): MaybePromise<void>
  onSessionEnd?(ctx: PluginContext): MaybePromise<void>
  onTargetAttached?(target: CDPTarget, ctx: PluginContext): MaybePromise<void>
  onTargetDetached?(target: CDPTarget, ctx: PluginContext): MaybePromise<void>
  /**
   * A frame committed a new document. Runs before the underlying event reaches
   * the client, so anything emitted here arrives first — but the event stream is
   * blocked until it resolves, so kick off long work without awaiting it.
   */
  onDocument?(doc: CDPDocument, ctx: PluginContext): MaybePromise<void>
}

/**
 * A plugin definition passed to {@link definePlugin}. `Options` is the typed
 * config surface the author exposes to automators.
 */
export interface PluginDefinition<Options> {
  name: string
  defaults?: Options
  /** Method globs (e.g. `Runtime.*`, `Page.frameNavigated`) narrowing invocations. */
  match?: string[]
  /** Higher runs earlier when multiple plugins touch the same message. */
  priority?: number
  setup(cfg: Options, ctx: PluginContext): PluginHooks | Promise<PluginHooks>
}

/**
 * A resolved plugin ready for per-session instantiation. Produced by calling a
 * plugin factory (the value returned from {@link definePlugin}).
 */
export interface ConfiguredPlugin {
  name: string
  options: Record<string, unknown>
  priority: number
  matches(method: string): boolean
  /** The globs `matches` was compiled from, retained so traces can show them. */
  match?: string[]
  setup(ctx: PluginContext): PluginHooks | Promise<PluginHooks>
}

/** The factory an automator calls, e.g. `stealth({ mode: 'addBinding' })`. */
export interface PluginFactory<Options> {
  (options?: Partial<Options>): ConfiguredPlugin
  pluginName: string
}

export interface EnvVars {
  CDP_PROXY_PORT?: string
  CDP_PROXY_HOST?: string
  CDP_BROWSER_PORT?: string
  CDP_BROWSER_HOST?: string
  CDP_BROWSER_DIRECTORY?: string
  CDP_BROWSER_VERSION?: string
  CDP_BROWSER_EXECUTABLE_PATH?: string
  CDP_BROWSER_WS_ENDPOINT?: string
  CDP_PROXY_LOG_LEVEL?: string
  CDP_PROXY_LOG_TAGS?: string
  CDP_HEADLESS?: string
  CDP_ISOLATION?: string
  CDP_PLUGINS_DIRECTORY?: string
  CDP_DEBUG?: string
}
