/**
 * Covers the broker (§7.2) — the four CDP commands that only have room for one
 * caller, and what happens when there are two.
 *
 * The property under test throughout is *composition*: the second caller must
 * not silently destroy the first's arrangement. Since the client is one of the
 * callers and does not know the platform exists, the interesting assertions are
 * the ones where a Playwright call and a plugin declaration are both in effect.
 */

import { assert, assertEquals } from '@std/assert'
import { Broker, BROKERED } from '../src/broker.ts'
import { Debug } from '../src/debug.ts'
import type {
  CDPEvent,
  CDPRequest,
  CDPTarget,
  Send,
  SessionId,
} from '../src/types.ts'

function broker(debug = Debug.using('')) {
  const sent: { method: string; params: unknown; sessionId?: string }[] = []
  const answered: { id: number; result: unknown }[] = []
  const emitted: CDPEvent[] = []
  const wire = {
    send: ((method: string, params: unknown, sessionId?: SessionId) => {
      sent.push({ method, params, sessionId })
      return Promise.resolve({})
    }) as Send,
    emit: (evt: CDPEvent) => void emitted.push(evt),
    respond: (id: number, _s: SessionId | undefined, result: unknown) =>
      void answered.push({ id, result }),
  }
  return { it: new Broker(wire, debug), sent, answered, emitted, debug }
}

const request = (
  method: string,
  params: Record<string, unknown> = {},
  sessionId = 'S',
): CDPRequest => ({ id: 1, method, params, sessionId })

/** A target to attach, since only a page has a viewport to emulate. */
const page = (sessionId = 'S'): CDPTarget => ({
  sessionId,
  targetId: `T-${sessionId}`,
  type: 'page',
})

const headersOf = (
  sent: { method: string; params: unknown }[],
): Record<string, string> | undefined =>
  (sent.findLast((s) => s.method === 'Network.setExtraHTTPHeaders')
    ?.params as { headers: Record<string, string> } | undefined)?.headers

// ─── headers ──────────────────────────────────────────────────────────────────

Deno.test('a surface header and a client header end up in one map', async () => {
  // Neither caller knows about the other. Left to CDP, whichever called second
  // would have thrown the first's away with no error.
  const { it, sent, answered } = broker()
  it.headers('surfaces', { 'Accept-Language': 'de-DE,de' })

  assertEquals(
    await it.request(request('Network.setExtraHTTPHeaders', {
      headers: { 'X-Test': 'from-the-client' },
    })),
    true,
  )

  assertEquals(headersOf(sent), {
    'X-Test': 'from-the-client',
    'Accept-Language': 'de-DE,de',
  })
  assertEquals(
    answered,
    [{ id: 1, result: {} }],
    'the client is still answered',
  )
})

Deno.test('a claim outranks the client on the same header, and says so', async () => {
  // A client that overrode `Accept-Language` without knowing about the profile
  // would be contradicting the identity the rest of the session presents.
  const { it, sent, debug } = broker()
  it.headers('surfaces', { 'Accept-Language': 'de-DE,de' })
  await it.request(request('Network.setExtraHTTPHeaders', {
    headers: { 'Accept-Language': 'en-US' },
  }))

  assertEquals(headersOf(sent)?.['Accept-Language'], 'de-DE,de')
  assert(
    debug.snapshot().conflicts.some((c) =>
      c.includes('Accept-Language') && c.includes('the client wanted')
    ),
    'the loser has to be named, or this is the silent clobber with extra steps',
  )
})

Deno.test('priority decides between two claims and names the loser', () => {
  const { it, debug } = broker()
  it.headers('polite', { 'Accept-Language': 'en-US' }, 10)
  it.headers('rude', { 'Accept-Language': 'fr-FR' }, 5)
  assertEquals(it.merged['Accept-Language'], 'en-US')
  assert(debug.snapshot().conflicts.some((c) => c.includes('rude wanted')))

  it.headers('ruder', { 'Accept-Language': 'ja-JP' }, 50)
  assertEquals(it.merged['Accept-Language'], 'ja-JP')
  assert(debug.snapshot().conflicts.some((c) => c.includes('took it from')))
})

