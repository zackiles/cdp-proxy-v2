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
const page = it.page.raw

console.log('--- iframe')
const iframe = await page.evaluate(async () => {
  const frame = document.createElement('iframe')
  frame.src = 'about:blank'
  document.documentElement.append(frame)
  await new Promise((r) => frame.addEventListener('load', r, { once: true }))
  const inner = frame.contentWindow as Window & { eval(code: string): unknown }
  const value = await inner.eval(`(() => typeof globalThis)()`)
  frame.remove()
  return value as unknown
})
console.log('iframe =', iframe)

console.log('--- worker')
const worker = await page.evaluate(async () => {
  const blob = new Blob(['onmessage = async () => postMessage(await (() => typeof globalThis)())'], { type: 'text/javascript' })
  const url = URL.createObjectURL(blob)
  const w = new Worker(url)
  return await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('worker never answered')), 8000)
    w.onmessage = (e) => { clearTimeout(timer); resolve(e.data) }
    w.onerror = (e) => { clearTimeout(timer); reject(new Error(e.message)) }
    w.postMessage(null)
  })
})
console.log('worker =', worker)

await it[Symbol.asyncDispose]()
await shutdown()
Deno.exit(0)
