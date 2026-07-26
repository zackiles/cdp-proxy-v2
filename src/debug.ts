/**
 * @module debug
 * @description Opt-in tracing for plugin authors, enabled with `CDP_DEBUG` or the
 * SDK's `debug` option. It answers the questions a plugin author cannot otherwise
 * answer from the outside:
 *
 * - What did the pipeline do with this message, and which plugin decided that?
 * - What did my plugin's own `ctx.send` / `ctx.emit` traffic look like?
 * - Why did my hook never run, and what was still in flight when things stopped?
 *
 * Trace lines are filtered by a spec of `source[:methodGlob]` entries, where
 * `source` is a plugin name or `proxy` for the transport itself:
 *
 * ```sh
 * CDP_DEBUG=1                    # everything
 * CDP_DEBUG=stealth              # one plugin's decisions
 * CDP_DEBUG=stealth:Runtime.*    # ...narrowed to the methods you care about
 * CDP_DEBUG=proxy,myplugin       # the transport plus your plugin
 * ```
 *
 * Tracing is inert unless asked for, so the hot path pays one boolean check.
 * Invocation counting is always on because it is a map bump, and it powers the
 * one diagnostic worth having for free: a plugin whose `match` globs never
 * matched anything is almost always a typo, and is otherwise silent.
 */

import { Config } from './config.ts'
import { Logger } from './logger.ts'
import { describe } from './profile.ts'
import type { Ledger } from './coverage.ts'
import type { LaunchSpec, Profile } from './types.ts'

const log = Logger.get('trace', { level: 'debug' })

/** What a plugin did with a message. */
export type Outcome = 'pass' | 'change' | 'drop' | 'respond' | 'error'

/** A plugin as the pipeline resolved it, for the install report and warnings. */
export interface Installed {
  name: string
  kind: string
  priority: number
  /** Which end of its kind's order core holds; absent for authored plugins. */
  pinned?: 'first' | 'last'
  /** Declared method globs, if the plugin narrowed what it sees. */
  match?: string[]
  /** Names of the hooks the plugin actually implements. */
  hooks: string[]
}

/** An actor and whether it is on a page, for `Proxy.debug` (§6.3). */
export interface Watching {
  name: string
  /** `idle` until a page matches, then `watching`, or `failed` if setup threw. */
  state: 'idle' | 'watching' | 'failed'
  /** The globs it declared, which is what to check when it stays idle. */
  urls?: string[]
  /** The page it took, or tried to. */
  url?: string
  reason?: string
}

const MESSAGE_HOOKS = ['onRequest', 'onResponse', 'onEvent']

interface Filter {
  source: RegExp
  method: RegExp
}

function glob(pattern: string): RegExp {
  return new RegExp(
    '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') +
      '$',
  )
}

export class Debug {
  readonly enabled: boolean
  readonly #filters: Filter[]
  readonly #session: string
  /** `plugin` → `hook` → [invocations, total ms]. */
  readonly #counts = new Map<string, Map<string, [number, number]>>()
  /** CDP method → how many times it actually crossed to the browser. */
  readonly #forwarded = new Map<string, number>()
  readonly #conflicts: string[] = []
  readonly #corrections: string[] = []
  readonly #actors = new Map<string, Watching>()
  #installed: Installed[] = []
  #surfaces: string[] = []
  #launch: LaunchSpec = { flags: [], env: {}, extensions: [], conflicts: [] }

