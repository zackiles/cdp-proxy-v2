import { chromium } from 'playwright'
import { Config } from '../src/config.ts'
const options = await Config.create({ CDP_HEADLESS: 'true' })
const PAGE = `<!doctype html><html><body><h1 id="h">hello</h1></body></html>`
const site = Deno.serve({ port: 0, onListen: () => {} }, () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }))
const origin = `http://localhost:${(site.addr as Deno.NetAddr).port}`
let port = 10100

const PW = [
  '--disable-field-trial-config','--disable-background-networking','--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows','--disable-back-forward-cache','--disable-breakpad',
  '--disable-client-side-phishing-detection','--disable-component-extensions-with-background-pages',
  '--disable-component-update','--no-default-browser-check','--disable-default-apps','--disable-dev-shm-usage',
  '--disable-extensions',
  '--disable-features=ImprovedCookieControls,LazyFrameLoading,GlobalMediaControls,DestroyProfileOnBrowserClose,MediaRouter,DialMediaRouteProvider,AcceptCHFrame,AutoExpandDetailsElement,CertificateTransparencyComponentUpdater,AvoidUnnecessaryBeforeUnloadCheckSync,Translate,HttpsUpgrades,PaintHolding,ThirdPartyStoragePartitioning,LensOverlay,PlzDedicatedWorker',
  '--allow-pre-commit-input','--disable-hang-monitor','--disable-ipc-flooding-protection','--disable-popup-blocking',
  '--disable-prompt-on-repost','--disable-renderer-backgrounding','--force-color-profile=srgb','--metrics-recording-only',
  '--no-first-run','--password-store=basic','--use-mock-keychain','--no-service-autorun','--export-tagged-pdf',
  '--disable-search-engine-choice-screen','--unsafely-disable-devtools-self-xss-warnings','--enable-use-zoom-for-dsf=false',
  '--use-angle','--headless','--hide-scrollbars','--mute-audio','--no-sandbox',
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

await probe('full playwright arg set', PW)
await site.shutdown()
