/** Manual Phase 4 check: launch contributions, fleet identities, promotion. */

import { Config } from '../src/config.ts'
import { chromium, rpc, shutdown } from '../src/sdk.ts'
import { stealth } from '../plugins/stealth.ts'
import { clock } from '../plugins/launch/clock.ts'
import { proxy as proxyPlugin } from '../plugins/launch/proxy.ts'
import type { Constraint, PluginList } from '../src/types.ts'

const options = await Config.create({
  CDP_HEADLESS: 'true',
  CDP_PROXY_HOST: 'localhost',
  CDP_BROWSER_HOST: 'localhost',
  CDP_PROXY_LOG_LEVEL: 'info',
})
Config.setGlobal(new Config(options))

const PAGE = `<!doctype html><html><body><h1 id="h">hi</h1></body></html>`
const site = Deno.serve(
  { port: 0, onListen: () => {} },
  () => new Response(PAGE, { headers: { 'content-type': 'text/html' } }),
)
const origin = `http://localhost:${(site.addr as Deno.NetAddr).port}`

async function run(label: string, plugins: PluginList, profile?: Constraint) {
  const browser = await chromium.launch({ plugins, profile })
  try {
    const page = await browser.newPage()
    await page.goto(origin, { waitUntil: 'domcontentloaded' })
    const seen = await page.evaluate(() => ({
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      language: navigator.language,
      screen: [globalThis.outerWidth, globalThis.outerHeight],
    }))

    const control = rpc(await browser.newBrowserCDPSession())
    const debug = await control.debug()
    const drawn = (await control.profile()).profile
    console.log(`\n── ${label}`)
    console.log('  claims  ', drawn?.id, drawn?.locale, drawn?.timezone)
    console.log('  sees    ', seen)
    console.log(
      '  launch  ',
      debug.launch.filter((f: string) =>
        f.startsWith('--lang') || f.startsWith('--window-size') ||
        f.startsWith('--proxy')
      ),
    )
    if (debug.conflicts.length) console.log('  conflict', debug.conflicts)
  } finally {
    await browser.close().catch(() => {})
  }
}

// A pooled session: it adopts the slot's identity, launched from core `flags`.
await run('pooled stealth', [stealth()])
// Same again: the second session lands on the same process and the same machine.
await run('pooled stealth (again)', [stealth()])
// A launch plugin promotes the session to a process of its own, and `TZ` makes
// the browser genuinely be where the profile says it is.
await run('clock (own process)', [stealth(), clock()])
// A constraint no slot satisfies does the same thing without a launch plugin.
await run('constrained to de-DE', [stealth()], { locale: ['de-DE'] })
// Credentials must not reach the command line.
await run('proxy flags', [stealth(), proxyPlugin({ url: 'http://u:p@127.0.0.1:1/' })])
  .catch((e) => console.log('\n── proxy flags: expected failure —', String(e).split('\n')[0]))

await shutdown()
await site.shutdown()
