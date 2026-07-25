# CDP Proxy v2 — Final Implementation Plan

> Status: proposal for review (revision 2 — reframed around the end-user outcome).
> The product is **not** a proxy. It is a stealthy, plugin-configurable Playwright
> that a user imports and gets back a normal `Browser`/`Context`/`Page`. The proxy
> and plugin system are an invisible implementation detail. This is an evolution
> of `rebrowser` that avoids Playwright source-patching entirely by manipulating
> CDP at the network layer, and doubles as a platform for authoring CDP plugins.

---

## 0. Intent and the real product

Author's north star (rebrowser/rebrowser-patches issue #93, Feb 2025):

> "I created a MITM proxy server for CDP clients such as Playwright to intercept
> raw CDP commands between the client and browser... to approach 'patching'
> playwright at the network request level, as opposed to doing the code-patching
> you're all doing here. It's based on plugins that hook the requests/responses
> between playwright<->browser..."

The proxy is the *mechanism*. The **product** is the developer experience on top
of it. Everything in this plan is judged against one question: does it make the
two personas' outcomes effortless and transparent?

### Acceptance definition (product-level, supersedes the old single-script bar)

- **Automator**: `import`s one module, gets a normal Playwright `Browser`, drives
  one or more **isolated per-site sessions** concurrently at volume, with a chosen
  set of stealth/CDP plugins active, and never sees the proxy. Passes
  `bot-detector.rebrowser.net` / `brotector` / `are_you_a_bot` with stealth on;
  behaves like stock Playwright with it off. Runs **headless in the cloud** and
  **headful locally for debugging** from the same code. Can target a **managed,
  remote, or pooled** browser.
- **Plugin author**: writes a typed plugin in one file, configures it with typed
  options, tests it against a mock CDP stream and a real browser, and composes it
  with other plugins without ordering surprises.

---

## 0.1 Corrections verified against the current source (read before implementing)

Facts confirmed by reading the code. Earlier phrasing over-stated what already
works; treat these as required fixes/constraints, not assumptions.

1. **`http-handler.ts` does not forward to the browser — it self-fetches.**
   `handleHttp` does `await fetch(request)` where `request.url` is the *proxy's*
   own address. `browserHost`/`browserPort` are used only for span attributes and
   the response-body rewrite, never for the upstream fetch. As written, HTTP CDP
   endpoints (`/json/*`) loop back into the proxy instead of reaching the browser;
   only the `webSocketDebuggerUrl` body rewrite (`replaceInResponse`) works.
   **Fix (Phase 0): rebuild the request against the upstream**
   (`http://<browserHost>:<browserPort><path>`, preserving method/headers/body)
   before fetching. The current smoke test hides this because `main.ts` hands
   Playwright a `ws://` URL and connects directly, bypassing `/json/version`.

2. **The session token cannot ride the connect URL query string.** Playwright's
   `connectOverCDP(http…)` first GETs `/json/version`, then connects to the
   returned `webSocketDebuggerUrl`, discarding any query on the user URL; and
   `websocket-handler.ts` builds the upstream URL from `requestUrl.pathname` only
   (dropping the query — correct, since the browser must never see the token). Use
   `connectOverCDP(endpoint, { headers: { 'x-cdp-session': token } })` and read the
   token from the upgrade request headers (or connect a `ws://` URL directly).
   **This supersedes the `?s=<token>` shown in the diagrams below.**

3. **Headless is hard-coded.** `constants.ts` `BROWSER_LAUNCH_FLAGS` includes
   `--headless=new` and `browser-manager.ts` applies it unconditionally. The
   headful/headless switch (§9) requires making that flag conditional, not just
   adding a config value.

4. **The existing `CDPPlugin` interface in `types.ts` is superseded.** v2 currently
   defines `CDPPlugin` with `sendCommand`/`emitEvent` and a ctx-less
   `onRequest(request)`. The `definePlugin`/`PluginContext` model (§7) replaces it;
   `types.ts` will be rewritten, and `sessionToken` is a **new** identifier
   alongside the existing `ConnectionId`/`SessionId`/`TargetId`.

---

## 0.2 Empirical validation (raw-CDP probe against a real Chromium)

A throwaway raw-CDP probe was run against the Chromium in `.cache`
(133.0.6938.0, provisioned by the jsr installer) on macOS 26.5.1. Confirmed:

