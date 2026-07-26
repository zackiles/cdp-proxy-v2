import { assert, assertEquals, assertRejects } from '@std/assert'
import { definePlugin, Pipeline } from '../src/plugin.ts'
import type {
  CDPRequest,
  ConfiguredPlugin,
  PluginContext,
} from '../src/types.ts'

type StubContext = PluginContext & { emitted: [string, unknown][] }

function stubContext(): StubContext {
  const emitted: [string, unknown][] = []
  const state = new Map<string, unknown>()
  // The typed send/emit signatures are generic over the CDP protocol, so the
  // stub is asserted into place once rather than reimplementing them.
  return {
    emitted,
    sessionToken: 'token',
    connectionId: 'conn',
    targets: new Map(),
    signal: new AbortController().signal,
    send: () => Promise.resolve({}),
    emit: (method: string, params: unknown) => emitted.push([method, params]),
    inject: () => Promise.resolve(() => Promise.resolve()),
    state: <T>(sessionId: string, init: () => T): T => {
      const key = sessionId
      if (!state.has(key)) state.set(key, init())
      return state.get(key) as T
    },
    log: () => {},
  } as unknown as StubContext
}

const request = (method: string, id = 1): CDPRequest => ({ id, method })

async function pipeline(plugins: ConfiguredPlugin[]) {
  const ctx = stubContext()
  return { ctx, pipe: await Pipeline.install(plugins, () => ctx) }
}

Deno.test('definePlugin merges defaults with per-call options', () => {
  const factory = definePlugin<{ mode: string; extra?: number }>({
    name: 'p',
    defaults: { mode: 'a' },
    setup: () => ({}),
  })

  assertEquals(factory.pluginName, 'p')
  assertEquals(factory().options, { mode: 'a' })
  assertEquals(factory({ mode: 'b', extra: 2 }).options, {
    mode: 'b',
    extra: 2,
  })
})

Deno.test('definePlugin match globs narrow which methods a plugin sees', () => {
  const configured = definePlugin({
    name: 'p',
    match: ['Runtime.*', 'Page.frameNavigated'],
    setup: () => ({}),
  })()

  assert(configured.matches('Runtime.enable'))
  assert(configured.matches('Page.frameNavigated'))
  assert(!configured.matches('Page.enable'))
  assert(!configured.matches('Network.enable'))
})

Deno.test('definePlugin without match sees every method', () => {
  const configured = definePlugin({ name: 'p', setup: () => ({}) })()
  assert(configured.matches('Anything.atAll'))
})

Deno.test('Pipeline runs onRequest in priority order and chains edits', async () => {
  const order: string[] = []
  const low = definePlugin({
    name: 'low',
    priority: 1,
    setup: () => ({
      onRequest(msg) {
        order.push('low')
        return { ...msg, params: { ...msg.params, low: true } }
      },
    }),
  })()
  const high = definePlugin({
    name: 'high',
    priority: 10,
    setup: () => ({
      onRequest(msg) {
        order.push('high')
        return { ...msg, params: { high: true } }
      },
    }),
  })()

  const { pipe } = await pipeline([low, high])
  const out = await pipe.onRequest(request('Runtime.enable'))

  assertEquals(order, ['high', 'low'])
  assertEquals((out as CDPRequest).params, { high: true, low: true })
})

Deno.test('Pipeline short-circuits on {respond} and skips later plugins', async () => {
  let laterRan = false
  const responder = definePlugin({
    name: 'responder',
    priority: 10,
    setup: () => ({ onRequest: () => ({ respond: { ok: true } }) }),
  })()
  const later = definePlugin({
    name: 'later',
    priority: 1,
    setup: () => ({
      onRequest: (msg) => {
        laterRan = true
        return msg
      },
    }),
  })()

  const { pipe } = await pipeline([responder, later])
  const out = await pipe.onRequest(request('Runtime.enable'))

  assertEquals(out, { respond: { ok: true } })
  assertEquals(laterRan, false)
})

Deno.test('a refused request is answered, never left unanswered', async () => {
  const dropper = definePlugin({
    name: 'drop',
    setup: () => ({ onRequest: () => null }),
  })()

  const { pipe } = await pipeline([dropper])
  const out = await pipe.onRequest(request('Runtime.enable'))

  assertEquals(out, {
    respond: {
      error: {
        code: -32000,
        message: 'Runtime.enable was refused by plugin "drop"',
      },
    },
  })
})

Deno.test('Pipeline treats a void onRequest as unmodified forward', async () => {
  const noop = definePlugin({
    name: 'noop',
    setup: () => ({ onRequest: () => {} }),
  })()

  const { pipe } = await pipeline([noop])
  const msg = request('Runtime.enable')
  assertEquals(await pipe.onRequest(msg), msg)
})

Deno.test('Pipeline only invokes plugins whose match accepts the method', async () => {
  const seen: string[] = []
  const scoped = definePlugin({
    name: 'scoped',
    match: ['Runtime.*'],
    setup: () => ({
      onRequest: (msg) => {
        seen.push(msg.method)
        return msg
      },
    }),
  })()

  const { pipe } = await pipeline([scoped])
  await pipe.onRequest(request('Runtime.enable'))
  await pipe.onRequest(request('Page.enable'))

  assertEquals(seen, ['Runtime.enable'])
})

