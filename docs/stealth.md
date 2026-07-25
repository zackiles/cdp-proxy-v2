# The stealth plugin

`plugins/stealth.ts` mirrors what `rebrowser-patches` achieves by forking
Playwright, but does it at the CDP network layer. This document records how it
works and — more importantly — the browser behaviour that was measured to get
there, so the next person does not have to rediscover it.

## The problem

Playwright calls `Runtime.enable` on every page so Chrome will announce execution
contexts via `Runtime.executionContextCreated`; Playwright needs those ids to
evaluate anything. But enabling the Runtime domain also makes Chrome serialize
console arguments and report console activity, which is the long-standing
fingerprint for "a DevTools client is attached".

So the plugin never forwards `Runtime.enable`. It answers the command itself and
then supplies, by hand, the context ids Playwright would have learned.

## Supplying the contexts

Playwright needs two worlds per frame:

- **the main world**, where `page.evaluate()` runs;
- **a utility world** named `__playwright_utility_world__`, where selector
  queries, `page.title()`, and most internals run.

The utility world is easy: `Page.createIsolatedWorld` with that name returns an
id we can announce.

The main world is the hard part, because with the runtime disabled Chrome will not
tell us its id. But it does not have to: a remote object's `objectId` has the form
`<isolate>.<context>.<n>`, so **any handle into a frame names that frame's world**.
Two calls are enough, and neither needs `Runtime.enable`:

- **the top frame**: `Runtime.evaluate` with `expression: 'self'`. The reply's
  `objectId` carries the id.
- **a subframe**: `DOM.getFrameOwner` → `DOM.describeNode` (pierced, for the
  content document) → `DOM.resolveNode`. With no `executionContextId` passed,
  `DOM.resolveNode` resolves the node in **its own frame's** default world, which
  is the only way to name a subframe's main world from outside. Works for
  cross-origin subframes too.

The handle is released with `Runtime.releaseObject` — it is invisible to the page,
but holding it would pin the frame's objects for the life of the session.

The derived ids are announced to the client as synthetic
`Runtime.executionContextCreated` events.

### The binding this replaced

The original technique (ported from `rebrowser-patches`) installed a
`Runtime.addBinding` under a random `__pw_*` name plus an on-new-document listener,
had an isolated world poke it with a `CustomEvent`, and read the id off the
resulting `Runtime.bindingCalled`. It worked, and it removed the binding afterwards
— but `Runtime.removeBinding` only stops *future* contexts receiving the binding.
**The function it already installed stays on `window` for the life of the
document.** Measured on a stock stealth session, every page carried one or two
`__pw_<hex>` globals, permanently, and they accumulated across navigations.

That is a worse tell than the one the plugin exists to remove: uniquely named,
enumerable in one line with `Object.getOwnPropertyNames(window)`, and prefixed with
Playwright's own initials. The handle-based derivation touches nothing in the page,
costs two round trips instead of six, and is covered by a smoke assertion that no
`__`-prefixed global survives a navigation.

### Why there is no binding helper either

The obvious follow-up is a `ctx.bind` helper that gets the disposal right so plugin
authors do not have to. Measured against Chrome 147 on a session with the runtime
disabled, there is nothing to get right:

| Measurement | Result |
| --- | --- |
| `addBinding({ name })`, then read `window` | the function is there |
| `removeBinding({ name })`, then read `window` | **still there** |
| `Runtime.evaluate('delete self[name]')` | gone — the only way to remove it |
| `addBinding`, navigate, then read `window` | **gone, and the channel is dead** |
| `addBinding({ executionContextName })` + inject into that world | never fires, across three navigations |
| the same, after one `Runtime.enable` | fires |

So without `Runtime.enable` a binding reaches only the contexts that already exist
and dies at the next navigation, and scoping it to an isolated world does not work
at all. A binding channel is therefore either quietly broken or it announces the
session — a wrapper cannot fix either, so none is offered.

