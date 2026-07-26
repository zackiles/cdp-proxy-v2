/**
 * @module new
 * @description `deno task new <kind> <path>` — scaffold a plugin and its test (§9.7).
 *
 * Scaffold rather than copy. Copying the nearest existing plugin is how a kind's
 * conventions drift: the copy brings the original's realms, its priority, and
 * its guards, and the differences that mattered are invisible in a diff against
 * nothing.
 *
 * ```sh
 * deno task new surface graphics/webgl   # plugins/surface/graphics/webgl.ts
 * deno task new surface webgl            # ...at the kind root; a path is inert
 * deno task new actor consent/banner
 * ```
 *
 * The category segment is optional, and when it is missing for a kind that has
 * categories the task suggests one from §10.2's table rather than making an
 * author remember it. It suggests and does not insist, because a path is inert
 * (§10.1) — the suggestion is for the next reader, not for the loader.
 */

import { dirname, join } from '@std/path'
import { KINDS } from '../src/types.ts'
import type { Kind } from '../src/types.ts'

const ROOT = new URL('..', import.meta.url).pathname

/** §10.2's table, as a hint rather than a rule. */
const GROUPS: Partial<Record<Kind, Record<string, string>>> = {
  surface: {
    'platform/': 'os arch chrome userAgent brands fonts',
    'locale/': 'languages locale timezone geo',
    'display/': 'screen viewport chromeHeight',
    'hardware/': 'hardware.*',
    'graphics/': 'gpu',
    'media/': 'media',
    'network/': 'claims made on the wire rather than in a field',
  },
  actor: {
    'challenge/': 'captchas and interstitials',
    'consent/': 'cookie and consent banners',
    'session/': 'logins and session upkeep',
    'behaviour/': 'anything the page measures about how it is used',
  },
}

const plugin = (kind: Kind, name: string, depth: number): string => {
  const up = '../'.repeat(depth + 1)
  const Name = name[0].toUpperCase() + name.slice(1)
  const head =
    `/**\n * @module plugins/${kind}/${name}\n * @description One sentence on what this carries, and why.\n */\n\n` +
    `import { definePlugin } from '${up}src/plugin.ts'\n` +
    `import type { PluginFactory } from '${up}src/types.ts'\n\n` +
    `export interface ${Name}Options {\n` +
    `  /** definePlugin needs an index signature; see plugin-developer.md. */\n` +
    `  [key: string]: unknown\n}\n\n`

  const bodies: Record<Kind, string> = {
    surface: `interface Config {
  /** Everything the page function needs, as JSON: it closes over nothing. */
  value: string
}

export const ${name}: PluginFactory<${Name}Options> = definePlugin<
  ${Name}Options,
  Config
>({
  kind: 'surface',
  name: '${name}',
  setup(_options, ctx) {
    // Stand down rather than invent: an absent field claims nothing, and the
    // real browser's value reaching the page is correct until something says
    // otherwise (§2.9).
    const { os } = ctx.profile
    if (!os) return {}

    return {
      realms: ['page', 'iframe'],
      config: { value: os },
      page(config) {
        define(navigator, 'platform', config.value)
      },
    }
  },
})`,
    actor: `export const ${name}: PluginFactory<${Name}Options> = definePlugin<
  ${Name}Options
>({
  kind: 'actor',
  name: '${name}',
  urls: ['http://*', 'https://*'],
  setup(_options, page) {
    // \`document\` fires on every navigation, including the first. Nothing here
    // is on the message queue, so taking time is allowed (§6.1).
    page.on('document', async () => {
      if (!await page.wait('body', 2_000)) return
      page.log('arrived at', page.url)
    })
  },
})`,
    profile: `export const ${name}: PluginFactory<${Name}Options> = definePlugin<
  ${Name}Options
>({
  kind: 'profile',
  name: '${name}',
  priority: 50,
  setup(_options, _ctx) {
    return {
      // Return \`undefined\` to decline: the next loader answers, and core
      // \`generate\` answers last (§2.4).
      draw: (_constraint) => undefined,
    }
  },
})`,
    launch: `export const ${name}: PluginFactory<${Name}Options> = definePlugin<
  ${Name}Options
>({
  kind: 'launch',
  name: '${name}',
  setup(_options, ctx) {
    // DANGER: a flag is per-process, so a session that contributes one cannot
    // share a browser with a session that does not (§3.3).
    return { flags: [\`--lang=\${ctx.profile.locale}\`] }
  },
})`,
    protocol: `export const ${name}: PluginFactory<${Name}Options> = definePlugin<
  ${Name}Options
>({
  kind: 'protocol',
  name: '${name}',
  match: ['Page.*'],
  setup(_options, ctx) {
    return {
      onRequest(msg) {
        ctx.log(msg.method)
        return msg
      },
    }
  },
})`,
  }

  return `${head}${bodies[kind]}\n\nexport default ${name}\n`
}

