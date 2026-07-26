/**
 * Covers the corpus and remote loaders (§2.3) and burn (§2.7).
 *
 * The tests with teeth are the ones about *falling through*. A loader chain is
 * only a chain because a loader that cannot answer says so and the next one
 * tries; a corpus with no Windows row that threw, or a coordinator that took the
 * session down when it went offline, would turn the highest-fidelity source into
 * the most fragile one.
 */

import { assert, assertEquals, assertRejects } from '@std/assert'
import { corpus, forget } from '../plugins/profile/corpus.ts'
import { remote } from '../plugins/profile/remote.ts'
import { burn, draw } from '../src/profile.ts'
import { machine } from '../src/core/generate.ts'
import { generate } from '../src/core/mod.ts'
import { random } from '../src/profile.ts'
import type { Draw } from '../src/types.ts'

/** A corpus row is a `Draw` minus what the runtime stamps, plus a weight. */
function row(over: Partial<Draw> & { weight?: number }) {
  const base = machine({}, random(over.id ?? 'row'), over.id ?? 'row')
  const { seed: _seed, source: _source, ...rest } = base
  return { ...rest, ...over }
}

async function file(rows: unknown[]): Promise<string> {
  const path = await Deno.makeTempFile({ suffix: '.jsonl' })
  await Deno.writeTextFile(
    path,
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
  )
  forget()
  return path
}

// ─── the corpus ───────────────────────────────────────────────────────────────

Deno.test('a corpus row is drawn whole, and the runtime stamps its origin', async () => {
  const path = await file([
    row({ id: 'only', os: 'Windows', locale: 'de-DE' }),
  ])
  const drawn = await draw([corpus({ path })], {}, 'run')

  assertEquals(drawn.id, 'only')
  assertEquals(drawn.source, 'corpus')
  assertEquals(drawn.os, 'Windows')
  // Seeded from the row so two sessions on the same identity share its jitter,
  // and from the run so they are not the same session (§2.10).
  assert(drawn.seed.startsWith('only:'))
})

Deno.test('a corpus with nothing that fits passes to the next loader', async () => {
  // Throwing here would make the highest-fidelity source the most fragile one.
  const path = await file([row({ id: 'mac', os: 'macOS' })])
  const drawn = await draw(
    [corpus({ path }), generate()],
    { os: ['Windows'] },
    'run',
  )
  assertEquals(drawn.source, 'generate')
  assertEquals(drawn.os, 'Windows')
})

Deno.test('weight decides the draw, and there is no uniform mode', async () => {
  const path = await file([
    row({ id: 'common', weight: 99 }),
    row({ id: 'rare', weight: 1 }),
  ])
  const counts: Record<string, number> = {}
  for (let i = 0; i < 200; i++) {
    const drawn = await draw([corpus({ path })], {}, `run-${i}`)
    counts[drawn.id] = (counts[drawn.id] ?? 0) + 1
  }
  // A fleet of twelve machines sampled uniformly is a fleet no population looks
  // like (§2.5); the assertion is only that weight is doing something large.
  assert(
    counts.common > counts.rare * 5,
    `expected the 99:1 row to dominate, got ${JSON.stringify(counts)}`,
  )
})

Deno.test('a row missing a required field is rejected with its line number', async () => {
  const good = row({ id: 'fine' })
  const { chrome: _chrome, ...broken } = row({ id: 'broken' })
  const path = await file([good, broken])
  await assertRejects(
    () => draw([corpus({ path })], {}, 'run'),
    Error,
    'no profile loader answered',
  )
})

Deno.test('comments and blank lines are skipped', async () => {
  const path = await Deno.makeTempFile({ suffix: '.jsonl' })
  await Deno.writeTextFile(
    path,
    `// captured 2026-07-01\n\n${JSON.stringify(row({ id: 'kept' }))}\n\n`,
  )
  forget()
  assertEquals((await draw([corpus({ path })], {}, 'run')).id, 'kept')
})

Deno.test('an optional field the row does not have stays absent', async () => {
  // A row captured before a surface existed has no field for it, and a defaulted
  // field is an incoherent field (§2.9).
  const { gpu: _gpu, fonts: _fonts, ...bare } = row({ id: 'old' })
  const path = await file([bare])
  const drawn = await draw([corpus({ path })], {}, 'run')
  assertEquals(drawn.gpu, undefined)
  assertEquals(drawn.fonts, undefined)
})

// ─── burn ─────────────────────────────────────────────────────────────────────

Deno.test('a burnt row stops being handed out for the life of the process', async () => {
  const path = await file([
    row({ id: 'burn-me' }),
    row({ id: 'survivor' }),
  ])
  const loaders = [corpus({ path })]

  assertEquals(await burn(loaders, 'burn-me', 'blocked by the site'), [
    'corpus',
  ])
  for (let i = 0; i < 20; i++) {
    assertEquals((await draw(loaders, {}, `run-${i}`)).id, 'survivor')
  }
})

Deno.test('burning the last row falls through rather than failing the session', async () => {
  const path = await file([row({ id: 'only' })])
  const loaders = [corpus({ path }), generate()]
  await burn(loaders, 'only', 'blocked')
  assertEquals((await draw(loaders, {}, 'run')).source, 'generate')
})

