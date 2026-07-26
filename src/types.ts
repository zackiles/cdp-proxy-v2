/**
 * @module types
 * @description Shared types for the CDP proxy: identifiers, CDP message shapes,
 * the plugin platform, and the typed CDP surface backed by `devtools-protocol`.
 *
 * The plugin platform has five kinds (`docs/plugin-platform.md` §1). One
 * constructor builds all of them and `kind` selects which definition the rest of
 * the object must satisfy, so narrowing `kind` fixes both the context `setup`
 * receives and the hooks it must return.
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
  /**
   * The command this answers. A reply carries no method on the wire, so the proxy
   * fills it in for `onResponse` — otherwise every plugin that cares about replies
   * has to keep its own id-to-method map — and strips it again before the client
   * sees the message. It is also what `match` filters `onResponse` on.
   */
  method?: string
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

/** Send a typed CDP command on behalf of a plugin. */
export type Send = <M extends keyof Commands>(
  method: M,
  params?: CommandParams<M>,
  sessionId?: SessionId,
) => Promise<CommandReturn<M>>

// ─── kinds ────────────────────────────────────────────────────────────────────

/** Where a plugin attaches, and therefore what API it is given (§1.1). */
export type Kind = 'profile' | 'launch' | 'protocol' | 'surface' | 'actor'

/** A JavaScript global scope a surface can be delivered into (§7.1). */
export type Realm = 'page' | 'iframe' | 'worker' | 'service_worker'

const KINDS: readonly Kind[] = [
  'profile',
  'launch',
  'protocol',
  'surface',
  'actor',
]

/** The default for a surface: every realm, which is the point of the kind (§4.4). */
const REALMS: readonly Realm[] = ['page', 'iframe', 'worker', 'service_worker']

export { KINDS, REALMS }

/** Plugins grouped by kind, which is the order the runtime resolves them in. */
export type PluginSet = Record<Kind, ConfiguredPlugin[]>

/**
 * The base every kind that *reads* the identity shares (§9.4). `ProfileContext`
 * is the one exception, because it is what produces the identity.
 */
export interface Context {
  readonly profile: Profile
  /** Aborts at the end of the kind's lifetime; check it before logging failures. */
  readonly signal: AbortSignal
  log(...args: unknown[]): void
}

// ─── profile ──────────────────────────────────────────────────────────────────

/**
 * One machine, claimed coherently (§2.1). Deeply frozen once sealed (§2.6), so
 * there is no way to change one field of a drawn profile — patching `os` onto a
 * row drawn from another OS is how a session ends up claiming an Apple GPU on a
 * Windows User-Agent. Optional fields are absent rather than defaulted, and a
 * surface whose field is absent stands down rather than inventing one (§2.9).
 */
export interface Profile {
  readonly id: string
  readonly seed: string
  /** Which loader drew it, for the trace. */
  readonly source: string
  /** Bumped when a field is added; a surface compares before standing down. */
  readonly schema: number

  readonly os: 'macOS' | 'Windows' | 'Linux'
  readonly osVersion: string
  readonly arch: 'x86' | 'arm'
  /** The binary's major version, corrected by reconciliation. Never guessed. */
  readonly chrome: number

  readonly userAgent: string
  readonly brands: readonly { brand: string; version: string }[]

  readonly languages: readonly string[]
  readonly locale: string
  readonly timezone: string
  readonly geo?: { latitude: number; longitude: number; accuracy: number }

  readonly screen: {
    width: number
    height: number
    scale: number
    depth: number
  }
  readonly viewport: { width: number; height: number }
  /** Tab strip plus toolbar: the gap between outerHeight and innerHeight. */
  readonly chromeHeight: number

  readonly hardware: { cores: number; memory: number; touch: boolean }
  readonly gpu?: {
    vendor: string
    renderer: string
    angle: string
    params?: Readonly<Record<number, number | string>>
  }
  readonly fonts?: readonly string[]
  readonly media?: {
    codecs: readonly string[]
    devices: readonly { kind: string; label: string }[]
  }

  /** Deterministic per-profile jitter in [0, 1) for a stable key (§2.10). */
  noise(key: string): number
}

