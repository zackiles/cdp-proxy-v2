/**
 * @module profile
 * @description The identity every other kind reads from (§2). A profile is one
 * coherent claim about one machine: drawn once, corrected against the process
 * that actually started, then frozen for the life of the run.
 *
 * The pipeline is §2.6:
 *
 * ```
 * draw(constraint) → candidate → launch reads it → browser starts
 *                              → reconcile → seal → published to every kind
 * ```
 *
 * Two properties are load-bearing and are enforced here rather than asked for.
 *
 * A sealed profile is **deeply frozen**, so there is no way to change one field
 * of a drawn row. Patching `os` to `'Windows'` on a row drawn from macOS is
 * exactly how a session ends up claiming an Apple GPU under a Windows
 * User-Agent; a variant means drawing again with a tighter constraint (§2.4).
 *
 * Reconciliation only ever moves the profile **toward** the process. It never
 * moves the process toward the profile. A profile that disagrees with its own
 * browser is worse than no profile, because every surface then confidently
 * asserts the disagreement (§2.6).
 */

import type {
  ConfiguredPlugin,
  Constraint,
  Draw,
  Profile,
  ProfileContext,
  ProfileHooks,
} from './types.ts'
import { order } from './plugin.ts'
import { Logger } from './logger.ts'
import { asError } from './utils.ts'

/**
 * Bumped whenever a field is added. A row drawn under an older schema is missing
 * the newer fields, and a surface compares before standing down (§2.9).
 */
export const SCHEMA = 1

/** When each optional field was introduced, so a stand-down can say why. */
export const SINCE: Readonly<Record<string, number>> = {
  geo: 1,
  gpu: 1,
  fonts: 1,
  media: 1,
}

/**
 * A 32-bit string hash (xmur3). Only used to seed the generator and to derive
 * `noise`, both of which need speed and determinism rather than cryptographic
 * strength — and both must be synchronous, which rules out `crypto.subtle`.
 */
function hash(str: string): number {
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return (h ^= h >>> 16) >>> 0
}

/**
 * A seeded generator (mulberry32). Two runs given the same seed draw the same
 * machine, which is what makes a failure reproducible tomorrow.
 */
export function random(seed: string): () => number {
  let a = hash(seed)
  return () => {
    a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Freeze every object hanging off the profile, not just the top level. A shallow
 * freeze would leave `profile.screen.width` writable, and a single mutated
 * sub-field is the same incoherence as a mutated top-level one.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key])
  }
  return Object.freeze(value)
}

/**
 * Attach `noise` and freeze. `noise` is derived from the seed here rather than by
 * each loader, so a loader that forgot it cannot produce a profile whose jitter
 * is not reproducible.
 *
 * DANGER: `noise(key)` must be stable for the life of the profile. Canvas and
 * audio evasions jitter their output by it, and a real browser returns a *stable*
 * hash — a page that reads the canvas twice and gets two answers has caught you
 * with one line of JavaScript. Deriving it from the seed makes it stable across
 * reloads, across pages, and across runs whenever the profile is pinned (§2.10).
 */
export function seal(draw: Draw): Profile {
  const seed = draw.seed
  const cache = new Map<string, number>()
  const profile: Profile = {
    ...draw,
    noise(key: string): number {
      let value = cache.get(key)
      if (value === undefined) {
        cache.set(key, value = hash(`${seed}:${key}`) / 4294967296)
      }
      return value
    },
  }
  return deepFreeze(profile)
}

/**
 * Chrome's own GREASE algorithm, reproduced rather than approximated: the
 * greased brand, its version, and the order of the three entries are all derived
 * from the major version, so a real Chrome 147 and a drawn row produce the same
 * `navigator.userAgentData.brands`.
 *
 * It lives here rather than in `generate` because reconciliation needs it too. A
 * corrected version has to be re-greased rather than pasted over the old list:
 * the greased entry carries a *greased* version (`8`, `99`, `24`), so writing the
 * major into it produces a brand list no Chrome has ever sent.
 */
export function brands(major: number): { brand: string; version: string }[] {
  const chars = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_']
  const versions = ['8', '99', '24']
  const orders = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [
    2,
    1,
    0,
  ]]
  const entries = [
    {
      brand: `Not${chars[major % chars.length]}A${
        chars[(major + 1) % chars.length]
      }Brand`,
      version: versions[major % versions.length],
    },
    { brand: 'Chromium', version: String(major) },
    { brand: 'Google Chrome', version: String(major) },
  ]
  return orders[major % orders.length].map((i) => entries[i])
}

/** What the running process turned out to be, for reconciliation. */
export interface Facts {
  /** `Browser.getVersion`'s `product`, e.g. `HeadlessChrome/140.0.7259.5`. */
  product?: string
  userAgent?: string
}

/**
 * Correct a candidate against the browser that actually started, returning the
 * corrected row and a line per correction for the trace.
 *
 * The clearest case is the Chrome version, and it is the reason this step exists
 * at all: a page can feature-detect. If the profile claims 148 and the binary is
 * 147, an API that shipped in 148 is missing and the claim is caught in one line.
 * No loader can know the binary's version, so the profile's version is whatever
 * the binary says it is.
 */
