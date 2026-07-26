/**
 * Covers profile resolution (§2): the loader chain, sealing, `noise`,
 * reconciliation, and whether `generate` draws machines that exist.
 *
 * The coherence tests are the ones with teeth. Every field individually
 * plausible is the easy half; the failure the profile kind exists to prevent is a
 * row whose fields are each fine and which together describe no machine — an
 * Apple GPU under a Windows User-Agent.
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertRejects,
} from '@std/assert'
import { definePlugin } from '../src/plugin.ts'
import { draw, random, reconcile, SCHEMA, seal } from '../src/profile.ts'
import { generate, machine } from '../src/core/generate.ts'
import { pin } from '../plugins/profile/pin.ts'
import type { Constraint, Draw } from '../src/types.ts'

const loader = (
  name: string,
  priority: number,
  drawn: (c: Constraint) => Draw | undefined,
) =>
  definePlugin({
    kind: 'profile',
    name,
    priority,
    setup: () => ({ draw: drawn }),
  })()

const anyRow = (seed = 'seed') => machine({}, random(seed), seed)

// ─── the chain ────────────────────────────────────────────────────────────────

Deno.test('the first loader that answers wins, by priority not by position', async () => {
  const high = anyRow('high')
  const low = anyRow('low')
  const resolved = await draw(
    [loader('low', 1, () => low), loader('high', 90, () => high)],
    {},
    'run',
  )
  assertEquals(resolved.id, high.id)
})

Deno.test('undefined means pass, so a loader that cannot answer is not an error', async () => {
  const fallback = anyRow('fallback')
  const resolved = await draw(
    [loader('picky', 90, () => undefined), loader('always', 1, () => fallback)],
    {},
    'run',
  )
  assertEquals(resolved.id, fallback.id)
  assertEquals(resolved.source, 'always')
})

Deno.test('a loader that throws is skipped rather than fatal', async () => {
  // An unreachable `remote` should degrade to the next source, not fail the
  // session: falling through is the whole reason the chain is a chain.
  const resolved = await draw(
    [
      loader('remote', 90, () => {
        throw new Error('connection refused')
      }),
      loader('local', 1, () => anyRow('local')),
    ],
    {},
    'run',
  )
  assertEquals(resolved.source, 'local')
})

Deno.test('source is stamped by the runtime, not taken from the loader', async () => {
  // `pin` draws its row from generate's tables, so a self-reported source would
  // say `generate` and the trace would name the wrong origin.
  const resolved = await draw([pin({ id: 'abc' })], {}, 'run')
  assertEquals(resolved.source, 'pin')
})

Deno.test('a chain that cannot answer says what each loader said', async () => {
  await assertRejects(
    () => draw([], {}, 'run'),
    Error,
    'no profile loader answered',
  )

  // The usual cause is a constraint nothing can satisfy, so the reason each
  // loader gave is the answer rather than a footnote.
  await assertRejects(
    () =>
      draw(
        [loader('picky', 1, () => undefined), generate()],
        { os: ['Solaris' as 'Linux'] },
        'run',
      ),
    Error,
    'picky: no match; generate: generate has no os satisfying the constraint',
  )
})

// ─── sealing ──────────────────────────────────────────────────────────────────

Deno.test('a sealed profile cannot be patched, at any depth', () => {
  const profile = seal(anyRow())

  // Patching one field of a drawn row is how a session ends up claiming an Apple
  // GPU on a Windows User-Agent (§2.4), so both levels are frozen.
  let outer = false
  try {
    ;(profile as unknown as { os: string }).os = 'Windows'
  } catch {
    outer = true
  }
  assert(outer, 'a top-level field must not be writable')

  let inner = false
  try {
    ;(profile.screen as unknown as { width: number }).width = 800
  } catch {
    inner = true
  }
  assert(inner, 'a nested field must not be writable either')
})

Deno.test('noise is stable, keyed, and inside [0, 1)', () => {
  const profile = seal(anyRow('stable'))

  // A real browser returns a *stable* canvas hash. A page that reads twice and
  // gets two answers has caught you with one line of JavaScript (§2.10).
  assertEquals(profile.noise('canvas'), profile.noise('canvas'))
  assertNotEquals(profile.noise('canvas'), profile.noise('audio'))
  for (const key of ['canvas', 'audio', 'webgl']) {
    const value = profile.noise(key)
    assert(value >= 0 && value < 1, `${key} produced ${value}`)
  }

  // Same seed, same jitter — which is what makes a pinned profile reproducible
  // across runs and not merely across reloads.
  assertEquals(seal(anyRow('stable')).noise('canvas'), profile.noise('canvas'))
  assertNotEquals(
    seal(anyRow('other')).noise('canvas'),
    profile.noise('canvas'),
  )
})

// ─── reconciliation ───────────────────────────────────────────────────────────

Deno.test("the binary's version wins, and the claim follows it everywhere", () => {
  const candidate = { ...anyRow(), chrome: 148 }
  const { draw: fixed, corrections } = reconcile(candidate, {
    product: 'Chrome/147.0.7259.5',
  })

  // A page feature-detects: claiming 148 on a 147 binary is caught by one
  // missing API (§2.6).
  assertEquals(fixed.chrome, 147)
  assert(fixed.userAgent.includes('Chrome/147.0.0.0'))
  assertEquals(
    fixed.brands.find((b) => b.brand === 'Google Chrome')?.version,
    '147',
  )
  assertEquals(corrections.length, 1)

  // The greased entry carries a greased version, not the major. Pasting 147 into
  // it produces a brand list no Chrome has ever sent, which is a worse tell than
  // the stale version it was fixing.
  const greased = fixed.brands.find((b) => /^Not.A.Brand$/.test(b.brand))
  assert(greased, `no greased brand in ${JSON.stringify(fixed.brands)}`)
  assert(
    ['8', '99', '24'].includes(greased.version),
    `greased brand claims version ${greased.version}`,
  )
})

Deno.test('reconciliation moves the profile toward the process and nothing else', () => {
  const candidate = anyRow()
  const { draw: same, corrections } = reconcile(candidate, {
    product: `Chrome/${candidate.chrome}.0.0.0`,
  })
  assertEquals(corrections, [])
  assertEquals(same, candidate)

  // No answer from the browser leaves the schedule's guess in place rather than
  // zeroing the field.
  assertEquals(reconcile(candidate, {}).draw.chrome, candidate.chrome)
})

Deno.test('the HeadlessChrome token never survives reconciliation', () => {
  const candidate = {
    ...anyRow(),
    userAgent: 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/147.0.0.0',
  }
  const { draw: fixed, corrections } = reconcile(candidate, {})
  assert(!fixed.userAgent.includes('Headless'))
  assertEquals(corrections.length, 1)
})

// ─── generate ─────────────────────────────────────────────────────────────────

Deno.test('the same seed draws the same machine', () => {
  assertEquals(
    machine({}, random('abc'), 'abc'),
    machine({}, random('abc'), 'abc'),
  )
})

Deno.test('a hundred draws are all machines that exist', () => {
  for (let i = 0; i < 100; i++) {
    const row = machine({}, random(`row-${i}`), `row-${i}`)

    // The renderer, the architecture and the OS are one claim, not three.
    if (row.os === 'macOS') {
      assert(
        row.arch !== 'arm' || row.gpu!.angle === 'Metal',
        `Apple silicon with ${row.gpu!.angle}: ${row.gpu!.renderer}`,
      )
      assert(row.userAgent.includes('Macintosh; Intel Mac OS X 10_15_7'))
    }
    if (row.os === 'Windows') {
      assert(
        !/Apple|Mesa/.test(row.gpu!.renderer),
        `Windows reporting ${row.gpu!.renderer}`,
      )
      assert(row.userAgent.includes('Windows NT 10.0; Win64; x64'))
    }
    if (row.os === 'Linux') {
      assert(row.userAgent.includes('X11; Linux x86_64'))
      assert(!row.hardware.touch, 'a Linux desktop claiming touch')
    }

    // The version appears in three places and a page can compare all three.
    assert(row.userAgent.includes(`Chrome/${row.chrome}.0.0.0`))
    assertEquals(
      row.brands.find((b) => b.brand === 'Chromium')?.version,
      String(row.chrome),
    )

    assertEquals(row.languages[0], row.locale)
    assert(row.fonts!.length > 10, 'a machine with no fonts is not a machine')
    assert(
      row.viewport.height < row.screen.height,
      'a window bigger than its screen',
    )
    assertEquals(row.schema, SCHEMA)
    // A machine that enumerates no audio output does not exist either, and the
    // proprietary decoders come with the Chrome the row claims to be.
    assert(row.media!.devices.some((d) => d.kind === 'audiooutput'))
    assert(row.media!.codecs.some((c) => c.includes('avc1')))
  }
})

Deno.test('the fleet is weighted toward common machines, not spread evenly', () => {
  const counts = new Map<string, number>()
  for (let i = 0; i < 400; i++) {
    const os = machine({}, random(`fleet-${i}`), `fleet-${i}`).os
    counts.set(os, (counts.get(os) ?? 0) + 1)
  }
  // A uniform fleet is a rarity failure at the aggregate level: every row is
  // plausible and the population matches none that exists (§2.5).
  assert(
    (counts.get('Windows') ?? 0) > (counts.get('macOS') ?? 0),
    `Windows ${counts.get('Windows')} vs macOS ${counts.get('macOS')}`,
  )
  assert((counts.get('Linux') ?? 0) < (counts.get('macOS') ?? 0))
})

Deno.test('a constraint is answered with a whole row that satisfies it', () => {
  for (let i = 0; i < 20; i++) {
    const seed = `constrained-${i}`
    const row = machine(
      { os: ['macOS'], minChrome: 140, timezone: ['Europe/Berlin'] },
      random(seed),
      seed,
    )
    assertEquals(row.os, 'macOS')
    assertEquals(row.timezone, 'Europe/Berlin')
    assertEquals(row.locale, 'de-DE')
    assert(row.chrome >= 140)
    // The whole row followed the constraint, rather than one field being patched.
    assert(row.userAgent.includes('Macintosh'))
  }
})

Deno.test('generate answers or says which axis it could not satisfy', async () => {
  const resolved = await draw([generate()], { os: ['Linux'] }, 'run')
  assertEquals(resolved.os, 'Linux')

  await assertRejects(
    () => draw([generate()], { os: ['Solaris' as 'Linux'] }, 'run'),
    Error,
    'no profile loader answered',
  )
})

// ─── pin ──────────────────────────────────────────────────────────────────────

Deno.test('pin reproduces one machine from its id, and stands aside without one', async () => {
  const first = await draw([pin({ id: 'yesterday' }), generate()], {}, 'a')
  const second = await draw([pin({ id: 'yesterday' }), generate()], {}, 'b')

  // Same id, same machine, regardless of the run seed: that is what re-opening
  // yesterday's failure means.
  assertEquals(first.id, 'yesterday')
  assertEquals(second, first)

  const unpinned = await draw([pin({}), generate()], {}, 'c')
  assertEquals(unpinned.source, 'generate')
})

Deno.test('a pinned id that cannot meet the constraint falls through', async () => {
  const resolved = await draw(
    [pin({ id: 'pinned' }), generate()],
    { os: ['Linux'] },
    'run',
  )
  assertEquals(resolved.os, 'Linux')
})
