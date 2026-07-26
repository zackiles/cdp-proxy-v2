import { Config } from '../src/config.ts'
import { chromium, rpc, shutdown } from '../src/sdk.ts'
import { stealth } from '../plugins/stealth.ts'
const options = await Config.create({ CDP_HEADLESS: 'true', CDP_PROXY_HOST: 'localhost', CDP_BROWSER_HOST: 'localhost', CDP_PROXY_LOG_LEVEL: 'error' })
Config.setGlobal(new Config(options))
const browser = await chromium.launch({ plugins: [stealth()], isolation: 'browser' })
const page = await browser.newPage()
const id = await rpc(await page.context().newCDPSession(page)).profile()
console.log('uncovered:', id.coverage!.uncovered)
console.log('stoodDown:', id.coverage!.stoodDown)
console.log('read:', Object.keys(id.coverage!.read))
await browser.close(); await shutdown(); Deno.exit(0)