/**
 * What a loader returns. `noise` is derived from `seed` by the runtime at seal
 * time rather than by every loader, so a loader that forgot it cannot produce a
 * profile whose jitter is not reproducible.
 */
export type Draw = Omit<Profile, 'noise'>

/** A query against the loaders, never a patch to a drawn profile (§2.4). */
export interface Constraint {
  os?: Profile['os'][]
  locale?: string[]
  timezone?: string[]
  minChrome?: number
  /** Ask for a specific identity back, e.g. to pair with a userDataDir. */
  id?: string
  [key: string]: unknown
}

export interface ProfileHooks {
  /** Return `undefined` to pass to the next loader by priority. */
  draw(constraint: Constraint): MaybePromise<Draw | undefined>
  /** A stateful loader is told when an identity is retired (§2.7). */
  burn?(id: string, reason: string): MaybePromise<void>
}

export interface ProfileContext extends Omit<Context, 'profile'> {
  /** Seeded from the run, so a draw is reproducible given the same seed. */
  random(): number
  /** The run's seed, for a loader that wants to derive its own values from it. */
  readonly seed: string
}

/** What `Proxy.profile` answers: the sealed identity and who read what (§2.8). */
export interface Coverage {
  /** Profile field → the plugins that read it. */
  read: Record<string, string[]>
  /** Fields nothing read, so the browser's own value reaches the page (§2.8). */
  uncovered: string[]
  /** Plugin → why it installed nothing (§2.9). */
  stoodDown: Record<string, string>
}

// ─── launch ───────────────────────────────────────────────────────────────────

/**
 * Fields a `launch` plugin found the process disagreed with it about (§2.6).
 *
 * `id`, `seed` and `source` are not correctable: they say which identity this
 * is and where it came from, and a process cannot have an opinion about that.
 */
export type Correction = Partial<Omit<Draw, 'id' | 'seed' | 'source'>>

export interface LaunchHooks {
  flags?: string[]
  env?: Record<string, string>
  extensions?: string[]
  userDataDir?: string
  auth?: { username: string; password: string }
  /**
   * The process exists. Check that the contribution took effect, and return what
   * the profile should say instead where it did not (§3.2).
   *
   * A window Chrome clamped to the display is the ordinary case: the flag asked
   * for 2560×1440, the process is 1512×944, and a profile still claiming the
   * first is contradicted by `window.outerWidth` on the first page that reads
   * it. What is returned here is folded into the identity before it seals, so
   * every other kind sees the corrected value rather than the asked-for one.
   */
  onStart?(browser: BrowserInfo): MaybePromise<void | Correction>
  onStop?(browser: BrowserInfo): MaybePromise<void>
}

export interface BrowserInfo {
  pid: number
  host: string
  port: number
  userDataDir?: string
  flags: readonly string[]
  executablePath: string
  /** `Browser.getVersion`'s product string, e.g. `HeadlessChrome/147.0.7258.5`. */
  product?: string
  /** The binary's own User-Agent, before any surface rewrites it. */
  userAgent?: string
}

export interface LaunchContext extends Context {
  readonly platform: 'darwin' | 'linux' | 'windows'
}

/** One process's resolved launch contribution, after the merge in §3.1. */
export interface LaunchSpec {
  flags: string[]
  env: Record<string, string>
  extensions: string[]
  userDataDir?: string
  auth?: { username: string; password: string }
  /** Conflicts and warn-list hits, reported at session start (§9.5). */
  conflicts: string[]
}

// ─── surface ──────────────────────────────────────────────────────────────────