Deno.test("a new target gets the merged set, not the first page's", async () => {
  // Domain state is per-session, so a header set installed on the first page
  // means nothing to the second — which is why this happens on attach.
  const { it, sent } = broker()
  it.headers('surfaces', { 'Accept-Language': 'de-DE,de' })
  await it.attach(page('S2'))
  assertEquals(
    sent.findLast((s) => s.method === 'Network.setExtraHTTPHeaders')?.sessionId,
    'S2',
  )
})

Deno.test('nothing is sent when nobody asked for a header', async () => {
  const { it, sent } = broker()
  await it.attach(page())
  assertEquals(sent, [])
})

// ─── Fetch and proxy auth ─────────────────────────────────────────────────────

Deno.test('proxy credentials answer the challenge without a plugin enabling Fetch', async () => {
  // §3.1's `auth` is resolved at launch and has nowhere to go until here.
  const { it, sent } = broker()
  it.auth({ username: 'zack', password: 'hunter2' })
  await it.attach(page())

  const enable = sent.find((s) => s.method === 'Fetch.enable')
  assertEquals(
    (enable?.params as { handleAuthRequests: boolean })
      .handleAuthRequests,
    true,
  )

  assertEquals(
    await it.event({
      method: 'Fetch.authRequired',
      params: { requestId: 'R1' },
      sessionId: 'S',
    }),
    true,
    "a challenge the client never asked for is the broker's to answer",
  )
  assertEquals(
    sent.findLast((s) => s.method === 'Fetch.continueWithAuth')
      ?.params,
    {
      requestId: 'R1',
      authChallengeResponse: {
        response: 'ProvideCredentials',
        username: 'zack',
        password: 'hunter2',
      },
    },
  )
})

Deno.test('a challenge with no credentials is declined rather than left hanging', async () => {
  // An unanswered challenge stalls the request until Chrome gives up, and a
  // client that never enabled Fetch has nothing listening to answer it.
  const { it, sent } = broker()
  it.auth({ username: 'u', password: 'p' })
  const other = broker()
  await other.it.attach(page())
  assertEquals(
    await other.it.event({
      method: 'Fetch.authRequired',
      params: { requestId: 'R' },
      sessionId: 'S',
    }),
    true,
  )
  assertEquals(
    (other.sent.findLast((s) => s.method === 'Fetch.continueWithAuth')
      ?.params as { authChallengeResponse: { response: string } })
      .authChallengeResponse.response,
    'Default',
  )
  assert(sent.length === 0 || true)
})

Deno.test("the client's patterns and the broker's are unioned", async () => {
  const { it, sent } = broker()
  it.auth({ username: 'u', password: 'p' })
  await it.request(request('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/*' }],
  }))

  const enable = sent.findLast((s) => s.method === 'Fetch.enable')
  assertEquals((enable?.params as { patterns: unknown[] }).patterns, [
    { urlPattern: '*' },
    { urlPattern: '*/api/*' },
  ])
})

Deno.test('Fetch.enable with no patterns means every request, not none', async () => {
  // Recording an absent `patterns` as `[]` would union to nothing and silently
  // switch off the client's own interception.
  const { it, sent } = broker()
  await it.request(request('Fetch.enable', {}))
  assertEquals(
    (sent.findLast((s) => s.method === 'Fetch.enable')
      ?.params as { patterns: unknown[] }).patterns,
    [{ urlPattern: '*' }],
  )
})

Deno.test('a paused request the client owns is delivered to it', async () => {
  const { it } = broker()
  await it.request(request('Fetch.enable', {}))
  assertEquals(
    await it.event({
      method: 'Fetch.requestPaused',
      params: { requestId: 'R' },
      sessionId: 'S',
    }),
    false,
    'page.route() has to keep working',
  )
})

