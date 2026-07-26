/**
 * Covers `surface` compilation and delivery (§4), and the lint rule that makes
 * page-function serialization survivable (§4.1).
 *
 * The two things worth asserting hardest are the ones that fail silently in
 * production: a captured identifier, which the page turns into `undefined`
 * without an error, and the page-side `noise()` drifting from `profile.noise`,
 * which would leave a surface jittering by one amount while the runtime believes
 * it claimed another.
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { compile } from '../src/surface.ts'
import { deliver } from '../src/realms.ts'
import { definePlugin } from '../src/plugin.ts'
import { random, seal } from '../src/profile.ts'
import { machine } from '../src/core/generate.ts'
import { Debug } from '../src/debug.ts'
import { Ledger } from '../src/coverage.ts'
import plugin from '../tools/lint.ts'
import type {
  CDPTarget,
  ConfiguredPlugin,
  Profile,
  SessionId,
} from '../src/types.ts'

const profile = (id = 'surface-test'): Profile =>
  seal(machine({ id }, random(id), id))

function context(coverage = new Ledger(), row = profile()) {
  return (name: string) => ({
    profile: coverage.view(row, name),
    signal: new AbortController().signal,
    log: () => {},
  })
}

/** What `deliver` writes to, recorded rather than sent. */
function wire() {
  const injected: string[] = []
  const evaluated: string[] = []
  const sent: { method: string; params: unknown }[] = []
  return {
    injected,
    evaluated,
    sent,
    inject: (source: string) => {
      injected.push(source)
      return Promise.resolve({})
    },
    evaluate: (source: string) => void evaluated.push(source),
    send: ((method: string, params: unknown) => {
      sent.push({ method, params })
      return Promise.resolve({})
      // deno-lint-ignore no-explicit-any
    }) as any,
    log: () => {},
  }
}

const target: CDPTarget = {
  sessionId: 'S' as SessionId,
  targetId: 'T',
  type: 'page',
}

Deno.test('a page function reaches the bundle as source, with the helpers', async () => {
  const patcher = definePlugin<Record<string, unknown>, { title: string }>({
    kind: 'surface',
    name: 'patcher',
    setup: () => ({
      config: { title: 'spoofed' },
      page(config) {
        document.title = config.title
      },
    }),
  })()

  const row = profile()
  const compiled = await compile([patcher], context(new Ledger(), row), row)
  const bundle = compiled.bundle('page')

  assertStringIncludes(bundle, 'document.title = config.title')
  assertStringIncludes(bundle, '{"title":"spoofed"}')
  // The three helpers, prepended once rather than once per surface.
  assertStringIncludes(bundle, 'const native =')
  assertStringIncludes(bundle, 'const define =')
  assertStringIncludes(bundle, 'const noise =')
  assertEquals(bundle.split('const native =').length - 1, 1)
})

Deno.test('the page-side noise() agrees with profile.noise', async () => {
  // DANGER: this is the test that keeps the duplication in HELPERS honest. The
  // page cannot import `profile.noise`, so it is reimplemented in the bundle,
  // and a surface whose jitter stops matching what the runtime believes it
  // claimed is exactly the incoherence the profile exists to prevent (§2.10).
  const row = profile('noise-agreement')
  const nothing = definePlugin({
    kind: 'surface',
    name: 'nothing',
    setup: () => ({ page() {} }),
  })()
  const compiled = await compile([nothing], context(new Ledger(), row), row)

  const pageNoise = new Function(
    `${
      compiled.bundle('page').replace(/^\(\(\) => \{/, '').replace(
        /\}\)\(\)$/,
        '',
      )
    }
     return noise`,
  )() as (key: string) => number

  for (const key of ['canvas.channel.0', 'chrome.tran', 'anything']) {
    assertEquals(pageNoise(key), row.noise(key), `noise disagreed on ${key}`)
  }
})

