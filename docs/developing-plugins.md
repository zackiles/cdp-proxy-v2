# Developing plugins

A plugin is a typed factory that intercepts a session's CDP traffic. It can
read, rewrite, answer, or suppress any message travelling between the client and
Chrome, run its own commands the client never sees, inject synthetic events, and
run code inside the page.

Everything the bundled `stealth` plugin does — suppressing `Runtime.enable`,
synthesizing execution contexts, rewriting the User-Agent and window geometry —
it does through this API, with no special access. If you can express it in CDP,
you can express it as a plugin.

- [Mental model](#mental-model)
- [Quick start](#quick-start)
- [`definePlugin` reference](#defineplugin-reference)
- [Configuration and options](#configuration-and-options)
- [Hooks](#hooks)
- [The context object](#the-context-object)
- [Custom RPC: talking to your plugin from client code](#custom-rpc-talking-to-your-plugin-from-client-code)
- [Running code in the page](#running-code-in-the-page)
- [Debugging](#debugging)
- [Testing](#testing)
- [Distributing a plugin](#distributing-a-plugin)
- [Gotchas](#gotchas)
- [Checklist](#checklist)

## Mental model

One client connection is one **session**. When a session opens, the runtime
calls your `setup` once and keeps the hooks it returns for the life of that
connection.

```
client (Playwright) ──▶ onRequest  ──▶ Chrome
client               ◀── onResponse ◀── Chrome
client               ◀── onEvent    ◀── Chrome
```

Three consequences worth internalising up front:

- **State lives in the `setup` closure.** Each session gets a fresh call, so two
  concurrent sessions cannot see each other's state. Module-level state is _not_
  isolated — see [Gotchas](#gotchas).
- **You are in the message path.** Hooks run before the message continues, so a
  slow hook is latency for the client and a hook that never resolves is a hang.
- **Your own traffic is invisible to the client.** `ctx.send` commands travel on
  the same socket but are resolved to you and never forwarded, on an id space
  that cannot collide with the client's.

## Quick start

```ts
import { definePlugin } from './src/mod.ts'
import type { PluginFactory } from './src/mod.ts'

export interface BlockOptions {
  patterns: string[]
  /** definePlugin requires an index signature; see Configuration. */
  [key: string]: unknown
}

export const block: PluginFactory<BlockOptions> = definePlugin<BlockOptions>({
  name: 'block',
  defaults: { patterns: ['*.png', '*.jpg', '*.woff2'] },
  setup(cfg, ctx) {
    return {
      async onTargetAttached({ sessionId, type }) {
        if (type !== 'page') return
        await ctx.send('Network.enable', undefined, sessionId)
        await ctx.send('Network.setBlockedURLs', {
          urls: cfg.patterns,
        }, sessionId)
        ctx.log(`blocking ${cfg.patterns.length} patterns`)
      },
    }
  },
})

export default block
```

```ts
const browser = await chromium.launch({
  plugins: [stealth(), block({ patterns: ['*.mp4'] })],
})
```

`definePlugin` returns a **factory**. Calling it resolves the options and
produces a `ConfiguredPlugin`; the runtime calls `setup` later, once per
session.

## `definePlugin` reference

```ts
definePlugin<Options extends Record<string, unknown>>({
  name, defaults, match, priority, optional, setup,
}): PluginFactory<Options>
```

| Field      | Type                                                | Default  | Meaning                                                                                                                     |
| ---------- | --------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------- |
| `name`     | `string`                                            | required | Identifies the plugin in traces, logs, errors, and `Proxy.hello`. Also the name it is registered under for by-name loading. |
| `defaults` | `Options`                                           | `{}`     | Merged under per-call options. Shallow.                                                                                     |
| `match`    | `string[]`                                          | all      | CDP-method globs narrowing which messages reach your message hooks.                                                         |
| `priority` | `number`                                            | `0`      | Higher runs **earlier**. Ties keep array order.                                                                             |
| `optional` | `boolean`                                           | `false`  | If `setup` throws, skip this plugin instead of failing the session.                                                         |
| `setup`    | `(cfg, ctx) => PluginHooks \| Promise<PluginHooks>` | required | Called once per session; returns the hooks.                                                                                 |

The factory also carries `factory.pluginName`, which is how autoloading
discovers it.

### `match`

Globs are anchored and only `*` is special, so `Runtime.*` matches
`Runtime.evaluate` but not `Runtimex.evaluate`, and `Page.frameNavigated`
matches exactly one method.

```ts
match: ;
;['Network.*', 'Fetch.requestPaused']
```

`match` filters `onRequest`, `onEvent`, and `onResponse`. It does **not** filter
lifecycle hooks — `onDocument` and the rest always run. Narrowing is worth
doing: an event-heavy session pushes tens of thousands of messages through the
pipeline, and a plugin that only cares about `Fetch.*` should not be invoked for
all of them.

A `match` that never matches anything is reported at session end even with
tracing off, because a typo like `Runtim.*` otherwise looks exactly like a
working plugin.

### `priority`

All plugins run for every message, in priority order, with each one handed what
the previous one returned. `stealth` sits at `100` so it decides about
`Runtime.enable` before anything else sees it. Use priority when two plugins
touch the same method and the order matters; leave it at `0` otherwise.

Priority orders lifecycle hooks too, not just message hooks.

### `optional`

If `setup` throws, the connection fails and the client is disconnected with your
plugin named. That is deliberate: a plugin that never installed means the
session is running while believing it is configured in a way it is not, and for
`stealth` that means quietly handing back a plain, detectable browser.

Set `optional: true` when your plugin's absence costs visibility rather than
correctness. `recorder` is optional; `stealth` is not.

`Proxy.hello` reports the plugins that actually installed, never the ones that
were requested.

## Configuration and options

Options are resolved when the **factory** is called, by shallow-merging over
`defaults`:

```ts
const configured = block({ patterns: ['*.mp4'] })
// configured.options === { patterns: ['*.mp4'] }
```

Three things follow from "shallow":

- A nested object in options **replaces** the default wholesale rather than
  merging field by field. `stealth`'s `screen` option works this way, and says
  so.
- Passing `undefined` for a key does not fall back to the default — it overrides
  it with `undefined`. Omit the key instead.
- `cfg` inside `setup` is the merged object, typed as `Options`. Optional fields
  that `defaults` fills are still typed optional, which is why the bundled
  plugins use `cfg.screen!`.

### The index signature

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

### Typing

`ctx.send` and `ctx.emit` are generic over `devtools-protocol`, so methods,
params, and return types all autocomplete and typecheck:

```ts
const { root } = await ctx.send('DOM.getDocument', { depth: 1 }, sessionId)
//      ^? Protocol.DOM.Node
```

## Hooks

`setup` returns an object with any subset of these. Every hook may be `async`.

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

### Error isolation

A hook that throws is logged with the plugin, hook, and method, and the message
continues as though that plugin had passed. One bad plugin can never break the
connection. A throwing hook is **not** the same as returning nothing, though:
the runtime distinguishes them internally, so a thrown `onRequest` does not
accidentally read as a refusal.

## The context object

The same `ctx` is handed to `setup` and to every hook. It is scoped to your
plugin by name, so traces, logs, and errors are attributed to you.

| Member                                | Type                                | Notes                                                                    |
| ------------------------------------- | ----------------------------------- | ------------------------------------------------------------------------ |
| `sessionToken`                        | `string`                            | Identifies the session.                                                  |
| `connectionId`                        | `string`                            | Identifies this client socket.                                           |
| `targets`                             | `ReadonlyMap<SessionId, CDPTarget>` | Live view; mutates as targets come and go.                               |
| `signal`                              | `AbortSignal`                       | Aborts at teardown.                                                      |
| `send(method, params?, sessionId?)`   | `Promise<Result>`                   | Typed CDP command; the reply is yours alone.                             |
| `emit(method, params, sessionId?)`    | `void`                              | Typed synthetic event, injected into the client's stream in order.       |
| `inject(source, sessionId, options?)` | `Promise<() => Promise<void>>`      | Run code at the start of every document.                                 |
| `state(sessionId, init)`              | `T`                                 | Per-target scratch space, dropped on detach.                             |
| `log(...args)`                        | `void`                              | Writes through the configured log level, tagged with plugin and session. |

### `send`

```ts
const { result } = await ctx.send('Runtime.evaluate', {
  expression: '1 + 1',
}, sessionId)
```

Omit `sessionId` for browser-level commands. The response resolves to your
plugin and is never forwarded to the client. A command that gets no reply
rejects after 30 seconds naming your plugin, the method, and the CDP session. A
command still in flight when the session ends is reported as a warning, because
that is almost always the cause of a hang.

Awaiting `ctx.send` inside a hook is safe and does not deadlock: replies to
plugin commands bypass the message queue entirely.

### `emit`

Fire-and-forget, synchronous, ordered relative to surrounding traffic. This is
how `stealth` hands Playwright the `Runtime.executionContextCreated` events that
a suppressed `Runtime.enable` never produced.

### `state`

```ts
const forTarget = (sessionId: SessionId) =>
  ctx.state(sessionId, () => ({ ready: false, frames: new Map() }))
```

Created on first use and dropped when that target detaches, after your
`onTargetDetached` has run. Each plugin sees its own.

Prefer it to a `Map` keyed by session id in your closure. Plugins outlive the
pages they configure, so a hand-rolled map has to be pruned on detach, and
forgetting is a leak that only shows up on long-lived connections driving many
pages. `stealth` uses it for exactly this.

### `inject`

See [Running code in the page](#running-code-in-the-page).

## Custom RPC: talking to your plugin from client code

Any method under `Proxy.` is answered by the proxy or by a plugin and never
reaches Chrome. Answer one from `onRequest`:

```ts
onRequest(msg) {
  if (msg.method === 'Proxy.history') {
    return { respond: { entries: [...entries] } }
  }
  return msg
}
```

From the client, reach it through Playwright's raw-CDP escape hatch. `rpc()`
adds types for the reserved namespace, which Playwright's own `send` does not
know:

```ts
import { rpc } from './src/mod.ts'

const proxy = rpc(await browser.newBrowserCDPSession())
const { entries } = await proxy.send<{ entries: Entry[] }>('Proxy.history')
```

A `Proxy.*` method no plugin answers gets `-32601` back. If your plugin declares
`match`, remember it applies here too — `match: ['Network.*']` means your
`onRequest` never sees `Proxy.history`.

## Running code in the page

`ctx.inject(source, sessionId, options?)` runs `source` at the start of every
document in a target, subframes included, and returns a function that stops
future documents from getting it. Documents that already ran it keep whatever it
did.

```ts
onTargetAttached: ;
;(async ({ sessionId, type }) => {
  if (type !== 'page') return
  await ctx.inject(
    `self.helper = () => 42`,
    sessionId,
    { world: 'my_world' },
  )
})
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
trace: [0c349e67] pipeline: stealth(100) → myplugin(0)
trace: [0c349e67]   stealth hooks=onRequest,onResponse,onEvent,onDocument match=*
trace: [0c349e67]   myplugin hooks=onRequest match=Runtime.*
trace: [0c349e67] → Runtime.enable #8 @38080A
trace: [0c349e67]   stealth onRequest respond Runtime.enable
trace: [0c349e67] ↩ Runtime.enable #8 answered without the browser
trace: [0c349e67] ⇢ stealth send Page.enable #9
trace: [0c349e67] ⇠ stealth Page.enable #9 ok 2.1ms
trace: [0c349e67] summary
trace: [0c349e67]   stealth onRequest=42/3.1ms onEvent=310/8.9ms onDocument=1/0.3ms
trace: [0c349e67]   myplugin no hooks ran
```

The resolved pipeline is reported up front — order, priority, the hooks you
actually implement, and the globs you declared. That is the first thing to check
when plugins fight over a message or a hook never fires. Decisions are reported
as `pass`, `change`, `drop`, `respond`, or `error`.

Two things are reported even with tracing off, because both are otherwise silent
and both are nearly always bugs: a `match` glob that never matched, and a
`ctx.send` still in flight when the session ended.

## Testing

The fastest useful test drives a real browser and asserts behaviour:

```ts
const browser = await chromium.launch({ plugins: [myPlugin()] })
const page = await browser.newPage()
await page.goto(url)
assertEquals(await page.evaluate(() => /* ... */), expected)
```

`Proxy.debug` returns the same picture the traces paint, as data, so you can
assert your hooks actually ran instead of scraping logs:

```ts
const { plugins } = await rpc(await browser.newBrowserCDPSession()).debug()
assert(plugins.find((p) => p.name === 'myplugin')!.calls.onRequest > 0)
```

For hook logic in isolation, drive the `Pipeline` directly with a stub context —
`test/plugin.test.ts` has the pattern. `test/proxy-connection.test.ts` goes one
level up, wiring a real client socket through a `ProxyConnection` to a fake
browser so id remapping and suppression can be asserted end to end.

When you assert that something is _absent_ — no injected global, no forwarded
command — check the assertion can still fail, by temporarily breaking the thing
it guards. An absence assertion that has quietly become vacuous looks identical
to a passing one.

## Distributing a plugin

In-process, just import and pass it to `plugins: [...]`.

For a standalone proxy, drop the file in the directory named by
`CDP_PLUGINS_DIRECTORY` (`plugins` by default) and the server loads it at
startup:

- `*.ts` and `*.js` files, loaded in alphabetical order.
- Files containing `.disabled.` are skipped, which is how you park one without
  deleting it.
- The factory must be the **default export**, or a named export matching the
  filename (`block.ts` → `export const block`).

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
`stealth` guards on `page`/`iframe` for exactly this reason, and suppressing
`Runtime.enable` on a worker would strand Playwright without contexts.

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
that page. Kick off long work without awaiting it, as `stealth` does with its
context provisioning. Awaiting `ctx.send` is fine; awaiting something that
depends on _another event arriving through the pipeline for the same target_
deadlocks.

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
return the same object if you like — `stealth` does — just do not read `pass` as
"nothing happened".

## Checklist

Before shipping a plugin:

- [ ] State that must not cross sessions is inside `setup`, not module scope.
- [ ] Per-target state uses `ctx.state`, or is pruned in `onTargetDetached`.
- [ ] `target.type` is checked before page-only commands.
- [ ] `match` globs are spelled right — run once and check for the never-matched
      warning.
- [ ] `optional` is set if the plugin only observes.
- [ ] Long work is not awaited inside a message hook.
- [ ] Failures check `ctx.signal.aborted` before logging.
- [ ] Injected page code uses a named `world` unless it must touch page globals.
- [ ] There is a test that fails when the plugin is removed.
