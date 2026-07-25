/**
 * Covers plugin autoload (§7.4): the standalone server discovers plugins on disk
 * so remote clients can name them over the control endpoint. Without this the
 * control endpoint can only ever answer "unknown plugin".
 */

import { assert, assertEquals } from '@std/assert'
import { Config } from '../src/config.ts'
import { Proxy } from '../src/proxy.ts'

// The pool is not started here, so these values are never dialled.
if (!Config.hasGlobal) {
  Config.setGlobal(
    new Config(await Config.create({ CDP_PROXY_LOG_LEVEL: 'silent' })),
  )
}

const proxy = () => new Proxy({ handleSignals: false })

Deno.test('the bundled plugins directory loads every shipped plugin', async () => {
  const loaded = await proxy().loadPlugins('plugins')
  assert(loaded.includes('stealth'), `expected stealth, got ${loaded}`)
  assert(loaded.includes('recorder'), `expected recorder, got ${loaded}`)
})

Deno.test('autoload skips disabled files and non-plugins', async () => {
  const dir = await Deno.makeTempDir()
  try {
    await Deno.writeTextFile(
      `${dir}/good.ts`,
      `import { definePlugin } from '${
        import.meta.resolve('../src/plugin.ts')
      }'\nexport default definePlugin({ name: 'good', setup: () => ({}) })\n`,
    )
    await Deno.writeTextFile(
      `${dir}/parked.disabled.ts`,
      `export default definePlugin({ name: 'parked', setup: () => ({}) })\n`,
    )
    await Deno.writeTextFile(`${dir}/notes.md`, 'not a plugin')
    await Deno.writeTextFile(`${dir}/empty.ts`, 'export const nothing = 1\n')

    assertEquals(await proxy().loadPlugins(dir), ['good'])
  } finally {
    await Deno.remove(dir, { recursive: true })
  }
})

Deno.test('a missing plugins directory is a warning, not a crash', async () => {
  assertEquals(await proxy().loadPlugins('does/not/exist'), [])
})
