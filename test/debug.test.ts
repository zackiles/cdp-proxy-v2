import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { Debug } from '../src/debug.ts'
import { definePlugin, Pipeline } from '../src/plugin.ts'
import type { CDPRequest, PluginContext } from '../src/types.ts'

/** Collect everything written to the console while `fn` runs. */
async function captured(fn: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const sinks = ['error', 'warn', 'info', 'debug'] as const
  const originals = sinks.map((name) => [name, console[name]] as const)
  for (const name of sinks) {
    console[name] = (...args: unknown[]) =>
      lines.push(args.map(String).join(' '))
  }
  try {
    await fn()
  } finally {
    for (const [name, original] of originals) console[name] = original
  }
  return lines
}

const ctx = () =>
  ({
    sessionToken: 'token',
    connectionId: 'conn',
    targets: new Map(),
    signal: new AbortController().signal,
    send: () => Promise.resolve({}),
    emit: () => {},
    log: () => {},
  }) as unknown as PluginContext

const request = (method: string, id = 1): CDPRequest => ({ id, method })

Deno.test('no spec means no tracing and no cost', () => {
  const debug = Debug.using('')
  assertEquals(debug.enabled, false)
})

Deno.test('a spec of 1 traces every source and method', async () => {
  const lines = await captured(() => {
    const debug = Debug.using('1')
    assert(debug.enabled)
    debug.trace('proxy', 'Page.enable', 'wire line')
    debug.trace('anything', 'Whatever.method', 'plugin line')
  })
  assertEquals(lines.length, 2)
})

Deno.test('a spec filters by source and by method glob', async () => {
  const lines = await captured(() => {
    const debug = Debug.using('stealth:Runtime.*,proxy')
    debug.trace('stealth', 'Runtime.enable', 'kept: matching plugin and method')
    debug.trace('stealth', 'Page.enable', 'dropped: wrong method')
    debug.trace('recorder', 'Runtime.enable', 'dropped: wrong plugin')
    debug.trace('proxy', 'Page.enable', 'kept: proxy matches any method')
  })

  assertEquals(lines.length, 2)
  assertStringIncludes(lines[0], 'matching plugin and method')
  assertStringIncludes(lines[1], 'proxy matches any method')
})

Deno.test('the install report names order, priority, hooks and globs', async () => {
  const lines = await captured(async () => {
    await Pipeline.install(
      [
        definePlugin({
          name: 'low',
          priority: 1,
          setup: () => ({ onEvent: (e) => e }),
        })(),
        definePlugin({
          name: 'high',
          priority: 90,
          match: ['Runtime.*'],
          setup: () => ({ onRequest: (m) => m }),
        })(),
      ],
      ctx,
      Debug.using('1'),
    )
  })

  const report = lines.join('\n')
  assertStringIncludes(report, 'pipeline protocol: high(90) → low(1)')
  assertStringIncludes(report, 'high hooks=onRequest match=Runtime.*')
  assertStringIncludes(report, 'low hooks=onEvent match=*')
})

Deno.test('each plugin decision is traced with its outcome', async () => {
  const lines = await captured(async () => {
    const pipe = await Pipeline.install(
      [
        definePlugin({
          name: 'answer',
          priority: 10,
          setup: () => ({ onRequest: () => ({ respond: {} }) }),
        })(),
      ],
      ctx,
      Debug.using('answer'),
    )
    await pipe.onRequest(request('Runtime.enable'))
  })

  assertStringIncludes(
    lines.join('\n'),
    'answer onRequest respond Runtime.enable',
  )
})

Deno.test('a thrown hook traces as an error, not as a pass', async () => {
  const lines = await captured(async () => {
    const pipe = await Pipeline.install(
      [
        definePlugin({
          name: 'thrower',
          setup: () => ({
            onRequest: () => {
              throw new Error('nope')
            },
          }),
        })(),
      ],
      ctx,
      Debug.using('thrower'),
    )
    // The message must still be forwarded: one bad plugin cannot break the wire.
    const outcome = await pipe.onRequest(request('Page.enable'))
    assertEquals((outcome as CDPRequest).method, 'Page.enable')
  })

  const all = lines.join('\n')
  assertStringIncludes(all, 'thrower onRequest error Page.enable')
  assert(!all.includes('thrower onRequest pass'), 'must not also report a pass')
})

Deno.test('a match glob that never matches is reported even with tracing off', async () => {
  const lines = await captured(async () => {
    const debug = Debug.using('')
    const pipe = await Pipeline.install(
      [
        definePlugin({
          name: 'typo',
          match: ['Runtim.*'],
          setup: () => ({ onRequest: (m) => m }),
        })(),
      ],
      ctx,
      debug,
    )
    await pipe.onRequest(request('Runtime.enable'))
    debug.summary([])
  })

  assertEquals(lines.length, 1)
  assertStringIncludes(lines[0], 'typo declared match=Runtim.*')
})

Deno.test('a glob that does match stays quiet', async () => {
  const lines = await captured(async () => {
    const debug = Debug.using('')
    const pipe = await Pipeline.install(
      [
        definePlugin({
          name: 'fine',
          match: ['Runtime.*'],
          setup: () => ({ onRequest: (m) => m }),
        })(),
      ],
      ctx,
      debug,
    )
    await pipe.onRequest(request('Runtime.enable'))
    debug.summary([])
  })

  assertEquals(lines, [])
})

Deno.test('commands left in flight at teardown are named', async () => {
  const lines = await captured(() => {
    Debug.using('').summary([{
      plugin: 'stealth',
      method: 'Page.getFrameTree',
    }])
  })

  assertEquals(lines.length, 1)
  assertStringIncludes(lines[0], 'stealth was still awaiting Page.getFrameTree')
})

Deno.test('the summary counts every plugin, including idle ones', async () => {
  const lines = await captured(async () => {
    const debug = Debug.using('1')
    const pipe = await Pipeline.install(
      [
        definePlugin({ name: 'busy', setup: () => ({ onEvent: (e) => e }) })(),
        definePlugin({
          name: 'idle',
          setup: () => ({ onResponse: (r) => r }),
        })(),
      ],
      ctx,
      debug,
    )
    await pipe.onEvent({ method: 'Page.loadEventFired' })
    await pipe.onEvent({ method: 'Page.loadEventFired' })
    debug.summary([])
  })

  const report = lines.join('\n')
  assertStringIncludes(report, 'busy onEvent=2')
  assertStringIncludes(report, 'idle no hooks ran')
})
