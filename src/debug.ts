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

const log = Logger.get('trace', { level: 'debug' })

/** What a plugin did with a message. */
export type Outcome = 'pass' | 'change' | 'drop' | 'respond' | 'error'

/** A plugin as the pipeline resolved it, for the install report and warnings. */
export interface Installed {
  name: string
  priority: number
  /** Declared method globs, if the plugin narrowed what it sees. */
  match?: string[]
  /** Names of the hooks the plugin actually implements. */
  hooks: string[]
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
  #installed: Installed[] = []

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
    this.#write(
      `pipeline: ${
        plugins.map((p) => `${p.name}(${p.priority})`).join(' → ') || 'empty'
      }`,
    )
    for (const p of plugins) {
      this.#write(
        `  ${p.name} hooks=${p.hooks.join(',') || 'none'} match=${
          p.match?.join(',') ?? '*'
        }`,
      )
    }
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
   */
  summary(outstanding: { plugin: string; method: string }[]): void {
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

    for (const { plugin, method } of outstanding) {
      log.warn(
        `[${this.#session}] ${plugin} was still awaiting ${method} when the session ended`,
      )
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
    plugins: (Installed & { calls: Record<string, number> })[]
  } {
    return {
      tracing: this.#filters.map((f) =>
        `${f.source.source}:${f.method.source}`
      ),
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