- **`/json/version` shape**: `webSocketDebuggerUrl =
  ws://<host>:<port>/devtools/browser/<guid>`. This is exactly what the proxy
  rewrites (swap host:port, keep path) and fronts — validates the http-handler
  rewrite target and §6.1.
- **Flatten works**: `Target.setAutoAttach({autoAttach:true, flatten:true})`
  succeeds on the browser socket — confirms the single-socket / `sessionId` model.
- **A concrete stealth tell**: the UA is `…HeadlessChrome/133.0.0.0…` and claims
  `Intel Mac OS X 10_15_7` on an arm64 host. A fingerprint/UA plugin (§8) must fix
  `HeadlessChrome`, the UA platform lie, and `navigator.webdriver`.
- **Not live-validated here**: `Runtime.enable`→`executionContextCreated`, sessionId
  event routing, and the `console.debug(error)` detection trap. This Chromium build
  **crashes the renderer and drops the CDP socket** (close code 0) on page/target
  attach under macOS 26.5.1. These flows are well-documented CDP behavior
  (chromedevtools.github.io — `Target`/`Runtime` domains) and corroborated by the
  v1 docs, so the design stands, but they must be validated on a stable browser/OS
  pairing in CI.
- **macOS gotcha**: the binary **crash-loops on launch until
  `com.apple.quarantine` is stripped** (`xattr -dr com.apple.quarantine <app>`).

Implications: browser-build ↔ OS compatibility is fragile, so **version pinning and
crash resilience are first-class** — reinforcing the jsr installer (§5.1), pool
health checks that recycle a browser whose socket drops, and remote browsers on a
known-good image. The proxy/`SessionManager` must **detect upstream socket death
and reap the session** rather than hang (the probe showed sends silently timing out
after the socket closed).

---

## 1. Personas and desired outcomes

### Persona A — the automator (dominant, optimize for this)
Automates bots across many websites. Wants:
- A drop-in Playwright that is stealthy by default and configurable per site.
- **The website/page is the first-class citizen.** Each site is an isolated
  session (own storage, cookies, fingerprint, plugin state; optionally own
  network proxy/IP and own browser process) so sites cannot correlate or
  contaminate each other.
- High concurrency; cloud-headless in prod, headful locally to debug.
- To point at a managed browser, a preconfigured remote Chromium, or a pool.
- Zero knowledge of CDP, sessions, or the proxy.

### Persona B — the plugin author
Extends/instruments CDP. Wants:
- A typed, documented plugin API with lifecycle + message hooks and a rich
  per-invocation context — not raw `sessionId` strings and hand-rolled maps.
- Typed CDP commands/events (via `devtools-protocol`).
- Per-session plugin instances with isolated state, typed config, and predictable
  composition/ordering with other plugins.

---

## 2. Product surfaces and layered architecture

Two imports, one for each persona. Everything below them is internal.

```
Persona A (automator)                    Persona B (plugin author)
  import { chromium } from '<sdk>'         import { definePlugin } from '<plugin-sdk>'
        │                                          │
        ▼                                          ▼
┌───────────────────────────── Client SDK (wrapper) ─────────────────────────────┐
│  returns STOCK Playwright objects; hides browser sourcing + proxy + plugin cfg  │
└───────────────────────────────────────────────────────────────────────────────┘
        │ connectOverCDP(endpoint, { headers: { 'x-cdp-session': <token> } })  // see §0.1.2
        ▼
┌──────────────────────────────── Proxy core ────────────────────────────────────┐
│  Router → per-connection ProxyConnection → Plugin pipeline (per-session insts)  │
│  flatten transport · id remap · session/target registry · custom-command RPC    │
└───────────────────────────────────────────────────────────────────────────────┘
        │ chooses upstream by session/pool
        ▼
┌──────────────────────── Browser sourcing (managed | remote | pool) ─────────────┐
│  BrowserManager (local, headful/headless) · Remote CDP endpoint · Browser pool  │
└───────────────────────────────────────────────────────────────────────────────┘
```

- **Layer 1 — Client SDK** (§3): the "import a Playwright" surface. A thin wrapper
  that returns **stock** Playwright objects (no fork, no source patch) already
  wired to the proxy with the caller's plugin config. This is the product.
- **Layer 2 — Session & isolation** (§4) and **Browser sourcing** (§5).
- **Layer 3 — Proxy core & transport** (§6): the flatten MITM, `ProxyConnection`,
  id remapping, custom-command RPC. (This is the strongest part of the previous
  revision and is largely preserved.)
