import { Config } from '../src/config.ts'
import { chromium, shutdown } from '../src/sdk.ts'
import type { PluginList } from '../src/types.ts'

const options = await Config.create({
  CDP_HEADLESS: 'true',
  CDP_PROXY_HOST: 'localhost',
  CDP_BROWSER_HOST: 'localhost',
  CDP_PROXY_LOG_LEVEL: 'error',
})
Config.setGlobal(new Config(options))

const probe = async (plugins: PluginList) => {
  const browser = await chromium.launch({ plugins, isolation: 'browser' })
  const page = await browser.newPage()
  console.log(plugins === 'none' ? 'none' : 'core', 'launched')
  const out = await Promise.race([
    page.evaluate(async () => {
      const frame = document.createElement('iframe')
      frame.src = 'about:blank'
      document.documentElement.append(frame)
      await new Promise((r) => frame.addEventListener('load', r, { once: true }))
      return 'loaded'
    }),
    new Promise((r) => setTimeout(() => r('TIMEOUT'), 8000)),
  ])
  console.log(plugins === 'none' ? 'none' : 'core', '=>', out)
  await browser.close()
}

await probe('none')
await probe([])
await shutdown()
Deno.exit(0)