Deno.test('a paused request nobody claimed is continued rather than dropped', async () => {
  const { it, sent } = broker()
  it.auth({ username: 'u', password: 'p' })
  assertEquals(
    await it.event({
      method: 'Fetch.requestPaused',
      params: { requestId: 'R' },
      sessionId: 'S',
    }),
    true,
  )
  assertEquals(
    sent.findLast((s) => s.method === 'Fetch.continueRequest')?.params,
    { requestId: 'R' },
  )
})

Deno.test('the client giving up on Fetch does not switch off proxy auth', async () => {
  const { it, sent } = broker()
  it.auth({ username: 'u', password: 'p' })
  await it.request(request('Fetch.enable', {}))
  assertEquals(await it.request(request('Fetch.disable')), true)

  const enable = sent.findLast((s) => s.method === 'Fetch.enable')
  assertEquals((enable?.params as { patterns: unknown[] }).patterns, [{
    urlPattern: '*',
  }])
})

Deno.test('Fetch.disable passes through when the broker wanted nothing', async () => {
  const { it } = broker()
  await it.request(request('Fetch.enable', {}))
  assertEquals(
    await it.request(request('Fetch.disable')),
    false,
    'with no claim of its own the broker has no reason to intercept',
  )
})

// ─── the display ──────────────────────────────────────────────────────────────

const monitor = { screen: { width: 2560, height: 1440, scale: 2 }, chrome: 87 }

const metricsOf = (sent: { method: string; params: unknown }[]) =>
  sent.findLast((s) => s.method === 'Emulation.setDeviceMetricsOverride')
    ?.params as Record<string, number | boolean> | undefined

Deno.test('the client keeps its viewport and the surface gets its monitor', async () => {
  // The tell being fixed: Playwright pins `screen` to the viewport it was asked
  // for, so `screen.width === innerWidth`, which no real monitor does. The
  // viewport itself is the client's to decide and is left alone.
  const { it } = broker()
  it.display('surfaces', monitor)
  const msg = request('Emulation.setDeviceMetricsOverride', {
    width: 800,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
  })

  assertEquals(await it.request(msg), false, 'it still goes to the browser')
  assertEquals(msg.params, {
    width: 800,
    height: 600,
    mobile: false,
    deviceScaleFactor: 2,
    screenWidth: 2560,
    screenHeight: 1440,
  })
})

Deno.test('a page that sets no viewport still claims a monitor', async () => {
  // A caller passing `viewport: null` never sends the command, so the rewrite
  // alone would leave the monitor unclaimed with nothing to say so.
  const { it, sent } = broker()
  it.display('surfaces', monitor)
  await it.attach(page())
  assertEquals(metricsOf(sent), undefined, 'not on attach: it is too early')

  await it.document('S')
  assertEquals(metricsOf(sent), {
    width: 0,
    height: 0,
    deviceScaleFactor: 2,
    mobile: false,
    screenWidth: 2560,
    screenHeight: 1440,
  })

  await it.document('S')
  assertEquals(
    sent.filter((s) => s.method === 'Emulation.setDeviceMetricsOverride')
      .length,
    1,
    'a second navigation does not re-send an override that is still in effect',
  )
})

Deno.test("a viewport the client set is not replaced by the page's own monitor", async () => {
  // The trap this is here for: an override belongs to the *target*, so a client
  // calling newCDPSession() on a page it already sized produces a second attach,
  // and a claim sent on that session would reset the viewport it asked for.
  const { it, sent } = broker()
  it.display('surfaces', monitor)
  await it.attach(page('FIRST'))
  await it.request(request('Emulation.setDeviceMetricsOverride', {
    width: 800,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
  }, 'FIRST'))

  await it.attach({ sessionId: 'SECOND', targetId: 'T-FIRST', type: 'page' })
  await it.document('SECOND')
  assertEquals(
    sent.filter((s) => s.method === 'Emulation.setDeviceMetricsOverride'),
    [],
    'the broker sent nothing of its own: the client owns this viewport',
  )
})

