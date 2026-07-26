import { Config } from '../src/config.ts'
import { harness } from '../src/harness.ts'
import { shutdown } from '../src/sdk.ts'
const options = await Config.create({ CDP_HEADLESS: 'true', CDP_PROXY_HOST: 'localhost', CDP_BROWSER_HOST: 'localhost', CDP_PROXY_LOG_LEVEL: 'error' })
Config.setGlobal(new Config(options))
const server = Deno.serve({ port: 0, onListen: () => {} }, () => new Response('<!doctype html><title>h</title>', { headers: { 'content-type': 'text/html' } }))
const origin = `http://localhost:${(server.addr as Deno.NetAddr).port}`
const it = await harness({ plugins: [] })
const page = it.page.raw
await page.goto(origin, { waitUntil: 'domcontentloaded' })
const out = await Promise.race([
  page.evaluate((fn) => {
    const frame = document.createElement('iframe')
    document.body.append(frame)
    const inner = frame.contentWindow as Window & { eval(c: string): unknown }
    const v = inner.eval(`(${fn})()`)
    frame.remove()
    return v as unknown
  }, '() => typeof globalThis + ":" + (location.href)'),
  new Promise((r) => setTimeout(() => r('TIMEOUT'), 10000)),
])
console.log('iframe no-wait =', out)
await it[Symbol.asyncDispose]()
await server.shutdown()
await shutdown()
Deno.exit(0)
