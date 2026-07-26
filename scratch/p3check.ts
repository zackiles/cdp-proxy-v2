/** Manual Phase 3 check: does a plain relay still click, and do surfaces land? */

import { Config } from '../src/config.ts'
import { chromium, rpc, shutdown } from '../src/sdk.ts'
import { stealth } from '../plugins/stealth.ts'
import type { PluginList } from '../src/types.ts'

const options = await Config.create({
  CDP_HEADLESS: 'true',
  CDP_PROXY_HOST: 'localhost',
  CDP_BROWSER_HOST: 'localhost',
  CDP_PROXY_LOG_LEVEL: 'error',
})
Config.setGlobal(new Config(options))

const PAGE = `<!doctype html><html><head><title>Smoke Page</title></head>
<body><h1 id="heading">hello</h1>
<button id="btn" onclick="document.getElementById('heading').textContent='clicked'">go</button>
</body></html>`

const site = Deno.serve(
  { port: 0, onListen: () => {} },
  () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }),
)
const origin = `http://localhost:${(site.addr as Deno.NetAddr).port}`

async function run(label: string, plugins: PluginList) {
  const browser = await chromium.launch({ plugins })
  try {
    const page = await browser.newPage()
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    const started = performance.now()
    try {
      await page.click('#btn', { timeout: 8_000 })
      console.log(
        `${label}: clicked in ${(performance.now() - started).toFixed(0)}ms →`,
        await page.textContent('#heading'),
      )
    } catch (err) {
      console.log(`${label}: CLICK FAILED — ${(err as Error).message.split('\n')[0]}`)
    }

    console.log(`${label}:`, await page.evaluate(() => ({
      ua: navigator.userAgent.slice(0, 60),
      platform: navigator.platform,
      cores: navigator.hardwareConcurrency,
      memory: (navigator as unknown as { deviceMemory: number }).deviceMemory,
      chrome: typeof (globalThis as unknown as { chrome?: unknown }).chrome,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      languages: navigator.languages,
      screen: [screen.width, screen.height, devicePixelRatio],
      outer: globalThis.outerHeight - globalThis.innerHeight,
      webgl: (() => {
        const gl = document.createElement('canvas').getContext('webgl')
        if (!gl) return null
        return [gl.getParameter(0x9245), gl.getParameter(0x9246)]
      })(),
      canvas: (() => {
        const c = document.createElement('canvas')
        const ctx = c.getContext('2d')!
        ctx.textBaseline = 'top'
        ctx.font = '14px Arial'
        ctx.fillText('fingerprint', 2, 2)
        return c.toDataURL().slice(-24)
      })(),
      toStringLies: Function.prototype.toString.call(
        Object.getOwnPropertyDescriptor(
          Object.getPrototypeOf(navigator),
          'platform',
        )?.get ?? (() => {}),
      ),
    })))

    if (plugins !== 'none') {
      const proxy = rpc(await browser.newBrowserCDPSession())
      const debug = await proxy.debug()
      console.log(`${label}: surfaces`, debug.surfaces)
      const { coverage } = await proxy.profile()
      console.log(`${label}: uncovered`, coverage?.uncovered)
      console.log(`${label}: read`, coverage?.read)
      console.log(`${label}: stoodDown`, coverage?.stoodDown)
    }
  } finally {
    await browser.close().catch(() => {})
  }
}

await run('relay', 'none')
await run('core ', [])
await run('steal', [stealth()])

await shutdown()
await site.shutdown()
