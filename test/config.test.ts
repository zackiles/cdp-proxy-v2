import { assert, assertEquals } from '@std/assert'
import { Config } from '../src/config.ts'

Deno.test('headless defaults on and is only disabled by an explicit "false"', async () => {
  assertEquals((await Config.create({})).headless, true)
  assertEquals((await Config.create({ CDP_HEADLESS: 'true' })).headless, true)
  assertEquals((await Config.create({ CDP_HEADLESS: 'false' })).headless, false)
})

Deno.test('isolation falls back to context unless browser is requested', async () => {
  assertEquals((await Config.create({})).isolation, 'context')
  assertEquals(
    (await Config.create({ CDP_ISOLATION: 'context' })).isolation,
    'context',
  )
  assertEquals(
    (await Config.create({ CDP_ISOLATION: 'browser' })).isolation,
    'browser',
  )
  assertEquals(
    (await Config.create({ CDP_ISOLATION: 'nonsense' })).isolation,
    'context',
  )
})

Deno.test('hosts, ports and remote endpoint come from the environment', async () => {
  const options = await Config.create({
    CDP_PROXY_PORT: '1234',
    CDP_PROXY_HOST: '0.0.0.0',
    CDP_BROWSER_PORT: '5678',
    CDP_BROWSER_HOST: '127.0.0.1',
    CDP_BROWSER_WS_ENDPOINT: 'ws://example:9222/devtools/browser/abc',
  })

  assertEquals(options.proxyPort, 1234)
  assertEquals(options.proxyHost, '0.0.0.0')
  assertEquals(options.browserPort, 5678)
  assertEquals(options.browserHost, '127.0.0.1')
  assertEquals(
    options.browserWsEndpoint,
    'ws://example:9222/devtools/browser/abc',
  )
})

Deno.test('absent ports are filled with free ones', async () => {
  const options = await Config.create({})
  assert(options.proxyPort > 0)
  assert(options.browserPort > 0)
  assert(options.proxyPort !== options.browserPort)
})

Deno.test('an explicit browser path always wins over auto-detection', async () => {
  const options = await Config.create({
    CDP_BROWSER_EXECUTABLE_PATH: '/custom/browser',
  })
  assertEquals(options.browserExecutablePath, '/custom/browser')
})

Deno.test('auto-detection resolves an existing, non-enterprise browser binary', async () => {
  const { browserExecutablePath: path } = await Config.create({})
  if (!path) return // no Playwright browser cache on this machine

  assert((await Deno.stat(path)).isFile, `${path} should be an executable file`)
  assert(
    !path.startsWith('/Applications/Google Chrome.app'),
    'must not resolve the enterprise-managed Chrome, which detaches targets mid-run',
  )
})

Deno.test('a Config instance reads and updates its own options', async () => {
  const config = new Config(await Config.create({ CDP_HEADLESS: 'false' }))
  assertEquals(config.get('headless'), false)

  config.update({ headless: true })
  assertEquals(config.get('headless'), true)
})