What plugins get instead is `ctx.inject`, which does work cold: a script injected
with a `worldName` runs in a fresh isolated world on **every** document with the
runtime disabled, and leaves nothing in the page's own world. Reading a value back
means evaluating in that world rather than being pushed to, which is a round trip
the plugin initiates instead of a global the page can find.

## Navigation and subframes

A new document means new contexts. The plugin listens on the runtime's derived
`onDocument` hook, which fires for **every** frame that commits a document, and
derives both worlds for that frame.

Four details matter:

- **Every frame, not just the top one.** A page's iframes each need their own pair
  of worlds. Playwright's utility world backs all selector queries, so a subframe
  without contexts makes `frameLocator(...)` and `frame.evaluate(...)` hang until
  timeout with no error — the same class of failure that sank v1. Bookkeeping is
  therefore keyed by frame, and setup walks `Page.getFrameTree` so iframes that
  already exist when the client enables the runtime are covered too.
- **De-duplicate.** Announcing the same context id twice makes Playwright treat
  the second announcement as the context being destroyed, and every later
  evaluation fails with "Execution context was destroyed". Ids are tracked per
  frame and only announced once.
- **Provide once per document.** Work is keyed by `loaderId`, so the initial setup
  and an `onDocument` for the same document do not each pay for a derivation.
- **Retract what died.** A top-frame commit destroys every context in the page, so
  the plugin emits `Runtime.executionContextsCleared` and forgets the whole tree.
  A subframe navigating alone only invalidates its own contexts, so those are
  retracted individually with `Runtime.executionContextDestroyed`. That event must
  carry `executionContextUniqueId` as well as the numeric id, because Playwright
  keys contexts by the unique id; announce and retract have to agree on its shape.

## Workers are left alone

`Runtime.enable` is only suppressed for `page` and `iframe` targets. A worker
target has no `Page` domain, so there is nothing to derive contexts from and no
console tell to hide. Suppressing it there answers Playwright's `Runtime.enable`
with a success it can never act on, and `worker.evaluate()` then waits for a
context that will never be announced — with no timeout, so it hangs forever rather
than failing. The target type comes from `ctx.targets`, which the runtime keeps in
sync from `Target.attachedToTarget`.

## Why `setContent` needed extra work

`Frame.setContent` (`playwright-core/lib/server/frames.js`) does this:

```js
const tag = `--playwright--set--content--${this._id}--${++this._setContentCounter}--`
this._page._frameManager._consoleMessageTags.set(tag, () => {
  this._onClearLifecycle()
  this._waitForLoadState(progress, waitUntil).then(resolve).catch(reject)
})
await context.evaluate(({ html, tag }) => {
  document.open()
  console.debug(tag)
  document.write(html)
  document.close()
}, { html, tag })
```

It waits for its own `console.debug(tag)` to arrive as a `Runtime.consoleAPICalled`
event before it clears the frame lifecycle. With the runtime suppressed that event
never comes, so `setContent` hangs for its full 30s timeout even though the
document was written correctly.

The plugin therefore watches for a `Runtime.evaluate`/`Runtime.callFunctionOn`
carrying that tag and replays the console event itself — the exact event Chrome
would have sent. It is emitted when the request passes through, which keeps it
ahead of the load events that follow `document.open()`; arriving after them would
leave Playwright waiting for a `load` that had already happened.

Playwright resolves the message text from the event's args, and a `RemoteObject`
with no `objectId` previews as `String(value)`, so `args: [{ type: 'string',
value: tag }]` reproduces it exactly. The `executionContextId` must be a context
Playwright knows; it is read from the call's `contextId`, or parsed out of the
middle field of its `objectId` (`<isolate>.<context>.<index>`).

## Measured browser behaviour

These were established experimentally against Chrome for Testing 147 with raw CDP
sockets (`scratch/probe-*.ts`), not assumed.

**The console-preview vector is closed in Chrome 147.** Using `Runtime.enable` as
a positive control and a bare session as baseline, none of these fired in *either*
state: a getter on an error's own `stack`, a getter on `Error.prototype.stack`, a
getter on a plain object property, an enumerable accessor on an array, a `Proxy`
`ownKeys` trap, or a `Proxy` `get` trap. Chrome no longer invokes accessors or
proxy traps when building console previews.

