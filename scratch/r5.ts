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

const server = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
  const { pathname } = new URL(req.url)
  if (pathname === '/sw.js') {
    return new Response(
      `self.addEventListener('message', async (e) => {\n` +
        `  try { e.source.postMessage(await eval('(' + e.data + ')')()) }\n` +
        `  catch (err) { e.source.postMessage({ __error: String(err) }) }\n` +
        `})\n` +
        `self.addEventListener('install', () => self.skipWaiting())\n` +
        `self.addEventListener('activate', (e) => e.waitUntil(clients.claim()))`,
      { headers: { 'content-type': 'text/javascript' } },
    )
  }
  return new Response('<!doctype html><title>harness</title>', { headers: { 'content-type': 'text/html' } })
})
const origin = `http://localhost:${(server.addr as Deno.NetAddr).port}`

const it = await harness({ plugins: [] })
const page = it.page.raw
const step = async (label: string, work: Promise<unknown>) => {
  console.log('>>', label)
  const out = await Promise.race([work, new Promise((r) => setTimeout(() => r('TIMEOUT'), 15000))])
  console.log('  =', JSON.stringify(out))
}

await step('goto', page.goto(origin, { waitUntil: 'domcontentloaded' }).then(() => 'ok'))
await step('page', page.evaluate(() => typeof globalThis))
await step('iframe', page.evaluate(async (fn) => {
  const frame = document.createElement('iframe')
  document.body.append(frame)
  await new Promise((r) => frame.addEventListener('load', r, { once: true }))
  const inner = frame.contentWindow as Window & { eval(c: string): unknown }
  const v = await inner.eval(`(${fn})()`)
  frame.remove()
  return v as unknown
}, '() => typeof globalThis'))
await step('worker', page.evaluate(async (fn) => {
  const url = URL.createObjectURL(new Blob([`onmessage = async () => postMessage(await (${fn})())`], { type: 'text/javascript' }))
  const w = new Worker(url)
  return await new Promise<unknown>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no answer')), 10000)
    w.onmessage = (e) => { clearTimeout(t); resolve(e.data) }
    w.onerror = (e) => { clearTimeout(t); reject(new Error(e.message)) }
    w.postMessage(null)
  })
}, '() => typeof globalThis'))
await step('sw', page.evaluate(async (fn) => {
  const reg = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready
  const active = reg.active ?? navigator.serviceWorker.controller
  if (!active) throw new Error('never activated')
  return await new Promise<unknown>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('no answer')), 10000)
    navigator.serviceWorker.addEventListener('message', (e) => { clearTimeout(t); resolve(e.data) }, { once: true })
    active.postMessage(fn)
  })
}, '() => typeof globalThis'))

await it[Symbol.asyncDispose]()
await server.shutdown()
await shutdown()
Deno.exit(0)
