/**
 * Reproduces the binding table in `docs/stealth.md`: why there is no `ctx.bind`.
 *
 * Every row is measured against a session with the Runtime domain disabled, which
 * is the state a stealthed session is in, and the last row re-runs the isolated
 * world case with `Runtime.enable` as a positive control.
 */
import { Config } from '../src/config.ts'
import { chromium, shutdown } from '../src/sdk.ts'

Config.setGlobal(new Config(await Config.create({
  CDP_HEADLESS: 'true',
  CDP_PROXY_LOG_LEVEL: 'error',
})))

const browser = await chromium.launch({ plugins: [] })
const page = await browser.newPage()
const cdp = await page.context().newCDPSession(page)

const calls: string[] = []
cdp.on('Runtime.bindingCalled', (e) => calls.push(`${e.name}=${e.payload}`))

const NAME = '__channel'
const WORLD = 'probe_world'

/** Is the binding's function on the page's own `window`? */
const onWindow = () =>
  page.evaluate((n) =>
    typeof (globalThis as Record<string, unknown>)[n] === 'function'
  , NAME)

const row = (what: string, result: unknown) =>
  console.log(`${what.padEnd(46)} ${result}`)

await cdp.send('Page.enable')
await page.goto('https://example.com', { waitUntil: 'load' })

// ─── main world ─────────────────────────────────────────────────────────────
await cdp.send('Runtime.addBinding', { name: NAME })
row('addBinding, then read window', await onWindow())

await cdp.send('Runtime.removeBinding', { name: NAME })
row('removeBinding, then read window', await onWindow())

await cdp.send('Runtime.evaluate', { expression: `delete self['${NAME}']` })
row('evaluate delete self[name]', await onWindow())

await cdp.send('Runtime.addBinding', { name: NAME })
await page.goto('https://example.org', { waitUntil: 'load' })
row('addBinding, navigate, then read window', await onWindow())

// ─── isolated world ─────────────────────────────────────────────────────────
// The script reports through the DOM, which every world shares, so "the script
// ran" can be told apart from "the binding was reachable". It runs at
// document-start, where documentElement does not exist yet.
await cdp.send('Runtime.addBinding', {
  name: NAME,
  executionContextName: WORLD,
})
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    const write = (k, v) => {
      const go = () =>
        document.documentElement
          ? document.documentElement.setAttribute(k, v)
          : setTimeout(go, 1)
      go()
    }
    write('data-ran', '1')
    try { self['${NAME}'](location.hostname) } catch (e) { write('data-failed', '1') }
  `,
  worldName: WORLD,
})

const scoped = async (url: string) => {
  calls.length = 0
  await page.goto(url, { waitUntil: 'load' })
  await new Promise((r) => setTimeout(r, 400))
  const ran = await page.evaluate(() =>
    document.documentElement.getAttribute('data-ran')
  )
  return `script ran=${ran === '1'} bindingCalled=${JSON.stringify(calls)}`
}

for (const [i, url] of [
  'https://example.com/?1',
  'https://example.org/?2',
  'https://example.com/?3',
].entries()) {
  row(`world-scoped binding, navigation ${i + 1}`, await scoped(url))
}

await cdp.send('Runtime.enable')
row('the same, after Runtime.enable', await scoped('https://example.org/?4'))

await browser.close().catch(() => {})
await shutdown()
Deno.exit(0)
