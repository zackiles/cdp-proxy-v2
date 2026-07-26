/**
 * Covers `harness()` (§9.8) — public platform API rather than test-only
 * machinery, so it is itself tested. Fake mode only here; the real-browser mode
 * is exercised throughout `smoke.test.ts`.
 */

import { assert, assertEquals, assertRejects } from '@std/assert'
import { harness } from '../src/harness.ts'
import { definePlugin } from '../src/plugin.ts'

Deno.test('a fake harness installs core, so a plugin is tested as it will run', async () => {
  await using it = await harness({ fake: true })

  it.wire.pushEvent({
    method: 'Target.attachedToTarget',
    params: { sessionId: 'S', targetInfo: { targetId: 't', type: 'page' } },
  })
  await it.wire.waitForClient(1)
  it.wire.send({ id: 1, method: 'Runtime.enable', sessionId: 'S' })
  await it.wire.waitForClient(2)

  assertEquals(
    it.wire.browserSaw.filter((m) => m.method === 'Runtime.enable'),
    [],
    'core is installed in the harness, so the tell never reaches the browser',
  )
})

Deno.test("a fake harness with plugins: 'none' shows the unmodified wire", async () => {
  await using it = await harness({ fake: true, plugins: 'none' })

  it.wire.send({ id: 1, method: 'Runtime.enable', sessionId: 'S' })
  await it.wire.waitForBrowser(1)

  assertEquals(it.wire.browserSaw[0].method, 'Runtime.enable')
})

Deno.test('a fake harness surfaces what a plugin sent', async () => {
  const prober = definePlugin({
    kind: 'protocol',
    name: 'prober',
    setup: (_cfg, ctx) => ({
      onSessionStart: () => void ctx.send('Browser.getVersion'),
    }),
  })

  await using it = await harness({ fake: true, plugins: [prober()] })
  await it.wire.waitForBrowser(1)

  assertEquals(it.wire.browserSaw[0].method, 'Browser.getVersion')
  assertEquals(it.wire.clientSaw, [], 'plugin traffic stays invisible')
})

Deno.test('a bundle that fails in a worker is reported, not swallowed', async () => {
  // The worker path cannot await its own reply without deadlocking (§7.1), so
  // for a long time it dropped it — which made the worker the one realm where a
  // surface could install nothing and say nothing.
  const marker = definePlugin({
    kind: 'surface',
    name: 'marker',
    setup: () => ({ realms: ['worker'], page: () => {} }),
  })

  await using it = await harness({
    fake: true,
    debug: 'nothing',
    plugins: [marker()],
    reply: (msg) =>
      msg.method === 'Runtime.evaluate'
        ? {
          exceptionDetails: {
            exception: { description: 'TypeError: native is not a function' },
          },
        }
        : undefined,
  })

  it.wire.pushEvent({
    method: 'Target.attachedToTarget',
    params: { sessionId: 'W', targetInfo: { targetId: 'w', type: 'worker' } },
  })
  await it.wire.waitForClient(1)
  it.wire.send({ id: 1, method: 'Proxy.debug' })
  await it.wire.waitForClient(2)

  const { conflicts } = it.wire.clientSaw.at(-1)?.result as {
    conflicts: string[]
  }
  assert(
    conflicts.some((c) =>
      c.includes('failed in a worker') && c.includes('native is not a function')
    ),
    `the failure has to be findable, and ${
      JSON.stringify(conflicts)
    } is not it`,
  )
})

Deno.test('a fake harness resolves the launch merge, process or no process', async () => {
  // The whole of what a `launch` plugin decides happens before a process exists,
  // so it is the one kind fake mode can answer for completely (§3.1). Until this
  // existed, testing one meant calling `resolve()` and rebuilding the context.
  const roaming = definePlugin({
    kind: 'launch',
    name: 'roaming',
    setup: (_cfg, ctx) => ({
      flags: [`--lang=${ctx.profile.locale}`],
      env: { TZ: ctx.profile.timezone },
    }),
  })

  await using it = await harness({
    fake: true,
    plugins: [roaming()],
    profile: { id: 'fixed' },
  })

  assertEquals(it.launch.env.TZ, it.profile.timezone)
  assert(
    it.launch.flags.includes(`--lang=${it.profile.locale}`),
    `expected the locale flag in ${it.launch.flags}`,
  )
  // Core's own flags are in there too, and the plugin's override of one of them
  // is the conflict the merge reports rather than resolves silently (§9.5).
  assert(it.launch.flags.some((f) => f.startsWith('--window-size=')))
  assert(it.launch.conflicts.every((c) => typeof c === 'string'))
})

Deno.test('reaching for the wrong mode fails loudly rather than silently', async () => {
  await using it = await harness({ fake: true })
  let threw = false
  try {
    void it.page
  } catch {
    threw = true
  }
  assert(threw, 'harness.page must not be silently undefined in fake mode')
})

Deno.test('real mode refuses to run without a global Config', async () => {
  // The pool would otherwise throw from deep inside start(), long after the call
  // that actually forgot to configure anything.
  await assertRejects(
    () => harness({}),
    Error,
    'harness() in real mode needs a global Config',
  )
})
