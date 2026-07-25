// Throwaway: which page-visible signal actually detects Runtime.enable?
// Baseline = plain Playwright (Runtime definitely enabled), no proxy involved.
import { chromium } from 'playwright'
import { Config } from '../src/config.ts'

const executablePath = (await Config.create({})).browserExecutablePath
const browser = await chromium.launch({ executablePath, headless: true })
const page = await browser.newPage()
await page.setContent('<h1>hi</h1>')

const variants = {
  'stack getter, sync read': () => {
    let fired = false
    const e = new Error()
    Object.defineProperty(e, 'stack', { get() { fired = true; return '' } })
    console.debug(e)
    return fired
  },
  'stack getter, after tick': async () => {
    let fired = false
    const e = new Error()
    Object.defineProperty(e, 'stack', { get() { fired = true; return '' } })
    console.debug(e)
    await new Promise((r) => setTimeout(r, 50))
    return fired
  },
  'stack getter via console.log': async () => {
    let fired = false
    const e = new Error()
    Object.defineProperty(e, 'stack', { get() { fired = true; return '' } })
    console.log(e)
    await new Promise((r) => setTimeout(r, 50))
    return fired
  },
  'toString getter on plain object': async () => {
    let fired = false
    const o = { get willBeRead() { fired = true; return 1 } }
    console.debug(o)
    await new Promise((r) => setTimeout(r, 50))
    return fired
  },
  'Error.prototype.stack accessor': async () => {
    let fired = false
    const original = Object.getOwnPropertyDescriptor(Error.prototype, 'stack')
    Object.defineProperty(Error.prototype, 'stack', { get() { fired = true; return '' }, configurable: true })
    console.debug(new Error())
    await new Promise((r) => setTimeout(r, 50))
    if (original) Object.defineProperty(Error.prototype, 'stack', original)
    return fired
  },
  'error.toString invoked': async () => {
    let fired = false
    const e = new Error('x')
    e.toString = () => { fired = true; return 'x' }
    console.debug(e)
    await new Promise((r) => setTimeout(r, 50))
    return fired
  },
}

for (const [label, fn] of Object.entries(variants)) {
  try {
    console.log(`${await page.evaluate(fn as () => boolean) ? 'DETECTS' : '  ---  '}  ${label}`)
  } catch (err) {
    console.log(`  ERR    ${label}: ${err instanceof Error ? err.message : err}`)
  }
}

await browser.close()
