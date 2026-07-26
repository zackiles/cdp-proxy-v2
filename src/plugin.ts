/**
 * @module plugin
 * @description The plugin platform. Authors call {@link definePlugin} to produce a
 * typed, configurable factory of any of the five kinds; the runtime partitions a
 * session's set by kind, resolves each partition in phase order, and drives the
 * on-wire ones through the {@link Pipeline}.
 *
 * `kind` is a field rather than a per-kind constructor, so the API stops growing
 * with the taxonomy: a sixth kind is a new value, not a sixth export.
 */

import type {
  CDPDocument,
  CDPEvent,
  CDPRequest,
  CDPResponse,
  CDPTarget,
  ConfiguredPlugin,
  Kind,
  PluginContext,
  PluginDefinition,
  PluginFactory,
  PluginHooks,
  PluginSet,
  PresetDefinition,
  PresetFactory,
  RequestOutcome,
} from './types.ts'
import { KINDS } from './types.ts'
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
export function definePlugin<
  Options extends Record<string, unknown>,
  Config = undefined,
>(def: PluginDefinition<Options, Config>): PluginFactory<Options> {
  const kind: Kind = def.kind ?? 'protocol'
  const match = 'match' in def ? def.match : undefined
  const urls = 'urls' in def ? def.urls : undefined
  const scope = 'scope' in def ? def.scope : undefined
  const matches = compileMatcher(match)

  const factory = ((options?: Partial<Options>): ConfiguredPlugin => {
    const resolved = { ...(def.defaults ?? {}), ...(options ?? {}) } as Options
    return {
      kind,
      name: def.name,
      options: resolved as Record<string, unknown>,
      priority: def.priority ?? 0,
      matches,
      match,
      urls,
      scope,
      optional: def.optional,
      // deno-lint-ignore no-explicit-any
      setup: (ctx: any) => (def.setup as any)(resolved, ctx),
    }
  }) as PluginFactory<Options>
  factory.pluginName = def.name
  factory.kind = kind
  return factory
}

/**
 * A named list of configured plugins — the mechanism for defaults, and how
 * `stealth()` survives being broken up into surfaces (§8.5).
 *
 * It stays a separate constructor because a preset is not a plugin with a sixth
 * kind: it expands to plugins, so giving it a `kind` would put a value in the
 * `Kind` union that the runtime never installs.
 */
export function definePreset<Options extends Record<string, unknown>>(
  def: PresetDefinition<Options>,
): PresetFactory<Options> {
  const factory = ((
    options?: Partial<Options & { without?: string[] }>,
  ): ConfiguredPlugin[] => {
    const cfg = {
      ...(def.defaults ?? {}),
      ...(options ?? {}),
    } as Options & { without?: string[] }
    const without = new Set(cfg.without ?? [])
    return def.plugins(cfg).filter((p) => !without.has(p.name))
  }) as PresetFactory<Options>
  factory.presetName = def.name
  return factory
}

/** Expand presets so the runtime only ever sees a flat list (§8.6). */
export function flatten(
  list: (ConfiguredPlugin | ConfiguredPlugin[])[],
): ConfiguredPlugin[] {
  return list.flat()
}

/**
 * Group a flat list by kind, refusing duplicate names within a kind.
 *
 * The duplicate check is the actual defence against corsac's two `math.ts`
 * files: identity is `name`, a path is inert, so two plugins claiming the same
 * subject collide here rather than silently shadowing each other (§10.1).
 */
export function partition(plugins: ConfiguredPlugin[]): PluginSet {
  const set = Object.fromEntries(
    KINDS.map((k) => [k, [] as ConfiguredPlugin[]]),
  ) as PluginSet
  const seen = new Set<string>()
  for (const plugin of plugins) {
    const id = `${plugin.kind}/${plugin.name}`
    if (seen.has(id)) {
      throw new Error(
        `two ${plugin.kind} plugins are both named "${plugin.name}"; ` +
          'a name must be unique within its kind',
      )
    }
    seen.add(id)
    set[plugin.kind].push(plugin)
  }
  return set
}

