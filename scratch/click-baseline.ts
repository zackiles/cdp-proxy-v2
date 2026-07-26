import { chromium } from 'playwright'
import { launch } from 'chrome-launcher'
import { Config } from '../src/config.ts'
import { HEADLESS_FLAG } from '../src/constants.ts'
import { BASELINE } from '../src/core/flags.ts'
const options = await Config.create({ CDP_HEADLESS: 'true' })
const PAGE = `<!doctype html><html><body><h1 id="h">hello</h1>
<button id="btn" onclick="document.getElementById('h').textContent='clicked'">go</button></body></html>`
const site = Deno.serve({ port: 0, onListen: () => {} }, () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }))
const origin = `http://localhost:${(site.addr as Deno.NetAddr).port}`

const probe = async (label: string, endpoint: string) => {
  const browser = await chromium.connectOverCDP(endpoint)
  const page = await browser.newPage()
  await page.goto(origin, { waitUntil: 'domcontentloaded' })
  const raf = await page.evaluate(() => new Promise<string>((r) => {
    const timer = setTimeout(() => r('rAF never fired'), 3000)
    requestAnimationFrame(() => { clearTimeout(timer); r('rAF fired') })
  }))
  console.log(label, '→', raf)
  await browser.close()
}

// 1. Playwright-launched browser, connected over CDP.
const pw = await chromium.launch({ headless: true, executablePath: options.browserExecutablePath, args: ['--remote-debugging-port=9333'] })
await probe('playwright flags + connectOverCDP', 'http://localhost:9333')
await pw.close()

// 2. Our own flags, connected over CDP.
const ours = await launch({
  chromePath: options.browserExecutablePath,
  port: 9334,
  userDataDir: false,
  logLevel: 'silent',
  startingUrl: undefined,
  chromeFlags: [...BASELINE, HEADLESS_FLAG, '--remote-debugging-port=9334'],
  handleSIGINT: false,
})
await probe('our flags + connectOverCDP     ', 'http://localhost:9334')
await ours.kill()
await site.shutdown()