export interface SurfaceHooks<Config = undefined> {
  /**
   * Runs in the main world of every realm, before any page script.
   *
   * DANGER: serialized with `Function.prototype.toString()`, so it cannot close
   * over anything — not imports, not `cfg`, not `ctx`. Everything it needs comes
   * through `config`, which must be JSON-serializable. A captured reference is
   * `undefined` at run time with no error, which is why `deno task lint:page`
   * rejects free identifiers in a page function (§4.1).
   */
  page?: (config: Config) => void
  config?: Config
  /** Defaults to every realm. */
  realms?: Realm[]
  /** Native CDP overrides. Preferred over `page` wherever CDP can do the job. */
  emulate?(realm: RealmContext): MaybePromise<void>
  /** Merged across surfaces by the runtime, which owns the header set (§7.2). */
  headers?: Record<string, string>
  /**
   * The monitor and the window around the viewport, declared rather than sent.
   *
   * `Emulation.setDeviceMetricsOverride` is whole-state and the *client* is a
   * caller: Playwright sends its own the moment a viewport is set, and it pins
   * the screen to that viewport, which no real monitor does. An `emulate` hook
   * cannot win that — whatever it sends is replaced moments later. So the broker
   * owns the command and folds this in, both on the client's calls and on its
   * own when the client never makes one (§7.2).
   */
  display?: Display
}

/** A claim about the display, merged by the runtime and sent by the broker. */
export interface Display {
  /** The monitor, which is bigger than the viewport on every real machine. */
  screen?: { width: number; height: number; scale: number }
  /** Tab strip plus toolbar: the gap between `outerHeight` and `innerHeight`. */
  chrome?: number
}

export interface RealmContext {
  readonly realm: Realm
  readonly sessionId: SessionId
  readonly frameId?: string
  send: Send
}

/** Reads are recorded; unread fields are reported as uncovered (§2.8). */
export type SurfaceContext = Context

// ─── actor ────────────────────────────────────────────────────────────────────

/**
 * The handle an actor acts through (§6.2). Deliberately small: it is not a
 * second Playwright and will not grow into one. `click` and `fill` go through
 * the `Input` domain, so the page sees `isTrusted: true` rather than the
 * `element.click()` tell.
 */
export interface PageContext extends Context {
  readonly target: CDPTarget
  readonly url: string
  eval<T, A = undefined>(fn: (arg: A) => T, arg?: A): Promise<T>
  has(selector: string): Promise<boolean>
  wait(selector: string, timeout?: number): Promise<boolean>
  click(selector: string): Promise<void>
  fill(selector: string, text: string): Promise<void>
  goto(url: string): Promise<void>
  /** `document` fires on every navigation, including the first; `close` on detach. */
  on(event: 'document' | 'close', fn: () => MaybePromise<void>): void
  /**
   * Escape hatch (§6.4): typed CDP, bound to this target.
   *
   * DANGER: refuses `Runtime.enable`, the brokered domains (§7.2), and
   * `*.disable` for a domain this actor did not enable. Other `*.enable` calls
   * are allowed and logged, because a newly enabled domain changes what the
   * session looks like from the browser's side.
   */
  send: PluginContext['send']
  /**
   * Escape hatch (§6.4): observe a typed CDP event on this page's session.
   * Returns an unsubscribe.
   *
   * DANGER: observe-only, and delivered off the message queue *after* the
   * pipeline has decided — so it cannot change the message, and the page may
   * have moved on by the time it runs.
   */
  cdp<M extends keyof Events>(
    method: M,
    fn: (
      params: Events[M] extends [infer P] ? P : Record<string, never>,
    ) => void,
  ): () => void
}

// ─── injection and the protocol context ───────────────────────────────────────

export interface InjectOptions {
  /**
   * Run in a named isolated world rather than the page's own. Chrome creates the
   * world for each document, and the page can neither see nor reach anything the
   * script defines there — the only way to run plugin code on a page without
   * leaving something behind for it to find.
   *
   * Reading a result back out means evaluating in the same world, which
   * `Page.createIsolatedWorld({ frameId, worldName })` returns the context id for.
   * A `Runtime.addBinding` callback channel is not an option: see {@link
   * PluginContext.inject}.
   */
  world?: string
  /** Also run once in the document already loaded, not just the next one. */
  immediately?: boolean
}

/**
 * Per-invocation context handed to every `protocol` plugin hook. Replaces v1's
 * injected `sendCommand` + hand-rolled session maps with a rich, typed surface.
 */