- **Layer 4 — Plugin platform** (§7) and the **stealth reference plugin** (§8).

---

## 3. Layer 1 — Client SDK (the automator's whole world)

Ship a wrapper module that *feels* like Playwright but returns stealthy sessions.
It must return genuine Playwright objects so all existing Playwright code, typings,
and tooling work unchanged.

```ts
import { chromium, stealth, blockAds } from '<sdk>'

// Local debug: headful, one site.
const browser = await chromium.launch({
  headless: false,                 // default true (cloud); false locally to debug
  plugins: [stealth(), blockAds()], // per-session plugin set + typed config
})
const page = await browser.newPage()   // isolated site session under the hood
await page.goto('https://example.com')

// High volume: many isolated sites, each its own context/fingerprint/state.
const sites = urls.map((url) =>
  chromium.session({ plugins: [stealth({ mode: 'addBinding' })] })
    .then(async (s) => { await s.page.goto(url); /* ... */ ; await s.close() }),
)
await Promise.all(sites)
```

How the wrapper works (invisible to the user):
1. **Source a browser** (managed/remote/pool — §5).
2. **Register the plugin set** for this session with the proxy via an HTTP control
   endpoint; receive a short-lived **session token**.
3. **Connect** stock Playwright, passing the token via a connect **header**
   (`connectOverCDP(endpoint, { headers: { 'x-cdp-session': token } })`) — not a
   URL query string (see §0.1.2). The proxy reads the token from the upgrade
   request and instantiates that session's plugin instances with isolated state.
4. Return the resulting `Browser`/`BrowserContext`/`Page`. Nothing leaks.

Design decisions:
- **Wrapper, not a fork.** Preserves the project thesis (no source patching) and
  keeps Playwright upgrades trivial. The user's phrase "patched playwright module"
  is satisfied by a wrapper that transparently patches *behavior* over the wire.
- **`plugins` is the primary knob**, accepted at `launch()` and per `session()`,
  so config is **per site**, not global.
- Sensible defaults: `stealth()` on unless explicitly disabled; `headless: true`
  in cloud, overridable for local debugging.

---

## 4. Layer 2 — Session & isolation model (website = first-class)

