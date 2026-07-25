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

The main world is the hard part, because with the runtime disabled Chrome will
not tell us its id. The technique (ported from `rebrowser-patches`):

1. `Runtime.addBinding` with a random, throwaway name. A bound function reports
   its caller's `executionContextId` when invoked.
2. `Page.addScriptToEvaluateOnNewDocument` (with `runImmediately: true`, so it
   also lands in the *current* document) installs a listener in the main world
   that calls that binding.
3. `Page.createIsolatedWorld` + `Runtime.evaluate` dispatch a `CustomEvent` from
   the isolated world into the main world.
4. The listener fires, and the resulting `Runtime.bindingCalled` event carries the
   real main-world `executionContextId`.

The binding and the injected script are then **removed**. Leaving a random
function on `window` and a listener in every future document would itself be a
tell, and the next navigation derives a fresh pair anyway.

The derived ids are announced to the client as synthetic
`Runtime.executionContextCreated` events, and `Runtime.bindingCalled` for our own
binding is swallowed so the handshake never leaks.

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
sequence (`Page.enable`, `Runtime.addBinding`,
`Page.addScriptToEvaluateOnNewDocument`, `Page.createIsolatedWorld`,
`Runtime.evaluate`, `Emulation.setUserAgentOverride`), no `consoleAPICalled` was
ever delivered — confirming the derivation is genuinely runtime-free.

**`document.open()` does not destroy contexts.** It reuses the same global, and
Chrome emits neither `executionContextsCleared` nor `executionContextCreated`
around it, so no re-derivation is needed for `setContent`.

## Other tells handled

- **User-Agent.** `Browser.getVersion` is read once and `HeadlessChrome` rewritten
  to `Chrome`, applied via `Emulation.setUserAgentOverride` along with matching
  `userAgentMetadata` so `navigator.userAgentData.brands` agrees with the UA
  string.
- **`navigator.webdriver`.** Never set, because `--enable-automation` is
  deliberately absent from the launch flags (see `constants.ts`); that flag would
  set `navigator.webdriver = true` and show the automation infobar.
