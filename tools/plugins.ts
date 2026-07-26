/**
 * @module plugins
 * @description `deno task plugins` — every plugin, with what it reads (§9.7).
 *
 * The answer to "is there already a fonts surface?" without grepping, and
 * deliberately the primary discovery tool rather than the directory tree,
 * because a path is inert (§10.1). A listing that shows what each plugin
 * *reads* is more useful than one that shows where somebody filed it.
 *
 * Each plugin is **resolved**, not parsed. The tool builds it with its defaults,
 * runs `setup` against a recording view of a real drawn profile, and reports
 * what came back — so `reads gpu` is the same fact the coverage report is built
 * from rather than a second, drifting guess at it. That also means a plugin that
 * cannot set up without options says so here, which is worth knowing.
 *
 * ```sh
 * deno task plugins
 * deno task plugins surface     # one kind
 * ```
 */

import { basename, join, relative, resolve, toFileUrl } from '@std/path'
import type {
  ConfiguredPlugin,
  Kind,
  PluginContext,
  PluginFactory,
  PresetFactory,
  Profile,
} from '../src/types.ts'
import { KINDS } from '../src/types.ts'
import { Ledger } from '../src/coverage.ts'
import { machine } from '../src/core/generate.ts'
import { random, seal } from '../src/profile.ts'
import { core } from '../src/core/mod.ts'

const ROOT = new URL('..', import.meta.url).pathname

interface Row {
  tier: 'core' | 'authored'
  kind: Kind | 'preset'
  name: string
  path: string
  note: string
}

async function* files(directory: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(directory)) {
    if (entry.name.startsWith('.') || entry.name.includes('.disabled.')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory) yield* files(path)
    else if (/\.ts$/.test(entry.name)) yield path
  }
}

/**
 * What one plugin turns out to be, once built and set up.
 *
 * Every failure is a row rather than a throw: a listing that stops at the first
 * plugin needing an API key is a listing nobody can use.
 */
async function inspect(
  path: string,
  profile: Profile,
  tier: Row['tier'],
): Promise<Row | undefined> {
  const mod = await import(toFileUrl(resolve(path)).href) as Record<
    string,
    unknown
  >
  const factory = (mod.default ?? mod[basename(path, '.ts')]) as
    | PluginFactory<Record<string, unknown>>
    | PresetFactory<Record<string, unknown>>
    | undefined
  if (typeof factory !== 'function') return undefined

  const shown = relative(ROOT, resolve(path))
  if (!('pluginName' in factory)) {
    const expanded = (factory as PresetFactory<Record<string, unknown>>)()
    return {
      tier,
      kind: 'preset',
      name: (factory as PresetFactory<Record<string, unknown>>).presetName,
      path: shown,
      note: `expands to ${expanded.map((p) => p.name).join(' ')}`,
    }
  }

  const plugin: ConfiguredPlugin = factory()
  const ledger = new Ledger()
  const options = Object.keys(plugin.options)
  const notes: string[] = []

  let hooks: Record<string, unknown> = {}
  try {
    hooks = await plugin.setup(context(ledger.view(profile, plugin.name))) ??
      {}
    // A surface that reaches for CDP reads the profile inside `emulate` rather
    // than in `setup` — `timezone` reads nothing at all until it runs — so the
    // hook is called against the same inert context. Nothing is connected to
    // it, so this stays a read of the plugin rather than a run of it.
    const emulate = hooks.emulate as ((realm: unknown) => unknown) | undefined
    if (typeof emulate === 'function') {
      await emulate({
        realm: 'page',
        sessionId: 'plugins',
        send: () => Promise.resolve({}),
      })
    }
  } catch (err) {
    notes.push(`needs options: ${(err as Error).message}`)
  }

  const read = Object.keys(ledger.report(profile).read)
  if (read.length > 0) notes.unshift(`reads ${read.join(' ')}`)
  if (Array.isArray(hooks.realms)) {
    notes.push(`realms ${(hooks.realms as string[]).join(',')}`)
  }
  if (options.length > 0) notes.push(`opts ${options.join(' ')}`)
  if (plugin.match) notes.push(`match ${plugin.match.join(' ')}`)
  if (plugin.urls) notes.push(`urls ${plugin.urls.join(' ')}`)
  if (plugin.priority !== 0) notes.push(`priority ${plugin.priority}`)
  if (Object.keys(hooks).length === 0 && notes.length === 0) {
    notes.push('stood down against this profile')
  }

  return { tier, kind: plugin.kind, name: plugin.name, path: shown, note: notes.join('  ') }
}

