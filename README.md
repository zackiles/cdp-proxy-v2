# cdp-proxy

**Unpatched Playwright, undetectable on the wire.** The usual fixes for the
`Runtime.enable` leak rewrite your automation library's source or ship a forked
browser build. This one sits between the library and Chrome instead, so
`playwright` stays the real package at the real version, Chrome stays the real
Chrome, and the tell is gone for anything that speaks CDP — Node, Python, or a
raw socket.

```ts
import { chromium } from './src/mod.ts'

const browser = await chromium.launch()
const page = await browser.newPage()
await page.goto('https://example.com')
console.log(await page.title())
```

That is the whole setup. `browser`, `context`, and `page` are genuine Playwright
objects from the genuine package, so every Playwright method, type, and tool
works unchanged — and stays working when you upgrade, because there is no patch
to re-apply.

Sitting on the wire is also what makes the rest of it possible. Each session
draws one coherent machine and every plugin reads its claims from that same row,
where a plugin can be a launch flag, a rewrite of any CDP message, one browser
API answered in the page and in its workers, or imperative behaviour on a page —
a few dozen lines each, no fork of Playwright or Chrome, and a coverage report
that names what nothing covered.

## Why it exists

### One command decides whether you look like a bot

To evaluate anything on a page, Playwright needs that page's JavaScript
execution context ids, and the only way Chrome hands them over is
`Runtime.enable`. Enabling that domain changes how the browser behaves: it
starts reporting console activity and serializing console arguments, which is
the long-standing signature of "a DevTools client is attached."