export interface PluginContext {
  readonly sessionToken: SessionToken
  readonly connectionId: ConnectionId
  /**
   * The sealed identity this session presents (§2). Every read is recorded, and
   * a field nothing read is reported as uncovered — so reaching for
   * `ctx.profile.userAgent` is also how the runtime learns the User-Agent is
   * covered.
   *
   * DANGER: never hold a value from here across a draw. The profile is the one
   * coherent row, and a plugin that caches `userAgent` and keeps using it after
   * reconciliation corrected the Chrome version is asserting a version the binary
   * does not have.
   */
  readonly profile: Profile
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
  send: Send
  /** Emit a typed synthetic CDP event to the client, in order. */
  emit<M extends keyof Events>(
    method: M,
    params: Events[M] extends [infer P] ? P : Record<string, never>,
    sessionId?: SessionId,
  ): void
  /**
   * Run `source` at the start of every document in a target, its subframes
   * included, and return a function that stops future documents from getting it.
   * Documents that already ran it keep whatever it did.
   *
   * Pass `world` to run in an isolated world, invisible to the page.
   *
   * IMPORTANT: there is deliberately no `bind` companion for calling back *out*
   * of injected code. `Runtime.addBinding` installs its function into the
   * contexts that exist when it is sent and is gone after the next navigation
   * unless `Runtime.enable` is on, and scoping it to a world needs
   * `Runtime.enable` too — so a binding channel is either quietly broken or
   * announces the session. Read results back with `Runtime.evaluate` instead.
   */
  inject(
    source: string,
    sessionId: SessionId,
    options?: InjectOptions,
  ): Promise<() => Promise<void>>
  /**
   * Scratch space for one target, created on first use and dropped when the
   * target detaches. Plugins outlive the pages they configure, so anything keyed
   * by session id in plugin scope has to be pruned by hand on detach, and
   * forgetting is a leak that only shows on long-lived connections. Each plugin
   * sees its own.
   */
  state<T>(sessionId: SessionId, init: () => T): T
  /** Per-plugin scoped logger. */
  log(...args: unknown[]): void
}

/**
 * Result of an `onRequest` hook.
 *
 * Note that `null` *refuses* the command rather than discarding it: every CDP
 * command has a client waiting on its id, so a silent drop would hang the client
 * until its own timeout. Use `{ respond }` to suppress a command while keeping the
 * client happy — that is what a plugin hiding a command almost always wants.
 */
export type RequestOutcome =
  | CDPRequest // forward (possibly modified)
  | null // refuse: the client gets an error naming the plugin
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
  /**
   * Custom `Proxy.*` methods this plugin answers (§7.3).
   *
   * Declared rather than string-matched in `onRequest`, which is what the same
   * thing used to cost: an invisible method, a `match` glob that silently broke
   * it, and two plugins able to claim the same name with no way to find out.
   * Declared methods are registered at install, so a collision is an error at
   * session start; they bypass `match`; and they appear in `Proxy.hello`.
   *
   * ```ts
   * rpc: { 'Proxy.history': () => ({ entries: [...entries] }) }
   * ```
   *
   * `{ respond }` from `onRequest` is unchanged and is still the right tool for
   * intercepting a *real* CDP method.
   */
  rpc?: Record<
    string,
    (
      params: Record<string, unknown>,
      ctx: PluginContext,
    ) => MaybePromise<Record<string, unknown>>
  >
}

// ─── definitions ──────────────────────────────────────────────────────────────

/** Shared by every kind. `kind` selects which definition the rest must satisfy. */
export interface Definition<Options> {
  name: string
  defaults?: Options
  /** Higher runs earlier when two plugins of a kind touch the same thing. */
  priority?: number
  /**
   * Let the session continue without this plugin if `setup` throws. Off by
   * default: a plugin that never installed is a silent lie about how the session
   * is configured, and a caller who asked for stealth should not be handed a
   * plain browser. Set it for plugins that only observe, like a recorder.
   */
  optional?: boolean
}

export interface ProfileDefinition<O> extends Definition<O> {
  kind: 'profile'
  setup(cfg: O, ctx: ProfileContext): MaybePromise<ProfileHooks>
}