/**
 * A context that is enough to set up against and not enough to act through.
 *
 * One shape for all five kinds, so the tool does not need to know which it is
 * holding: the members no kind of that plugin uses simply go untouched.
 *
 * DANGER: `send` resolving to `{}` is what lets a `launch` or `profile` plugin
 * be inspected at all, and it is also why nothing here may be *driven*. This
 * tool builds plugins to read them, never to run them.
 */
function context(profile: Profile): PluginContext {
  return {
    profile,
    sessionToken: 'plugins',
    connectionId: 'plugins',
    targets: new Map(),
    signal: new AbortController().signal,
    send: () => Promise.resolve({}),
    emit: () => {},
    inject: () => Promise.resolve(() => Promise.resolve()),
    state: <T>(_id: string, init: () => T) => init(),
    random: Math.random,
    seed: 'plugins',
    log: () => {},
    // The `actor` half: a `PageContext` an actor can subscribe to and question
    // without anything on the other end answering.
    target: { sessionId: 'plugins', targetId: 'plugins', type: 'page' },
    url: 'about:blank',
    on: () => {},
    cdp: () => () => {},
    eval: () => Promise.resolve(undefined),
    has: () => Promise.resolve(false),
    wait: () => Promise.resolve(false),
    click: () => Promise.resolve(),
    fill: () => Promise.resolve(),
    goto: () => Promise.resolve(),
  } as unknown as PluginContext
}

async function main(): Promise<number> {
  const only = Deno.args[0] as Kind | undefined
  if (only && !KINDS.includes(only)) {
    console.error(`unknown kind ${only}; expected one of ${KINDS.join(' ')}`)
    return 1
  }

  const profile = seal(machine({}, random('plugins'), 'plugins'))
  const rows: Row[] = []
  const pinned = new Map(core().map((p) => [p.name, p.pinned]))

  for (
    const [directory, tier] of [
      [join(ROOT, 'src', 'core'), 'core'],
      [join(ROOT, 'plugins'), 'authored'],
    ] as const
  ) {
    for await (const path of files(directory)) {
      try {
        const row = await inspect(path, profile, tier)
        if (row) rows.push(row)
      } catch (err) {
        rows.push({
          tier,
          kind: 'preset',
          name: basename(path, '.ts'),
          path: relative(ROOT, path),
          note: `failed to load: ${(err as Error).message}`,
        })
      }
    }
  }

  const shown = rows
    .filter((row) => !only || row.kind === only)
    .sort((a, b) =>
      a.tier.localeCompare(b.tier) || a.kind.localeCompare(b.kind) ||
      a.name.localeCompare(b.name)
    )

  const width = (pick: (row: Row) => string) =>
    Math.max(...shown.map((row) => pick(row).length))
  const tier = width((r) => r.tier)
  const kind = width((r) => r.kind)
  const name = width((r) => r.name)
  const path = width((r) => r.path)

  for (const row of shown) {
    const pin = pinned.get(row.name)
    console.log(
      [
        row.tier.padEnd(tier),
        row.kind.padEnd(kind),
        row.name.padEnd(name),
        row.path.padEnd(path),
        [pin && `pinned ${pin}`, row.note].filter(Boolean).join('  '),
      ].join('  ').trimEnd(),
    )
  }
  return 0
}

if (import.meta.main) Deno.exit(await main())
