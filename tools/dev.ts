/**
 * @module dev
 * @description `deno task dev --plugin <name>` — the headful iteration loop (§9.7).
 *
 * A change is one save away from a visible result: `--watch` restarts the
 * process, this reopens a headful browser with the plugin installed, and the
 * profile is pinned so the machine is the same one every time. Without a pin the
 * GPU and the screen change on every reload and a real regression is
 * indistinguishable from a redraw.
 *
 * ```sh
 * deno task dev --plugin webgl                 # on a served local page
 * deno task dev --plugin webgl --url https://abrahamjuliot.github.io/creepjs/
 * deno task dev --plugin webgl --id 8f2cd104   # a machine you saw a failure on
 * ```
 *
 * It takes the plugin's `name`, not its path, for the same reason nothing else
 * does: a path is inert (§10.1).
 *
 * With no `--plugin` it runs the standalone proxy instead, which is what this
 * task did before the loop existed and is still what you want when the thing
 * being iterated on is the server.
 */

import { parseArgs } from '@std/cli/parse-args'
import { basename, join, toFileUrl } from '@std/path'
import { Config } from '../src/config.ts'
import type { ConfiguredPlugin, PluginFactory, PresetFactory } from '../src/types.ts'

const ROOT = new URL('..', import.meta.url).pathname

async function* files(directory: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(directory)) {
    if (entry.name.startsWith('.') || entry.name.includes('.disabled.')) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory) yield* files(path)
    else if (/\.ts$/.test(entry.name)) yield path
  }
}

/** Find a plugin or preset by the name it declares, wherever it was filed. */
async function find(
  wanted: string,
): Promise<ConfiguredPlugin[] | undefined> {
  const named: string[] = []
  for await (const path of files(join(ROOT, 'plugins'))) {
    const mod = await import(toFileUrl(path).href).catch(() => undefined) as
      | Record<string, unknown>
      | undefined
    const factory = (mod?.default ?? mod?.[basename(path, '.ts')]) as
      | PluginFactory<Record<string, unknown>>
      | PresetFactory<Record<string, unknown>>
      | undefined
    if (typeof factory !== 'function') continue
    const name = 'pluginName' in factory ? factory.pluginName : factory.presetName
    named.push(name)
    if (name !== wanted) continue
    const made = factory({})
    return Array.isArray(made) ? made : [made]
  }
  console.error(
    `no plugin named ${wanted}. This tree has: ${named.sort().join(' ')}`,
  )
  return undefined
}

async function main(): Promise<number> {
  const args = parseArgs(Deno.args, {
    string: ['plugin', 'url', 'id', 'debug'],
    boolean: ['headless'],
    default: { headless: false },
  })

  if (!args.plugin) {
    await import('../src/main.ts')
    return 0
  }

  const plugins = await find(args.plugin)
  if (!plugins) return 1

  Config.setGlobal(
    new Config(
      await Config.create({
        CDP_HEADLESS: String(args.headless),
        CDP_PROXY_HOST: 'localhost',
        CDP_BROWSER_HOST: 'localhost',
      }),
    ),
  )

  const { chromium, rpc, shutdown } = await import('../src/sdk.ts')
  const { pin } = await import('../plugins/profile/pin.ts')

  // Pinned, so the machine is the same one on every save. `--id` reopens the
  // machine a failure happened on, which is what makes one re-openable (§2.4).
  const id = args.id ?? `dev-${args.plugin}`
  const browser = await chromium.launch({
    plugins: [pin({ id }), ...plugins],
    headless: args.headless,
    isolation: 'browser',
    debug: args.debug ?? args.plugin,
  })

  // DANGER: a served page rather than `about:blank`, because `about:blank` is
  // not a secure context and not an origin. `getBattery`, `navigator.
  // mediaDevices`, service workers and blob workers are all absent or refused
  // there, so a surface iterated on the blank page looks like it stood down when
  // it works — the same trap `harness.origin()` exists to avoid in tests.
  const local = args.url ? undefined : Deno.serve(
    { port: 0, onListen: () => {} },
    () =>
      new Response(
        `<!doctype html><title>dev: ${args.plugin}</title>` +
          `<h1>${args.plugin}</h1><p>Open DevTools, or pass --url.`,
        { headers: { 'content-type': 'text/html' } },
      ),
  )
  const url = args.url ??
    `http://localhost:${(local!.addr as Deno.NetAddr).port}/`

  const page = await browser.newPage()
  const session = await page.context().newCDPSession(page)
  const { profile, coverage } = await rpc(session).profile()
  await page.goto(url)

  console.log(`\nprofile ${profile?.id} ${profile?.os} ${profile?.osVersion}`)
  console.log(`chrome ${profile?.chrome} / ${profile?.locale} / ${profile?.timezone}`)
  if (coverage) {
    for (const [field, by] of Object.entries(coverage.read)) {
      console.log(`  ${field} ← ${by.join(' ')}`)
    }
    if (coverage.uncovered.length > 0) {
      console.log(`  uncovered ${coverage.uncovered.join(' ')}`)
    }
    for (const [name, why] of Object.entries(coverage.stoodDown)) {
      console.log(`  ${name} stood down: ${why}`)
    }
  }
  console.log(`\nat ${url}`)
  console.log('save the plugin to reload; ctrl-c to stop')

  // The browser stays open until the watcher kills the process, which is the
  // whole loop: edit, save, look.
  await new Promise<void>((resolve) => {
    Deno.addSignalListener('SIGINT', resolve)
  })
  await browser.close().catch(() => {})
  await local?.shutdown()
  await shutdown()
  return 0
}

if (import.meta.main) Deno.exit(await main())