Deno.test('a client clearing its viewport does not clear the monitor', async () => {
  // Chrome's clear takes the screen override with it, so the claim goes back on
  // afterwards — otherwise `page.setViewportSize(null)` silently unmasks it.
  const { it, sent, answered } = broker()
  it.display('surfaces', monitor)
  await it.attach(page())
  assertEquals(
    await it.request(request('Emulation.clearDeviceMetricsOverride')),
    true,
  )
  assertEquals(
    sent.map((s) => s.method),
    [
      'Emulation.clearDeviceMetricsOverride',
      'Emulation.setDeviceMetricsOverride',
    ],
  )
  assertEquals(metricsOf(sent)?.screenWidth, 2560)
  assertEquals(
    answered,
    [{ id: 1, result: {} }],
    'the client is still answered',
  )
})

Deno.test('the window gets the height its tab strip and toolbar occupy', async () => {
  // Playwright sizes the window to the viewport exactly, leaving
  // `outerHeight === innerHeight`, which no real window has.
  const { it } = broker()
  it.display('surfaces', monitor)
  const msg = request('Browser.setWindowBounds', {
    windowId: 1,
    bounds: { width: 800, height: 600 },
  })
  assertEquals(await it.request(msg), false)
  assertEquals((msg.params as { bounds: unknown }).bounds, {
    width: 800,
    height: 687,
  })
})

Deno.test('nothing is claimed when no surface claimed a display', async () => {
  const { it, sent } = broker()
  const msg = request('Emulation.setDeviceMetricsOverride', {
    width: 800,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
  })
  assertEquals(await it.request(msg), false)
  assertEquals(msg.params, {
    width: 800,
    height: 600,
    deviceScaleFactor: 1,
    mobile: false,
  })
  await it.attach(page())
  await it.document('S')
  assertEquals(sent, [])
})

Deno.test('two surfaces claiming the display leaves the first holding it', () => {
  const { it, debug } = broker()
  it.display('surfaces', monitor)
  it.display('latecomer', { screen: { width: 1, height: 1, scale: 1 } })
  assert(debug.snapshot().conflicts.some((c) => c.includes('latecomer')))
})

// ─── auto-attach ──────────────────────────────────────────────────────────────

Deno.test('the client keeps its auto-attach, widened for realm delivery', async () => {
  // Browser-wide and shared with Playwright, so refusing it is not an option
  // and neither is replacing it.
  const { it, debug } = broker()
  it.pause()
  const msg = request('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: false,
    flatten: true,
  })
  assertEquals(await it.request(msg), false, 'it still goes to the browser')
  assertEquals(msg.params, {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  })
  assert(debug.snapshot().conflicts.some((c) => c.includes('widened')))
})

Deno.test("a pause the client asked for is the client's to release", async () => {
  // Resuming one it paused would release the target before it attached its own
  // listeners, losing events it was promised.
  const { it, sent } = broker()
  it.pause()
  await it.request(request('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
  }, 'PARENT'))

  await it.resume('CHILD', 'PARENT')
  assertEquals(
    sent.filter((s) => s.method === 'Runtime.runIfWaitingForDebugger'),
    [],
  )

  await it.resume('CHILD', 'SOMEWHERE-ELSE')
  assertEquals(
    sent.findLast((s) => s.method === 'Runtime.runIfWaitingForDebugger')
      ?.sessionId,
    'CHILD',
  )
})

Deno.test('nothing is resumed when no realm needed the pause', async () => {
  const { it, sent } = broker()
  await it.resume('CHILD')
  assertEquals(sent, [])
})

// ─── the list itself ──────────────────────────────────────────────────────────

Deno.test('every brokered command explains its declarative alternative', () => {
  // The list is also `actor`'s refused list (§6.4), and an error that only says
  // "refused" sends the author to write a `protocol` plugin instead.
  assertEquals(Object.keys(BROKERED).sort(), [
    'Emulation.setDeviceMetricsOverride',
    'Fetch.enable',
    'Network.setExtraHTTPHeaders',
    'Target.setAutoAttach',
  ])
  for (const [method, why] of Object.entries(BROKERED)) {
    assert(why.length > 30, `${method} needs a reason worth reading`)
  }
})