**`toString` probes are false positives.** Overriding `toString` on an error and
logging it fires in all states, including with the Runtime domain disabled,
because headless Chrome stringifies console arguments for its own log sink
regardless of CDP.

The consequence: on this Chrome, suppressing `Runtime.enable` cannot be validated
by a page-level probe. The smoke test asserts the wire-level invariant instead —
Playwright sends `Runtime.enable` and it never reaches the browser — which is the
property the plugin actually guarantees, and which holds regardless of which
console vectors a given Chrome version happens to expose.

**None of our own calls enable the runtime.** After running the full stealth
sequence (`Page.enable`, `Runtime.evaluate`, `DOM.resolveNode`,
`Page.createIsolatedWorld`, `Emulation.setUserAgentOverride`), no
`consoleAPICalled` was ever delivered — confirming the derivation is genuinely
runtime-free. `DOM.*` needs no explicit `DOM.enable` and, unlike `Runtime.enable`,
changes nothing the page can observe.

**`document.open()` does not destroy contexts.** It reuses the same global, and
Chrome emits neither `executionContextsCleared` nor `executionContextCreated`
around it, so no re-derivation is needed for `setContent`.

**`Page.addScriptToEvaluateOnNewDocument` needs `Page.enable` on the same CDP
session.** Without it the command succeeds, returns an identifier, and the script
then never runs — no error anywhere, and the world it names is never created.
Domain state is per-session in flatten mode, so the client having enabled `Page`
does not help. `ctx.inject` sends `Page.enable` itself for this reason.

## Other tells handled

- **User-Agent.** `Browser.getVersion` is read once and `HeadlessChrome` rewritten
  to `Chrome`, applied via `Emulation.setUserAgentOverride` along with matching
  `userAgentMetadata` so `navigator.userAgentData.brands` agrees with the UA
  string.
- **`navigator.webdriver`.** Never set, because `--enable-automation` is
  deliberately absent from the launch flags (see `constants.ts`); that flag would
  set `navigator.webdriver = true` and show the automation infobar.
- **`navigator.languages`.** Headless reports the single entry `['en-US']`. An
  `acceptLanguage` is passed with the UA override so the list has the shape
  Chrome's does. Note the value is `en-US,en`, *not* a real header's
  `en-US,en;q=0.9`: Chrome splits the string on commas to build
  `navigator.languages`, so the q-weight would show up as a literal language
  called `en;q=0.9`. Set it to match the country of whatever network proxy the
  session goes out through.
- **The display.** Playwright pins `screenWidth`/`screenHeight` to the viewport it
  was configured with, so headless reports `screen.width === innerWidth` — no real
  monitor is exactly the size of a browser viewport. The plugin rewrites those two
  fields (and `deviceScaleFactor`) on the client's own
  `Emulation.setDeviceMetricsOverride`, leaving the requested viewport untouched, so
  `page.viewportSize()` and screenshots are unaffected. Configure with
  `stealth({ screen: { width, height, scale } })`.
- **The window.** Playwright then sizes the window to the viewport exactly, leaving
  `outerHeight === innerHeight` — a Chrome window with no tab strip and no toolbar.
  Its `Browser.setWindowBounds` is rewritten to add the 88px those occupy. Doing it
  by rewriting Playwright's own call rather than issuing our own matters:
  `Browser.setWindowBounds` clears any metrics override in place, and Playwright
  sends the two back to back, so an override sent ahead of it would be discarded.
- **WebGL.** `--disable-gpu` leaves the page with *no* WebGL context at all, and
  every real Chrome has one, so `!!canvas.getContext('webgl')` is a one-line
  headless test. The flag is gone; `--use-gl=angle` keeps the genuine GPU renderer
  string (on this machine, `ANGLE (Apple, ANGLE Metal Renderer: Apple M4 Pro…)`)
  and `--enable-unsafe-swiftshader` lifts Chrome's block on software WebGL so a
  machine or container without a GPU still gets a context. Nothing is spoofed —
  the reported renderer is the real one.
