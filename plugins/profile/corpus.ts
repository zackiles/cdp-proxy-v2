/**
 * @module plugins/profile/corpus
 * @description Draw from a file of captured real machines (§2.3).
 *
 * `generate` invents rows that are *consistent* with what public aggregates say;
 * a corpus row was measured on a machine that exists. The difference is the
 * correlations nobody thought to write down — the exact ANGLE driver build that
 * ships with that GPU on that Windows patch level, the font list a Dell laptop
 * actually has after Office is installed, the two-pixel `chromeHeight` a
 * particular display scale produces. A table encodes the correlations its author
 * knew about. A capture encodes all of them.
 *
 * ## The format
 *
 * JSONL: one JSON object per line, blank lines and `//` comments skipped. Each
 * object is a `Draw` minus the fields the runtime owns (`seed`, `source`,
 * `schema` are stamped here), plus an optional `weight`.
 *
 * ```jsonl
 * {"id":"dell-7420","weight":3,"os":"Windows","osVersion":"19.0.0","arch":"x86", … }
 * {"id":"mbp-m2",   "weight":1,"os":"macOS",  "osVersion":"26.5.0","arch":"arm", … }
 * ```
 *
 * `tools/capture.ts` writes this format from a real browser on hardware you own.
 *
 * IMPORTANT: a row is used **whole or not at all**. There is no merging with
 * `generate`'s tables and no filling in of missing fields, because a row that is
 * half measured and half invented is exactly the incoherence the profile kind
 * exists to prevent (§2.4). A missing optional field stays missing and the
 * surface that wanted it stands down (§2.9), which leaves the real browser's
 * value in place rather than a made-up one.
 *
 * ## Weighting
 *
 * `weight` defaults to 1, and the sampler has no uniform mode (§2.5). A corpus of
 * twelve machines sampled uniformly gives every one of them an 8% share, which is
 * a fleet no real population looks like; weights are how a corpus of mostly
 * laptops stays mostly laptops.
 */

import { definePlugin } from '../../src/plugin.ts'
import { Config } from '../../src/config.ts'
import { SCHEMA } from '../../src/profile.ts'
import type { Constraint, Draw, PluginFactory } from '../../src/types.ts'

export interface CorpusOptions {
  /** Path to the JSONL file. Defaults to `CDP_CORPUS`. */
  path?: string
  /**
   * Where to record burns so a restart still knows about them (§2.7).
   *
   * Off unless a path is given, and a *separate* path on purpose: the corpus is
   * an input, and a run that edits its own input cannot be re-run. With no file
   * the withdrawal lasts as long as the process, which is enough for a single
   * long-lived fleet member and not enough for anything that restarts.
   */
  burns?: string
  [key: string]: unknown
}

interface Row {
  draw: Omit<Draw, 'seed' | 'source' | 'schema'> & { schema?: number }
  weight: number
}

/**
 * Parsed files, keyed by path. A corpus is read once per process rather than
 * once per session: it is an immutable input, and re-reading it for every
 * connection turns a fleet's startup into a file-system benchmark.
 */
const files = new Map<string, Row[]>()

/**
 * Ids withdrawn by `burn` (§2.7). Never written back to the corpus itself — that
 * is an input, and a run that edits its own input cannot be re-run — but written
 * to `burns` when the caller named one, and read back from it on the next start.
 */
const burnt = new Set<string>()

/** Burn files already folded into {@link burnt}, so each is read once. */
const recovered = new Set<string>()

async function withdrawn(file: string): Promise<void> {
  if (recovered.has(file)) return
  recovered.add(file)
  const text = await Deno.readTextFile(file).catch(() => '')
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      // Tolerant on the way in: the file is appended to under failure, and a
      // process killed mid-write leaves half a line. That should cost the one
      // burn it was writing rather than every burn before it.
      const { id } = JSON.parse(line) as { id?: string }
      if (id) burnt.add(id)
    } catch { /* half a line is one lost burn, not a broken loader */ }
  }
}