Deno.test('a surface declines the realms its API is meaningless in', async () => {
  const dom = definePlugin({
    kind: 'surface',
    name: 'dom',
    setup: () => ({
      realms: ['page', 'iframe'] as const,
      page() {
        document.title = 'x'
      },
    }),
    // deno-lint-ignore no-explicit-any
  })() as any as ConfiguredPlugin

  const row = profile()
  const compiled = await compile([dom], context(new Ledger(), row), row)

  assert(compiled.bundle('page').length > 0)
  assertEquals(compiled.bundle('worker'), '', 'a worker has no document')
})

Deno.test('emulate runs per target and headers are merged, first value winning', async () => {
  const one = definePlugin({
    kind: 'surface',
    name: 'one',
    priority: 10,
    setup: () => ({
      headers: { 'Accept-Language': 'en-US,en' },
      emulate: (realm) =>
        void realm.send('Emulation.setTimezoneOverride', {
          timezoneId: 'UTC',
        }, realm.sessionId),
    }),
  })()
  const two = definePlugin({
    kind: 'surface',
    name: 'two',
    setup: () => ({ headers: { 'Accept-Language': 'fr-FR' } }),
  })()

  const row = profile()
  const debug = Debug.using('')
  const compiled = await compile(
    [two, one],
    context(new Ledger(), row),
    row,
    debug,
  )

  assertEquals(compiled.names, ['one', 'two'], 'priority orders the surfaces')
  assertEquals(compiled.headers['Accept-Language'], 'en-US,en')
  assertStringIncludes(debug.snapshot().conflicts[0], 'two wanted "fr-FR"')

  const w = wire()
  await deliver(compiled, target, w)
  assertEquals(w.sent[0].method, 'Emulation.setTimezoneOverride')
  assert(
    !w.sent.some((s) => s.method === 'Network.setExtraHTTPHeaders'),
    "headers are the broker's to send, not delivery's (§7.2)",
  )
})

Deno.test('a surface that cannot set up installs nothing, and says so', async () => {
  const broken = definePlugin({
    kind: 'surface',
    name: 'broken',
    setup: () => {
      throw new Error('no gpu to speak of')
    },
  })()

  const row = profile()
  const debug = Debug.using('')
  const compiled = await compile(
    [broken],
    context(new Ledger(), row),
    row,
    debug,
  )

  assertEquals(compiled.names, [])
  assertStringIncludes(
    debug.snapshot().conflicts[0],
    'broken installed nothing',
  )
})

Deno.test('a surface reading the profile turns its field green', async () => {
  const coverage = new Ledger()
  const row = profile()
  const clocked = definePlugin({
    kind: 'surface',
    name: 'clocked',
    setup: (_cfg, ctx) => {
      const timezoneId = ctx.profile.timezone
      return {
        emulate: (realm) =>
          void realm.send(
            'Emulation.setTimezoneOverride',
            { timezoneId },
            realm.sessionId,
          ),
      }
    },
    // deno-lint-ignore no-explicit-any
  })() as any as ConfiguredPlugin

  await compile([clocked], context(coverage, row), row)
  const report = coverage.report(row)

  assertEquals(report.uncovered.includes('timezone'), false)
})

Deno.test('the lint rule rejects what the page cannot resolve', () => {
  const capture = `
    const OUTSIDE = 1
    export const bad = definePlugin({
      kind: 'surface',
      name: 'bad',
      setup: () => ({ page() { document.title = String(OUTSIDE) } }),
    })
  `
  const found = Deno.lint.runPlugin(plugin, 'bad.ts', capture)
  assertEquals(found.length, 1)
  assertStringIncludes(found[0].message, '`OUTSIDE` is undefined in the page')

  const clean = `
    export const good = definePlugin({
      kind: 'surface',
      name: 'good',
      setup: () => ({
        config: { title: 'x' },
        page(config) {
          const patch = function () { return config.title }
          define(document, 'title', native(patch, 'title')())
          for (const part of [1, 2]) Math.max(part, noise('k'))
        },
      }),
    })
  `
  assertEquals(Deno.lint.runPlugin(plugin, 'good.ts', clean), [])

  // A `page` that is not a surface's is not held to a rule about serialization.
  const unrelated = `
    const handle = { page() { return outer.thing } }
  `
  assertEquals(Deno.lint.runPlugin(plugin, 'other.ts', unrelated), [])
})