export function reconcile(
  draw: Draw,
  facts: Facts,
): { draw: Draw; corrections: string[] } {
  const corrections: string[] = []
  let next = draw

  const actual = Number(facts.product?.match(/\/(\d+)\./)?.[1])
  if (actual && actual !== next.chrome) {
    corrections.push(`chrome ${next.chrome} → ${actual} (the binary's version)`)
    next = {
      ...next,
      chrome: actual,
      userAgent: next.userAgent.replace(/Chrome\/\d+/, `Chrome/${actual}`),
      brands: brands(actual),
    }
  }

  // A loader is free to build its own User-Agent, and one that read it off a
  // headless binary would hand the page the single most direct tell there is.
  if (/HeadlessChrome/.test(next.userAgent)) {
    corrections.push('userAgent: dropped the HeadlessChrome token')
    next = {
      ...next,
      userAgent: next.userAgent.replace('HeadlessChrome', 'Chrome'),
    }
  }

  return { draw: next, corrections }
}

/**
 * Walk the loaders in priority order until one answers, then stamp the fields the
 * runtime owns.
 *
 * `undefined` means "I cannot satisfy this constraint", so composition falls out
 * of ordering: a `pin` that only answers when its id is set sits above a `corpus`
 * that answers when it has a match, above core `generate`, which is pinned last
 * and can satisfy anything. The chain therefore cannot fail to answer, and the
 * throw below is for the one case that is a bug rather than a configuration:
 * core was dropped.
 */
export async function draw(
  loaders: ConfiguredPlugin[],
  constraint: Constraint,
  seed: string,
  signal: AbortSignal = new AbortController().signal,
): Promise<Draw> {
  const refused: string[] = []
  for (const loader of order(loaders)) {
    const log = Logger.get(`plugin:${loader.name}`)
    try {
      const hooks = await (loader.setup as unknown as (
        ctx: ProfileContext,
      ) => ProfileHooks | Promise<ProfileHooks>)({
        seed,
        signal,
        random: random(`${seed}:${loader.name}`),
        log: (...args) => log.debug(args.map(String).join(' ')),
      })
      const row = await hooks.draw(constraint)
      if (!row) {
        refused.push(`${loader.name}: no match`)
        continue
      }
      // `source` is stamped rather than trusted: a loader that delegates its draw
      // to another loader's tables would otherwise report the wrong origin, and
      // the trace's whole job is saying where the identity came from.
      //
      // The seed is the other way round — the loader's wins. It belongs to the
      // row rather than to the run, because `noise` derives from it: overwriting
      // a pinned row's seed with the run's would give the same pinned identity a
      // different canvas hash on every run, which is exactly the stability
      // `pin` exists to provide (§2.10).
      return { ...row, source: loader.name, seed: row.seed || seed }
    } catch (err) {
      // A loader that throws is skipped rather than fatal: the chain exists so
      // that a source being unavailable falls through to the next one, and an
      // unreachable `remote` should degrade to `generate`, not fail the session.
      const error = asError(err)
      refused.push(`${loader.name}: ${error.message}`)
      log.error('draw failed', { error })
    }
  }
  // Naming what each loader said turns the usual cause — a constraint nothing can
  // satisfy — into an answer, rather than a report that the terminal loader is
  // missing when it is sitting right there having refused.
  throw new Error(
    `no profile loader answered${
      refused.length > 0 ? ` (${refused.join('; ')})` : ''
    }`,
  )
}

/**
 * Retire an identity, telling every loader that keeps state (§2.7).
 *
 * Which loader drew the row is not enough to decide who to tell: a `corpus` row
 * handed out by a `remote` coordinator is burnt in both places or in neither, and
 * a loader that does not implement `burn` — `generate`, `pin` — ignores it by
 * having nothing to ignore it with. So the whole chain is told and the ones with
 * something to do, do it.
 *
 * Failures are collected rather than thrown. A burn is a best-effort withdrawal
 * issued while something has already gone wrong, and an unreachable coordinator
 * must not turn "this identity is blocked" into a second failure on top.
 */
export async function burn(
  loaders: ConfiguredPlugin[],
  id: string,
  reason: string,
  // Only here because `setup` takes a context; nothing a `burn` does reads it.
  seed = id,
  signal: AbortSignal = new AbortController().signal,
): Promise<string[]> {
  const told: string[] = []
  for (const loader of order(loaders)) {
    const log = Logger.get(`plugin:${loader.name}`)
    try {
      const hooks = await (loader.setup as unknown as (
        ctx: ProfileContext,
      ) => ProfileHooks | Promise<ProfileHooks>)({
        seed,
        signal,
        random: random(`${seed}:${loader.name}`),
        log: (...args) => log.debug(args.map(String).join(' ')),
      })
      if (!hooks.burn) continue
      await hooks.burn(id, reason)
      told.push(loader.name)
    } catch (err) {
      log.warn(`could not withdraw ${id}`, { error: asError(err) })
    }
  }
  return told
}

/**
 * Whether an already-drawn identity answers a constraint (§2.7).
 *
 * The pool needs this and the loaders do not: a loader draws to fit, whereas a
 * pool slot was launched hours ago against whatever the fleet drew, and the
 * question is only ever whether the session can be put on it. Failing the test
 * is not an error — it is what promotes the session to a process of its own.
 */
export function satisfies(profile: Draw, constraint: Constraint): boolean {
  if (constraint.id && constraint.id !== profile.id) return false
  if (constraint.os && !constraint.os.includes(profile.os)) return false
  if (constraint.locale && !constraint.locale.includes(profile.locale)) {
    return false
  }
  if (constraint.timezone && !constraint.timezone.includes(profile.timezone)) {
    return false
  }
  if (constraint.minChrome && profile.chrome < constraint.minChrome) {
    return false
  }
  return true
}

/**
 * Everything a session needs to know about its identity, kept together because
 * the report is only meaningful next to the row it describes.
 */
export function describe(profile: Profile): string {
  return `${profile.id} source=${profile.source} ${profile.os} ` +
    `${profile.osVersion} / Chrome ${profile.chrome} / ${profile.locale} / ` +
    `${profile.timezone}`
}