  private constructor(spec: string, sessionToken: string) {
    this.#session = sessionToken.slice(0, 8)
    this.#filters = spec
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        // `1`/`true`/`all` are what people actually type when they want it all.
        if (/^(1|true|all|\*)$/i.test(entry)) {
          return { source: /.*/, method: /.*/ }
        }
        const [source, method = '*'] = entry.split(':')
        return { source: glob(source), method: glob(method) }
      })
    this.enabled = this.#filters.length > 0
  }

  /** Resolve the spec from config; tracing stays off if no config is installed. */
  static for(sessionToken: string): Debug {
    let spec = ''
    try {
      spec = Config.get('debug')
    } catch { /* embedded or under test: no global config, no tracing */ }
    return new Debug(spec, sessionToken)
  }

  /** For tests and embedders that want a spec without touching global config. */
  static using(spec: string, sessionToken = 'test'): Debug {
    return new Debug(spec, sessionToken)
  }

  /**
   * Report the resolved pipeline. Order and priority are the first thing to check
   * when plugins fight over the same message, and the declared globs are the
   * first thing to check when a hook never fires.
   */
  installed(plugins: Installed[]): void {
    this.#installed = plugins
    if (!this.enabled) return
    this.pipeline('protocol', plugins)
    for (const p of plugins) {
      this.#write(
        `  ${p.name} hooks=${p.hooks.join(',') || 'none'} match=${
          p.match?.join(',') ?? '*'
        }`,
      )
    }
  }

  /**
   * One kind's resolved order (§9.5). `*` marks a core plugin, shown at its
   * pinned end rather than with a priority, because it does not have one to
   * compare against.
   */
  pipeline(kind: string, plugins: Installed[]): void {
    if (!this.enabled) return
    const label = (p: Installed) =>
      p.pinned ? `${p.name}*` : `${p.name}(${p.priority})`
    this.#write(
      `pipeline ${kind}: ${plugins.map(label).join(' → ') || 'empty'}`,
    )
  }

  /**
   * The identity this session presents and who is carrying which part of it
   * (§2.8). The uncovered line is the one to read: a field nothing claimed is a
   * field where the real browser's value reaches the page, contradicting
   * everything the profile does claim.
   */
  profile(profile: Profile, coverage: Ledger): void {
    if (!this.enabled) return
    this.#write(`profile ${describe(profile)}`)
    for (const line of coverage.lines(profile)) this.#write(line)
  }

  /**
   * The surfaces that compiled, in delivery order. Reported separately from the
   * protocol pipeline because surfaces resolve once per session and then only
   * ever run in the page, where no trace line can reach them.
   */
  surfaces(names: string[]): void {
    this.#surfaces = names
    if (!this.enabled) return
    this.#write(`pipeline surface: ${names.join(' → ') || 'empty'}`)
  }

  /**
   * The actors this session configured, before any of them has seen a page.
   *
   * Registered up front so an actor that never matched anything is visible as
   * `idle` rather than absent — "my banner-dismisser did nothing" and "my
   * banner-dismisser was never installed" look identical from the client, and
   * they have different fixes (§6.3).
   */
  actors(plugins: { name: string; urls?: string[] }[]): void {
    for (const p of plugins) {
      this.#actors.set(p.name, { name: p.name, urls: p.urls, state: 'idle' })
    }
    if (!this.enabled) return
    this.#write(
      `pipeline actor: ${plugins.map((p) => p.name).join(' → ') || 'empty'}`,
    )
  }

  /** An actor took a page, or failed trying. */
  actor(name: string, url: string, failed?: string): void {
    const held = this.#actors.get(name)
    this.#actors.set(name, {
      name,
      urls: held?.urls,
      url,
      state: failed ? 'failed' : 'watching',
      reason: failed,
    })
    if (!this.enabled) return
    this.#write(
      failed
        ? `actor ${name} failed on ${url}: ${failed}`
        : `actor ${name} took ${url}`,
    )
  }

  /** How the process was started (§3.1), which no later trace can recover. */
  launched(spec: LaunchSpec): void {
    this.#launch = spec
    if (!this.enabled) return
    this.#write(`launch ${spec.flags.join(' ')}`)
    for (const [key, value] of Object.entries(spec.env)) {
      this.#write(`  env ${key}=${value}`)
    }
  }

  /** A field the running browser corrected, which is always worth seeing (§2.6). */
  reconciled(text: string): void {
    this.#corrections.push(text)
    if (this.enabled) this.#write(`  reconciled ${text}`)
  }

  /**
   * A resolution that had to pick a winner — a clobbered launch flag, a header
   * two surfaces both contributed. Recorded whether or not tracing is on, so
   * `Proxy.debug` can answer for it either way.
   */
  conflict(text: string): void {
    this.#conflicts.push(text)
    if (this.enabled) this.#write(`conflict  ${text}`)
  }

  /** A command that actually reached the browser, which is the wire-level fact. */
  forwarded(method: string): void {
    if (!this.enabled) return
    this.#forwarded.set(method, (this.#forwarded.get(method) ?? 0) + 1)
  }

  /** One trace line, if this source and method are in scope. */
  trace(source: string, method: string, text: string): void {
    if (!this.enabled) return
    if (
      !this.#filters.some((f) => f.source.test(source) && f.method.test(method))
    ) {
      return
    }
    this.#write(text)
  }

  /** Record an invocation so the summary and the never-matched warning can work. */
  count(plugin: string, hook: string, ms: number): void {
    let hooks = this.#counts.get(plugin)
    if (!hooks) this.#counts.set(plugin, hooks = new Map())
    const [calls, total] = hooks.get(hook) ?? [0, 0]
    hooks.set(hook, [calls + 1, total + ms])
  }

  /**
   * Close the session out: per-plugin totals when tracing, plus the warnings that
   * are worth raising either way — a plugin that never matched, and commands a
   * plugin was still waiting on when the session went away.
   *
   * `clean` is whether the session ended because somebody asked it to. A command
   * in flight when a client disconnects is the ordinary shape of a disconnect and
   * not worth a warning; the same list when the upstream died is the most useful
   * line in the log.
   */
  summary(
    outstanding: { plugin: string; method: string }[],
    clean = false,
  ): void {
    for (const p of this.#installed) {
      const hooks = this.#counts.get(p.name)
      const ran = MESSAGE_HOOKS.some((h) => hooks?.has(h))
      const listens = p.hooks.some((h) => MESSAGE_HOOKS.includes(h))
      if (p.match?.length && listens && !ran) {
        log.warn(
          `[${this.#session}] ${p.name} declared match=${
            p.match.join(',')
          } but no message hook ever ran — check the globs`,
        )
      }
    }

    for (const actor of this.#actors.values()) {
      if (actor.state === 'idle' && actor.urls?.length) {
        log.warn(
          `[${this.#session}] ${actor.name} declared urls=${
            actor.urls.join(',')
          } but no page ever matched — check the globs`,
        )
      }
    }

    for (const { plugin, method } of outstanding) {
      const text =
        `${plugin} was still awaiting ${method} when the session ended`
      if (clean) this.#write(text)
      else log.warn(`[${this.#session}] ${text}`)
    }

    if (!this.enabled) return
    this.#write('summary')
    // Walk the installed plugins rather than the counters, so a plugin that never
    // ran at all shows up as exactly that instead of silently missing.
    for (const p of this.#installed) {
      const hooks = this.#counts.get(p.name)
      const parts = [...hooks ?? []].map(([hook, [calls, ms]]) =>
        `${hook}=${calls}/${ms.toFixed(1)}ms`
      )
      this.#write(`  ${p.name} ${parts.join(' ') || 'no hooks ran'}`)
    }
  }

  /**
   * The same picture the trace lines paint, as data. Served over `Proxy.debug` so
   * a plugin author can assert on their hooks from a test instead of reading logs.
   */
  snapshot(): {
    tracing: string[]
    /**
     * Which commands reached the browser, and how often. Only populated while
     * tracing, because an unbounded map on the hot path of a long-lived
     * connection is a leak rather than a diagnostic.
     */
    forwarded: Record<string, number>
    conflicts: string[]
    /** What the running browser corrected about the drawn identity (§2.6). */
    reconciled: string[]
    /** The surfaces that compiled, in delivery order (§4.2). */
    surfaces: string[]
    /** Every configured actor and whether it is on a page (§6.3). */
    actors: Watching[]
    /**
     * The merge the process was started from (§3.1): flags, environment, data
     * dir, and the conflicts resolving them reported.
     */
    launch: LaunchSpec
    plugins: (Installed & { calls: Record<string, number> })[]
  } {
    return {
      tracing: this.#filters.map((f) =>
        `${f.source.source}:${f.method.source}`
      ),
      forwarded: Object.fromEntries(this.#forwarded),
      conflicts: [...this.#conflicts],
      reconciled: [...this.#corrections],
      surfaces: [...this.#surfaces],
      actors: [...this.#actors.values()],
      launch: {
        ...this.#launch,
        flags: [...this.#launch.flags],
        conflicts: [...this.#launch.conflicts],
      },
      plugins: this.#installed.map((p) => ({
        ...p,
        calls: Object.fromEntries(
          [...this.#counts.get(p.name) ?? []].map((
            [hook, [calls]],
          ) => [hook, calls]),
        ),
      })),
    }
  }

  #write(text: string): void {
    log.debug(`[${this.#session}] ${text}`)
  }
}