const spec = (kind: Kind, name: string, path: string): string => {
  const surface = kind === 'surface'
  // test/plugins/<kind>/<path>.test.ts, so one more level than the plugin.
  const up = '../'.repeat(path.split('/').length + 2)
  return `/**
 * ${name} (${kind}). Real browser, because the question this plugin answers is
 * one a page asks.
 */

import { assertEquals } from '@std/assert'
import { Config } from '${up}src/config.ts'
import { harness } from '${up}src/harness.ts'
import { shutdown } from '${up}src/sdk.ts'
import { ${name} } from '${up}plugins/${kind}/${path}.ts'

const options = await Config.create({
  CDP_HEADLESS: 'true',
  CDP_PROXY_HOST: 'localhost',
  CDP_BROWSER_HOST: 'localhost',
  CDP_PROXY_LOG_LEVEL: 'error',
})

Deno.test({
  name: '${name}: carries its claim',
  ignore: !options.browserExecutablePath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    Config.setGlobal(new Config(options))

    try {
      await t.step('the page sees the profile\\'s value', async () => {
        await using it = await harness({ plugins: [${name}()] })
        assertEquals(await it.page.eval(() => navigator.platform), 'MacIntel')
      })

      await t.step('and the probe can still fail', async () => {
        // An absence assertion that has quietly gone vacuous looks exactly like
        // a passing one, so the same probe runs without the plugin.
        await using it = await harness({ plugins: [] })
        assertEquals(await it.page.eval(() => navigator.platform), 'MacIntel')
      })
${
    surface
      ? `
      await t.step('in every realm it claims', async () => {
        await using it = await harness({ plugins: [${name}()] })
        const seen = await it.eachRealm(() => navigator.platform)
        assertEquals(seen.page, seen.iframe)
      })
`
      : ''
  }    } finally {
      await shutdown()
    }
  },
})
`
}

function main(): number {
  const [kind, where] = Deno.args
  if (!KINDS.includes(kind as Kind) || !where) {
    console.error(
      `usage: deno task new <${KINDS.join('|')}> <[category/]name>\n\n` +
        'e.g. deno task new surface graphics/webgl',
    )
    return 1
  }

  const path = where.replace(/\.ts$/, '')
  const name = path.split('/').pop()!
  if (!/^[a-z][a-z0-9]*$/.test(name)) {
    console.error(
      `"${name}" is not a plugin name: lowercase, one word, no hyphens — ` +
        'the simplest word that says what it carries',
    )
    return 1
  }

  const groups = GROUPS[kind as Kind]
  if (groups && !path.includes('/')) {
    console.log(`${name} is going at the ${kind} root. The categories are:\n`)
    for (const [group, carries] of Object.entries(groups)) {
      console.log(`  ${group.padEnd(11)} ${carries}`)
    }
    console.log(
      '\nA path is inert, so this is a suggestion for the next reader ' +
        'rather than a requirement (§10.1).\n',
    )
  }

  const file = join(ROOT, 'plugins', kind, `${path}.ts`)
  const test = join(ROOT, 'test', 'plugins', kind, `${path}.test.ts`)
  for (const target of [file, test]) {
    try {
      Deno.statSync(target)
      console.error(`${target} already exists`)
      return 1
    } catch { /* the good case */ }
  }

  Deno.mkdirSync(dirname(file), { recursive: true })
  Deno.mkdirSync(dirname(test), { recursive: true })
  Deno.writeTextFileSync(file, plugin(kind as Kind, name, path.split('/').length))
  Deno.writeTextFileSync(test, spec(kind as Kind, name, path))

  console.log(`plugins/${kind}/${path}.ts`)
  console.log(`test/plugins/${kind}/${path}.test.ts`)
  console.log(`\ndeno task dev --plugin ${name}`)
  return 0
}

if (import.meta.main) Deno.exit(main())
