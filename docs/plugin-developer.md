# Plugin developer guide

A plugin is a typed factory that attaches to one part of a session. Depending on
its **kind** it decides which machine the session claims, how the browser
process starts, what travels on the CDP wire, what the page's own JavaScript
sees, or what happens on the page once it loads.

Everything the bundled `stealth` preset does — the User-Agent, the GPU strings,
the fonts, the timezone, the codecs, the monitor — it does through this API,
with no special access. If you can express it in CDP or in a page function, you
can express it as a plugin.

- [How a session is assembled](#how-a-session-is-assembled)
- [The five kinds](#the-five-kinds)
- [The three tasks](#the-three-tasks)
- [`definePlugin`](#defineplugin)
- [Options](#options)
- [The profile](#the-profile)
- [`profile` — which machine to claim](#profile--which-machine-to-claim)
- [`launch` — the browser process](#launch--the-browser-process)
- [`protocol` — the CDP wire](#protocol--the-cdp-wire)
- [`surface` — what the page sees](#surface--what-the-page-sees)
- [`actor` — behaviour on a page](#actor--behaviour-on-a-page)
- [Presets](#presets)
- [The core tier](#the-core-tier)
- [Brokered domains](#brokered-domains)
- [Custom RPC](#custom-rpc)
- [Running code in the page](#running-code-in-the-page)
- [Debugging](#debugging)
- [Testing](#testing)
- [Distributing a plugin](#distributing-a-plugin)
- [Gotchas](#gotchas)
- [Checklist](#checklist)

## How a session is assembled

One client connection is one **session**. Its plugin set is partitioned by kind
and each partition is resolved in its own phase, in this order:

| Phase        | What happens                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| 1 `profile`  | Loaders are asked for a machine, in priority order, until one answers.                                     |
| 2 `launch`   | Every contribution is merged into one `LaunchSpec` and the process starts.                                 |
| 3 `onStart`  | `launch` plugins check what the process actually did and return corrections.                               |
| 4 seal       | The drawn row plus its corrections is frozen. Every later kind reads that.                                 |
| 5 `protocol` | `setup` runs for each plugin and the pipeline is installed, before any client message is forwarded.        |
| 6 `surface`  | Surfaces compile to one injected bundle, a list of `Emulation.*` calls, a header set, and a display claim. |
| 7 `actor`    | `setup` runs per page target, as pages appear.                                                             |

The ordering is the whole design in one line: **the identity is decided before
anything can read it, and corrected before anything can contradict it.** A flag
asked for a 2560×1440 window, Chrome clamped it to the display, and phase 3 is
where the profile stops claiming the size it did not get.

```
client (Playwright) ──▶ onRequest  ──▶ Chrome
client               ◀── onResponse ◀── Chrome
client               ◀── onEvent    ◀── Chrome
```

Three consequences worth internalising up front:

- **State lives in the `setup` closure.** Each session gets a fresh call, so two
  concurrent sessions cannot see each other's state. Module-level state is _not_
  isolated — see [Gotchas](#gotchas).
- **You are in the message path.** `protocol` hooks run before the message
  continues, so a slow hook is latency for the client and a hook that never
  resolves is a hang. `actor` callbacks are the exception: they run off the
  queue.
- **Your own traffic is invisible to the client.** `ctx.send` commands travel on
  the same socket but are resolved to you and never forwarded, on an id space
  that cannot collide with the client's.

## The five kinds

`kind` is a field on the definition, so one constructor builds all five and the
only thing that changes between them is what you write inside.

| Kind       | Lifetime                      | Context          | Write one when                                              |
| ---------- | ----------------------------- | ---------------- | ----------------------------------------------------------- |
| `profile`  | once, before the browser      | `ProfileContext` | you have machines to hand out — a corpus, a pool, a fixture |
| `launch`   | once, before the process      | `LaunchContext`  | the claim needs a command-line flag or an env var           |
| `protocol` | on every CDP message          | `PluginContext`  | you need to read, rewrite, answer, or suppress traffic      |
| `surface`  | once per session, in the page | `SurfaceContext` | a browser API should report something the profile says      |
| `actor`    | once per page                 | `PageContext`    | something on the page needs doing — a banner, a challenge   |

Two rules decide between them more often than anything else:

- **If the profile has a field for it, write a `surface`.** A surface declares
  what an API should report and the runtime decides how to get it there, which
  is why one surface reaches the page, its iframes, and its workers while a
  hand-rolled `protocol` plugin reaches the page only.
- **If it needs to await something slow, write an `actor`.** A `protocol` hook
  runs inside the message path, so a ten-second call to a captcha solver is ten
  seconds of stalled page. An actor's callbacks run off the queue.

## The three tasks

```sh
deno task plugins                      # what exists, and what each one reads
deno task new surface graphics/webgl   # scaffold the plugin and its test
deno task dev --plugin webgl           # headful, pinned profile, reloads on save
```

`deno task plugins` is the answer to "is there already a fonts surface?". It
resolves each plugin rather than parsing it, so the `reads gpu` column is the
same fact the coverage report is built from:

```
authored  surface   webgl   plugins/surface/graphics/webgl.ts  reads gpu  realms page,iframe,worker
authored  surface   fonts   plugins/surface/platform/fonts.ts  reads fonts  realms page,iframe
core      launch    flags   src/core/flags.ts                  pinned first  reads locale viewport chromeHeight
```

Scaffold rather than copy. Copying the nearest plugin brings its realms, its
priority, and its guards, and the differences that mattered are invisible in a
diff against nothing.

## `definePlugin`

```ts
function definePlugin<
  Options extends Record<string, unknown>,
  Config = undefined,
>(
  def: PluginDefinition<Options, Config>,
): PluginFactory<Options>
```

`Config` is the `surface` kind's page-function payload; every other kind leaves
it alone.

| Field      | Type                                    | Default    | Meaning                                                                                                                                                                                                                            |
| ---------- | --------------------------------------- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kind`     | `Kind`                                  | `protocol` | Which part of the session this attaches to. Omitting it is how a plugin written before the kinds existed still works.                                                                                                              |
| `name`     | `string`                                | required   | Identifies the plugin in traces, logs, errors, and `Proxy.hello`. Also the name it is registered under for by-name loading. Unique within a kind: two plugins claiming one name collide at startup, wherever they sit in the tree. |
| `defaults` | `Options`                               | `{}`       | Merged under per-call options. Shallow.                                                                                                                                                                                            |
| `match`    | `string[]`                              | all        | `protocol` only: CDP-method globs narrowing which messages reach your message hooks.                                                                                                                                               |
| `urls`     | `string[]`                              | all        | `actor` only: URL globs deciding which pages get an instance.                                                                                                                                                                      |
| `scope`    | `'page' \| 'session'`                   | `page`     | `actor` only: instantiate once per connection instead of once per page.                                                                                                                                                            |
| `priority` | `number`                                | `0`        | Higher runs **earlier**. Ties keep array order.                                                                                                                                                                                    |
| `optional` | `boolean`                               | `false`    | If `setup` throws, skip this plugin instead of failing the session.                                                                                                                                                                |
| `setup`    | `(cfg, ctx) => Hooks \| Promise<Hooks>` | required   | What it returns depends on the kind; the sections below cover each.                                                                                                                                                                |

The return value is a factory an automator calls:

```ts
interface PluginFactory<Options> {
  (options?: Partial<Options>): ConfiguredPlugin
  pluginName: string
  kind: Kind
}
```

**A path is inert.** `plugins/surface/graphics/webgl.ts` and
`plugins/surface/webgl.ts` produce the identical plugin: autoload recurses and
registers what it finds, and nothing reads the directory name. The folders are
for the next person to read, and `deno task new` suggests one rather than
insisting.

### `match`

Globs are anchored and only `*` is special, so `Runtime.*` matches
`Runtime.evaluate` but not `Runtimex.evaluate`, and `Page.frameNavigated`
matches exactly one method. A list narrows to the union of its entries:
`match: ['Network.*', 'Fetch.requestPaused']`.

`match` filters `onRequest`, `onEvent`, and `onResponse`. It does **not** filter
lifecycle hooks or declared `rpc` methods — those always run. Narrowing is worth
doing: an event-heavy session pushes tens of thousands of messages through the
pipeline, and a plugin that only cares about `Fetch.*` should not be invoked for
all of them.

A `match` that never matched anything is reported at session end even with
tracing off, because a typo like `Runtim.*` otherwise looks exactly like a
working plugin.

### `priority`

Higher runs earlier, within a kind. It orders the pipeline for `protocol`, the
loaders for `profile`, the merge for `launch`, the bundle for `surface`, and who
wins a contested claim in the [broker](#brokered-domains). `navigator` and
`screen` sit at `100` so their claims are the ones that survive a conflict;
leave it at `0` unless two plugins touch the same thing and the order matters.

### `optional`

If `setup` throws, the connection fails and the client is disconnected with your
plugin named. That is deliberate: a plugin that never installed means the
session is running while believing it is configured in a way it is not, and for
`stealth` that means quietly handing back a plain, detectable browser.

Set `optional: true` when your plugin's absence costs visibility rather than
correctness. `recorder` is optional; a surface is not.

`Proxy.hello` reports the plugins that actually installed, never the ones that
were requested.

## Options

Options are resolved when the **factory** is called, by shallow-merging over
`defaults`:

```ts
const configured = block({ patterns: ['*.mp4'] })
// configured.options === { patterns: ['*.mp4'] }
```

Three things follow from "shallow":

- A nested object in options **replaces** the default wholesale rather than
  merging field by field.
- Passing `undefined` for a key does not fall back to the default — it overrides
  it with `undefined`. Omit the key instead.
- `cfg` inside `setup` is the merged object, typed as `Options`. Optional fields
  that `defaults` fills are still typed optional, which is why the bundled
  plugins reach for `cfg.timeout!`.

`definePlugin` constrains `Options extends Record<string, unknown>`, so an
interface passed as the type argument needs an index signature:

```ts
export interface MyOptions {
  limit?: number
  [key: string]: unknown // required
}
```

Without it TypeScript rejects the interface, because an `interface` (unlike a
`type` alias) is not implicitly assignable to `Record<string, unknown>`.

`ctx.send` and `ctx.emit` are generic over `devtools-protocol`, so methods,
params, and return types all autocomplete and typecheck:

```ts
const { root } = await ctx.send('DOM.getDocument', { depth: 1 }, sessionId)
//      ^? Protocol.DOM.Node
```

## The profile

Every kind but `profile` gets `ctx.profile`: one coherent claim about one
machine, drawn once per browser run and frozen. It is where a plugin's values
come from — `profile.gpu.renderer` rather than a renderer string you picked.

```ts
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

  /** Deterministic per-profile jitter in [0, 1) for a stable key. */
  noise(key: string): number
}
```

Four properties are worth knowing before you read a field.

**It is immutable, and writing to it throws** with a message naming your plugin.
Patching `os` onto a row drawn from another OS is how a session ends up claiming
an Apple GPU behind a Windows User-Agent. Draw again with a tighter constraint
instead.

**An absent optional field means stand down.** `gpu`, `fonts`, `geo`, and
`media` are optional, because a loader may have nothing to say about them. The
correct response is to install nothing and let the real browser's value through
— a made-up renderer is worse than the driver's own:

```ts
setup(cfg, ctx) {
  const { gpu } = ctx.profile
  if (!gpu) return {} // stand down; do not invent one
  return { config: { renderer: gpu.renderer }, page(config) { /* ... */ } }
}
```

**Every read is recorded.** `ctx.profile` is a recording view, so the coverage
report can say which fields your plugin carried and which fields nothing did:

```
profile 8f2c source=corpus Windows 11 / Chrome 147 / en-US / America/New_York
  navigator  reads userAgent brands os osVersion arch
  webgl      reads gpu
  uncovered  fonts
  devices    stood down: profile has no media
```

**The uncovered line is the point.** A field nothing read is a field where the
real browser's value reaches the page while the profile claims something else.
`assertEquals(it.coverage.uncovered, [])` is a test you can write. The asymmetry
is worth stating plainly: unread is definitely uncovered, read is only probably
covered — the report catches omissions, not mistakes.

`profile.noise(key)` is deterministic per-identity jitter in `[0, 1)`. Use it
anywhere you would reach for `Math.random()`: a canvas hash seeded from the
clock changes on every read, which is a stronger signal than the hash itself.
The same function is available page-side inside a `surface`.

## `profile` — which machine to claim

A loader answers a `Constraint` with a whole machine, or declines. Loaders run
in priority order and the first answer wins; core `generate` answers last, so
there is always one.

```ts
interface ProfileHooks {
  /** Return `undefined` to pass to the next loader by priority. */
  draw(constraint: Constraint): MaybePromise<Draw | undefined>
  /** A stateful loader is told when an identity is retired. */
  burn?(id: string, reason: string): MaybePromise<void>
}

interface ProfileContext {
  /** Seeded from the run, so a draw is reproducible given the same seed. */
  random(): number
  readonly seed: string
  readonly signal: AbortSignal
  log(...args: unknown[]): void
}

interface Constraint {
  os?: ('macOS' | 'Windows' | 'Linux')[]
  locale?: string[]
  timezone?: string[]
  minChrome?: number
  /** Ask for a specific identity back, e.g. to pair with a userDataDir. */
  id?: string
  [key: string]: unknown
}

/** What a loader returns: the profile without `noise`, which the runtime derives. */
type Draw = Omit<Profile, 'noise'>
```

```ts
export const fixture: PluginFactory<FixtureOptions> = definePlugin<
  FixtureOptions
>({
  kind: 'profile',
  name: 'fixture',
  priority: 50,
  setup(cfg, ctx) {
    const blocked = new Set<string>()
    return {
      draw(constraint) {
        return rows.find((r) => !blocked.has(r.id) && satisfies(r, constraint))
      },
      burn(id) {
        blocked.add(id)
      },
    }
  },
})
```

**Answer with a whole row or decline.** A loader that fills in half a machine
and leaves the rest to the next one produces a row nothing drew — an Apple GPU
under a Windows User-Agent is the failure this rule exists to prevent. `noise`
is the one field you do not supply: the runtime derives it from `seed` at seal
time, so a loader cannot produce an identity whose jitter is not reproducible.

**`burn` is how an identity is retired.** The automator calls `Proxy.burn` when
it sees a block, the runtime tells every loader, and each decides what that
means: `corpus` stops handing the row out and can record the withdrawal to a
file so it survives a restart, and `remote` tells the coordinating service so
the whole fleet stops. A loader with no state to withdraw from implements
nothing.

The three bundled loaders are `pin` (one fixed id, for reproducing a failure),
`corpus` (weighted sampling from a JSONL file of captured machines — see
`deno task capture`), and `remote` (an HTTP coordinator that draws and burns for
a fleet).

## `launch` — the browser process

Flags, environment variables, extensions, the user data directory, and proxy
credentials. Contributions from every `launch` plugin are merged into one spec.

```ts
interface LaunchHooks {
  flags?: string[]
  env?: Record<string, string>
  extensions?: string[]
  userDataDir?: string
  auth?: { username: string; password: string }
  /** The process exists; return what the profile should say where it disagreed. */
  onStart?(browser: BrowserInfo): MaybePromise<void | Correction>
  onStop?(browser: BrowserInfo): MaybePromise<void>
}

interface BrowserInfo {
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

interface LaunchContext extends Context {
  readonly platform: 'darwin' | 'linux' | 'windows'
}

/** A partial profile: what the process disagreed with the claim about. */
type Correction = Partial<Omit<Draw, 'id' | 'seed' | 'source'>>
```

```ts
export const clock: PluginFactory<ClockOptions> = definePlugin<ClockOptions>({
  kind: 'launch',
  name: 'clock',
  setup(cfg, ctx) {
    return { env: { TZ: ctx.profile.timezone } }
  },
})
```

> DANGER: a flag is per-process, and a plugin set is per-session. A session that
> contributes a flag cannot share a browser with one that does not, so **every
> `launch` plugin costs a browser process.** That is the right trade for
> `--proxy-server` and the wrong one for anything a `surface` could carry.

Four flags are reserved and throw at registration: `--remote-debugging-port`,
`--remote-debugging-address`, `--user-data-dir`, and `--headless` are the
runtime's. Two more are allowed with a warning, because they undo the platform's
own work: `--enable-automation` sets `navigator.webdriver`, and `--disable-gpu`
leaves the page with no WebGL context at all.

`userDataDir` and `auth` are exclusive: two plugins claiming either is an error
naming both, because there is no coherent way to merge them. A `userDataDir` is
also paired with the identity that first used it — the directory carries a
marker file, and reusing it under a different profile is an error rather than a
browser whose cache remembers a machine it is no longer claiming to be.

### Corrections

`onStart(browser)` runs once the process exists, with its pid, port, and the
flags it was actually started with. Check that your contribution took effect,
and return what the profile should say instead where it did not:

```ts
onStart(browser) {
  const got = browser.flags.find((f) => f.startsWith('--window-size='))
  if (!got) return
  const [width, height] = got.slice('--window-size='.length).split(',').map(Number)
  return { viewport: { width, height: height - ctx.profile.chromeHeight } }
}
```

What you return is merged into the identity **before it seals**, so every other
kind reads the corrected value. `id`, `seed`, and `source` cannot be corrected:
they say which identity this is, and a process has no opinion about that. Core
`flags` uses this for the window size — the merge is last-wins, so an authored
plugin's `--window-size` beats core's, and without the correction every surface
would go on claiming a viewport `window.outerWidth` disagrees with.

## `protocol` — the CDP wire

The general kind: read, rewrite, answer, or suppress messages in either
direction. `setup` returns any subset of these hooks, and every one may be
`async`.

```ts
interface PluginHooks {
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
  onDocument?(doc: CDPDocument, ctx: PluginContext): MaybePromise<void>
  rpc?: Record<
    string,
    (
      params: Record<string, unknown>,
      ctx: PluginContext,
    ) => MaybePromise<Record<string, unknown>>
  >
}
```

```ts
export const block: PluginFactory<BlockOptions> = definePlugin<BlockOptions>({
  name: 'block',
  defaults: { patterns: ['*.png', '*.jpg', '*.woff2'] },
  match: ['Network.*'],
  setup(cfg, ctx) {
    return {
      async onTargetAttached({ sessionId, type }) {
        if (type !== 'page') return
        await ctx.send('Network.enable', undefined, sessionId)
        await ctx.send(
          'Network.setBlockedURLs',
          { urls: cfg.patterns },
          sessionId,
        )
        ctx.log(`blocking ${cfg.patterns.length} patterns`)
      },
    }
  },
})
```

### Message hooks

| Hook                   | Direction        | Return to forward       | Return to change         | Other                                            |
| ---------------------- | ---------------- | ----------------------- | ------------------------ | ------------------------------------------------ |
| `onRequest(msg, ctx)`  | client → browser | the message, or nothing | a modified `CDPRequest`  | `{ respond }` answers the client; `null` refuses |
| `onResponse(msg, ctx)` | browser → client | the message, or nothing | a modified `CDPResponse` | `null` drops the reply (**see gotchas**)         |
| `onEvent(evt, ctx)`    | browser → client | the event, or nothing   | a modified `CDPEvent`    | `null` swallows the event                        |

`onRequest` outcomes in full:

| Return                          | Effect                                                              |
| ------------------------------- | ------------------------------------------------------------------- |
| the message, modified or not    | forward it                                                          |
| `undefined` / nothing           | forward unchanged                                                   |
| `{ respond: result }`           | answer the client with `result`; the browser never sees the command |
| `{ respond: { error: {...} } }` | answer the client with a CDP error                                  |
| `null`                          | refuse: the client gets `-32000` naming your plugin                 |

`{ respond }` and `null` **short-circuit** — lower-priority plugins never see
the message. Returning a message hands it to the next plugin.

To hide a command while keeping the client happy, use `{ respond: {} }` rather
than `null`. Every CDP command has a client awaiting its id, which is why `null`
is a refusal with an error rather than a silent drop.

`onResponse` receives the originating method on `msg.method`, even though a CDP
reply carries no method on the wire — the proxy fills it in and strips it again
before the client sees the message. That is also what `match` filters on.

### Lifecycle hooks

| Hook                            | When                                                          |
| ------------------------------- | ------------------------------------------------------------- |
| `onSessionStart(ctx)`           | after every plugin has installed, before client traffic flows |
| `onSessionEnd(ctx)`             | connection torn down; `ctx.signal` is already aborted         |
| `onTargetAttached(target, ctx)` | a page, iframe, or worker attached to this session            |
| `onTargetDetached(target, ctx)` | that target went away                                         |
| `onDocument(doc, ctx)`          | a frame committed a new document                              |

`CDPTarget` is `{ sessionId, targetId, type, browserContextId? }`. `type` is
Chrome's own: `page`, `iframe`, `worker`, `service_worker`, and others. **Always
check it** — see [Gotchas](#gotchas).

`onDocument` is usually the one you want. It hands you
`{ sessionId, frameId, loaderId, url, isMain }` already worked out from raw
`Page.*` traffic, so you never sequence navigation yourself, and it fires for
subframes too — the case that is easy to forget and where anything touching
execution contexts tends to break. It runs _before_ the underlying event reaches
the client, so anything you `ctx.emit` from it arrives first.

### `PluginContext`

The same `ctx` is handed to `setup` and to every hook. It is scoped to your
plugin by name, so traces, logs, and errors are attributed to you.

| Member                                | Type                                | Notes                                                                    |
| ------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| `profile`                             | `Profile`                           | The sealed identity; every read is recorded.                             |
| `sessionToken`                        | `SessionToken`                      | Identifies the session.                                                  |
| `connectionId`                        | `ConnectionId`                      | Identifies this client socket.                                           |
| `targets`                             | `ReadonlyMap<SessionId, CDPTarget>` | Live view; mutates as targets come and go.                               |
| `signal`                              | `AbortSignal`                       | Aborts at teardown.                                                      |
| `send(method, params?, sessionId?)`   | `Promise<Result>`                   | Typed CDP command; the reply is yours alone.                             |
| `emit(method, params, sessionId?)`    | `void`                              | Typed synthetic event, injected into the client's stream in order.       |
| `inject(source, sessionId, options?)` | `Promise<() => Promise<void>>`      | Run code at the start of every document.                                 |
| `state(sessionId, init)`              | `T`                                 | Per-target scratch space, dropped on detach.                             |
| `log(...args)`                        | `void`                              | Writes through the configured log level, tagged with plugin and session. |

**`send`** takes the CDP session id last and omits it for browser-level
commands. The response resolves to your plugin and is never forwarded to the
client. A command that gets no reply rejects after 30 seconds naming your
plugin, the method, and the CDP session; one still in flight when the session
ends is reported as a warning, because that is almost always the cause of a
hang. Awaiting it inside a hook is safe and does not deadlock — replies to
plugin commands bypass the message queue entirely.

**`emit`** is fire-and-forget, synchronous, and ordered relative to surrounding
traffic. It is how core `contexts` hands Playwright the
`Runtime.executionContextCreated` events that a suppressed `Runtime.enable`
never produced.

**`state`** is created on first use and dropped when that target detaches, after
your `onTargetDetached` has run. Each plugin sees its own:

```ts
const forTarget = (sessionId: SessionId) =>
  ctx.state(sessionId, () => ({ ready: false, frames: new Map() }))
```

Prefer it to a `Map` keyed by session id in your closure. Plugins outlive the
pages they configure, so a hand-rolled map has to be pruned on detach, and
forgetting is a leak that only shows up on long-lived connections driving many
pages.

### Error isolation

A hook that throws is logged with the plugin, hook, and method, and the message
continues as though that plugin had passed. One bad plugin can never break the
connection. A throwing hook is **not** the same as returning nothing, though:
the runtime distinguishes them internally, so a thrown `onRequest` does not
accidentally read as a refusal.

## `surface` — what the page sees

A surface owns exactly one browser-visible API and says what it should report.
What it does _not_ choose is how the value gets there, and that ordering is the
whole reason the kind exists:

> A launch flag beats an `Emulation.*` override, which beats a page patch.

Each rung down is more visible to the page, so give the runtime an `emulate`
hook wherever CDP can do the job and keep `page` for what CDP cannot express.

```ts
interface SurfaceHooks<Config = undefined> {
  /** Runs in the main world of every realm, before any page script. */
  page?: (config: Config) => void
  /** Everything `page` needs, as JSON. */
  config?: Config
  /** Defaults to every realm. */
  realms?: Realm[]
  /** Native CDP overrides. Preferred over `page` wherever CDP can do the job. */
  emulate?(realm: RealmContext): MaybePromise<void>
  /** Merged across surfaces by the runtime, which owns the header set. */
  headers?: Record<string, string>
  /** The monitor and the window around the viewport, declared rather than sent. */
  display?: Display
}

type Realm = 'page' | 'iframe' | 'worker' | 'service_worker'

interface RealmContext {
  readonly realm: Realm
  readonly sessionId: SessionId
  readonly frameId?: string
  send: Send
}

interface Display {
  screen?: { width: number; height: number; scale: number }
  /** Tab strip plus toolbar: the gap between `outerHeight` and `innerHeight`. */
  chrome?: number
}
```

```ts
export const webgl: PluginFactory<WebglOptions> = definePlugin<
  WebglOptions,
  Config
>({
  kind: 'surface',
  name: 'webgl',
  setup(options, ctx) {
    const { gpu } = ctx.profile
    if (!gpu) return {}

    return {
      realms: ['page', 'iframe', 'worker'],
      config: { vendor: gpu.vendor, renderer: gpu.renderer },
      page(config) {
        const proto = WebGLRenderingContext.prototype
        const getParameter = proto.getParameter
        proto.getParameter = native(function (name) {
          if (name === 0x9245) return config.vendor
          if (name === 0x9246) return config.renderer
          return getParameter.call(this, name)
        }, 'getParameter')
      },
      headers: { 'Accept-Language': ctx.profile.languages.join(',') },
    }
  },
})
```

### The serialization rule

> DANGER: a `page` function is serialized with `Function.prototype.toString()`,
> so **it closes over nothing**. Imports, `cfg`, `ctx`, and any outer variable
> are `undefined` in the page, with no error, because the reference simply does
> not resolve there. Everything comes in through the single `config` argument,
> which must be JSON-serializable.

This is a silent failure — the patch does half its job and the surface reports
success — so `deno lint` rejects free identifiers in a `page` function. Nothing
else will catch it.

Three helpers are prepended to the bundle and are available without an import:

| Helper                    | Why you want it                                                                                                                                                                                                |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `native(fn, name)`        | Makes a patched function's `name` and `toString()` match the built-in it replaced. Without it, one `Function.prototype.toString` call finds every patch at once.                                               |
| `define(obj, key, value)` | Installs a value with the descriptor the original had, on the object that actually declares it. Patching `navigator.userAgent` directly leaves an own property where the real one is on `Navigator.prototype`. |
| `noise(key)`              | The page-side `profile.noise`: the same jitter, from the same seed.                                                                                                                                            |

That set is the answer to "surfaces need to share code": shared page-side logic
grows the helper set under review rather than arriving through an import that
would not survive serialization.

### Realms

`realms` is a claim you should test. A surface that only reaches `window` is
bypassed by `new Worker()` or a same-origin iframe, and both bypasses are one
line of page JavaScript:

```ts
const seen = await it.eachRealm(() => navigator.hardwareConcurrency)
assertEquals(seen, { page: 8, iframe: 8, worker: 8, service_worker: 8 })
```

Delivery uses two mechanisms, because Chrome gives workers no third option:
documents get `Page.addScriptToEvaluateOnNewDocument`, which already covers the
whole frame tree, and workers get `Runtime.evaluate` during the pause that
`waitForDebuggerOnStart` creates. A worker that was already running when the
session attached cannot be reached before its own code runs, and the runtime
reports that rather than pretending otherwise.

Decline the realms your API does not exist in — `navigator.mediaDevices` is a
window API, and delivering a patch for it to a worker runs code against globals
that are not there.

### `display`

`Emulation.setDeviceMetricsOverride` is whole-state and the client is also a
caller: Playwright sends its own the moment a viewport is set, and it pins the
screen to that viewport, which no real monitor does. An `emulate` hook cannot
win that race — whatever it sends is replaced moments later. So a surface
_declares_ the monitor and the window around it, and the
[broker](#brokered-domains) folds the claim into the client's own call:

```ts
return {
  display: {
    screen: { ...ctx.profile.screen },
    chrome: ctx.profile.chromeHeight,
  },
}
```

## `actor` — behaviour on a page

The imperative kind: watch a page, decide, act. Captchas, cookie banners, login
flows.

```ts
interface ActorDefinition<O> extends Definition<O> {
  kind: 'actor'
  /** URL globs; the actor is instantiated only on pages that match. */
  urls?: string[]
  /** `session` instantiates once per connection instead of once per page. */
  scope?: 'page' | 'session'
  setup(cfg: O, page: PageContext): MaybePromise<void>
}

interface PageContext extends Context {
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
  /** Escape hatch: typed CDP, bound to this target. */
  send: PluginContext['send']
  /** Escape hatch: observe a typed CDP event on this page's session. */
  cdp<M extends keyof Events>(
    method: M,
    fn: (
      params: Events[M] extends [infer P] ? P : Record<string, never>,
    ) => void,
  ): () => void
}
```

```ts
export const banner: PluginFactory<BannerOptions> = definePlugin<BannerOptions>(
  {
    kind: 'actor',
    name: 'banner',
    urls: ['http://*', 'https://*'],
    setup(cfg, page) {
      page.on('document', async () => {
        for (const selector of cfg.accept) {
          if (!await page.wait(selector, cfg.timeout)) continue
          await page.click(selector)
          return
        }
      })
    },
  },
)
```

Three runtime properties make it a kind rather than a helper library, and all
three are things a library could not provide:

**Its lifetime is one page.** `setup` runs per page target and its closure is
that page's state, dropped on detach. No `ctx.state`, no map keyed by session
id, no pruning. `scope: 'session'` opts out for an actor that has to coordinate
across pages, like a login the others wait on.

**It is off the message queue.** Callbacks are scheduled on their own task per
page, so an actor can await a solver over HTTP for ten seconds while the page's
CDP traffic keeps flowing. This is the opposite of a `protocol` hook.

**It gets a page handle.** `page.click('#submit')` rather than three
`Input.dispatchMouseEvent` calls with coordinates you computed. `click` and
`fill` go through the `Input` domain, so the page sees `isTrusted: true` — a JS
`element.click()` does not, and that is a well-known tell.

`PageContext` is not a second Playwright and will not grow into one.

### The escape hatch, and its six limits

Keeping the handle small is only defensible if there is a way out of it:

```ts
await page.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath })

const off = page.cdp('Page.javascriptDialogOpening', ({ message }) => {
  page.log(`dialog: ${message}`)
  void page.send('Page.handleJavaScriptDialog', { accept: true })
})
```

`send` is `ctx.send` with the session id filled in. `cdp` is the listening half:
without it an actor could talk but not listen, which is the gap that would push
you back down to `protocol` for one command.

> DANGER: the hatch is **observe-only, unarbitrated, and invisible to the
> platform's reporting.** Every one of these is a bug that looks like a platform
> failure when you hit it:
>
> 1. **`cdp` cannot change anything.** It is a copy of the event, delivered
>    after the pipeline has decided. Needing to suppress or rewrite a message is
>    the signal that you are writing the wrong kind.
> 2. **Handlers run late.** They are scheduled off the message queue, so the
>    page may have navigated by the time yours runs. Re-check before acting.
> 3. **Enabling a domain is not free.** It changes what the session looks like
>    from the browser's side. `Runtime.enable` is refused outright — it is the
>    exact tell core `contexts` exists to suppress, and one actor calling it
>    would undo every surface in the session. Other `*.enable` calls are allowed
>    and logged.
> 4. **Brokered domains are refused,** and the error names the alternative.
> 5. **You may not disable what you did not enable.** The plugin that _was_
>    using the domain has no way to find out it stopped working.
> 6. **Nothing here is covered or arbitrated.** Coverage and the conflict report
>    work by reading declarations, and a raw command declares nothing.

Reaching the hatch three times in one plugin is a strong hint the work belongs
in `protocol` after all.

## Presets

A preset is a named list of configured plugins. It is how `stealth()` survives
being fourteen surfaces, and how a caller drops one of them without rebuilding
the list:

```ts
import { definePreset } from './src/mod.ts'

export const mine: PresetFactory<MineOptions> = definePreset<MineOptions>({
  name: 'mine',
  defaults: { webdriver: false },
  plugins: (cfg) => [navigator({ webdriver: cfg.webdriver }), webgl(), fonts()],
})
```

```ts
await chromium.launch({ plugins: [mine({ without: ['fonts'] })] })
```

`without` is free — every preset gets it, filtered by plugin name. A preset is
deliberately not a sixth kind: it expands to plugins, so giving it a `kind`
would put a value in the `Kind` union that the runtime never installs.

## The core tier

Three plugins are installed for every session that is not `plugins: 'none'`.
They are pinned to one end of their kind's order and no `priority` can displace
them:

| Core       | Kind       | Pinned | What it does                                                                                                           |
| ---------- | ---------- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `contexts` | `protocol` | first  | Answers `Runtime.enable` itself and supplies the execution contexts the client would have learned.                     |
| `generate` | `profile`  | last   | Synthesizes a coherent machine from population-weighted tables, so there is always a draw.                             |
| `flags`    | `launch`   | first  | Turns profile fields the command line owns into flags: `--lang`, `--window-size`, and the reconciliation that follows. |

They are not policy, which is why they are not in `stealth()`: `plugins: []` is
a session that presents the real machine honestly and is still not announced on
the wire.

## Brokered domains

Four CDP commands are whole-state rather than additive — calling one replaces
whatever the last caller set, with no error and no sign anything was lost:

| Command                              | What the second caller destroys            |
| ------------------------------------ | ------------------------------------------ |
| `Fetch.enable`                       | The first caller's `patterns` array.       |
| `Network.setExtraHTTPHeaders`        | The first caller's entire header map.      |
| `Target.setAutoAttach`               | The first caller's settings, browser-wide. |
| `Emulation.setDeviceMetricsOverride` | The first caller's metrics struct.         |

`Browser.setWindowBounds` and `Emulation.clearDeviceMetricsOverride` join them
as the other half of the display claim: the window's height and the monitor
behind it are one story, and a client clearing its viewport must not take the
monitor down with it.

Nobody calls these directly. Everyone declares — `headers` and `display` from a
surface, `realms` for auto-attach — the broker unions the declarations, makes
one call, and dispatches what comes back to whoever matched. Overlaps are
resolved by priority and named in the trace at session start, so two plugins
fighting is a line of output rather than a mystery.

The client is a participant rather than an exception. Playwright sets extra
headers, enables `Fetch` for `page.route()`, and sets auto-attach on every page,
all without knowing the platform exists; each of those is intercepted, folded
into the union, and answered as though it had been forwarded. That is why
`page.route()` and a surface's `Accept-Language` can both be in effect when
neither knows about the other.

An `actor`'s escape hatch refuses these by name and points at the declarative
route. A `protocol` plugin that sends one is folded into the merge like any
other caller.

## Custom RPC

Any method under `Proxy.` is answered by the proxy or by a plugin and never
reaches Chrome. **Declare it**, rather than string-matching in `onRequest`:

```ts
setup(cfg, ctx) {
  const entries: Entry[] = []
  return {
    onEvent(evt) { /* ... collect ... */ return evt },
    rpc: {
      'Proxy.history': (params) => ({ entries: entries.slice(-Number(params.limit ?? 50)) }),
    },
  }
}
```

Four things follow from declaring it, and all four are why the older
string-matching route is now the second choice:

- Two plugins claiming one method is an **error at session start**, naming both,
  rather than whichever installed first quietly winning.
- It **bypasses `match`**. A plugin narrowed to `Network.*` still answers its
  own RPC, which is exactly the trap that made the old route fragile.
- It appears in **`Proxy.hello`**, so the methods a session answers are
  discoverable rather than folklore in a README.
- A throw is answered as a CDP error naming your plugin, not a hang.

From the client, reach it through Playwright's raw-CDP escape hatch. `rpc()`
adds types for the reserved namespace, which Playwright's own `send` does not
know:

```ts
import { rpc } from './src/mod.ts'

const proxy = rpc(await browser.newBrowserCDPSession())
const { entries } = await proxy.send<{ entries: Entry[] }>('Proxy.history')
const { rpc: answered } = await proxy.hello() // every method this session has
```

The runtime declares four of its own, which a plugin cannot take over:

| Method          | Answers                                                                  |
| --------------- | ------------------------------------------------------------------------ |
| `Proxy.hello`   | `{ connectionId, sessionToken, plugins, upstream, rpc }`                 |
| `Proxy.debug`   | The trace as data: pipeline, hook counts, surfaces, actors, launch spec. |
| `Proxy.profile` | `{ profile, coverage }` — the sealed identity and who read what.         |
| `Proxy.burn`    | Retire this identity so no loader hands it out again.                    |

`Proxy.burn` is the automator's call rather than the runtime's, because only the
code driving the page can recognize a block when it sees one. It answers with
the loaders that did something about it.

A `Proxy.*` method nobody answers gets `-32601` back, listing the ones that
exist. `{ respond }` in `onRequest` still works and is still the right tool for
intercepting a _real_ CDP method.

## Running code in the page

A `surface` is the declarative route and should be your first choice. From a
`protocol` plugin, `ctx.inject(source, sessionId, options?)` runs `source` at
the start of every document in a target, subframes included, and returns a
function that stops future documents from getting it. Documents that already ran
it keep whatever it did.

```ts
return {
  async onTargetAttached({ sessionId, type }) {
    if (type !== 'page') return
    await ctx.inject(`self.helper = () => 42`, sessionId, { world: 'my_world' })
  },
}
```

| Option        | Effect                                                               |
| ------------- | -------------------------------------------------------------------- |
| `world`       | Run in a named isolated world instead of the page's own.             |
| `immediately` | Also run once in the document already loaded, not just the next one. |

**Use a `world` unless you specifically need to touch the page's own globals.**
The page can neither see nor reach anything the script defines in a named world,
which makes it the only way to run plugin code on a page without leaving
something behind for a detector to find. It works with the Runtime domain
disabled, on every navigation.

To read a value back, evaluate in the same world —
`Page.createIsolatedWorld({ frameId, worldName })` returns its execution context
id, and `Runtime.evaluate` accepts a `contextId`.

**There is deliberately no `ctx.bind`.** The obvious companion to `inject` would
be a `Runtime.addBinding` channel for calling back _out_ of injected code.
Measured against Chrome 147 with the runtime disabled, it cannot be made to
work: a binding installs only into contexts that already exist, is gone after
the next navigation, and scoping it to an isolated world never fires at all
until `Runtime.enable` is sent. So the channel is either quietly broken or it
announces the session. Worse, `Runtime.removeBinding` does not take the
installed function back off `window` — only an explicit `delete` does — so a
binding leaves a page-visible global behind for the life of the document.
`docs/stealth.md` has the measurements, and `scratch/probe-binding.ts`
reproduces them.

## Debugging

Trace what your plugin does with each message, per session:

```ts
const browser = await chromium.launch({
  plugins: [myPlugin()],
  debug: 'myplugin',
})
```

```sh
CDP_DEBUG=1                  # everything
CDP_DEBUG=myplugin           # just your plugin's decisions
CDP_DEBUG=myplugin:Runtime.* # ...narrowed to the methods you care about
CDP_DEBUG=proxy              # just the transport: forwards, drops, id remapping
```

The filter is `source[:methodGlob]`, where source is a plugin name or `proxy`
for the transport. A `debug` passed to `launch` applies to that session alone;
`CDP_DEBUG` supplies the default for sessions that do not ask.

```
trace: [0c349e67] pipeline: contexts(core) → myplugin(0)
trace: [0c349e67]   contexts hooks=onRequest,onResponse,onEvent,onDocument match=*
trace: [0c349e67]   myplugin hooks=onRequest match=Runtime.*
trace: [0c349e67] profile 8f2c source=generate Windows / Chrome 147 / en-US
trace: [0c349e67] → Runtime.enable #8 @38080A
trace: [0c349e67]   contexts onRequest respond Runtime.enable
trace: [0c349e67] ↩ Runtime.enable #8 answered without the browser
trace: [0c349e67] ⇢ myplugin send Page.enable #9
trace: [0c349e67] ⇠ myplugin Page.enable #9 ok 2.1ms
trace: [0c349e67] summary
trace: [0c349e67]   contexts onRequest=42/3.1ms onEvent=310/8.9ms onDocument=1/0.3ms
trace: [0c349e67]   myplugin no hooks ran
```

The resolved pipeline is reported up front — order, priority, the hooks you
actually implement, and the globs you declared. That is the first thing to check
when plugins fight over a message or a hook never fires. Decisions are reported
as `pass`, `change`, `drop`, `respond`, or `error`.

Three things are warned about even with tracing off, because each is otherwise
silent and each is nearly always a bug: a `match` glob that never matched, an
`actor` whose `urls` never matched a page, and a `ctx.send` still in flight when
the session ended.

The coverage report is the fourth thing to read. It is printed with the trace
and is always available from `Proxy.profile()`, whether or not tracing is on.

## Testing

`harness()` is the platform's test API, exported from `src/mod.ts` alongside
everything else. It drives a real browser through the real proxy and hands back
a page, the sealed profile, the coverage report, the launch spec, and the trace;
`await using` tears it all down.

```ts
import { assertEquals } from '@std/assert'
import { harness, pin, webgl } from '../src/mod.ts'

Deno.test('webgl reports the profile GPU', async () => {
  await using it = await harness({
    plugins: [pin({ id: 'fixture-1' }), webgl()],
  })

  assertEquals(
    await it.page.eval(() => {
      const gl = document.createElement('canvas').getContext('webgl')!
      return gl.getParameter(0x9245)
    }),
    it.profile.gpu!.vendor,
  )
  assertEquals(it.coverage.uncovered, [])
})
```

| Member             | What it is for                                                                  |
| ------------------ | ------------------------------------------------------------------------------- |
| `it.page`          | A `PageContext` on a real page: `eval`, `has`, `wait`, `click`, `fill`, `goto`. |
| `it.profile`       | The sealed identity, as the session actually resolved it.                       |
| `it.coverage`      | Who read what, and which fields nothing claimed.                                |
| `it.launch`        | The merged flags, env, data dir, and conflicts the process starts from.         |
| `it.eachRealm(fn)` | One expression in the page, an iframe, a worker, and a service worker.          |
| `it.origin()`      | Move the page onto a real loopback origin, and return it.                       |
| `it.trace`         | Every trace line this session produced.                                         |
| `it.wire`          | Fake mode only: every message each side saw.                                    |

Core is installed, as it is everywhere else, so a plugin is tested in the
configuration it will actually run in. `harness({ plugins: 'none' })` drops it
for the rare test that needs the unmodified wire, and `harness({ fake: true })`
swaps the browser for a scripted CDP stream when all you need is what went out.

**Use `it.origin()` before probing a secure-context API.** `about:blank` is not
an origin, and `navigator.mediaDevices`, `getBattery`, blob workers, and service
workers are all absent or refused without one — so a surface tested on the blank
page reports as standing down when it works.

**`it.eachRealm` is how a surface proves its `realms`.** The expression is
serialized the same way a `page` function is, so it closes over nothing.

**`it.launch` works in fake mode too.** A `launch` plugin decides everything it
decides before a process exists, so the merge runs without one — which makes it
the one kind that needs no browser to test. What fake mode cannot show is
`onStart`, since nothing started.

`Proxy.debug` returns the same picture the traces paint, as data, so you can
assert your hooks actually ran instead of scraping logs:

```ts
const { plugins, actors } = await rpc(await browser.newBrowserCDPSession())
  .debug()
assert(plugins.find((p) => p.name === 'myplugin')!.calls.onRequest > 0)
// Actors report a state rather than a count: `idle` means no page matched your
// `urls`, and `failed` carries the reason `setup` threw.
assertEquals(actors.find((a) => a.name === 'mybanner')?.state, 'watching')
```

For hook logic in isolation, drive the `Pipeline` directly with a stub context —
`test/plugin.test.ts` has the pattern.

When you assert that something is _absent_ — no injected global, no forwarded
command — check the assertion can still fail, by temporarily breaking the thing
it guards. An absence assertion that has quietly become vacuous looks identical
to a passing one.

## Distributing a plugin

In-process, just import and pass it to `plugins: [...]`.

For a standalone proxy, drop the file in the directory named by
`CDP_PLUGINS_DIRECTORY` (`plugins` by default) and the server loads it at
startup:

- `*.ts` and `*.js` files, at any depth, loaded in alphabetical order.
- Files containing `.disabled.` are skipped, which is how you park one without
  deleting it.
- The factory must be the **default export**, or a named export matching the
  filename (`block.ts` → `export const block`). A preset works here too.

Clients then ask for it by name over the control endpoint:

```sh
curl -X POST localhost:9994/proxy/register \
  -H 'content-type: application/json' \
  -d '{"plugins":[{"name":"block","options":{"patterns":["*.mp4"]}}]}'
# → { "token": "…" }
```

An unknown name is a `400`, so a typo fails at registration rather than silently
running without your plugin.

## Gotchas

**A `page` function closes over nothing.** The single most common way to write a
surface that reports success and does half its job. Everything comes in through
`config`; `deno lint` is what catches it.

**An absent profile field is a stand-down, not a default.** Filling in a
plausible GPU for a profile that claims none produces a machine no loader drew.
Return `{}` and let the browser's own value through.

**Never patch the profile.** It is frozen and writing to it throws. A variant is
a tighter `Constraint`, not a field assignment.

**Module-level state is shared across every session in the process.** Closure
state inside `setup` is per-session; anything declared outside it is not. This
is the single easiest way to leak one site's data into another's session.

```ts
const shared = new Set() // WRONG: every session in the process writes to this
export const p = definePlugin({
  name: 'p',
  setup() {
    const mine = new Set() // right: one per session
    return {/* ... */}
  },
})
```

**Check `target.type` before touching a target.** `onTargetAttached` fires for
workers and service workers as well as pages. A worker has no `Page` domain, so
`Page.enable`, `ctx.inject`, and anything frame-related will reject against one.
Suppressing `Runtime.enable` on a worker would strand Playwright without
contexts, which is why core `contexts` guards on `page`/`iframe`.

**Never rewrite `id` or `sessionId` on a message.** The runtime remaps ids
between the client and browser id-spaces around your hook; changing `id`
yourself corrupts that mapping and the client gets a reply it cannot match.
Changing `sessionId` misroutes the message. Rewrite `method` and `params`
freely.

**Returning `null` from `onResponse` leaves the client hanging.** Unlike
`onRequest`, there is no synthesized answer — the reply is simply dropped, and
the client waits on that command id until its own timeout. If you want to hide a
result, return a modified response with a benign `result` instead.

**`match` filters on the original method, not your rewritten one.** If a
high-priority plugin rewrites `msg.method`, lower-priority plugins are still
selected by what the client originally sent. The message they receive carries
the new method; only the filtering decision uses the old one.

**A hook blocks its own target's message stream.** Messages are queued per CDP
session, so a slow hook delays that page and not the others — but it does delay
that page. Kick off long work without awaiting it. Awaiting `ctx.send` is fine;
awaiting something that depends on _another event arriving through the pipeline
for the same target_ deadlocks.

**`onTargetAttached` blocks more than one target.** Page attaches arrive at
browser level, so they are handled on the connection's root queue and an `await`
there delays every target's first message. The ordering is deliberate — it is
what guarantees `ctx.targets` is populated before a target's own traffic arrives
— but keep the work small.

**A slow `setup` delays the whole connection.** No client message is forwarded
until every plugin has installed. Do discovery work in `onSessionStart` or
`onTargetAttached` rather than in `setup` where you can.

**`ctx.targets` is not refreshed after attach.** Entries carry `sessionId`,
`targetId`, `type`, and `browserContextId` as of attach time. A target that
navigates does not update; use `onDocument` for URL changes.

**Every in-flight `ctx.send` rejects at teardown, by design.** Check
`ctx.signal.aborted` before reporting a failure, or a normal session close fills
the logs with errors:

```ts
doWork().catch((e) => {
  if (!ctx.signal.aborted) ctx.log('failed', e)
})
```

**You only ever see your own session's targets.** Chrome's auto-attach is
browser-wide, so a shared browser announces every client's pages to every
client. The runtime filters foreign targets out before the pipeline. Contexts
your plugin creates with `Target.createBrowserContext` are claimed for your
connection automatically, so their targets are yours and nobody else's.

**Enabling a domain is per-CDP-session.** The client having enabled `Page` on a
target does not mean _your_ commands see it enabled. `ctx.inject` sends
`Page.enable` itself because `Page.addScriptToEvaluateOnNewDocument` otherwise
succeeds, returns an identifier, and then silently never runs.

**Mutating a message in place works, but reads as `pass` in traces.** The trace
compares object identity to decide between `pass` and `change`. Mutate and
return the same object if you like — just do not read `pass` as "nothing
happened".

## Checklist

Before shipping a plugin:

- [ ] It is the right kind — a page API is a `surface`, slow work is an `actor`.
- [ ] Values come from `ctx.profile`, not from constants you picked.
- [ ] An absent optional field stands the plugin down instead of defaulting it.
- [ ] State that must not cross sessions is inside `setup`, not module scope.
- [ ] Per-target state uses `ctx.state`, or is pruned in `onTargetDetached`.
- [ ] `target.type` is checked before page-only commands.
- [ ] `match` globs are spelled right — run once and check for the never-matched
      warning.
- [ ] `optional` is set if the plugin only observes.
- [ ] Long work is not awaited inside a message hook.
- [ ] Failures check `ctx.signal.aborted` before logging.
- [ ] Injected page code uses a named `world` unless it must touch page globals.
- [ ] A `page` function reads nothing but its `config` — `deno lint` checks.
- [ ] `realms` is asserted with `it.eachRealm`, not just declared.
- [ ] A brokered domain is reached through a declaration, not a direct call.
- [ ] There is a test that fails when the plugin is removed.
