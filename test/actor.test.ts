/**
 * Covers the `actor` kind (§6) against a real browser, because the three things
 * that make it a kind rather than a library — per-page lifetime, off-queue
 * scheduling, and trusted input — are all runtime properties that a fake CDP
 * stream cannot demonstrate.
 *
 * The `isTrusted` assertion is the one to keep: `element.click()` produces
 * `isTrusted: false` and is a well-known one-line check, so an actor that
 * stopped going through the `Input` domain would still pass every functional
 * test while failing the only one that matters.
 */

import { assert, assertEquals, assertRejects, assertThrows } from '@std/assert'
import { Config } from '../src/config.ts'
import { chromium, rpc, shutdown } from '../src/sdk.ts'
import { definePlugin } from '../src/plugin.ts'
import { banner } from '../plugins/actor/banner.ts'
import { captcha } from '../plugins/actor/captcha.ts'
import type { PageContext } from '../src/types.ts'

const options = await Config.create({
  CDP_HEADLESS: 'true',
  CDP_PROXY_HOST: 'localhost',
  CDP_BROWSER_HOST: 'localhost',
  CDP_PROXY_LOG_LEVEL: 'error',
})

/** Resolves once, with whatever the actor saw; the test awaits the actor. */
function latch<T>() {
  let settle!: (value: T) => void
  const value = new Promise<T>((r) => (settle = r))
  return { value, settle }
}

const FORM = `<!doctype html><title>Form</title>
<button id="go">go</button>
<input id="name">
<div id="trusted"></div><div id="typed"></div>
<script>
  document.getElementById('go').addEventListener('click', (e) => {
    document.getElementById('trusted').textContent = String(e.isTrusted)
  })
  document.getElementById('name').addEventListener('keydown', () => {
    const seen = document.getElementById('typed')
    seen.textContent = String(Number(seen.textContent || 0) + 1)
  })
</script>`

const CONSENT = `<!doctype html><title>Consent</title>
<div id="banner"><button id="onetrust-accept-btn-handler">Accept</button></div>
<script>
  document.getElementById('onetrust-accept-btn-handler')
    .addEventListener('click', () => {
      document.getElementById('banner').remove()
      document.title = 'Dismissed'
    })
</script>`

const CHALLENGE = `<!doctype html><title>Challenge</title>
<div class="g-recaptcha" data-sitekey="test-key" data-callback="onSolved"></div>
<textarea id="g-recaptcha-response"></textarea>
<iframe src="https://www.google.com/recaptcha/api2/anchor"></iframe>
<script>function onSolved(t) { document.title = 'solved:' + t }</script>`

