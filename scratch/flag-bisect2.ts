import { chromium } from 'playwright'
import { Config } from '../src/config.ts'
const options = await Config.create({ CDP_HEADLESS: 'true' })
const PAGE = `<!doctype html><html><body><h1 id="h">hello</h1></body></html>`
const site = Deno.serve({ port: 0, onListen: () => {} }, () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }))
const origin = `http://localhost:${(site.addr as Deno.NetAddr).port}`
let port = 10200

const CANDIDATES = [
  '--disable-features=PaintHolding',
  '--force-color-profile=srgb',
  '--use-angle',
  '--enable-use-zoom-for-dsf=false',
  '--hide-scrollbars',
  '--disable-dev-shm-usage',
  '--disable-field-trial-config',
  '--disable-back-forward-cache',
  '--disable-popup-blocking',
  '--disable-breakpad',
]

const probe = async (label: string, args: string[]) => {
  const p = port++
  const dir = await Deno.makeTempDir()
  const child = new Deno.Command(options.browserExecutablePath!, {
    args: [...args, `--remote-debugging-port=${p}`, `--user-data-dir=${dir}`],
    stdout: 'null', stderr: 'null',
  }).spawn()
  for (let i = 0; i < 80; i++) {
    try { await fetch(`http://localhost:${p}/json/version`); break } catch { await new Promise((r) => setTimeout(r, 250)) }
  }
  try {
    const browser = await chromium.connectOverCDP(`http://localhost:${p}`)
    const page = await browser.newPage()
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    const raf = await page.evaluate(() => new Promise<string>((r) => {
      const timer = setTimeout(() => r('NO'), 2500)
      requestAnimationFrame(() => { clearTimeout(timer); r('yes') })
    }))
    console.log(raf.padEnd(4), label)
    await browser.close()
  } finally {
    child.kill()
    await child.status
  }
}

for (const flag of CANDIDATES) {
  await probe(`--headless + ${flag}`, ['--headless', '--no-sandbox', flag])
}
await site.shutdown()
