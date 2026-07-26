/**
 * @module coverage
 * @description Which profile fields anything actually read (§2.8).
 *
 * Each kind gets its own view of the sealed profile and that view records reads,
 * so the runtime can report at session start what the identity claims and what
 * nothing is carrying:
 *
 * ```
 * profile 8f2c source=corpus Windows 11 / Chrome 147 / en-US / America/New_York
 *   navigator  reads userAgent brands os osVersion
 *   webgl      reads gpu
 *   uncovered  fonts hardware.memory
 *   media      stood down: profile has no media (schema 0 < 1)
 * ```
 *
 * **The uncovered line is the point.** A profile field that nothing read is a
 * field where the real browser's value reaches the page, contradicting
 * everything the profile does claim. Finding out you forgot a fonts surface
 * should be a line in a trace and an assertion in a test, not something a
 * detector tells you.
 *
 * The asymmetry is worth stating plainly: **unread is definitely uncovered; read
 * is only probably covered.** A surface that reads `gpu` and then installs a
 * broken patch still reports as covering it. This catches omissions, which are
 * the common failure, and does not catch mistakes.
 *
 * Two rules decide what the report can say, and both follow from what a reader
 * would do about a line:
 *
 * - **Only a present field can be uncovered.** An absent optional field claims
 *   nothing, so the browser's own value reaching the page is correct rather than
 *   contradictory. Listing it as uncovered would ask an author to go cover a
 *   field that does not exist.
 * - **Reading an absent field is a stand-down, not a read.** It is precisely what
 *   a surface guarding on its field does — `if (!ctx.profile.media) return {}` —
 *   so the runtime learns about the stand-down from the guard itself rather than
 *   from a second API the author has to remember to call (§2.9).
 */

import type { Coverage, Profile } from './types.ts'
import { SINCE } from './profile.ts'

/** Identity, not claims: nothing reaches a page through these. */
const INTERNAL = new Set(['id', 'seed', 'source', 'schema', 'noise'])

/**
 * Groups whose members are separate claims carried by separate surfaces, so the
 * report names the leaf. `gpu` is deliberately not one: it is a single claim that
 * one surface carries whole, and `gpu.vendor gpu.renderer gpu.angle` in the
 * uncovered line would be three lines of noise for one missing plugin.
 */
const EXPAND = new Set(['hardware'])

export class Ledger {
  readonly #read = new Map<string, Set<string>>()
  readonly #down = new Map<string, string>()

  /**
   * The profile as one plugin sees it: identical values, reads recorded against
   * that plugin's name.
   *
   * A `Proxy` rather than a wrapper with explicit getters because the recording
   * must not be something an author can forget to go through. `ctx.profile` is
   * the only profile a plugin is given, so every read is on the record and the
   * uncovered line cannot be quietly wrong.
   */
  view(profile: Profile, plugin: string): Profile {
    return this.#wrap(profile, '', plugin) as Profile
  }

  /** A plugin that installed nothing, and why (§2.9). */
  standDown(plugin: string, reason: string): void {
    if (!this.#down.has(plugin)) this.#down.set(plugin, reason)
  }

  /** What has been read so far, flat enough to carry between the two ledgers. */
  reads(): Record<string, string[]> {
    return Object.fromEntries([...this.#read].map(([f, p]) => [f, [...p]]))
  }

  /**
   * Take on reads that happened somewhere this ledger could not watch. The
   * `launch` kind is the case: it resolves at registration, against a candidate,
   * before the connection whose report has to account for it exists. A `--lang`
   * the profile decided is coverage of `locale`, and dropping it would put the
   * field in the uncovered line while a flag is carrying it.
   */
  adopt(reads: Record<string, string[]>): void {
    for (const [field, plugins] of Object.entries(reads)) {
      for (const plugin of plugins) this.#record(field, plugin)
    }
  }

  report(profile: Profile): Coverage {
    const read: Record<string, string[]> = {}
    for (const [field, plugins] of this.#read) read[field] = [...plugins]
    return {
      read,
      uncovered: fields(profile).filter((f) => !this.#read.has(f)),
      stoodDown: Object.fromEntries(this.#down),
    }
  }

  /** The §2.8 report, one line per plugin then the summary lines. */
  lines(profile: Profile): string[] {
    const byPlugin = new Map<string, string[]>()
    for (const [field, plugins] of this.#read) {
      for (const plugin of plugins) {
        const list = byPlugin.get(plugin) ?? []
        list.push(field)
        byPlugin.set(plugin, list)
      }
    }
    const width = Math.max(
      10,
      ...[...byPlugin.keys(), ...this.#down.keys()].map((n) => n.length),
    )
    const pad = (s: string) => s.padEnd(width)

    const out = [...byPlugin].map(([plugin, read]) =>
      `  ${pad(plugin)} reads ${read.join(' ')}`
    )
    const { uncovered } = this.report(profile)
    if (uncovered.length > 0) {
      out.push(`  ${pad('uncovered')} ${uncovered.join(' ')}`)
    }
    for (const [plugin, reason] of this.#down) {
      out.push(`  ${pad(plugin)} stood down: ${reason}`)
    }
    return out
  }

  #record(field: string, plugin: string): void {
    const plugins = this.#read.get(field) ?? new Set<string>()
    plugins.add(plugin)
    this.#read.set(field, plugins)
  }

  /**
   * One recording layer, over a copy rather than over the sealed row itself.
   *
   * DANGER: the copy is not an optimization and must not be removed. A `get` trap
   * on a frozen target is required to hand back the target's own value, so
   * proxying the sealed profile directly makes returning a recording wrapper for
   * `hardware` a `TypeError` at the first read. Immutability is preserved by the
   * traps below instead of by the target, which is a stronger guarantee anyway:
   * a write is refused with a message that says why rather than failing silently.
   */
  #wrap(source: object, prefix: string, plugin: string): object {
    const refuse = (key: string | symbol): never => {
      throw new TypeError(
        `${plugin} tried to set profile.${prefix}${String(key)}: a sealed ` +
          'profile is one coherent row and cannot be patched — draw again ' +
          'with a tighter constraint instead (§2.4)',
      )
    }

    return new Proxy({ ...source } as Record<string, unknown>, {
      get: (target, key) => {
        const value = Reflect.get(target, key)
        if (typeof key !== 'string' || INTERNAL.has(key)) return value
        const field = `${prefix}${key}`
        if (value === undefined) {
          // The schema is only worth naming when it is the reason: a row drawn
          // before the field existed is a different problem from a loader that
          // simply has nothing to say about it, and only the first is fixed by
          // drawing a newer row.
          const schema = (source as Profile).schema
          const since = SINCE[field]
          this.standDown(
            plugin,
            `profile has no ${field}` +
              (since && schema < since ? ` (schema ${schema} < ${since})` : ''),
          )
          return value
        }
        if (!prefix && EXPAND.has(key)) {
          return this.#wrap(value as object, `${key}.`, plugin)
        }
        this.#record(field, plugin)
        return value
      },
      set: (_target, key) => refuse(key),
      defineProperty: (_target, key) => refuse(key),
      deleteProperty: (_target, key) => refuse(key),
    })
  }
}

/** Every field of this profile that carries a claim to a page. */
export function fields(profile: Profile): string[] {
  const out: string[] = []
  for (const [key, value] of Object.entries(profile)) {
    if (INTERNAL.has(key) || value === undefined) continue
    if (EXPAND.has(key)) {
      out.push(...Object.keys(value as object).map((k) => `${key}.${k}`))
    } else out.push(key)
  }
  return out
}
