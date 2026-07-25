/**
 * @module plugin
 * @description The plugin platform (Persona B). Authors call {@link definePlugin}
 * to produce a typed, configurable factory; the runtime instantiates one isolated
 * instance per session and drives it through the {@link Pipeline}.
 */

import type {
  CDPDocument,
  CDPEvent,
  CDPRequest,
  CDPResponse,
  CDPTarget,
  ConfiguredPlugin,
  PluginContext,
  PluginDefinition,
  PluginFactory,
  PluginHooks,
  RequestOutcome,
} from './types.ts'
import { Logger } from './logger.ts'
import { Debug, type Outcome } from './debug.ts'
import { asError } from './utils.ts'

/**
 * Compiles CDP-method globs (e.g. `Runtime.*`, `Page.frameNavigated`) into a
 * predicate. Absent/empty globs match everything.
 */
function compileMatcher(globs?: string[]): (method: string) => boolean {
  if (!globs || globs.length === 0) return () => true
  const patterns = globs.map(
    (g) =>
      new RegExp(
        '^' + g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') +
          '$',
      ),
  )
  return (method) => patterns.some((re) => re.test(method))
}

/**
 * Turn a typed plugin definition into a factory an automator can configure and
 * pass in a session's `plugins: [...]`. Each factory call captures resolved
 * options; the runtime calls `setup` once per session for isolated state.
 */
export function definePlugin<Options extends Record<string, unknown>>(
  def: PluginDefinition<Options>,
): PluginFactory<Options> {
  const matches = compileMatcher(def.match)
  const factory = ((options?: Partial<Options>): ConfiguredPlugin => {
    const resolved = { ...(def.defaults ?? {}), ...(options ?? {}) } as Options
    return {
      name: def.name,
      options: resolved as Record<string, unknown>,
      priority: def.priority ?? 0,
      matches,
      match: def.match,
      optional: def.optional,
      setup: (ctx: PluginContext) => def.setup(resolved, ctx),
    }
  }) as PluginFactory<Options>
  factory.pluginName = def.name
  return factory
}

interface InstalledPlugin {
  name: string
  priority: number
  matches: (method: string) => boolean
  hooks: PluginHooks
  ctx: PluginContext
}

/**
 * A per-session chain of installed plugins. Runs hooks in priority order with
 * per-hook error isolation; a throwing plugin never breaks message flow.
 */
export class Pipeline {
  #plugins: InstalledPlugin[] = []
  readonly #debug: Debug

  private constructor(plugins: InstalledPlugin[], debug: Debug) {
    this.#plugins = plugins
    this.#debug = debug
  }

  /**
   * `context` is a factory rather than a single object so every plugin gets its
   * own view: its `log`, `send` and `emit` are attributed to it by name, which is
   * what makes traces readable and stops one plugin reaching another's.
   */
  static async install(
    plugins: ConfiguredPlugin[],
    context: (plugin: string) => PluginContext,
    debug: Debug = Debug.using(''),
  ): Promise<Pipeline> {
    const installed: InstalledPlugin[] = []
    const failed: string[] = []
    for (const p of plugins) {
      try {
        const ctx = context(p.name)
        installed.push({
          name: p.name,
          priority: p.priority,
          matches: p.matches,
          hooks: await p.setup(ctx),
          ctx,
        })
      } catch (err) {
        const error = asError(err)
        Logger.get(`plugin:${p.name}`).error('setup failed', { error })
        if (!p.optional) failed.push(`${p.name} (${error.message})`)
      }
    }
    // A hook that throws on one message is recoverable, so those stay isolated.
    // A plugin that never installed is not: the session would run on believing it
    // is configured in a way it is not, which for stealth means quietly handing
    // back a plain browser. Fail the session instead.
    if (failed.length > 0) {
      throw new Error(`plugin setup failed: ${failed.join(', ')}`)
    }
    installed.sort((a, b) => b.priority - a.priority)

    const pipeline = new Pipeline(installed, debug)
    debug.installed(installed.map((p) => ({
      name: p.name,
      priority: p.priority,
      match: plugins.find((c) => c.name === p.name)?.match,
      hooks: Object.keys(p.hooks),
    })))
    return pipeline
  }

  get size(): number {
    return this.#plugins.length
  }

  /** The plugins actually installed, in the order they run. */
  get names(): string[] {
    return this.#plugins.map((p) => p.name)
  }

