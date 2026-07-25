# cdp-proxy

**A stealthy, plugin-configurable Playwright.** Import it, get back a normal
Playwright `Browser`, and drive it as you always have — except the browser no
longer announces that it is being automated.

```ts
import { chromium } from './src/mod.ts'

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto('https://example.com')
console.log(await page.title())
```

That is the whole setup. `browser`, `context`, and `page` are genuine Playwright
objects, so every Playwright method, type, and tool works unchanged.

## Why it exists

To learn a page's JavaScript execution contexts, Playwright must call
`Runtime.enable`. That one call makes Chrome report console activity and serialize
console arguments — the long-standing fingerprint for "a DevTools client is
attached". It is what most bot detectors actually look for.

Other projects fix this by forking or patching Playwright's source, which you then
have to maintain across every release. This project fixes it one layer lower. It
sits between your client and Chrome as a CDP proxy, answers `Runtime.enable`
itself, and hands Playwright the context ids it would have learned — so the
command never reaches the browser and there is nothing to patch.

Working at the protocol layer generalizes: **anything** that speaks CDP can be
intercepted, rewritten, dropped, or answered by a plugin, without forking a
client. Stealth is just the first plugin.

## Getting started

You need [Deno](https://deno.com) 2.7+ and a Chromium binary. The easiest source
of one is Playwright's own browser cache, which this project finds automatically:

```sh
npx playwright install chromium
```

Then run the snippet above with `deno run -A your-script.ts`. No proxy to start
and nothing to configure — a proxy and browser are launched in-process on first
use and torn down with the browser.

## Everyday usage

**Stealth is on by default**, because a stealthy Playwright is the point. The
`plugins` option replaces that default set, and `plugins: []` opts out entirely
and gives you a plain pass-through proxy:

```ts
import { chromium, recorder, stealth } from './src/mod.ts'

await chromium.launch()                                  // stealth
await chromium.launch({ plugins: [stealth(), recorder()] }) // stealth + your own
await chromium.launch({ plugins: [] })                   // stock Playwright
```

**Debug locally, run headless in production**, from the same code:

```ts
const browser = await chromium.launch({ headless: false, slowMo: 250 })
```

**Drive many sites at once.** Every launch is an isolated session with its own
cookies, storage, and plugin state, so concurrent sites cannot contaminate or
correlate each other. `chromium.session()` is a shorthand that hands you a
browser, context, and page in one step:

```ts
await Promise.all(urls.map(async (url) => {
  const site = await chromium.session()
  await site.page.goto(url)
  // ... scrape ...
  await site.close()
}))
```

By default each session gets its own browser *context* — cheap, fast, and enough
to separate storage and cookies, and a session's plugins only ever see the targets
that session opened. When sites must not be correlatable at all, ask for a whole
browser process per session, with its own profile, cache, and process-level
fingerprint:

```ts
const browser = await chromium.launch({ isolation: 'browser' })
```

The one thing context isolation still shares is the browser's own default context,
which every CDP client sees when it connects. Pages you open yourself never land
there, but `browser.contexts()[0]` is common ground; use `isolation: 'browser'` if
even that is too much.

## Bundled plugins

**`stealth()`** is the flagship. It suppresses the `Runtime.enable` tell, supplies
synthetic execution contexts for every frame including subframes, spoofs the
User-Agent to drop the `HeadlessChrome` marker (keeping the platform metadata
consistent with it), and scrubs `navigator.webdriver`. `page.evaluate`,
`setContent`, selectors, iframes, and workers all keep working.
[docs/stealth.md](docs/stealth.md) has the measurements behind each decision.

The smoke test grades the result against [browserscan.net](https://www.browserscan.net/bot-detection):
the same browser is reported as `Robot` with no plugins and `Normal` with
`stealth()`, so the check cannot quietly pass if the spoofing regresses.

**`recorder()`** records a session's CDP traffic and serves it back, which is
useful both for debugging and as a compact example to copy:

```ts
import { chromium, type Entry, recorder, rpc, stealth } from './src/mod.ts'

const browser = await chromium.launch({ plugins: [stealth(), recorder()] })
const proxy = rpc(await browser.newBrowserCDPSession())
const { entries } = await proxy.send<{ entries: Entry[] }>('Proxy.history')
```

## Writing a plugin

A plugin is a typed factory. `setup` runs once per session and returns hooks;
state lives in the closure, so each session gets its own isolated instance and no
plugin can leak state into another site's session.

```ts
import { definePlugin } from './src/mod.ts'

export const blockImages = definePlugin<{ patterns: string[] }>({
  name: 'blockImages',
  defaults: { patterns: ['*.png', '*.jpg', '*.gif', '*.webp'] },
  priority: 50, // higher runs earlier
  setup(cfg, ctx) {
    return {
      async onTargetAttached({ sessionId }) {
        await ctx.send('Network.enable', undefined, sessionId)
        await ctx.send('Network.setBlockedURLs', {
          urls: cfg.patterns,
        }, sessionId)
      },
    }
  },
})
```

`ctx.send` and `ctx.emit` are generic over `devtools-protocol`, so methods,
params, and results all autocomplete and typecheck.

### Hooks

Message hooks see traffic in flight: `onRequest` (client → browser), `onResponse`,
and `onEvent` (browser → client). Add `match: ['Network.*']` to a definition to
only be called for the methods you care about.

From `onRequest` you can return:

| Return | Effect |
| --- | --- |
| the message, modified or not | forward it |
| nothing | forward unchanged |
| `null` | drop it silently |
| `{ respond: result }` | answer the client; never reaches the browser |

Lifecycle hooks tell you where you are: `onSessionStart`, `onSessionEnd`,
`onTargetAttached`, `onTargetDetached`, and `onDocument`.

`onDocument` is usually the one you want. It fires whenever any frame commits a
new document, handing you `{ sessionId, frameId, loaderId, url, isMain }` already
worked out, so you never have to sequence raw `Page.*` traffic yourself. It fires
for subframes too — the case that is easy to forget and where anything touching
execution contexts tends to break.

### The context object

`ctx.send()` issues CDP commands whose responses resolve to your plugin alone and
are never leaked to the client. `ctx.emit()` injects synthetic CDP events into the
client's stream, in order. `ctx.targets` is a live view of attached targets keyed
by CDP session id. `ctx.signal` aborts when the session tears down — check it
before reporting a failure, because every in-flight `send` rejects at that point
by design. `ctx.log()` writes through the configured log level, tagged with your
plugin and session.

A hook that throws is logged and skipped; one bad plugin can never break the
connection.

## Debugging a plugin

Your plugin sits in the middle of a message stream you cannot otherwise see, so
tracing is built in. Turn it on per launch, or with `CDP_DEBUG`:

```ts
const browser = await chromium.launch({ plugins: [myPlugin()], debug: 'myplugin' })
```

```sh
CDP_DEBUG=1                  # everything
CDP_DEBUG=myplugin           # just your plugin's decisions
CDP_DEBUG=myplugin:Runtime.* # ...narrowed to the methods you care about
CDP_DEBUG=proxy              # just the transport: forwards, drops, id remapping
```

The filter matches `source[:methodGlob]`, where source is a plugin name or `proxy`
for the transport itself.

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

You get the resolved pipeline up front — order, priority, the hooks you actually
implement, and the globs you declared, which is the first thing to check when
plugins fight over a message or a hook never fires. Then every decision, reported
as `pass`, `change`, `drop`, `respond`, or `error` and attributed to the plugin
that made it, alongside the transport's own view of what it forwarded and under
which remapped id. Your own `ctx.send` and `ctx.emit` traffic is tagged and timed.
At the end, a summary of invocation counts and time per hook.

Two things are reported even with tracing off, because both are otherwise
completely silent and both are nearly always bugs:

- **A `match` glob that never matched.** Typo `Runtim.*` and your hooks just never
  run, which looks exactly like a plugin that works. You get told instead.
- **A `ctx.send` still in flight when the session ended**, named with the plugin
  and method, so a hang points straight at its own cause.

A hook that throws is logged with the plugin, the hook, and the method that
triggered it. A `ctx.send` that never gets a reply fails after 30s naming the
plugin, method, and CDP session.

### Reserved `Proxy.*` methods

Any method under `Proxy.` is answered by the proxy or by a plugin and never
reaches Chrome. That gives client code a channel to your plugin through
Playwright's own raw-CDP escape hatch. `rpc()` wraps a CDP session to give that
namespace real types, since Playwright's own `send` only knows the real protocol:

```ts
import { rpc } from './src/mod.ts'

const proxy = rpc(await browser.newBrowserCDPSession())
await proxy.hello() // { connectionId, sessionToken, plugins, upstream }
await proxy.debug() // { tracing, plugins: [{ name, hooks, match, calls }] }
await proxy.send<{ entries: Entry[] }>('Proxy.history') // a plugin's own method
```

`hello().upstream` reports which browser this session landed on — the quickest way
to confirm pooling or `isolation: 'browser'` is doing what you expect. `debug()`
returns the same picture the trace lines paint, so your plugin's own tests can
assert its hooks ran rather than scraping logs:

```ts
const { plugins } = await proxy.debug()
assert(plugins.find((p) => p.name === 'myplugin')!.calls.onRequest > 0)
```

`recorder`'s `Proxy.history` is the same mechanism, answered by a plugin instead
of by the runtime — that is all it takes to expose your own.

## Running as a server

The SDK runs the proxy in-process, which is all most people need. You can also run
it standalone — one process fronting a browser, a remote CDP endpoint, or a pool
of them — and connect clients over the network. Copy `.env.example` to `.env`
first, so the proxy listens on a known port instead of picking a free one:

```sh
cp .env.example .env   # CDP_PROXY_PORT=9994
deno task dev
```

Clients register a plugin set, get a short-lived session token back, and pass it
on the connect headers:

```sh
curl -X POST localhost:9994/proxy/register \
  -H 'content-type: application/json' \
  -d '{"plugins":[{"name":"stealth"}],"isolation":"browser"}'
# → { "token": "…" }
```

The client here is stock Playwright — no import from this project at all:

```ts
import { chromium } from 'playwright'

const browser = await chromium.connectOverCDP('http://localhost:9994', {
  headers: { 'x-cdp-session': token },
})
```

The token rides a header rather than the URL because `connectOverCDP` discards
query strings when it follows `/json/version` to the real WebSocket — and because
the browser must never see it.

Plugins named this way are loaded from `plugins/` at startup. Rename a file to
`*.disabled.ts` to park it without deleting it. Embedded SDK use loads nothing
from disk unless you set `CDP_PLUGINS_DIRECTORY`.

## Configuration

Everything is environment-driven with a working default for each value; see
`.env.example`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `CDP_PROXY_PORT` / `CDP_PROXY_HOST` | free port / `localhost` | Where the proxy listens |
| `CDP_BROWSER_PORT` / `CDP_BROWSER_HOST` | free port / `localhost` | Where the managed browser listens |
| `CDP_BROWSER_EXECUTABLE_PATH` | auto-detected | Browser binary to launch |
| `CDP_BROWSER_WS_ENDPOINT` | — | Front an existing browser instead of launching one |
| `CDP_HEADLESS` | `true` | Headless, or headful for local debugging |
| `CDP_ISOLATION` | `context` | Default session isolation: `context` or `browser` |
| `CDP_PLUGINS_DIRECTORY` | `plugins` standalone, none embedded | Plugins to expose by name |
| `CDP_PROXY_LOG_LEVEL` | `verbose` | `silent`, `error`, `warn`, `info`, `verbose` |
| `CDP_PROXY_LOG_TAGS` | all | Comma-separated modules to log, e.g. `proxy,stealth` |
| `CDP_DEBUG` | — | Plugin trace filter — see [Debugging a plugin](#debugging-a-plugin) |

With `CDP_BROWSER_EXECUTABLE_PATH` unset, the newest "Chrome for Testing" in
Playwright's cache is used. That default is deliberate — see the first gotcha.

Logs print to the console and are mirrored to OpenTelemetry when the host app has
registered a global logger provider; [docs/telemetry.md](docs/telemetry.md) covers
the spans and attributes the proxy adds.

## Gotchas worth knowing

**Do not automate an enterprise-managed Chrome.** On a managed macOS fleet,
`/Applications/Google Chrome.app` inherits `com.google.Chrome` managed
preferences. On a fresh profile, policy provisioning — forced extension installs,
GCM registration — makes Chrome emit `Target.detachedFromTarget` for *every* page
target a few seconds after launch. Automation then dies mid-run with "Target page,
context or browser has been closed", with no crash and no clue. This was
reproduced with a raw CDP socket, no proxy or Playwright involved, and it
disappears entirely on Chrome for Testing, which ships a different bundle id.
Check with `ls "/Library/Managed Preferences/com.google.Chrome.plist"`.

**`page.setContent` needs a console echo.** Playwright's `setContent` calls
`document.open()` and then waits for its own `console.debug(tag)` to come back as
a `Runtime.consoleAPICalled` event before clearing the frame lifecycle. With the
runtime suppressed that event never arrives, so `setContent` would hang until
timeout. The stealth plugin replays the tag, which is why it works.

**The `Runtime.enable` tell is not page-observable on Chrome 147.** The widely
cited probe — a getter on an `Error`'s own `stack`, read after `console.debug` —
no longer fires, because console previews skip accessors and proxy traps. Headless
Chrome also stringifies console arguments for its own log sink whether or not CDP
is attached, so `toString`-based probes report false positives in every state.
Verified against a raw CDP session with `Runtime.enable` as a positive control.
The smoke test therefore asserts the wire-level invariant — `Runtime.enable` is
attempted by Playwright and never forwarded — rather than a page-level trap.

## How it works

A client connects to the proxy exactly as it would to Chrome. The proxy resolves
that connection's plugin set from its session token, dials the upstream browser,
and pipes messages through the plugin pipeline in both directions. One client
socket maps to exactly one browser socket, with all targets multiplexed over it by
CDP `sessionId` — the same "flatten" transport `connectOverCDP` already uses.

| Module | Role |
| --- | --- |
| `proxy.ts` | Orchestrator: serves the CDP surface, resolves upstream + plugins per connection |
| `proxy-connection.ts` | One client socket ↔ one browser socket: id remapping, target registry, pipeline |
| `plugin.ts` | `definePlugin` and the `Pipeline` that runs hooks in priority order |
| `session-manager.ts` | Session tokens, isolation mode, concurrency ceiling |
| `browser-pool.ts` | Browser sourcing: managed local instances, a remote endpoint, or a pool |
| `debug.ts` | The `CDP_DEBUG` tracer: filters, hook accounting, session summary |
| `sdk.ts` | The user-facing `chromium.launch()` / `chromium.session()` |
| `plugins/` | `stealth.ts` and `recorder.ts` |

Three invariants keep it honest, all covered by tests:

- **Id remapping.** Client command ids and plugin-originated command ids share one
  upstream id space, so they can never collide. Responses are restored to the
  client's original id, and plugin traffic is never visible to the client.
- **Short-circuiting.** A plugin may answer a request itself, and the command is
  then never forwarded. That is exactly how `Runtime.enable` is suppressed.
- **Target ownership.** Chrome's auto-attach is browser-wide, so a shared browser
  offers every client every other client's pages. Each connection claims every
  context it creates — whether the client or one of its own plugins opened it —
  and releases the claim when that context is disposed, so a plugin can only
  configure its own session's targets. The browser's own default context is
  claimed by nobody and stays common ground. Dropping an attachment also means
  answering for it: clients auto-attach with `waitForDebuggerOnStart`, so a hidden
  target still has to be released or its real owner hangs on first navigation.

## Development

```sh
deno task dev        # run the proxy standalone, with file watching
deno task test       # everything, including the end-to-end smoke test
deno task test:unit  # fast inner loop: skips the test that needs a real browser
deno task smoke      # only the end-to-end test
```

The smoke test drives a real browser through the full stack and skips itself when
no browser binary can be resolved. Its last step is the only one that leaves the
machine: it grades the browser against [browserscan.net](https://www.browserscan.net)
and skips itself when there is no egress. `scratch/` holds throwaway probes used to
pin down browser behaviour; it is excluded from formatting and is not part of the
build.

## License

MIT