Deno.test('Pipeline isolates a throwing hook and keeps the message flowing', async () => {
  const thrower = definePlugin({
    name: 'thrower',
    priority: 10,
    setup: () => ({
      onRequest: () => {
        throw new Error('boom')
      },
    }),
  })()
  const survivor = definePlugin({
    name: 'survivor',
    priority: 1,
    setup: () => ({
      onRequest: (msg) => ({ ...msg, params: { survived: true } }),
    }),
  })()

  const { pipe } = await pipeline([thrower, survivor])
  const out = await pipe.onRequest(request('Runtime.enable'))

  assertEquals((out as CDPRequest).params, { survived: true })
})

Deno.test('a plugin that cannot set up fails the whole session', async () => {
  const broken = definePlugin({
    name: 'broken',
    setup: () => {
      throw new Error('no dice')
    },
  })()
  const ok = definePlugin({ name: 'ok', setup: () => ({}) })()

  // Installing the rest and carrying on would leave the session claiming a
  // configuration it does not have.
  await assertRejects(
    () => pipeline([broken, ok]),
    Error,
    'plugin setup failed: broken (no dice)',
  )
})

Deno.test('an optional plugin that cannot set up is skipped', async () => {
  const broken = definePlugin({
    name: 'broken',
    optional: true,
    setup: () => {
      throw new Error('no dice')
    },
  })()
  const ok = definePlugin({ name: 'ok', setup: () => ({}) })()

  const { pipe } = await pipeline([broken, ok])
  assertEquals(pipe.names, ['ok'])
})

Deno.test('Pipeline chains and can drop responses and events', async () => {
  const plugin = definePlugin({
    name: 'p',
    setup: () => ({
      onResponse: (msg) => ({ ...msg, result: { patched: true } }),
      onEvent: (evt) => (evt.method === 'Runtime.bindingCalled' ? null : evt),
    }),
  })()

  const { pipe } = await pipeline([plugin])

  const response = await pipe.onResponse({ id: 7, result: { original: true } })
  assertEquals(response?.result, { patched: true })

  assertEquals(await pipe.onEvent({ method: 'Runtime.bindingCalled' }), null)
  assertEquals(
    (await pipe.onEvent({ method: 'Page.loadEventFired' }))?.method,
    'Page.loadEventFired',
  )
})

Deno.test('Pipeline drives lifecycle and target hooks', async () => {
  const calls: string[] = []
  const plugin = definePlugin({
    name: 'p',
    setup: () => ({
      onSessionStart: () => void calls.push('start'),
      onSessionEnd: () => void calls.push('end'),
      onTargetAttached: (t) => void calls.push(`attach:${t.targetId}`),
      onTargetDetached: (t) => void calls.push(`detach:${t.targetId}`),
    }),
  })()

  const { pipe } = await pipeline([plugin])
  const target = { sessionId: 's', targetId: 't', type: 'page' }
  await pipe.onSessionStart()
  await pipe.onTargetAttached(target)
  await pipe.onTargetDetached(target)
  await pipe.onSessionEnd()

  assertEquals(calls, ['start', 'attach:t', 'detach:t', 'end'])
})

Deno.test('a declared method is answered by the plugin that declared it', async () => {
  const plugin = definePlugin({
    name: 'history',
    // The glob is the point: a declared method bypasses `match`, which is the
    // trap the declaration replaces (§7.3).
    match: ['Page.*'],
    setup: () => ({
      rpc: {
        'Proxy.history': (params: Record<string, unknown>) => ({
          entries: [params.url],
        }),
      },
    }),
  })()

  const { pipe } = await pipeline([plugin])
  assertEquals(pipe.rpc, ['Proxy.history'])
  assertEquals(await pipe.answer('Proxy.history', { url: '/a' }), {
    entries: ['/a'],
  })
  assertEquals(await pipe.answer('Proxy.nobody', {}), undefined)
})

Deno.test('two plugins declaring one method fail the session at install', async () => {
  const claim = (name: string) =>
    definePlugin({
      name,
      setup: () => ({ rpc: { 'Proxy.history': () => ({}) } }),
    })()

  await assertRejects(
    () => pipeline([claim('first'), claim('second')]),
    Error,
    'both declare Proxy.history',
  )
})

Deno.test('a declared method that throws answers an error, not a hang', async () => {
  const plugin = definePlugin({
    name: 'brittle',
    setup: () => ({
      rpc: {
        'Proxy.brittle': () => {
          throw new Error('nope')
        },
      },
    }),
  })()

  const { pipe } = await pipeline([plugin])
  const answer = await pipe.answer('Proxy.brittle', {}) as {
    error: { message: string }
  }
  assertEquals(answer.error.message, 'brittle failed to answer Proxy.brittle')
})

Deno.test('plugin setup receives resolved options and a usable context', async () => {
  let received: unknown
  const plugin = definePlugin<{ mode: string }>({
    name: 'p',
    defaults: { mode: 'a' },
    setup: (cfg, ctx) => {
      received = cfg
      ctx.emit('Runtime.executionContextsCleared', {})
      return {}
    },
  })({ mode: 'b' })

  const { ctx } = await pipeline([plugin])
  assertEquals(received, { mode: 'b' })
  assertEquals(ctx.emitted, [['Runtime.executionContextsCleared', {}]])
})