/**
 * Resolution order within a kind: core keeps the end of the order its job needs
 * and no `priority` can displace it (§8.4), then higher priority runs earlier.
 */
export function order(plugins: ConfiguredPlugin[]): ConfiguredPlugin[] {
  const rank = (p: ConfiguredPlugin) =>
    p.pinned === 'first' ? 2 : p.pinned === 'last' ? 0 : 1
  return [...plugins].sort((a, b) =>
    rank(b) - rank(a) || b.priority - a.priority
  )
}

interface InstalledPlugin {
  name: string
  kind: Kind
  priority: number
  pinned?: 'first' | 'last'
  matches: (method: string) => boolean
  hooks: PluginHooks
  ctx: PluginContext
}

/**
 * A per-session chain of installed `protocol` plugins. Runs hooks in resolution
 * order with per-hook error isolation; a throwing plugin never breaks message
 * flow.
 */
export class Pipeline {
  #plugins: InstalledPlugin[] = []
  readonly #debug: Debug
  /** Declared `Proxy.*` methods, by name, resolved once at install (§7.3). */
  readonly #rpc: Map<string, InstalledPlugin>

  private constructor(
    plugins: InstalledPlugin[],
    debug: Debug,
    rpc = new Map<string, InstalledPlugin>(),
  ) {
    this.#plugins = plugins
    this.#debug = debug
    this.#rpc = rpc
  }

  /** The custom methods this session answers, for `Proxy.hello` (§7.3). */
  get rpc(): string[] {
    return [...this.#rpc.keys()].sort()
  }

  /**
   * Answer a declared method, or `undefined` if nothing claimed it.
   *
   * Deliberately not routed through `onRequest`: a declared method bypasses
   * `match`, so a plugin that narrowed itself to `Page.*` still answers its own
   * RPC — which is the trap the declaration replaces.
   */
  async answer(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown> | undefined> {
    const owner = this.#rpc.get(method)
    if (!owner) return undefined
    const run = await this.#guard(
      owner,
      'rpc',
      method,
      () => owner.hooks.rpc![method](params, owner.ctx),
    )
    return run.ok ? run.value : {
      error: {
        code: -32000,
        message: `${owner.name} failed to answer ${method}`,
      },
    }
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
    for (const p of order(plugins)) {
      try {
        const ctx = context(p.name)
        installed.push({
          name: p.name,
          kind: p.kind,
          priority: p.priority,
          pinned: p.pinned,
          matches: p.matches,
          hooks: await p.setup(ctx),
          ctx,
        })
      } catch (err) {
        const error = asError(err)
        Logger.get(`plugin:${p.name}`).error('setup failed', { error })
        // Core is never optional and there is no degraded mode for it (§9.6).
        if (!p.optional || p.pinned) failed.push(`${p.name} (${error.message})`)
      }
    }
    // A hook that throws on one message is recoverable, so those stay isolated.
    // A plugin that never installed is not: the session would run on believing it
    // is configured in a way it is not, which for stealth means quietly handing
    // back a plain browser. Fail the session instead.
    if (failed.length > 0) {
      throw new Error(`plugin setup failed: ${failed.join(', ')}`)
    }

    // Registered here rather than matched per message, which is what makes a
    // collision an error at session start instead of a coin toss at call time
    // (§7.3). Two plugins claiming one name is the failure the declaration
    // exists to catch, so it fails the session like any other setup failure.
    const rpc = new Map<string, InstalledPlugin>()
    for (const p of installed) {
      for (const method of Object.keys(p.hooks.rpc ?? {})) {
        const held = rpc.get(method)
        if (held) {
          throw new Error(
            `plugin setup failed: ${p.name} and ${held.name} both declare ` +
              `${method}, and only one of them can answer it`,
          )
        }
        rpc.set(method, p)
      }
    }

    const pipeline = new Pipeline(installed, debug, rpc)
    debug.installed(installed.map((p) => ({
      name: p.name,
      kind: p.kind,
      priority: p.priority,
      pinned: p.pinned,
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