export interface LaunchDefinition<O> extends Definition<O> {
  kind: 'launch'
  setup(cfg: O, ctx: LaunchContext): MaybePromise<LaunchHooks>
}

export interface ProtocolDefinition<O> extends Definition<O> {
  /**
   * Optional only so a plugin written before the kinds existed still compiles;
   * every shipped `protocol` plugin names it (§5).
   */
  kind?: 'protocol'
  /** CDP-method globs (e.g. `Runtime.*`, `Page.frameNavigated`). Absent means every method. */
  match?: string[]
  setup(cfg: O, ctx: PluginContext): MaybePromise<PluginHooks>
}

export interface SurfaceDefinition<O, C = undefined> extends Definition<O> {
  kind: 'surface'
  setup(cfg: O, ctx: SurfaceContext): MaybePromise<SurfaceHooks<C>>
}

export interface ActorDefinition<O> extends Definition<O> {
  kind: 'actor'
  /**
   * URL globs; the actor is instantiated only on pages that match.
   *
   * Named `urls` rather than `match` on purpose: `protocol`'s `match` filters
   * CDP method globs, and two fields with the same name and different meanings
   * is a trap (§6.3).
   */
  urls?: string[]
  /**
   * Instantiate once per connection instead of once per page, for an actor
   * coordinating across pages — a login that must happen before the others
   * proceed. Per-page is the default because it is what nearly every actor
   * wants (§6.3).
   */
  scope?: 'page' | 'session'
  setup(cfg: O, page: PageContext): MaybePromise<void>
}

/**
 * A plugin definition passed to `definePlugin`. `Options` is the typed config
 * surface the author exposes to automators; `kind` decides everything else.
 */
export type PluginDefinition<O, C = undefined> =
  | ProfileDefinition<O>
  | LaunchDefinition<O>
  | ProtocolDefinition<O>
  | SurfaceDefinition<O, C>
  | ActorDefinition<O>

/**
 * A resolved plugin ready for per-session instantiation. Produced by calling a
 * plugin factory (the value returned from `definePlugin`).
 *
 * `setup` is deliberately untyped here: which context it takes and which hooks
 * it returns are fixed by `kind`, and `definePlugin` is where that is checked.
 * The runtime installs each partition against its own contract.
 */
export interface ConfiguredPlugin {
  readonly kind: Kind
  name: string
  options: Record<string, unknown>
  priority: number
  matches(method: string): boolean
  /** The globs `matches` was compiled from, retained so traces can show them. */
  match?: string[]
  /** URL globs for an `actor`. */
  urls?: string[]
  /** Per-page or once per connection, for an `actor` (§6.3). */
  scope?: 'page' | 'session'
  optional?: boolean
  /**
   * Set by the runtime for the core tier (§8). Pinned to one end of its kind's
   * order, never `optional`, and not settable by an authored plugin.
   */
  pinned?: 'first' | 'last'
  // deno-lint-ignore no-explicit-any
  setup(ctx: any): any
}

/** The factory an automator calls, e.g. `webgl({ webgl2: false })`. */
export interface PluginFactory<Options> {
  (options?: Partial<Options>): ConfiguredPlugin
  pluginName: string
  kind: Kind
}

// ─── presets ──────────────────────────────────────────────────────────────────

export interface PresetDefinition<Options> {
  name: string
  defaults?: Options
  plugins(cfg: Options & { without?: string[] }): ConfiguredPlugin[]
}

export interface PresetFactory<Options> {
  (options?: Partial<Options & { without?: string[] }>): ConfiguredPlugin[]
  presetName: string
}

/** What an automator may pass as `plugins`: plugins, presets, or `'none'` (§8.6). */
export type PluginList = (ConfiguredPlugin | ConfiguredPlugin[])[] | 'none'

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
  /** Pin every session to one profile id, for reproducing a failure (§2.3). */
  CDP_PROFILE?: string
  /** How many identities the shared pool draws (§2.7); defaults to the pool size. */
  CDP_PROFILES?: string
  /** Path to a JSONL fingerprint corpus (Phase 5). */
  CDP_CORPUS?: string
}