  async onRequest(msg: CDPRequest): Promise<RequestOutcome> {
    let current: CDPRequest = msg
    for (const p of this.#plugins) {
      if (!p.hooks.onRequest || !p.matches(msg.method)) continue
      const run = await this.#guard(
        p,
        'onRequest',
        msg.method,
        () => p.hooks.onRequest!(current, p.ctx),
      )
      if (!run.ok) continue
      const outcome = run.value
      if (outcome === null) {
        this.#trace(p, 'onRequest', msg.method, 'drop')
        // Every CDP command has a client awaiting its id, so a refused command is
        // answered rather than discarded. Discarding it hung the client until its
        // own timeout, with nothing on the wire to explain why.
        return {
          respond: {
            error: {
              code: -32000,
              message: `${msg.method} was refused by plugin "${p.name}"`,
            },
          },
        }
      }
      if (outcome && typeof outcome === 'object' && 'respond' in outcome) {
        this.#trace(p, 'onRequest', msg.method, 'respond')
        return outcome
      }
      const next = outcome && typeof outcome === 'object'
        ? outcome as CDPRequest
        : current
      this.#trace(
        p,
        'onRequest',
        msg.method,
        next === current ? 'pass' : 'change',
      )
      current = next
    }
    return current
  }

  async onResponse(msg: CDPResponse): Promise<CDPResponse | null> {
    let current: CDPResponse = msg
    const label = msg.method ?? `#${msg.id}`
    for (const p of this.#plugins) {
      if (!p.hooks.onResponse) continue
      if (msg.method && !p.matches(msg.method)) continue
      const run = await this.#guard(
        p,
        'onResponse',
        label,
        () => p.hooks.onResponse!(current, p.ctx),
      )
      if (!run.ok) continue
      if (run.value === null) {
        this.#trace(p, 'onResponse', label, 'drop')
        return null
      }
      if (run.value) current = run.value
    }
    return current
  }

  async onEvent(evt: CDPEvent): Promise<CDPEvent | null> {
    let current: CDPEvent = evt
    for (const p of this.#plugins) {
      if (!p.hooks.onEvent || !p.matches(evt.method)) continue
      const run = await this.#guard(
        p,
        'onEvent',
        evt.method,
        () => p.hooks.onEvent!(current, p.ctx),
      )
      if (!run.ok) continue
      const outcome = run.value
      if (outcome === null) {
        this.#trace(p, 'onEvent', evt.method, 'drop')
        return null
      }
      const next = outcome ?? current
      this.#trace(
        p,
        'onEvent',
        evt.method,
        next === current ? 'pass' : 'change',
      )
      current = next
    }
    return current
  }

  async onSessionStart(): Promise<void> {
    for (const p of this.#plugins) {
      if (!p.hooks.onSessionStart) continue
      await this.#guard(
        p,
        'onSessionStart',
        '-',
        () => p.hooks.onSessionStart!(p.ctx),
      )
    }
  }

  async onSessionEnd(): Promise<void> {
    for (const p of this.#plugins) {
      if (!p.hooks.onSessionEnd) continue
      await this.#guard(
        p,
        'onSessionEnd',
        '-',
        () => p.hooks.onSessionEnd!(p.ctx),
      )
    }
  }

  async onTargetAttached(target: CDPTarget): Promise<void> {
    for (const p of this.#plugins) {
      if (!p.hooks.onTargetAttached) continue
      await this.#guard(
        p,
        'onTargetAttached',
        target.type,
        () => p.hooks.onTargetAttached!(target, p.ctx),
      )
    }
  }

  async onTargetDetached(target: CDPTarget): Promise<void> {
    for (const p of this.#plugins) {
      if (!p.hooks.onTargetDetached) continue
      await this.#guard(
        p,
        'onTargetDetached',
        target.type,
        () => p.hooks.onTargetDetached!(target, p.ctx),
      )
    }
  }

  async onDocument(doc: CDPDocument): Promise<void> {
    for (const p of this.#plugins) {
      if (!p.hooks.onDocument) continue
      await this.#guard(
        p,
        'onDocument',
        doc.isMain ? 'page' : 'frame',
        () => p.hooks.onDocument!(doc, p.ctx),
      )
    }
  }

  #trace(
    p: InstalledPlugin,
    hook: string,
    method: string,
    outcome: Outcome,
  ): void {
    this.#debug.trace(
      p.name,
      method,
      `  ${p.name} ${hook} ${outcome} ${method}`,
    )
  }

  /**
   * Run one hook with its own error boundary and accounting. Returns `ok: false`
   * on failure so a caller cannot mistake a thrown hook for "forward unchanged" —
   * both would otherwise surface as `undefined`.
   */
  async #guard<T>(
    p: InstalledPlugin,
    hook: string,
    method: string,
    fn: () => T | Promise<T>,
  ): Promise<{ ok: true; value: T } | { ok: false }> {
    const started = this.#debug.enabled ? performance.now() : 0
    try {
      return { ok: true, value: await fn() }
    } catch (err) {
      Logger.get(`plugin:${p.name}`).error(`${hook} failed on ${method}`, {
        error: asError(err),
      })
      this.#trace(p, hook, method, 'error')
      return { ok: false }
    } finally {
      this.#debug.count(
        p.name,
        hook,
        this.#debug.enabled ? performance.now() - started : 0,
      )
    }
  }
}
