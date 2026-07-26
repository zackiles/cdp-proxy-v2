import { Config } from '../src/config.ts'
import { chromium, shutdown } from '../src/sdk.ts'
Config.setGlobal(new Config(await Config.create({ CDP_HEADLESS: 'true', CDP_PROXY_HOST: 'localhost', CDP_BROWSER_HOST: 'localhost', CDP_PROXY_LOG_LEVEL: 'error' })))
const PAGE = `<!doctype html><html><body><h1 id="h">hello</h1>
<button id="btn" onclick="document.getElementById('h').textContent='clicked'">go</button></body></html>`
const site = Deno.serve({ port: 0, onListen: () => {} }, () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }))
const origin = `http://localhost:${(site.addr as Deno.NetAddr).port}`
const browser = await chromium.launch({ plugins: 'none' })
const page = await browser.newPage()
await page.goto(origin, { waitUntil: 'domcontentloaded' })
const raf = await page.evaluate(() => new Promise<string>((r) => {
  const timer = setTimeout(() => r('rAF never fired'), 3000)
  requestAnimationFrame(() => { clearTimeout(timer); r('rAF fired') })
}))
console.log('before bringToFront:', raf)
await page.bringToFront()
const raf2 = await page.evaluate(() => new Promise<string>((r) => {
  const timer = setTimeout(() => r('rAF never fired'), 3000)
  requestAnimationFrame(() => { clearTimeout(timer); r('rAF fired') })
}))
console.log('after bringToFront:', raf2)
try {
  await page.click('#btn', { timeout: 8000 })
  console.log('clicked:', await page.textContent('#h'))
} catch (e) { console.log('CLICK FAILED:', (e as Error).message.split('\n')[0]) }
await browser.close()
await shutdown()
await site.shutdown()