It is not a theoretical leak. DataDome
[published the technique](https://datadome.co/threat-research/how-new-headless-chrome-the-cdp-signal-are-impacting-bot-detection/),
and rebrowser's
[investigation](https://rebrowser.net/blog/how-to-fix-runtime-enable-cdp-detection-of-puppeteer-playwright-and-other-automation-libraries-61740)
found that simply not sending the command stopped Cloudflare Turnstile and
DataDome from challenging sessions on residential IPs. Every other layer of
stealth — proxies, fingerprints, human-like timing — is downstream of it: while
the runtime is enabled, none of that work matters.

The obvious escapes are all worse than the leak. A custom Chromium build that
drops the console event gives you a browser nothing else in the world matches.
`--auto-open-devtools-for-tabs` puts you in the <0.1% of users browsing with
DevTools open. Overriding `console.debug` is detected by anything that checks.

One caveat, measured here rather than repeated: the JavaScript probe that made
this famous — a getter on an `Error`'s own `stack`, read after `console.debug` —
no longer fires on Chrome 147, for the reasons in
[the gotchas](#gotchas-worth-knowing). The command still changes what the
browser does, the anti-bot vendors' own behaviour is still what it is, and on
the wire it costs nothing to never send it. That is why this project asserts the
wire-level invariant instead of grading itself against one page-level trap.

### The usual fix goes inside your client library

[`rebrowser-patches`](https://github.com/rebrowser/rebrowser-patches) is the
best-known answer, and it works by patching Playwright's and Puppeteer's own
source so the library never sends the command. That means a patch per library,
per language binding, and per release — the project ships whole forked packages
(`rebrowser-playwright`, `rebrowser-puppeteer`, a Python one) to make it
bearable, and your upgrades wait on theirs. It also forces a choice between
three fix modes, none of which is free:

| Fix mode                      | Main world | Workers | Leaves nothing in the page | Never detectable |
| ----------------------------- | ---------- | ------- | -------------------------- | ---------------- |
| `addBinding` (default)        | yes        | yes     | **no** — see below         | yes              |
| `alwaysIsolated`              | **no**     | **no**  | yes                        | yes              |
| `enableDisable`               | yes        | yes     | yes                        | **no** — a gap   |
| **this project, on the wire** | yes        | yes     | yes                        | yes              |

The binding mode is the interesting row, because this project shipped it first
and then measured it: `Runtime.removeBinding` does **not** take the installed
function back off `window`. A stealth session left one or two `__pw_<hex>`
globals on every document, permanently, accumulating across navigations —
uniquely named, enumerable in one line, and prefixed with Playwright's initials.
That is a stronger tell than the one being hidden.

### This project never sends the command at all

The proxy answers `Runtime.enable` itself and then works out the context ids the
client was promised, without asking the browser to announce them. A remote
object's `objectId` has the form `<isolate>.<context>.<n>`, so **any handle into
a frame names that frame's world**: `Runtime.evaluate('self')` for the top
frame, and `DOM.getFrameOwner` → `describeNode` → `resolveNode` for a subframe,
which resolves in the subframe's own world and works cross-origin. The ids come
back as synthetic `Runtime.executionContextCreated` events, in the shape
Playwright expects, and the handle is released.

So the runtime is never enabled — not even for the instant `enableDisable` needs
— nothing is installed in the page, and `page.evaluate` still runs in the main
world. [docs/stealth.md](docs/stealth.md) records every measurement behind that,
including the subframe cases where a missing utility world makes
`frameLocator()` hang rather than fail.

### The hard part is bookkeeping, not derivation

A client expects to know a frame's context ids **before** it uses anything that
needs them, so nothing can be resolved lazily on first evaluate. That is what
makes a naive proxy expensive: enumerate every context for every target the
moment the runtime is enabled, several commands apiece, and pay again on every
navigation. This proxy keeps the whole context model on its own side instead,
and the details are what make it transparent:

- **Derivation is driven by document commits and keyed by `loaderId`,** so each
  document is paid for once — one `Runtime.evaluate` for a top frame, three
  `DOM.*` calls for a subframe, one `Page.createIsolatedWorld` for the utility
  world Playwright's selectors run in.
- **Frames that already existed are walked out of `Page.getFrameTree`,** because
  a client that connects to a loaded page still expects contexts for its
  iframes.
- **Ids are announced once.** A repeat announcement of the same id reads to
  Playwright as the context being destroyed, and every later evaluation fails
  with "Execution context was destroyed".
- **Dead contexts are retracted in the shape the client keys them by.** A
  top-frame commit clears the tree; a subframe navigating alone retracts only
  its own, carrying `executionContextUniqueId` as well as the numeric id.

The result is a client whose model of the page is correct at every moment, built
entirely from messages it cannot distinguish from Chrome's own — and the
end-to-end test asserts both halves: Playwright does attempt `Runtime.enable`,
and it never reaches the browser.

### Where this sits among the alternatives

Stealth automation comes in two shapes, and both are things you consume rather
than things you extend:

| Shape                 | What it is                                                                                                                                       | You extend it by                       | It ties you to                                                                                          |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **A patched driver**  | a fork of your automation library that stops it emitting the tells — [patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright), rebrowser | maintaining your own patches on a fork | their cadence for _your_ library, and their design calls — patchright gives up working `console` output |
| **A patched browser** | a rebuilt binary with the fingerprints compiled in — [CloakBrowser](https://github.com/CloakHQ/CloakBrowser) (Chromium, C++), Camoufox (Firefox) | filing an issue                        | their build: free CloakBrowser tiers sit on older Chromium lines, current ones are licensed             |
| **A proxy**           | this project — the protocol conversation is yours, and a plugin platform sits on top of it                                                       | writing a plugin against a typed API   | nothing: stock `playwright`, real Chrome, each upgraded on its own schedule                             |

Two things are worth taking from the ecosystem's own findings. A patched driver
does not spoof fingerprints at all, which is why the standard advice is to
_stack_ three unrelated projects — patchright for the protocol, Camoufox for
fingerprints, CDP-Patches for trusted input — leaving you three configuration
models and no shared idea of which machine you are supposed to be. And a patched
browser cannot reach the protocol layer at all: an independent
[2026 benchmark](https://ianlpaterson.com/blog/anti-detect-browser-benchmark-patchright-nodriver-curl-cffi/)
found the signal that decided the most cases was gates "keying on how the
browser is driven, not what it claims to be", with source-level fingerprint
patches unable to touch it — one Cloudflare-protected gate blocked every patched
Chromium tested and let through the one client that simply does not emit
Playwright's startup sequence.

That sequence is the thing a proxy owns. `Runtime.enable` is answered here and
never forwarded, and `Target.setAutoAttach` is rewritten into one merged call
rather than relayed as the client sent it: the browser sees a conversation the
proxy composed. The difference is that you keep the whole Playwright API instead
of trading it for a smaller library to get the same effect.

### The platform is the point

Owning the wire is what makes the plugin system possible, and the plugin system
is what makes this a platform rather than a stealth patch. A plugin picks the
layer it belongs at, and there is one API for all of them:

| To change...                         | Write a    | Which is                                                          |
| ------------------------------------ | ---------- | ----------------------------------------------------------------- |
| which machine a session claims to be | `profile`  | a loader that answers a constraint with a whole machine           |
| how the process starts               | `launch`   | flags, env, extensions, a data dir, proxy credentials             |
| what crosses the wire                | `protocol` | hooks that read, rewrite, answer, or suppress any CDP message     |
| what a browser API reports           | `surface`  | a value off the profile and a page function, or a CDP override    |
| what happens on the page             | `actor`    | imperative code with a page handle, running off the message queue |

The range is the argument. A `surface` runs a few dozen lines and does for one
API what a C++ patch does — except the platform, not the author, decides how it
lands: a launch flag beats an `Emulation.*` override, which beats a page patch,
and whatever ends up in the page is delivered to that page, its iframes, and its
workers, because a patch that stops at `window` is undone by `new Worker()`. A
protocol plugin drops to raw messages when nothing declarative will do. Neither
is coupled to Playwright — they are written against CDP, so the same plugin
serves a Node client, a Python client, or a raw socket.

What that buys over a fork or a binary:

- **Per session, not per process.** Plugin sets and identities resolve per
  connection, so one process can drive twenty sites with twenty configurations
  and twenty different machines, concurrently and isolated. A patched binary has
  one global configuration.
- **One coherent identity instead of three tools' opinions.** The same benchmark
  found gates cross-checking layers for consistency, where the _mismatch_ is the
  signal. So every value a plugin reads comes from one profile row — drawn
  whole, corrected against the process that actually started, then frozen — and
  can be sampled from real machines you captured rather than invented.
- **It tells you what you are still leaking.** The coverage report names the
  profile fields nothing carried, plugin conflicts are named at session start,
  traces attribute every decision to a plugin, and `harness()` runs a plugin
  against a real browser and can assert the claim held in a worker. Nothing else
  in this space reports its own gaps as data.
- **It composes rather than competes.** Point it at any Chromium binary,
  including a source-patched stealth build, or front an already-running browser
  over CDP. The engine layer can stay whoever's you trust; the protocol layer
  and the identity model stay yours.

The boundary, stated plainly: TLS and HTTP/2 shape, the host's real GPU, and
font rasterization belong to the browser and the host, not to a proxy. That is
exactly why delivery prefers a flag to an override and an override to a page
patch, and why a profile is drawn whole rather than assembled field by field —
the layers this project does own should never be the contradiction a gate finds.

Suppressing the tell is the precondition. What the browser says once nobody can
see the wire is the platform — and the
[predecessor to this project](https://github.com/zackiles/cdp-proxy-interceptor)
is where that foundation was first proved.

## Getting started

You need [Deno](https://deno.com) 2.7+ and a Chromium binary. The easiest source
of one is Playwright's own browser cache, which this project finds
automatically:

```sh
npx playwright install chromium
```

Then run the snippet above with `deno run -A your-script.ts`. No proxy to start
and nothing to configure — a proxy and browser are launched in-process on first
use and torn down with the browser.

## Everyday usage

**Stealth is on by default**, because a stealthy Playwright is the point. The
`plugins` option replaces that default set:

```ts
import { chromium, recorder, stealth } from './src/mod.ts'

await chromium.launch() // the stealth preset
await chromium.launch({ plugins: [stealth(), recorder()] }) // stealth + your own
await chromium.launch({ plugins: [stealth({ without: ['canvas'] })] }) // minus one
await chromium.launch({ plugins: [] }) // core only: honest, but not announced
await chromium.launch({ plugins: 'none' }) // a transparent relay, for diagnosis
```

`plugins: []` is not stock Playwright. A small core tier is installed for every
session but `'none'`: the `Runtime.enable` defeat, a profile generator, and the
launch flags the identity owns. So `[]` is a session that presents the real
machine honestly and still does not announce itself on the wire, and `'none'` is
the pass-through you want when you are debugging the proxy itself.

**Debug locally, run headless in production**, from the same code:

```ts
const browser = await chromium.launch({ headless: false, slowMo: 250 })
```

One caveat: the browsers are launched when the first `launch()` in a process
starts the proxy, so a later launch cannot change their mode. Asking for a
different one logs a warning rather than quietly handing back the wrong kind of
browser — pass `isolation: 'browser'` for a session that needs its own mode,
since that gets a process of its own.

**Drive many sites at once.** Every launch is an isolated session with its own
cookies, storage, identity, and plugin state, so concurrent sites cannot
contaminate or correlate each other. `chromium.session()` is a shorthand that
hands you a browser, context, and page in one step:

```ts
await Promise.all(urls.map(async (url) => {
  const site = await chromium.session()
  await site.page.goto(url)
  // ... scrape ...
  await site.close()
}))
```

By default each session gets its own browser _context_ — cheap, fast, and enough
to separate storage and cookies, and a session's plugins only ever see the
targets that session opened. When sites must not be correlatable at all, ask for
a whole browser process per session, with its own profile, cache, and
process-level fingerprint:

```ts
const browser = await chromium.launch({ isolation: 'browser' })
```

The one thing context isolation still shares is the browser's own default
context, which every CDP client sees when it connects. Pages you open yourself
never land there, but `browser.contexts()[0]` is common ground; use
`isolation: 'browser'` if even that is too much.

## The machine a session claims

Every session draws a **profile**: one coherent set of claims about one machine
— OS and version, Chrome major, User-Agent and UA-CH brands, locale, timezone,
screen, GPU, fonts, codecs. Plugins read from it rather than inventing values,
which is what keeps an Apple GPU from turning up behind a Windows User-Agent.

Ask for the kind of machine you want, as a query:

```ts
const browser = await chromium.launch({
  profile: { os: ['Windows'], locale: ['en-US'], minChrome: 140 },
})
```

This is a **constraint, not an override.** Loaders answer it with a whole row or
decline; there is deliberately no way to change one field of a drawn profile,
because a patched field is exactly how identities become incoherent. Once drawn
and reconciled against the browser that actually started, the profile is frozen
for the life of the session.

Read back what you got, and who carried it:

```ts
import { rpc } from './src/mod.ts'

const proxy = rpc(await browser.newBrowserCDPSession())
const { profile, coverage } = await proxy.profile()
```

The same two facts are what the trace prints at session start:

```
profile 8f2c source=corpus Windows / Chrome 147 / en-US / America/New_York
  navigator  reads userAgent brands os osVersion arch
  webgl      reads gpu
  uncovered  fonts
```

**The uncovered line is the point.** A field nothing read is a field where the
real browser's value reaches the page while the profile claims something else —
an omission you find in a trace or a test rather than from a detector.

Three more things worth knowing:

- **Pin an identity to reproduce a failure.** `CDP_PROFILE=8f2c…` (or the `pin`
  loader) re-draws the same machine, because the id is the seed.
- **Retire one that got caught.** `await proxy.burn('blocked at checkout')`
  tells every loader to stop handing that identity out. Only the code driving
  the page can recognize a block, so it is the automator's call.
- **Use real machines when you have them.** `deno task capture` records a
  fingerprint from a real Chrome on hardware you own, and the `corpus` loader
  samples from that file. Synthetic rows from core `generate` are the fallback,
  not the ceiling.

## Bundled plugins

**`stealth()`** is a preset rather than a single plugin: it expands to the
surfaces that carry the identity, and nothing else. Drop any of them with
`stealth({ without: ['canvas'] })`, or compose your own set from the same
exports.

| Area     | Surfaces                       | Carries                                                     |
| -------- | ------------------------------ | ----------------------------------------------------------- |
| Platform | `navigator`, `chrome`, `fonts` | User-Agent and UA-CH, cores, memory, touch, the font list   |
| Graphics | `webgl`, `canvas`              | GPU vendor and renderer strings, per-identity canvas jitter |
| Display  | `screen`                       | Monitor size, scale, and the window chrome around it        |
| Locale   | `timezone`, `geo`              | Timezone, `Accept-Language`, geolocation                    |
| Media    | `audio`, `codecs`, `devices`   | AudioContext jitter, codec support, media device list       |
| Device   | `permissions`, `battery`       | Permission state consistent with itself, battery status     |
| Network  | `webrtc`                       | ICE candidates that do not leak the real address            |

A surface is delivered to every realm its API exists in — iframes and workers as
well as the main frame — because a patch that stops at `window` is bypassed by
one line of page JavaScript. [docs/stealth.md](docs/stealth.md) has the
measurements behind each decision.

The smoke test grades the result against
[browserscan.net](https://www.browserscan.net/bot-detection): the same browser
is reported as `Robot` with no plugins and `Normal` with `stealth()`, so the
check cannot quietly pass if the spoofing regresses.

Beyond stealth, the box also ships:

| Plugin                        | Kind       | What it is for                                               |
| ----------------------------- | ---------- | ------------------------------------------------------------ |
| `pin`, `corpus`, `remote`     | `profile`  | Where identities come from: fixed, captured, or coordinated  |
| `proxy`, `clock`, `extension` | `launch`   | Upstream proxy with credentials, `TZ`, an unpacked extension |
| `recorder`                    | `protocol` | Records a session's CDP traffic and serves it back           |
| `banner`, `captcha`           | `actor`    | Dismiss a cookie wall; detect and solve a challenge          |

`recorder` is the compact example worth copying:

```ts
import { chromium, type Entry, recorder, rpc, stealth } from './src/mod.ts'

const browser = await chromium.launch({ plugins: [stealth(), recorder()] })
const proxy = rpc(await browser.newBrowserCDPSession())
const { entries } = await proxy.send<{ entries: Entry[] }>('Proxy.history')
```

`deno task plugins` lists every plugin that exists, with the profile fields each
one reads.

## Writing a plugin

A plugin is a typed factory. `setup` runs once per session and returns hooks;
state lives in the closure, so each session gets its own isolated instance and
no plugin can leak state into another site's session.

`kind` decides where it attaches, and therefore what it is handed:

| Kind       | Runs                          | Write one when                                              |
| ---------- | ----------------------------- | ----------------------------------------------------------- |
| `profile`  | once, before the browser      | you have machines to hand out — a corpus, a pool, a fixture |
| `launch`   | once, before the process      | the claim needs a command-line flag or an env var           |
| `protocol` | on every CDP message          | you need to read, rewrite, answer, or suppress traffic      |
| `surface`  | once per session, in the page | a browser API should report something the profile says      |
| `actor`    | once per page                 | something on the page needs doing — a banner, a challenge   |

A `surface` is the one most plugins turn out to be. It names one browser-visible
API, reads the value from the profile, and lets the runtime decide how to
deliver it — a launch flag beats an `Emulation.*` override, which beats a page
patch:

```ts
import { definePlugin } from './src/mod.ts'

interface Config {
  cores: number
}

export const concurrency = definePlugin<Record<string, unknown>, Config>({
  kind: 'surface',
  name: 'concurrency',
  setup(cfg, ctx) {
    return {
      config: { cores: ctx.profile.hardware.cores },
      page(config) {
        define(globalThis.navigator, 'hardwareConcurrency', config.cores)
      },
    }
  },
})
```

A `protocol` plugin is the general escape hatch, and works on raw messages:

```ts
export const block = definePlugin<{ patterns: string[] }>({
  name: 'block',
  defaults: { patterns: ['*.png', '*.jpg'] },
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
      },
    }
  },
})
```

`ctx.send` and `ctx.emit` are generic over `devtools-protocol`, so methods,
params, and results all autocomplete and typecheck.
[docs/plugin-developer.md](docs/plugin-developer.md) is the full guide: every
kind's exact API, how options and matching resolve, the serialization rule for
page functions, the brokered domains, testing with `harness()`, and the gotchas
worth knowing before you ship one.

## Debugging a plugin

Your plugin sits in the middle of a message stream you cannot otherwise see, so
tracing is built in. Turn it on per launch, or with `CDP_DEBUG`:

```ts
const browser = await chromium.launch({
  plugins: [myPlugin()],
  debug: 'myplugin',
})
```

The filter applies to that session alone, so tracing one launch leaves every
other session in the process untouched. `CDP_DEBUG` supplies the default for
sessions that do not ask.

```sh
CDP_DEBUG=1                  # everything
CDP_DEBUG=myplugin           # just your plugin's decisions
CDP_DEBUG=myplugin:Runtime.* # ...narrowed to the methods you care about
CDP_DEBUG=proxy              # just the transport: forwards, drops, id remapping
```

The filter matches `source[:methodGlob]`, where source is a plugin name or
`proxy` for the transport itself.

```
trace: [0c349e67] pipeline: contexts(core) → myplugin(0)
trace: [0c349e67]   contexts hooks=onRequest,onResponse,onEvent,onDocument match=*
trace: [0c349e67]   myplugin hooks=onRequest match=Runtime.*
trace: [0c349e67] profile 8f2c source=generate Windows / Chrome 147 / en-US
trace: [0c349e67] → Runtime.enable #8 @38080A
trace: [0c349e67]   contexts onRequest respond Runtime.enable
trace: [0c349e67] ↩ Runtime.enable #8 answered without the browser
trace: [0c349e67] summary
trace: [0c349e67]   contexts onRequest=42/3.1ms onEvent=310/8.9ms
trace: [0c349e67]   myplugin no hooks ran
```

You get the resolved pipeline up front — order, priority, the hooks you actually
implement, and the globs you declared, which is the first thing to check when
plugins fight over a message or a hook never fires. Then every decision,
reported as `pass`, `change`, `drop`, `respond`, or `error` and attributed to
the plugin that made it, alongside the transport's own view of what it forwarded
and under which remapped id. At the end, a summary of invocation counts and time
per hook.

Three things are warned about even with tracing off, because each is otherwise
completely silent and each is nearly always a bug:

- **A `match` glob that never matched.** Typo `Runtim.*` and your hooks just
  never run, which looks exactly like a plugin that works.
- **An `actor` whose `urls` never matched a page**, which is a plugin that was
  installed and never ran.
- **A `ctx.send` still in flight when the session ended**, named with the plugin
  and method, so a hang points straight at its own cause.

The fourth thing worth checking is not a warning because only you know whether
it matters: the coverage report, printed in the trace and always available from
`Proxy.profile()`, names the profile fields nothing read.

### Reserved `Proxy.*` methods

Any method under `Proxy.` is answered by the proxy or by a plugin and never
reaches Chrome. That gives client code a channel to your plugin through
Playwright's own raw-CDP escape hatch. `rpc()` wraps a CDP session to give that
namespace real types, since Playwright's own `send` only knows the real
protocol:

```ts
import { rpc } from './src/mod.ts'

const proxy = rpc(await browser.newBrowserCDPSession())
await proxy.hello() // { connectionId, sessionToken, plugins, upstream, rpc }
await proxy.debug() // pipeline, hook counts, surfaces, actors, launch spec
await proxy.profile() // the sealed identity and its coverage report
await proxy.burn('blocked') // retire this identity fleet-wide
await proxy.send<{ entries: Entry[] }>('Proxy.history') // a plugin's own method
```

`hello().upstream` reports which browser this session landed on — the quickest
way to confirm pooling or `isolation: 'browser'` is doing what you expect.
`debug()` returns the same picture the trace lines paint, so your plugin's own
tests can assert its hooks ran rather than scraping logs:

```ts
const { plugins } = await proxy.debug()
assert(plugins.find((p) => p.name === 'myplugin')!.calls.onRequest > 0)
```

A plugin declares its own methods with `rpc: { 'Proxy.history': handler }`,
which is how `recorder` exposes its history: names are registered at install, so
a collision is an error at session start rather than whichever plugin loaded
first quietly winning.

## Running as a server

The SDK runs the proxy in-process, which is all most people need. You can also
run it standalone — one process fronting a browser, a remote CDP endpoint, or a
pool of them — and connect clients over the network. Copy `.env.example` to
`.env` first, so the proxy listens on a known port instead of picking a free
one:

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
query strings when it follows `/json/version` to the real WebSocket — and
because the browser must never see it.

Plugins and presets named this way are loaded from `plugins/` at startup, at any
depth. Rename a file to `*.disabled.ts` to park it without deleting it. Embedded
SDK use loads nothing from disk unless you set `CDP_PLUGINS_DIRECTORY`. A fleet
sharing one proxy sets `CDP_PROFILES` for how many identities exist across it,
and `CDP_CORPUS` for where they come from.

## Configuration

Everything is environment-driven with a working default for each value; see
`.env.example`.

| Variable                                | Default                             | Purpose                                                             |
| --------------------------------------- | ----------------------------------- | ------------------------------------------------------------------- |
| `CDP_PROXY_PORT` / `CDP_PROXY_HOST`     | free port / `localhost`             | Where the proxy listens                                             |
| `CDP_BROWSER_PORT` / `CDP_BROWSER_HOST` | free port / `localhost`             | Where the managed browser listens                                   |
| `CDP_BROWSER_EXECUTABLE_PATH`           | auto-detected                       | Browser binary to launch                                            |
| `CDP_BROWSER_WS_ENDPOINT`               | —                                   | Front an existing browser instead of launching one                  |
| `CDP_HEADLESS`                          | `true`                              | Headless, or headful for local debugging                            |
| `CDP_ISOLATION`                         | `context`                           | Default session isolation: `context` or `browser`                   |
| `CDP_PROFILE`                           | —                                   | Pin every session to one identity, by id, to reproduce a failure    |
| `CDP_PROFILES`                          | pool size                           | How many identities the fleet draws                                 |
| `CDP_CORPUS`                            | —                                   | JSONL corpus of captured fingerprints to draw from                  |
| `CDP_PLUGINS_DIRECTORY`                 | `plugins` standalone, none embedded | Plugins to expose by name                                           |
| `CDP_PROXY_LOG_LEVEL`                   | `verbose`                           | `silent`, `error`, `warn`, `info`, `verbose`                        |
| `CDP_PROXY_LOG_TAGS`                    | all                                 | Comma-separated modules to log, e.g. `proxy,stealth`                |
| `CDP_DEBUG`                             | —                                   | Plugin trace filter — see [Debugging a plugin](#debugging-a-plugin) |

With `CDP_BROWSER_EXECUTABLE_PATH` unset, the newest "Chrome for Testing" in
Playwright's cache is used. That default is deliberate — see the first gotcha.

Logs print to the console and are mirrored to OpenTelemetry when the host app
has registered a global logger provider; [docs/telemetry.md](docs/telemetry.md)
covers the spans and attributes the proxy adds.

## Gotchas worth knowing

**Do not automate an enterprise-managed Chrome.** On a managed macOS fleet,
`/Applications/Google Chrome.app` inherits `com.google.Chrome` managed
preferences. On a fresh profile, policy provisioning — forced extension
installs, GCM registration — makes Chrome emit `Target.detachedFromTarget` for
_every_ page target a few seconds after launch. Automation then dies mid-run
with "Target page, context or browser has been closed", with no crash and no
clue. This was reproduced with a raw CDP socket, no proxy or Playwright
involved, and it disappears entirely on Chrome for Testing, which ships a
different bundle id. Check with
`ls "/Library/Managed Preferences/com.google.Chrome.plist"`.

**`page.setContent` needs a console echo.** Playwright's `setContent` calls
`document.open()` and then waits for its own `console.debug(tag)` to come back
as a `Runtime.consoleAPICalled` event before clearing the frame lifecycle. With
the runtime suppressed that event never arrives, so `setContent` would hang
until timeout. Core `contexts` replays the tag, which is why it works.

**The `Runtime.enable` tell is not page-observable on Chrome 147.** The widely
cited probe — a getter on an `Error`'s own `stack`, read after `console.debug` —
no longer fires, because console previews skip accessors and proxy traps.
Headless Chrome also stringifies console arguments for its own log sink whether
or not CDP is attached, so `toString`-based probes report false positives in
every state. Verified against a raw CDP session with `Runtime.enable` as a
positive control. The smoke test therefore asserts the wire-level invariant —
`Runtime.enable` is attempted by Playwright and never forwarded — rather than a
page-level trap.

**A `launch` plugin costs a browser process.** Flags are per-process and plugin
sets are per-session, so a session contributing `--proxy-server` cannot share a
browser with one that does not. That is the right trade for an upstream proxy
and the wrong one for anything a surface could carry.

## How it works

A client connects to the proxy exactly as it would to Chrome. The proxy resolves
that connection's plugin set from its session token, draws the identity, dials
the upstream browser, and pipes messages through the plugin pipeline in both
directions. One client socket maps to exactly one browser socket, with all
targets multiplexed over it by CDP `sessionId` — the same "flatten" transport
`connectOverCDP` already uses.

| Module                | Role                                                                             |
| --------------------- | -------------------------------------------------------------------------------- |
| `proxy.ts`            | Orchestrator: serves the CDP surface, resolves upstream + plugins per connection |
| `proxy-connection.ts` | One client socket ↔ one browser socket: id remapping, target registry, pipeline  |
| `plugin.ts`           | `definePlugin`, `definePreset`, and the `Pipeline` that runs hooks in order      |
| `profile.ts`          | Drawing, reconciling, and sealing the identity a session claims                  |
| `coverage.ts`         | Which profile fields anything actually read, and what nothing carried            |
| `launch.ts`           | Merging every `launch` contribution into one process spec                        |
| `surface.ts`          | Compiling surfaces into a bundle, `Emulation.*` calls, headers, a display claim  |
| `realms.ts`           | Getting that bundle into pages, iframes, workers, and service workers            |
| `broker.ts`           | One owner for the CDP domains that only have room for one                        |
| `actor.ts`            | Per-page handles and the scheduling that keeps them off the message queue        |
| `session-manager.ts`  | Session tokens, isolation mode, concurrency ceiling                              |
| `browser-pool.ts`     | Browser sourcing: managed local instances, a remote endpoint, or a pool          |
| `debug.ts`            | The `CDP_DEBUG` tracer: filters, hook accounting, session summary                |
| `harness.ts`          | The test API: a real page, the profile, coverage, realms, the wire               |
| `sdk.ts`              | The user-facing `chromium.launch()` / `chromium.session()` / `rpc()`             |
| `core/`               | The always-installed tier: `contexts`, `generate`, `flags`                       |
| `plugins/`            | Everything authored on top: the stealth surfaces, loaders, actors, `recorder`    |

Five invariants keep it honest, all covered by tests:

- **Id remapping.** Client command ids and plugin-originated command ids share
  one upstream id space, so they can never collide. Responses are restored to
  the client's original id, and plugin traffic is never visible to the client.
- **Short-circuiting.** A plugin may answer a request itself, and the command is
  then never forwarded. That is exactly how `Runtime.enable` is suppressed.
- **Target ownership.** Chrome's auto-attach is browser-wide, so a shared
  browser offers every client every other client's pages. Each connection claims
  every context it creates — whether the client or one of its own plugins opened
  it — and releases the claim when that context is disposed, so a plugin can
  only configure its own session's targets. The browser's own default context is
  claimed by nobody and stays common ground. Dropping an attachment also means
  answering for it: clients auto-attach with `waitForDebuggerOnStart`, so a
  hidden target still has to be released or its real owner hangs on first
  navigation.
- **Identity coherence.** A profile is drawn whole, corrected once against the
  process that actually started, then frozen. Nothing can patch a field onto a
  row drawn from another machine, and every read is recorded so an unclaimed
  field is reported rather than discovered by a detector.
- **One owner per brokered domain.** `Fetch.enable`,
  `Network.setExtraHTTPHeaders`, `Target.setAutoAttach`, and
  `Emulation.setDeviceMetricsOverride` are whole-state: the second caller
  silently destroys the first one's settings. The broker unions every
  declaration — including the client's own calls — makes one call, and
  dispatches the results back, which is why `page.route()` and a surface's
  headers can both be in effect at once.

## Development

```sh
deno task dev        # run the proxy standalone, with file watching
deno task test       # everything, including the end-to-end smoke test
deno task test:unit  # fast inner loop: skips the test that needs a real browser
deno task smoke      # only the end-to-end test
```

Writing a plugin has three tasks of its own, and
[`docs/plugin-developer.md`](docs/plugin-developer.md) is the guide:

```sh
deno task plugins                      # every plugin, with the profile fields it reads
deno task new surface graphics/webgl   # scaffold a plugin and its test
deno task dev --plugin webgl           # headful, pinned profile, reloads on save
```

Feeding the identity pool has one more:

```sh
deno task capture --out fingerprints.jsonl --id my-laptop
```

It records a real machine's fingerprint from a headful Chrome — capture only on
hardware you own and are willing to be identified as, since a corpus row links
whoever draws it to that machine.

The smoke test drives a real browser through the full stack and skips itself
when no browser binary can be resolved. Its last step is the only one that
leaves the machine: it grades the browser against
[browserscan.net](https://www.browserscan.net) and skips itself when there is no
egress. `scratch/` holds throwaway probes used to pin down browser behaviour; it
is excluded from formatting and is not part of the build.

## License

MIT