Deno.test({
  name: 'actor: behaviour on a page, off the message queue',
  ignore: !options.browserExecutablePath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    Config.setGlobal(new Config(options))

    const site = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
      const { pathname } = new URL(req.url)
      const body = pathname === '/consent'
        ? CONSENT
        : pathname === '/challenge'
        ? CHALLENGE
        : FORM
      return new Response(body, { headers: { 'content-type': 'text/html' } })
    })
    const origin = `http://localhost:${(site.addr as Deno.NetAddr).port}`

    try {
      await t.step(
        'input is trusted, which element.click() never is',
        async () => {
          const done = latch<{ trusted: string; typed: string }>()
          const prober = definePlugin({
            kind: 'actor',
            name: 'prober',
            setup: (_cfg, page) => {
              page.on('document', async () => {
                if (!page.url.endsWith('/form')) return
                await page.click('#go')
                await page.fill('#name', 'zack')
                done.settle(
                  await page.eval(() => ({
                    trusted: document.getElementById('trusted')!.textContent!,
                    typed: document.getElementById('typed')!.textContent!,
                  })),
                )
              })
            },
          })

          const browser = await chromium.launch({
            plugins: [prober()],
            isolation: 'browser',
          })
          try {
            await (await browser.newPage()).goto(`${origin}/form`)
            assertEquals(await done.value, { trusted: 'true', typed: '4' })
          } finally {
            await browser.close()
          }
        },
      )

      await t.step('urls decides which pages get an instance', async () => {
        const seen: string[] = []
        const picky = definePlugin({
          kind: 'actor',
          name: 'picky',
          urls: ['*/consent'],
          setup: (_cfg, page) => void seen.push(page.url),
        })

        const browser = await chromium.launch({
          plugins: [picky()],
          isolation: 'browser',
        })
        try {
          const page = await browser.newPage()
          await page.goto(`${origin}/form`)
          await page.goto(`${origin}/consent`)
          await page.waitForTimeout(500)
          assertEquals(seen, [`${origin}/consent`])
        } finally {
          await browser.close()
        }
      })

      await t.step(
        'a slow actor does not stall the page it is on',
        async () => {
          // The property the kind exists for: every `protocol` hook runs inside
          // the message path, so this exact plugin written as one would hold the
          // session's CDP traffic for two seconds (§6.1).
          const slow = definePlugin({
            kind: 'actor',
            name: 'slow',
            setup: (_cfg, page) => {
              page.on(
                'document',
                () => new Promise<void>((r) => setTimeout(r, 2_000)),
              )
            },
          })

          const browser = await chromium.launch({
            plugins: [slow()],
            isolation: 'browser',
          })
          try {
            const page = await browser.newPage()
            const started = performance.now()
            await page.goto(`${origin}/form`)
            assertEquals(await page.title(), 'Form')
            assert(
              performance.now() - started < 1_500,
              'the navigation waited for the actor, which is the deadlock the ' +
                'kind exists to make impossible',
            )
          } finally {
            await browser.close()
          }
        },
      )

      await t.step('cdp() observes and send() acts', async () => {
        const done = latch<string>()
        const hatch = definePlugin({
          kind: 'actor',
          name: 'hatch',
          setup: (_cfg, page) => {
            page.cdp('Page.javascriptDialogOpening', ({ message }) => {
              void page.send('Page.handleJavaScriptDialog', { accept: true })
              done.settle(message)
            })
            page.on('document', () => void page.send('Page.enable'))
          },
        })

        const browser = await chromium.launch({
          plugins: [hatch()],
          isolation: 'browser',
        })
        try {
          const page = await browser.newPage()
          await page.goto(`${origin}/form`)
          await page.evaluate(() => setTimeout(() => alert('boo'), 50))
          assertEquals(await done.value, 'boo')
        } finally {
          await browser.close()
        }
      })

      await t.step(
        'the hatch refuses what would break the session',
        async () => {
          const refused = latch<string[]>()
          const rude = definePlugin({
            kind: 'actor',
            name: 'rude',
            setup: (_cfg, page: PageContext) => {
              page.on('document', async () => {
                const errors: string[] = []
                const tried = async (fn: () => Promise<unknown>) => {
                  errors.push(
                    (await assertRejects(fn) as Error).message,
                  )
                }
                // The tell core `contexts` exists to suppress; one actor calling
                // it would undo every surface in the session.
                await tried(() => page.send('Runtime.enable'))
                // Brokered: a direct call clobbers what the broker arranged for
                // everyone else (§7.2).
                await tried(() => page.send('Fetch.enable'))
                await tried(() =>
                  page.send('Network.setExtraHTTPHeaders', { headers: {} })
                )
                // Not yours to turn off: whatever was using it has no way to find
                // out it stopped working.
                await tried(() => page.send('Network.disable'))
                refused.settle(errors)
              })
            },
          })

          const browser = await chromium.launch({
            plugins: [rude()],
            isolation: 'browser',
          })
          try {
            await (await browser.newPage()).goto(`${origin}/form`)
            const errors = await refused.value
            assertEquals(errors.length, 4)
            assert(errors[0].includes('Runtime.enable is refused'))
            assert(errors[1].includes('unions interception patterns'))
            assert(errors[2].includes('surface'), errors[2])
            assert(errors[3].includes('did not enable Network'))
          } finally {
            await browser.close()
          }
        },
      )

      await t.step(
        'a domain the actor enabled is one it may disable',
        async () => {
          const done = latch<boolean>()
          const tidy = definePlugin({
            kind: 'actor',
            name: 'tidy',
            setup: (_cfg, page) => {
              page.on('document', async () => {
                await page.send('Log.enable')
                await page.send('Log.disable')
                done.settle(true)
              })
            },
          })
          const browser = await chromium.launch({
            plugins: [tidy()],
            isolation: 'browser',
          })
          try {
            await (await browser.newPage()).goto(`${origin}/form`)
            assertEquals(await done.value, true)
          } finally {
            await browser.close()
          }
        },
      )

      await t.step('banner clicks a consent dialog away', async () => {
        const browser = await chromium.launch({
          plugins: [banner()],
          isolation: 'browser',
        })
        try {
          const page = await browser.newPage()
          await page.goto(`${origin}/consent`)
          // Clicked rather than hidden: consent state lives in the cookie the
          // banner's own handler sets, and a hidden banner comes back.
          await page.waitForFunction(
            () => document.title === 'Dismissed',
            null,
            {
              timeout: 10_000,
            },
          )
          assertEquals(await page.locator('#banner').count(), 0)
        } finally {
          await browser.close()
        }
      })

      await t.step(
        'captcha hands the challenge over and calls the callback',
        async () => {
          const asked: string[] = []
          const browser = await chromium.launch({
            plugins: [captcha({
              solve: (challenge) => {
                asked.push(`${challenge.kind}:${challenge.sitekey}`)
                // Long enough that a `protocol` plugin doing this would have
                // stalled the session; the page keeps working.
                return new Promise((r) => setTimeout(() => r('TOKEN'), 1_500))
              },
            })],
            isolation: 'browser',
          })
          try {
            const page = await browser.newPage()
            await page.goto(`${origin}/challenge`)
            await page.waitForFunction(
              () => document.title === 'solved:TOKEN',
              null,
              {
                timeout: 15_000,
              },
            )
            assertEquals(asked, ['recaptcha:test-key'])
          } finally {
            await browser.close()
          }
        },
      )

      await t.step('an actor that is not running says so', async () => {
        // The failure mode this answers: an actor whose setup threw and an actor
        // whose globs never matched both look exactly like an actor that ran and
        // decided to do nothing (§6.3).
        const broken = definePlugin({
          kind: 'actor',
          name: 'broken',
          setup: () => {
            throw new Error('no solver configured')
          },
        })
        const elsewhere = definePlugin({
          kind: 'actor',
          name: 'elsewhere',
          urls: ['*/nowhere'],
          setup: () => {},
        })

        const browser = await chromium.launch({
          plugins: [broken(), elsewhere(), banner()],
          isolation: 'browser',
        })
        try {
          const page = await browser.newPage()
          await page.goto(`${origin}/form`)
          await page.waitForTimeout(500)
          const proxy = rpc(await browser.newBrowserCDPSession())
          const { actors, conflicts } = await proxy.debug()
          const state = Object.fromEntries(
            actors.map((a) => [a.name, a.state]),
          )
          assertEquals(state, {
            broken: 'failed',
            elsewhere: 'idle',
            banner: 'watching',
          })
          assertEquals(
            actors.find((a) => a.name === 'broken')?.reason,
            'no solver configured',
          )
          assert(
            conflicts.some((c) => c.includes('no solver configured')),
            `expected the failure in ${conflicts}`,
          )
        } finally {
          await browser.close()
        }
      })

      await t.step(
        'captcha with no solver refuses at setup, not at the challenge',
        () => {
          // A captcha plugin that silently does nothing until a site happens to
          // challenge you is a configuration error you find in production.
          assertThrows(
            () => captcha().setup({} as never),
            Error,
            'needs a `solve` function',
          )
        },
      )
    } finally {
      await site.shutdown()
      await shutdown()
    }
  },
})
