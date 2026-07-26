/**
 * Covers the kind discriminant, presets, partitioning, and core pinning (§1, §8).
 *
 * The properties worth pinning here are the structural ones: that `kind` decides
 * which partition a plugin lands in, that a duplicate `name` within a kind is a
 * startup error rather than a silent shadow, that core cannot be displaced by a
 * larger `priority`, and that `plugins: []` and `plugins: 'none'` differ by
 * exactly the core tier.
 */

import { assert, assertEquals, assertThrows } from '@std/assert'
import {
  definePlugin,
  definePreset,
  order,
  partition,
  Pipeline,
} from '../src/plugin.ts'
import { resolvePlugins } from '../src/proxy.ts'
import { core } from '../src/core/mod.ts'
import { Debug } from '../src/debug.ts'
import type { ConfiguredPlugin, PluginContext } from '../src/types.ts'

const noop = (name: string, kind: 'profile' | 'launch' | 'surface' | 'actor') =>
  definePlugin({
    // deno-lint-ignore no-explicit-any
    kind: kind as any,
    name,
    setup: () => ({}),
  })

Deno.test('kind lands a plugin in its own partition and defaults to protocol', () => {
  const set = partition([
    noop('loader', 'profile')(),
    noop('flag', 'launch')(),
    noop('gpu', 'surface')(),
    noop('solver', 'actor')(),
    definePlugin({ name: 'legacy', setup: () => ({}) })(),
  ])

  assertEquals(set.profile.map((p) => p.name), ['loader'])
  assertEquals(set.launch.map((p) => p.name), ['flag'])
  assertEquals(set.surface.map((p) => p.name), ['gpu'])
  assertEquals(set.actor.map((p) => p.name), ['solver'])
  // A plugin written before the kinds existed is a protocol plugin, which is the
  // migration §5 promises: adding `kind: 'protocol'` is additive, not a rename.
  assertEquals(set.protocol.map((p) => p.name), ['legacy'])
})

Deno.test('two plugins with one name inside a kind is a startup error', () => {
  const first = definePlugin({
    kind: 'surface',
    name: 'math',
    setup: () => ({}),
  })
  const second = definePlugin({
    kind: 'surface',
    name: 'math',
    setup: () => ({}),
  })

  // Corsac filed the same subject under two categories and nothing reconciled
  // them. Identity is `name`, so the collision surfaces here wherever the files
  // sit.
  assertThrows(
    () => partition([first(), second()]),
    Error,
    'two surface plugins are both named "math"',
  )

  // ...and the same name in two different kinds is not a collision at all.
  const surface = definePlugin({
    kind: 'surface',
    name: 'clock',
    setup: () => ({}),
  })
  const launch = definePlugin({
    kind: 'launch',
    name: 'clock',
    setup: () => ({}),
  })
  assertEquals(partition([surface(), launch()]).surface.length, 1)
})

Deno.test('match is only compiled for protocol, and urls only for actor', () => {
  const scoped = definePlugin({
    kind: 'protocol',
    name: 'scoped',
    match: ['Runtime.*'],
    setup: () => ({}),
  })()
  assert(scoped.matches('Runtime.enable'))
  assert(!scoped.matches('Page.enable'))

  const actor = definePlugin({
    kind: 'actor',
    name: 'solver',
    urls: ['https://*'],
    setup: () => {},
  })()
  assertEquals(actor.urls, ['https://*'])
  // A surface has no CDP methods to narrow, so it sees everything by default.
  assertEquals(actor.match, undefined)
  assert(actor.matches('anything'))
})

Deno.test('a preset expands to its plugins and `without` removes one', () => {
  const alpha = noop('alpha', 'surface')
  const beta = noop('beta', 'surface')
  const preset = definePreset<{ loud?: boolean }>({
    name: 'bundle',
    plugins: () => [alpha(), beta()],
  })

  assertEquals(preset.presetName, 'bundle')
  assertEquals(preset().map((p) => p.name), ['alpha', 'beta'])
  assertEquals(preset({ without: ['beta'] }).map((p) => p.name), ['alpha'])
})

Deno.test('a preset is flattened before the runtime sees it', () => {
  const preset = definePreset({
    name: 'bundle',
    plugins: () => [noop('alpha', 'surface')(), noop('beta', 'surface')()],
  })

  const set = resolvePlugins([preset(), noop('mine', 'surface')()])
  assertEquals(set.surface.map((p) => p.name), ['alpha', 'beta', 'mine'])
})

Deno.test("core is present for [] and absent for 'none'", () => {
  const coreOnly = resolvePlugins([])
  assertEquals(coreOnly.protocol.map((p) => p.name), ['contexts'])

  // `plugins: []` controls the authored set, and an empty authored set is exactly
  // what it says; core is presence rather than opt-in (§8.6).
  const passthrough = resolvePlugins('none')
  assertEquals(passthrough.protocol, [])
})

Deno.test('core is never optional, whatever the tier says', () => {
  for (const plugin of core()) {
    assertEquals(plugin.optional, false, `${plugin.name} must not be optional`)
    assert(plugin.pinned, `${plugin.name} must be pinned to one end`)
  }
})

Deno.test('priority cannot displace a pinned core plugin', () => {
  const eager = definePlugin({
    kind: 'protocol',
    name: 'eager',
    priority: 10_000,
    setup: () => ({}),
  })()
  const last = { ...noop('terminal', 'profile')(), pinned: 'last' } as const

  const resolved = order([
    eager,
    ...core().filter((p) => p.kind === 'protocol'),
    last,
  ])
  assertEquals(resolved.map((p) => p.name), ['contexts', 'eager', 'terminal'])
})

Deno.test('a pinned plugin that fails setup fails the session', async () => {
  const broken: ConfiguredPlugin = {
    ...definePlugin({
      kind: 'protocol',
      name: 'broken',
      // Marked optional to prove pinning overrides it: there is no degraded mode
      // for core (§9.6).
      optional: true,
      setup: () => {
        throw new Error('no dice')
      },
    })(),
    pinned: 'first',
  }

  const ctx = () => ({}) as unknown as PluginContext
  await Pipeline.install([broken], ctx, Debug.using(''))
    .then(
      () => {
        throw new Error('expected the session to fail')
      },
      (err: Error) =>
        assertEquals(err.message, 'plugin setup failed: broken (no dice)'),
    )
})