Deno.test('a burn recorded to a file outlives the process that made it', async () => {
  // Without this the corpus hands the row back on the next start, which is the
  // one thing a burn exists to prevent (§2.7).
  const path = await file([row({ id: 'burn-me' }), row({ id: 'survivor' })])
  const burns = await Deno.makeTempFile({ suffix: '.jsonl' })
  await burn([corpus({ path, burns })], 'burn-me', 'blocked by the site')

  // `forget()` is what a restart looks like from here: nothing in memory.
  forget()
  const restarted = [corpus({ path, burns })]
  for (let i = 0; i < 20; i++) {
    assertEquals((await draw(restarted, {}, `run-${i}`)).id, 'survivor')
  }

  const recorded = JSON.parse((await Deno.readTextFile(burns)).trim())
  assertEquals(recorded.id, 'burn-me')
  assertEquals(recorded.reason, 'blocked by the site')
})

Deno.test('a half-written burn line costs one burn, not the file', async () => {
  const path = await file([row({ id: 'first' }), row({ id: 'second' })])
  const burns = await Deno.makeTempFile({ suffix: '.jsonl' })
  await Deno.writeTextFile(
    burns,
    `{"id":"first","reason":"blocked"}\n{"id":"seco`,
  )
  forget()
  for (let i = 0; i < 10; i++) {
    assertEquals(
      (await draw([corpus({ path, burns })], {}, `r-${i}`)).id,
      'second',
    )
  }
})

Deno.test('a loader with no state to withdraw from is not told it failed', async () => {
  // `generate` and `pin` have no `burn`, and that is not an error: the chain is
  // told and the ones with something to do, do it.
  assertEquals(await burn([generate()], 'anything', 'blocked'), [])
})

// ─── remote ───────────────────────────────────────────────────────────────────

function coordinator(
  handler: (path: string, body: Record<string, unknown>) => Response,
) {
  const seen: {
    path: string
    body: Record<string, unknown>
    auth: string | null
  }[] = []
  const server = Deno.serve({ port: 0, onListen: () => {} }, async (req) => {
    const path = new URL(req.url).pathname
    const body = await req.json()
    seen.push({ path, body, auth: req.headers.get('authorization') })
    return handler(path, body)
  })
  return {
    url: `http://localhost:${(server.addr as Deno.NetAddr).port}`,
    seen,
    [Symbol.asyncDispose]: () => server.shutdown(),
  }
}

Deno.test('remote draws from the coordinator and outranks the corpus', async () => {
  await using service = await coordinator(() =>
    Response.json(row({ id: 'coordinated', os: 'Linux' }))
  )
  const path = await file([row({ id: 'local' })])
  const drawn = await draw(
    [corpus({ path }), remote({ url: service.url })],
    {},
    'run',
  )
  assertEquals(drawn.id, 'coordinated')
  assertEquals(drawn.source, 'remote')
  assertEquals(service.seen[0].path, '/draw')
})

Deno.test('204 means nothing fits, which is a pass and not a failure', async () => {
  await using service = await coordinator(() =>
    new Response(null, { status: 204 })
  )
  const drawn = await draw(
    [remote({ url: service.url }), generate()],
    {},
    'run',
  )
  assertEquals(drawn.source, 'generate')
})

Deno.test('an unreachable coordinator degrades to drawing locally', async () => {
  // Stated loudly in the module doc because it is the right default and it is
  // not free: a fleet that falls back has silently stopped coordinating.
  const drawn = await draw(
    [remote({ url: 'http://127.0.0.1:1', timeout: 200 }), generate()],
    {},
    'run',
  )
  assertEquals(drawn.source, 'generate')
})

Deno.test('a coordinator on a shared network gets a credential', async () => {
  await using service = await coordinator(() => Response.json(row({ id: 'c' })))
  await draw([remote({ url: service.url, token: 'hunter2' })], {}, 'run')
  assertEquals(service.seen[0].auth, 'Bearer hunter2')
})

Deno.test('a coordinator having a bad moment is asked twice', async () => {
  // The failure worth surviving is a connection reset or a rolling restart. A
  // 4xx is this request being wrong, and sending it again is only wrong twice.
  let calls = 0
  await using service = await coordinator(() =>
    ++calls === 1
      ? new Response(null, { status: 503 })
      : Response.json(row({ id: 'second-time' }))
  )
  const drawn = await draw([remote({ url: service.url })], {}, 'run')
  assertEquals(drawn.id, 'second-time')
  assertEquals(calls, 2)

  calls = 0
  await using refuses = await coordinator(() =>
    new Response(null, { status: 400 })
  )
  await draw([remote({ url: refuses.url }), generate()], {}, 'run')
  assertEquals(refuses.seen.length, 1)
})

Deno.test('a burn is posted to the coordinator so the fleet learns about it', async () => {
  await using service = await coordinator(() =>
    new Response(null, { status: 200 })
  )
  assertEquals(
    await burn([remote({ url: service.url })], 'spent', 'captcha wall'),
    ['remote'],
  )
  assertEquals(service.seen[0].path, '/burn')
  assertEquals(service.seen[0].body, { id: 'spent', reason: 'captcha wall' })
})

Deno.test('a coordinator that refuses the burn does not fail the caller', async () => {
  // A burn is best-effort withdrawal issued while something has already gone
  // wrong; it must not become a second failure on top.
  await using service = await coordinator(() =>
    new Response(null, { status: 503 })
  )
  assertEquals(await burn([remote({ url: service.url })], 'x', 'blocked'), [
    'remote',
  ])
})
