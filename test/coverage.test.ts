/**
 * Covers the coverage report (§2.8) — the thing that turns "you forgot a fonts
 * surface" from something a detector tells you into a line in a trace.
 */

import { assert, assertEquals, assertThrows } from '@std/assert'
import { fields, Ledger } from '../src/coverage.ts'
import { random, seal } from '../src/profile.ts'
import { machine } from '../src/core/generate.ts'

const profile = () => seal(machine({}, random('cover'), 'cover'))

/**
 * A row an older loader drew, missing one optional field.
 *
 * `generate` fills every field it knows about, so a stand-down cannot be
 * demonstrated with a fresh draw — and a stand-down is what a corpus row
 * captured before the field existed produces.
 */
const lacking = () =>
  seal({ ...machine({}, random('cover'), 'cover'), media: undefined })

Deno.test('a read is recorded against the plugin that made it', () => {
  const ledger = new Ledger()
  const row = profile()

  const navigator = ledger.view(row, 'navigator')
  void navigator.userAgent
  void navigator.brands
  void ledger.view(row, 'webgl').gpu

  const { read } = ledger.report(row)
  assertEquals(read.userAgent, ['navigator'])
  assertEquals(read.gpu, ['webgl'])
  assertEquals(read.brands, ['navigator'])
})

Deno.test('two plugins reading one field are both credited', () => {
  const ledger = new Ledger()
  const row = profile()
  void ledger.view(row, 'navigator').userAgent
  void ledger.view(row, 'headers').userAgent
  assertEquals(ledger.report(row).read.userAgent, ['navigator', 'headers'])
})

Deno.test('a field nothing read is uncovered, and reading it clears the line', () => {
  const ledger = new Ledger()
  const row = profile()

  // Uncovered is the point: the real browser's fonts reach the page while the
  // profile claims a different machine.
  assert(ledger.report(row).uncovered.includes('fonts'))
  void ledger.view(row, 'fonts').fonts
  assert(!ledger.report(row).uncovered.includes('fonts'))
})

Deno.test('identity is not a claim, so it is never uncovered', () => {
  const row = profile()
  for (const internal of ['id', 'seed', 'source', 'schema', 'noise']) {
    assert(
      !fields(row).includes(internal),
      `${internal} is runtime bookkeeping, not something a page can see`,
    )
  }
})

Deno.test('hardware reports its leaves, because separate surfaces carry them', () => {
  const ledger = new Ledger()
  const row = profile()

  void ledger.view(row, 'concurrency').hardware.cores
  const { read, uncovered } = ledger.report(row)
  assertEquals(read['hardware.cores'], ['concurrency'])
  assert(uncovered.includes('hardware.memory'))
  assert(uncovered.includes('hardware.touch'))

  // `gpu` stays whole: one surface carries it, and three leaf lines would be
  // three pieces of noise for one missing plugin.
  assert(uncovered.includes('gpu'))
  assert(!uncovered.some((f) => f.startsWith('gpu.')))
})

Deno.test('reading an absent field is a stand-down, not a read', () => {
  const ledger = new Ledger()
  const row = lacking()

  // This is precisely what a guarded surface does — `if (!ctx.profile.media)
  // return {}` — so the runtime learns about it from the guard itself (§2.9).
  assertEquals(row.media, undefined)
  void ledger.view(row, 'media').media

  const { read, uncovered, stoodDown } = ledger.report(row)
  assertEquals(read.media, undefined)
  assert(stoodDown.media.includes('profile has no media'))
  // A field the profile does not have claims nothing, so nothing contradicts it.
  assert(!uncovered.includes('media'))
})

Deno.test('the view hands back the real values, unchanged', () => {
  const row = profile()
  const view = new Ledger().view(row, 'anyone')
  assertEquals(view.userAgent, row.userAgent)
  assertEquals(view.screen.width, row.screen.width)
  assertEquals(view.noise('canvas'), row.noise('canvas'))
})

Deno.test('a plugin cannot patch its own view of the profile', () => {
  const view = new Ledger().view(profile(), 'overreach')

  // The view is a copy, so immutability has to come from the trap rather than
  // from the frozen row underneath — and refusing loudly beats a write that
  // silently lands on a copy nothing else can see.
  assertThrows(
    () => {
      ;(view as unknown as { os: string }).os = 'Windows'
    },
    TypeError,
    'overreach tried to set profile.os',
  )
  assertThrows(
    () => {
      ;(view.hardware as unknown as { cores: number }).cores = 64
    },
    TypeError,
    'overreach tried to set profile.hardware.cores',
  )
})

Deno.test('the report reads as a report', () => {
  const ledger = new Ledger()
  const row = lacking()
  void ledger.view(row, 'navigator').userAgent
  void ledger.view(row, 'navigator').os
  void ledger.view(row, 'media').media

  const text = ledger.lines(row).join('\n')
  assert(text.includes('navigator  reads userAgent os'), text)
  assert(text.includes('uncovered  '), text)
  assert(text.includes('media      stood down: profile has no media'), text)
})