Introduce a `Session` = one automated website, the unit of isolation and the unit
of plugin configuration. A `SessionManager` (lean; not v1's bloat) owns lifecycle:

- **Identity**: `sessionToken` (opaque, from the control endpoint) → `{ plugins,
  isolation, upstream }`. Distinct from CDP `sessionId` and proxy `connectionId`.
- **Isolation granularity** (config knob):
  - `context` (default): one Playwright `BrowserContext` per site inside a shared
    browser. Cheap, fast, isolated storage/cookies; supports per-context proxy +
    UA. Best for throughput.
  - `browser`: one browser process (own user-data-dir, own network proxy) per
    site. Strong isolation and distinct fingerprint per site — best when sites
    must not be correlatable. Drawn from the pool (§5).
- **Plugin-state isolation**: plugins are instantiated **per session** (factory
  model, §7), so no cross-site state bleed.
- **Concurrency**: max concurrent sessions, queueing/backpressure, per-session
  timeouts, and deterministic teardown (`session.close()` releases context/browser
  back to the pool and runs plugin `cleanup`).
- **Lifecycle events** surface to plugins (`onSessionStart`/`onSessionEnd`).

This is the abstraction the previous revision was missing: it makes "many isolated
bots at volume" a first-class capability rather than an afterthought.

---

## 5. Layer 2 — Browser sourcing: managed | remote | pool

Promoted from "non-goal" to first-class. All three modes resolve to the same
thing the proxy needs: an upstream browser WebSocket to front.

- **Managed (local)**: `src/browser-manager.ts` (a `chrome-launcher` wrapper)
  launches a browser and discovers its CDP URL. Headless is currently hard-coded
  (§0.1.3); make it a headful/headless switch. Used for local dev/debug and simple
  deployments.
- **Remote/preconfigured**: connect to an existing CDP endpoint (a browser already
  running elsewhere, e.g. a cloud browser). Config: `CDP_BROWSER_WS_ENDPOINT` /
  discovery URL. The proxy fronts it. The response-body `webSocketDebuggerUrl`
  rewrite is implemented, but the upstream **HTTP forward is currently broken**
  (§0.1.1) and must be fixed for `/json/*` discovery to work against a remote
  browser; WS forwarding already targets `browserHost:browserPort` correctly.
- **Pool**: a `BrowserPool` managing N upstreams (local and/or remote) with
  acquire/release, health checks, max-in-use, idle reaping, and recycle-after-N
  sessions (hygiene against fingerprint drift/leaks).

### 5.1 Two "browser-manager"s — installer vs launcher (do not conflate)
Two similarly named things; the earlier revision blurred them:
- **`@browser-tools/browser-manager` (jsr)** is an *installer* only —
  `install`/`remove`/`getLatestVersion`/`getInstallationHistory`. It downloads a
  version-pinned browser binary; it provisioned the Chromium in `.cache` (the
  `.installation-info` there is its output). It does **not** launch or speak CDP,
  and in v2 it is imported **only inside a commented block** in `main.ts` —
  provisioning is not wired into the live path.
- **`src/browser-manager.ts` (local)** is the *launcher* — a `chrome-launcher`
  wrapper that starts the browser and discovers `webSocketDebuggerUrl`. This is the
  live code path.

They are **complementary**, not a stalled extraction: the installer provisions a
binary at a version; the launcher (or a remote endpoint) runs it. Decision: keep
both — wire the jsr installer into pool provisioning (pin versions, de-quarantine
on macOS) in Phase 6, and use the launcher or a remote CDP URL to obtain a running
upstream. Do not try to replace the local launcher with the jsr package.

**Architecture: proxy-as-router-to-upstream.** A single proxy process fronts many
upstreams. Per client connection it resolves the upstream from the session token
(and pool policy) and opens exactly one browser WS — flatten stays intact
(one client WS ↔ one upstream WS). This gives remote + pooled browsers **without**
a proxy process per browser, and scales cleanly in the cloud.

---

## 6. Layer 3 — Proxy core & transport (largely preserved from rev 1)

### 6.1 The decision that makes it tractable: flatten-only, single socket per connection
Playwright's `connectOverCDP` uses CDP **flatten** mode: one WebSocket
(`/devtools/browser/<id>`), all targets/sessions multiplexed and distinguished by
a `sessionId` field. v2 already embraces this (it rejects `/devtools/page`). Rules:
- One client WS ↔ one upstream browser WS per connection.
- Route to a target by writing the `sessionId` field, never by opening another
  socket/endpoint. (v1 died on a per-`/devtools/page/<id>`-socket model that does
  not exist in the connection Playwright actually makes, plus an unfinished
  `sessionId`→`proxySessionId` rename.)

### 6.2 `ProxyConnection` (replaces stubbed `proxy-agent.ts`)
Owns, per client connection: `clientSocket`, `browserSocket`, `connectionId`,
`sessionToken`; the `targets`/`sessions` registry built from `Target.*` traffic;
**id remapping** (client id-space ↔ proxy id-space, with a disjoint high range for
plugin-originated commands); and minimal connect-time buffering only.

### 6.3 Data flow
- **client → browser**: parse → remap `id` → run `onRequest` chain (forward /
  `null` drop / `{respond}` short-circuit) → forward if not short-circuited.
- **browser → client**: parse → if the `id` is proxy-originated, resolve the
  plugin promise and **do not forward**; else map `id` back, run
  `onResponse`/`onEvent`, forward unless dropped.
- Maintain the session/target registry from `Target.attachedToTarget` /
  `detachedFromTarget`.

### 6.4 Correctness rules (from v1's failures — non-negotiable)
1. Never leak proxy-originated responses to the client (v1's silent bug).
2. A request short-circuit is a **response**, not an event (v1 emitted a
   response shaped as an event).
3. Preserve ordering: synthetic emissions sequenced inside the handler's async
   chain, never fire-and-forget.
4. Keep `sessionToken` (proxy session) vs CDP `sessionId` vs `connectionId`
   strictly distinct.

### 6.5 Custom-command RPC (issue #93 idea, now also the config channel)
Reserve a `Proxy.*` method namespace. A plugin (or the runtime) answers these via
`{respond}` without the browser seeing them. Used for the SDK↔proxy handshake
(e.g. `Proxy.hello`/config confirmation) and for exposing plugin features to
client code through Playwright's raw CDP `send`.

---

## 7. Layer 4 — The plugin platform (Persona B)

Elevate from "callbacks" to a real authoring platform.

### 7.1 Plugin shape: typed factory with a context object
Plugins are **factories** so each session gets a fresh, isolated instance:

```ts
export const stealth = definePlugin<StealthOptions>({
  name: 'stealth',
  defaults: { mode: 'addBinding' },
  setup(cfg) {
    // per-session state lives in this closure — isolated by construction
    return {
      async onRequest(msg, ctx) { /* ctx.send/emit, ctx.session, ctx.target */ },
      async onEvent(evt, ctx) { /* ... */ },
      async onSessionEnd(ctx) { /* cleanup */ },
    }
  },
})
```

- **`PluginContext` (`ctx`)** passed to every hook: `sessionToken`, CDP
  `sessionId`, `targetId`, `frameId?`, `connectionId`, site/isolation identity;
  plus `ctx.send(sessionId, method, params)` and `ctx.emit(sessionId, payload)`.
  This replaces rev-1's injected `this.sendCommand(sessionId, ...)` + manual maps.
- **Typed CDP**: `ctx.send` and message hooks are generic over the
  `devtools-protocol` types (already a dependency) — full autocomplete for
  methods/params/results.
- **Typed config**: `definePlugin<Options>` with `defaults`; validated at
  registration.

### 7.2 Hooks
- Message hooks: `onRequest` (→ forward | `null` | `{respond}`), `onResponse`,
  `onEvent` (→ message | `null`).
- Lifecycle hooks: `onSessionStart/onSessionEnd`, `onTargetAttached/Detached`,
  and derived higher-level `onPage`/`onFrame` so stealth-style plugins can act at
  the right moment (e.g. install init scripts on new document) without reverse-
  engineering raw `Target.*`/`Page.*` sequencing.

### 7.3 Matching, priority, composition
- **Matching/subscription** (v1 TODO): a plugin declares interest (method globs or
  a predicate) so the pipeline only invokes relevant plugins — perf + clarity at
  scale.
- **Priority**: explicit ordering when multiple plugins touch the same message.
- **Composition**: multiple stealth/CDP plugins stack predictably; the runtime
  guarantees deterministic order and documents short-circuit semantics.

### 7.4 Registration
- Programmatic: pass instances via SDK `plugins: [...]` (the primary path).
- Autoload: `./plugins` directory (`.ts`/`.js`, skip `*.disabled.*`) for
  server-side/global plugins.
- Per-session sets resolved from the session token, instantiated fresh per session.

---

## 8. Stealth reference plugin (the flagship)

Correct approach mirrors `rebrowser-patches`; you cannot merely fake
`Runtime.enable` (see v1's post-mortem). Summary (full detail retained from rev 1):

- **Defeat**: `Runtime.enable` on the main world emits `Runtime.consoleAPICalled`
  / trappable error serialization → automation tell.
- **Strategy**: give Playwright execution-context ids **without** enabling the
  runtime on the detectable main world.
  - `addBinding` (default): `Runtime.addBinding` +
    `Page.addScriptToEvaluateOnNewDocument`; on `Runtime.bindingCalled` derive the
    real context id; emit synthetic `Runtime.executionContextCreated`. Keeps
    main-world access.
  - `alwaysIsolated`: `Page.createIsolatedWorld`; hand over the isolated context
    id; pair with a `postMessage` bridge for main-world access.
- **Flow**: intercept client `Runtime.enable` → `{respond: {result:{}}}` (never
  forward); quietly enable machinery via `ctx.send`; on frame lifecycle create/
  derive contexts and emit synthetic context events (clear on `frameNavigated`);
  handle workers via `Target.*`; drop internal `bindingCalled` handshakes.
- **Fixes over v1's plugin**: no `proxySessionId`/`sessionId` confusion; flatten
  routing via `ctx.send(sessionId, …)` (not `/devtools/page/<id>`); real
  `{respond}` instead of event-shaped reply; ordered/awaited context creation.
- **Per-session isolation**: all state in the factory closure (§7.1), so
  concurrent sites never share stealth state.

Additional stealth/CDP plugins the platform should ship as examples: per-context
UA/fingerprint, `navigator.webdriver` scrub, block-lists/ad-block, request/
response mocking, and a session CDP-history recorder (v1 TODO).

---

## 9. Deployment & observability

- **Modes**: `headless: true` (cloud default) / `false` (local debug, optionally
  `slowMo`, devtools). Same automator code path for both.
- **Cloud**: proxy + pool colocated with browsers; SDK connects over the network;
  remote/pooled upstreams (§5).
- **Observability** (build on existing OTel): tag spans with `sessionToken`, site
  URL/host, isolation mode, upstream id, and plugin names; per-message spans
  (method/direction/sessionId). This is how high-volume cloud runs get debugged.
- **Structured session logs** (v1 TODO): optionally persist each session's
  Playwright→CDP command history for replay/analysis.

---

## 10. Packaging (platform, multi-package)

Following the author's pattern (`@browser-tools/browser-manager`,
`@zackiles/response-rewriter`):
- **proxy core** — proxy, `ProxyConnection`, plugin runtime, session/pool managers.
- **plugin SDK** — `definePlugin`, `PluginContext`, typed CDP re-exports.
- **client SDK** — the Playwright wrapper (the automator's import).
- **stealth plugins** — stealth + example plugins as their own package(s).

Keep one repo/workspace; publish independently. `mod.ts` becomes the core entry;
the client SDK is a separate export/package.

---

## 11. Phased roadmap

Each phase leaves `main` runnable and is independently testable.

- **Phase 0 — Cleanup & correctness fixes**: delete `proxy-agent.ts`; drop the
  dangling `WebSocketConnection` import in `shutdown-manager.ts`; remove commented
  scaffolding in `main.ts`; **fix `http-handler.ts` to forward to the upstream
  browser instead of self-fetching (§0.1.1)**; ensure compile.
- **Phase 1 — Plugin-aware transport**: `ProxyConnection` + id remap + session/
  target registry as a proven no-op pass-through; OTel message attributes.
- **Phase 2 — Plugin runtime**: `definePlugin`, `PluginContext`, pipeline
  (chains, error isolation, matching, priority), `ctx.send`/`ctx.emit`, typed CDP.
- **Phase 3 — Custom-command RPC + short-circuit**: `Proxy.*` namespace and
  `{respond}`; used later for the SDK handshake.
- **Phase 4 — Session & isolation**: `SessionManager`, session tokens, control
  endpoint, per-session plugin instances, context-level isolation, concurrency
  limits/teardown, and **upstream-death reaping** (close a session whose browser
  socket drops instead of hanging — see §0.2).
- **Phase 5 — Client SDK (automator surface)**: wrapper returning stock Playwright
  wired through the proxy; `plugins` config; headful/headless; `session()` API.
- **Phase 6 — Browser sourcing**: remote endpoint + `BrowserPool`; proxy-as-router
  upstream resolution; browser-level isolation option; wire the jsr installer for
  version-pinned provisioning + macOS de-quarantine (§5.1); pool health/recycle.
- **Phase 7 — Stealth plugin**: implement per §8; validate against detectors.
- **Phase 8 — Hardening & DX**: packaging split, docs (plugin authoring +
  automator quickstart), observability polish, soak/concurrency tests.

Rationale: the transport/runtime (1–3) must be correct first, but the **product
value (4–5) lands early** — an automator can get isolated, plugin-configured
sessions before the hardest plugin (stealth, 7) is done.

---

## 12. Testing & acceptance

- **Unit**: pipeline chains, matching/priority, id-remap round-trip, proxy-
  response swallowing, `{respond}`, session registry from mocked `Target.*`.
- **Integration (mock CDP)**: extend `test/websocket-handler.test.ts`; assert
  hooks fire and transforms/drops/synthetic responses behave.
- **SDK/UX (persona A)**: import wrapper → get `Page` → automate → works with
  plugins off (no regression) and on.
- **Isolation**: two concurrent sites; assert separate storage/cookies and **no
  plugin-state bleed**; distinct fingerprint in `browser` isolation mode.
- **Concurrency/soak**: N sessions in parallel; multi-frame/iframe/worker pages to
  catch stealth context races (v1's failure class); pool acquire/release/recycle.
- **Stealth acceptance**: `bot-detector.rebrowser.net`, `brotector`,
  `are_you_a_bot` pass with stealth on; `page.evaluate`/`waitForFunction` still
  work (main-world access, `addBinding`).
- **Deployment**: headful local and headless cloud from the same script; managed,
  remote, and pooled upstreams.

---

## 13. Component / file changes (high level)

| Area | Action |
|------|--------|
| `src/proxy-agent.ts` | **Delete** (→ `proxy-connection.ts`). |
| `src/proxy-connection.ts` | **New.** Per-connection transport, id remap, target registry, plugin dispatch. |
| `src/websocket-handler.ts` | Slim to upgrade + upstream connect + hand off to `ProxyConnection`; read session token from upgrade headers. |
| `src/http-handler.ts` | **Fix (§0.1.1).** Forward to `http://<browserHost>:<browserPort><path>` (rebuild request) instead of `fetch(request)` self-loop; keep the response-body rewrite. |
| `src/plugin/*` | **New.** `definePlugin`, `PluginContext`, pipeline (matching/priority), typed CDP. |
| `src/session-manager.ts` | **New (lean).** Sessions, tokens, isolation, concurrency, teardown. |
| `src/browser-pool.ts` | **New.** Pool + remote endpoint support; upstream resolution. |
| `src/control.ts` | **New.** HTTP control endpoint: register plugin set → session token. |
| `src/sdk/*` | **New.** Client wrapper returning stock Playwright (`launch`, `session`, `plugins`). |
| `src/config.ts` | Add isolation mode, headful/headless, remote endpoint, pool, plugins dir. |
| `src/shutdown-manager.ts` | Track `ProxyConnection`/sessions; drop dangling `WebSocketConnection` type. |
| `src/main.ts` | Remove dead scaffolding; wire runtime + control endpoint. |
| `src/mod.ts` | Real exports (core + plugin SDK); client SDK exported separately. |
| `plugins/stealth.ts` | **New.** Reference stealth plugin (§8). |
| `plugins/*.disabled.ts` | **New.** Examples (ad-block, UA/fingerprint, recorder). |
| `test/*` | Add pipeline, isolation, concurrency, SDK/UX, and detector tests. |
| `docs/*` | Automator quickstart + plugin authoring guide. |

---

## 14. Risks & mitigations

- **Product-layer scope creep.** The SDK/pool are large. Mitigate: land core
  transport/runtime first, ship context-level isolation before browser-level, and
  keep the pool minimal (acquire/release/health) initially.
- **Stealth brittleness / Playwright coupling.** Pin Playwright (already
  `1.50.1`), track rebrowser, gate releases on the detector suite.
- **Stealth context races** (v1's killer). Ordered/awaited context creation;
  multi-frame/worker soak test required.
- **Cross-site correlation at volume.** Per-session plugin instances +
  `browser`-mode isolation + per-context proxy/UA + pool recycling.
- **ID collision.** Client↔proxy remap + disjoint high range for plugin ids;
  unit-assert non-overlap.
- **Over-engineering (v1 regression).** Add machinery only when a test demands it;
  schema validation opt-in/off by default; keep `SessionManager` lean.
- **Browser build ↔ OS incompatibility & crashes** (observed: Chromium 133 drops
  the CDP socket on renderer ops under macOS 26.5.1; quarantine crash-loop).
  Mitigate: pin versions via the jsr installer, de-quarantine on macOS, pool health
  checks that recycle dead upstreams, `SessionManager` reaping on upstream socket
  close, and a CI matrix on known-good browser/OS pairs.

---

## 15. Decisions requested from reviewer

1. **Wrapper vs fork** for the automator import. Recommendation: **wrapper that
   returns stock Playwright** (preserves the no-source-patch thesis; trivial
   upgrades). Confirm.
2. **Default isolation granularity**: `context` (throughput) vs `browser`
   (strongest anti-correlation). Recommendation: **`context` default,
   `browser` opt-in** via config/pool.
3. **Per-session plugin config channel**: session token via a **connect header**
   + HTTP control endpoint (recommended; the URL query string is unreliable —
   §0.1.2) vs a `Proxy.configure` CDP handshake vs a dedicated proxy process per
   session. Recommendation: **token header + control endpoint.**
4. **Proxy topology**: single proxy as router to an upstream pool (recommended)
   vs one proxy per browser. Recommendation: **router-to-pool.**
5. **Stealth default mode**: `addBinding` (main-world access) vs `alwaysIsolated`.
   Recommendation: **`addBinding`.**
6. **ID handling**: full remap (recommended) vs high-range namespacing only.
7. **Packaging**: multi-package now vs single package with internal boundaries
   first. Recommendation: **single workspace, split when stable.**
8. **Schema validation**: opt-in debug only (recommended) vs drop.