async function load(path: string): Promise<Row[]> {
  const cached = files.get(path)
  if (cached) return cached

  const text = await Deno.readTextFile(path)
  const rows: Row[] = []
  let line = 0
  for (const raw of text.split('\n')) {
    line++
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('//')) continue
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(trimmed)
    } catch (err) {
      throw new Error(
        `${path}:${line} is not JSON: ${(err as Error).message}`,
      )
    }
    // A row missing a required field would draw a profile that claims nothing on
    // an axis every surface expects, so it is rejected at load with the line
    // number rather than at draw with a property access on undefined.
    for (const field of REQUIRED) {
      if (parsed[field] === undefined) {
        throw new Error(`${path}:${line} has no ${field}`)
      }
    }
    const { weight, ...draw } = parsed
    rows.push({
      draw: draw as unknown as Row['draw'],
      weight: typeof weight === 'number' && weight > 0 ? weight : 1,
    })
  }
  if (rows.length === 0) throw new Error(`${path} has no rows`)
  files.set(path, rows)
  return rows
}

const REQUIRED = [
  'id',
  'os',
  'osVersion',
  'arch',
  'chrome',
  'userAgent',
  'brands',
  'languages',
  'locale',
  'timezone',
  'screen',
  'viewport',
  'chromeHeight',
  'hardware',
] as const

/** `CDP_CORPUS`, so a standalone server points at a file without any code. */
function configured(): string {
  try {
    return Config.get('corpus')
  } catch {
    return ''
  }
}

/** Whether a row can honestly answer what was asked (§2.4). */
function fits(row: Row['draw'], constraint: Constraint): boolean {
  if (constraint.id && constraint.id !== row.id) return false
  if (constraint.os && !constraint.os.includes(row.os)) return false
  if (constraint.locale && !constraint.locale.includes(row.locale)) return false
  if (constraint.timezone && !constraint.timezone.includes(row.timezone)) {
    return false
  }
  if (constraint.minChrome && row.chrome < constraint.minChrome) return false
  return true
}

export const corpus: PluginFactory<CorpusOptions> = definePlugin<CorpusOptions>(
  {
    kind: 'profile',
    // Above `generate`, below `pin`: a captured row beats an invented one, and
    // an explicit id beats both.
    priority: 50,
    name: 'corpus',
    setup(options, ctx) {
      return {
        async draw(constraint) {
          const path = options.path || configured()
          if (!path) return undefined
          if (options.burns) await withdrawn(options.burns)
          const rows = await load(path)
          const eligible = rows.filter((r) =>
            !burnt.has(r.draw.id) && fits(r.draw, constraint)
          )
          if (eligible.length === 0) {
            // Passing rather than throwing is what makes the chain a chain: a
            // corpus with no Windows row should fall through to `generate`, not
            // fail the session (§2.3).
            ctx.log(
              `no row of ${rows.length} fits${
                burnt.size > 0 ? ` (${burnt.size} burnt)` : ''
              }`,
            )
            return undefined
          }

          const total = eligible.reduce((sum, r) => sum + r.weight, 0)
          let point = ctx.random() * total
          const chosen = eligible.find((r) => (point -= r.weight) <= 0) ??
            eligible[0]

          return {
            ...chosen.draw,
            schema: chosen.draw.schema ?? SCHEMA,
            seed: `${chosen.draw.id}:${ctx.seed}`,
            source: 'corpus',
          } as Draw
        },

        async burn(id, reason) {
          burnt.add(id)
          if (!options.burns) {
            ctx.log(`withdrew ${id} for this process: ${reason}`)
            return
          }
          // Appended rather than rewritten, so two processes sharing a burn file
          // cannot lose each other's withdrawals to a read-modify-write.
          await Deno.writeTextFile(
            options.burns,
            JSON.stringify({ id, reason, at: new Date().toISOString() }) + '\n',
            { append: true, create: true },
          ).catch((err) =>
            ctx.log(`withdrew ${id}, but could not record it: ${err.message}`)
          )
          ctx.log(`withdrew ${id}: ${reason}`)
        },
      }
    },
  },
)

/** Test seam: a corpus is cached per process, and a test writes a new file. */
export function forget(): void {
  files.clear()
  burnt.clear()
  recovered.clear()
}

export default corpus
