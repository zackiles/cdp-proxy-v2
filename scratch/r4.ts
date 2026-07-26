import { Config } from '../src/config.ts'
import { harness } from '../src/harness.ts'
import { shutdown } from '../src/sdk.ts'

const options = await Config.create({
  CDP_HEADLESS: 'true',
  CDP_PROXY_HOST: 'localhost',
  CDP_BROWSER_HOST: 'localhost',
  CDP_PROXY_LOG_LEVEL: 'error',
})
Config.setGlobal(new Config(options))

const it = await harness({ plugins: [] })
console.log('eachRealm:', await it.eachRealm(() => typeof globalThis))
await it[Symbol.asyncDispose]()
await shutdown()
Deno.exit(0)
