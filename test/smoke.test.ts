/**
 * End-to-end smoke test: the real SDK, the real proxy, a real browser.
 *
 * It pins the three properties the project exists for:
 *  1. with `plugins: 'none'` the proxy is transparent — stock Playwright still
 *     works, and this is the only configuration that is a plain relay now that
 *     `plugins: []` means core-only (§8.6);
 *  2. core's `contexts` stops Playwright's `Runtime.enable` reaching the browser,
 *     yet every Playwright API that depends on execution contexts (main world,
 *     utility world, navigation, setContent, clicking) keeps working;
 *  3. a real third-party detector grades the result as a human browser.
 */

import {
  assert,
  assertEquals,
  assertNotEquals,
  assertStringIncludes,
} from '@std/assert'
import { Config } from '../src/config.ts'
import { chromium, rpc, shutdown } from '../src/sdk.ts'
import { definePlugin } from '../src/plugin.ts'
import { stealth } from '../plugins/stealth.ts'
import { clock } from '../plugins/launch/clock.ts'
import { type Entry, recorder } from '../plugins/protocol/recorder.ts'
import type { PluginList } from '../src/types.ts'
import type { Browser } from 'playwright'

/** Third-party bot detector; the only assertion here that leaves the machine. */
const SCAN = 'https://www.browserscan.net/bot-detection'

const PAGE = `<!doctype html>
<html><head><title>Smoke Page</title></head>
<body><h1 id="heading">hello</h1>
<button id="btn" onclick="document.getElementById('heading').textContent='clicked'">go</button>
</body></html>`

/**
 * Taps the CDP requests crossing the pipeline, to prove one session's plugins do
 * not see another's traffic.
 *
 * IMPORTANT: a tap cannot be used to observe `Runtime.enable` any more. Core's
 * `contexts` is pinned first and answers it with `{ respond }`, which
 * short-circuits, so no authored plugin at any priority ever sees that command
 * (§8.4). What reached the browser is asked of the transport instead, via
 * `Proxy.debug`'s `forwarded` counters.
 *
 * IMPORTANT: do not assert the `Runtime.enable` tell from inside the page. On
 * Chrome 147 no page-visible probe distinguishes the domain being enabled —
 * console previews no longer invoke accessors or proxy traps, and headless
 * Chrome stringifies console arguments for its own log sink either way (verified
 * against a raw CDP session with `Runtime.enable` as a positive control). The
 * wire-level invariant below is the property core actually guarantees.
 */
function tap(log: string[], priority: number) {
  return definePlugin({
    kind: 'protocol',
    name: `tap-${priority}`,
    priority,
    setup: () => ({
      onRequest(msg) {
        if (msg.sessionId) log.push(msg.method)
        return msg
      },
    }),
  })()
}

/**
 * Fail loudly instead of hanging. Everything in the ownership step talks to a
 * browser shared with a neighbour session, where the classic symptom of a bug is
 * a wait that never ends rather than a wrong answer.
 */
async function bounded<T>(
  label: string,
  ms: number,
  work: Promise<T>,
): Promise<T> {
  let timer: number | undefined
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} did not settle in ${ms}ms`)),
          ms,
        )
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

const options = await Config.create({
  CDP_HEADLESS: 'true',
  CDP_PROXY_HOST: 'localhost',
  CDP_BROWSER_HOST: 'localhost',
  CDP_PROXY_LOG_LEVEL: 'error',
})

Deno.test({
  name: 'smoke: proxy + stealth drive a real browser end to end',
  // Needs a resolvable browser binary; skip rather than fail on a bare machine.
  ignore: !options.browserExecutablePath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    Config.setGlobal(new Config(options))

    const html = (body: string) =>
      new Response(body, { headers: { 'content-type': 'text/html' } })

    const site = Deno.serve({ port: 0, onListen: () => {} }, (req) => {
      const { pathname } = new URL(req.url)
      if (pathname === '/second') {
        return html('<title>Second</title><p>second</p>')
      }
      if (pathname === '/worker.js') {
        return new Response(
          'self.onmessage = (e) => self.postMessage(e.data * 2)',
          {
            headers: { 'content-type': 'text/javascript' },
          },
        )
      }
      if (pathname === '/worker') {
        return html(
          `<title>Worker</title><script>self.w = new Worker('/worker.js')</script>`,
        )
      }
      if (pathname === '/frames') {
        return html(
          '<title>Frames</title><iframe src="/second" name="kid"></iframe>',
        )
      }
      if (pathname === '/cookie') {
        return new Response('<title>Cookie</title>', {
          headers: {
            'content-type': 'text/html',
            'set-cookie': `who=${
              new URL(req.url).searchParams.get('who')
            }; Path=/`,
          },
        })
      }
      return html(PAGE)
    })
    const origin = `http://localhost:${(site.addr as Deno.NetAddr).port}`

    let plain: Browser | undefined
    let stealthy: Browser | undefined

    /** What actually crossed to the browser for one plugin configuration. */
    const wireOf = async (plugins: PluginList) => {
      const browser = await chromium.launch({ plugins, debug: 'proxy' })
      try {
        const page = await browser.newPage()
        await page.goto(origin, { waitUntil: 'domcontentloaded' })
        const proxy = rpc(await browser.newBrowserCDPSession())
        return (await proxy.debug()).forwarded
      } finally {
        await browser.close().catch(() => {})
      }
    }

    try {
      await t.step(
        "plugins: 'none' proxies Playwright unchanged",
        async () => {
          // The transparency this asserts is a property of ProxyConnection, not
          // of core, so it needs a genuinely empty session. `plugins: []` no
          // longer is one.
          plain = await chromium.launch({ plugins: 'none' })
          const page = await plain.newPage()
          await page.goto(origin, { waitUntil: 'domcontentloaded' })

          assertEquals(await page.title(), 'Smoke Page')
          assertEquals(await page.evaluate(() => 6 * 7), 42)
          await page.click('#btn')
          assertEquals(await page.textContent('#heading'), 'clicked')
          await plain.close()
          plain = undefined
        },
      )

      await t.step('core-only is not stock', async () => {
        // Nothing else proves core ran: `plugins: []` installs no surfaces, so a
        // page-side assertion would be indistinguishable from a plain browser.
        // The wire is where the difference is.
        const relay = await wireOf('none')
        assert(
          relay['Runtime.enable'] > 0,
          'without this control the assertion below proves nothing: Playwright ' +
            `must be sending Runtime.enable at all, saw ${
              Object.keys(relay).length
            } methods`,
        )

        const coreOnly = await wireOf([])
        assertEquals(
          coreOnly['Runtime.enable'],
          undefined,
          'plugins: [] installs core, and core must stop Runtime.enable ' +
            'reaching the browser',
        )
        assert(
          Object.keys(coreOnly).length > 0,
          'a core-only session still drives the browser',
        )
      })

      await t.step(
        'a core-only session has an identity, and only core carries it',
        async () => {
          // Core `flags` reaches `locale` and the window size on the command
          // line, which is a rung no page patch can reach (§4.2). Everything
          // else is a claim the real browser is currently contradicting, and the
          // uncovered line saying so is the deliverable.
          const browser = await chromium.launch({ plugins: [] })
          try {
            const page = await browser.newPage()
            await page.goto(origin, { waitUntil: 'domcontentloaded' })
            const real = await page.evaluate(() => navigator.userAgent)
            const { profile, coverage } = await rpc(
              await browser.newBrowserCDPSession(),
            ).profile()

            assert(profile, 'a session with plugins always has an identity')
            assertEquals(profile.source, 'generate')

            // Reconciliation is the assertion with teeth: a page feature-detects,
            // so the claimed version has to be the version of the binary that
            // actually started, which no loader could have known.
            assertEquals(
              String(profile.chrome),
              real.match(/Chrome\/(\d+)/)?.[1],
              `profile claims Chrome ${profile.chrome}, binary is ${real}`,
            )
            assert(
              !profile.userAgent.includes('Headless'),
              `the drawn UA kept a headless tell: ${profile.userAgent}`,
            )

            assertEquals(coverage!.read, {
              locale: ['flags'],
              viewport: ['flags'],
              chromeHeight: ['flags'],
            })
            for (const field of ['userAgent', 'gpu', 'fonts', 'timezone']) {
              assert(
                coverage!.uncovered.includes(field),
                `${field} should be uncovered until a surface carries it`,
              )
            }
          } finally {
            await browser.close().catch(() => {})
          }
        },
      )

      await t.step('a pinned id re-draws the same machine', async () => {
        const drawn = async (id: string) => {
          const browser = await chromium.launch({ profile: { id } })
          try {
            const { profile } = await rpc(await browser.newBrowserCDPSession())
              .profile()
            return profile!
          } finally {
            await browser.close().catch(() => {})
          }
        }

        // Deliberately no "a different id draws a different machine" assertion:
        // two ids landing on the same row is the tables working. Common machines
        // are supposed to repeat (§2.5), so that comparison is flaky by design.
        assertEquals(await drawn('smoke-pinned'), await drawn('smoke-pinned'))
        assertEquals((await drawn('smoke-pinned')).id, 'smoke-pinned')

        const relay = await chromium.launch({ plugins: 'none' })
        try {
          const { profile } = await rpc(await relay.newBrowserCDPSession())
            .profile()
          // A transparent relay claims nothing, so there is nothing to report.
          assertEquals(profile, null)
        } finally {
          await relay.close().catch(() => {})
        }
      })

      await t.step(
        'a launch plugin buys a process, and the fleet shares one otherwise',
        async () => {
          const seen = async (plugins: PluginList) => {
            const browser = await chromium.launch({ plugins })
            try {
              const control = rpc(await browser.newBrowserCDPSession())
              const { profile } = await control.profile()
              const page = await browser.newPage()
              await page.goto(origin, { waitUntil: 'domcontentloaded' })
              return {
                id: profile!.id,
                timezone: profile!.timezone,
                launch: (await control.debug()).launch.flags,
                inPage: await page.evaluate(() =>
                  Intl.DateTimeFormat().resolvedOptions().timeZone
                ),
              }
            } finally {
              await browser.close().catch(() => {})
            }
          }

          // Two sessions that asked for nothing land on the same pooled process,
          // so they are the same person — including the same canvas hash (§2.7).
          const first = await seen([stealth()])
          const second = await seen([stealth()])
          assertEquals(first.id, second.id)
          assertEquals(first.launch, second.launch)
          assert(
            first.launch.some((f) => f.startsWith('--lang=')),
            `core flags puts the profile locale on the command line: ${first.launch}`,
          )

          // A launch plugin is per-process, so it costs a process (§3.3), and
          // `TZ` makes the browser genuinely be where the profile says it is
          // rather than being told to say so.
          const own = await seen([stealth(), clock()])
          assertNotEquals(own.id, first.id)
          assertEquals(own.inPage, own.timezone)
        },
      )

      await t.step(
        'core suppresses Runtime.enable while both worlds work',
        async () => {
          stealthy = await chromium.launch({ plugins: [stealth()] })
          const page = await stealthy.newPage()
          await page.goto(origin, { waitUntil: 'domcontentloaded' })

          // Main world.
          assertEquals(await page.evaluate(() => 6 * 7), 42)
          // Utility world (Playwright's internal isolated world).
          assertEquals(await page.title(), 'Smoke Page')
        },
      )

      await t.step(
        'stealth scrubs the headless and automation tells',
        async () => {
          const page = await stealthy!.newPage()
          await page.goto(origin, { waitUntil: 'domcontentloaded' })

          const userAgent = await page.evaluate(() => navigator.userAgent)
          assertStringIncludes(userAgent, 'Chrome/')
          assert(
            !userAgent.includes('HeadlessChrome'),
            `headless tell in UA: ${userAgent}`,
          )

          assertEquals(await page.evaluate(() => navigator.webdriver), false)

          const brands = await page.evaluate(() =>
            // deno-lint-ignore no-explicit-any
            JSON.stringify((navigator as any).userAgentData?.brands ?? [])
          )
          assert(
            !brands.includes('Headless'),
            `headless tell in brands: ${brands}`,
          )
        },
      )

      await t.step('the page sits in a plausible browser window', async () => {
        const page = await stealthy!.newPage()
        await page.goto(origin, { waitUntil: 'domcontentloaded' })

        const shape = await page.evaluate(() => ({
          screenWidth: screen.width,
          innerWidth: globalThis.innerWidth,
          chrome: globalThis.outerHeight - globalThis.innerHeight,
          webgl: !!document.createElement('canvas').getContext('webgl'),
          languages: navigator.languages.length,
        }))

        // Headless pins the screen to the viewport and gives the window no tab
        // strip or toolbar, so both comparisons come out equal on a stock browser.
        assert(
          shape.screenWidth > shape.innerWidth,
          `screen ${shape.screenWidth} must exceed the viewport ${shape.innerWidth}`,
        )
        assert(shape.chrome > 0, 'a real window is taller than its viewport')
        // Every real Chrome has a WebGL context; --disable-gpu leaves none at all.
        assert(shape.webgl, 'WebGL must be available')
        assert(shape.languages > 1, 'Chrome sends a list, not one language')
      })

      await t.step(
        'stealth leaves nothing of its own in the page',
        async () => {
          const page = await stealthy!.newPage()
          const own = () =>
            page.evaluate(() =>
              Object.getOwnPropertyNames(globalThis).filter((k) =>
                k.startsWith('__')
              )
            )

          // Deriving a context used to cost a `Runtime.addBinding`, and
          // `Runtime.removeBinding` does not take the installed function back off
          // `window` — every document kept a uniquely named global, which is a
          // louder tell than the one this plugin removes.
          await page.goto(origin, { waitUntil: 'domcontentloaded' })
          assertEquals(await own(), [], 'a fresh document is untouched')

          await page.goto(`${origin}/second`, { waitUntil: 'domcontentloaded' })
          assertEquals(await own(), [], 'and stays untouched across navigation')
        },
      )

      await t.step('a plugin can run code the page cannot see', async () => {
        // The one stealth-safe way for a plugin to run page-side code: an
        // isolated world, which the page can neither read nor reach. A
        // `Runtime.addBinding` channel is not an alternative — without
        // `Runtime.enable` the binding is gone after the next navigation, and
        // scoping it to this world needs `Runtime.enable` as well.
        const world = definePlugin({
          kind: 'protocol',
          name: 'private-world',
          setup: (_cfg, ctx) => ({
            onTargetAttached: async (target) => {
              if (target.type !== 'page') return
              await ctx.inject(
                `self.secret = 'plugin'
                 const mark = () =>
                   document.documentElement
                     ? document.documentElement.setAttribute('data-ran', '1')
                     : setTimeout(mark, 1)
                 mark()`,
                target.sessionId,
                { world: 'plugin_world' },
              )
            },
          }),
        })()

        const browser = await chromium.launch({
          plugins: [stealth(), world],
        })
        try {
          const page = await browser.newPage()
          await page.goto(`${origin}/second`, { waitUntil: 'load' })

          // Every world shares one DOM, so the mark is proof the script ran.
          assertEquals(await page.getAttribute('html', 'data-ran'), '1')
          // Nothing it defined is reachable from the page's own world, and no
          // global of ours appeared there either.
          assertEquals(await page.evaluate(() => 'secret' in globalThis), false)
          assertEquals(
            await page.evaluate(() =>
              Object.getOwnPropertyNames(globalThis).filter((k) =>
                k.startsWith('__')
              )
            ),
            [],
          )
        } finally {
          await browser.close().catch(() => {})
        }
      })

      await t.step(
        'contexts survive navigation to a new document',
        async () => {
          const page = await stealthy!.newPage()
          await page.goto(origin, { waitUntil: 'domcontentloaded' })
          assertEquals(await page.evaluate(() => document.title), 'Smoke Page')

          await page.goto(`${origin}/second`, { waitUntil: 'domcontentloaded' })
          assertEquals(
            await page.title(),
            'Second',
            'utility world re-provided',
          )
          assertEquals(
            await page.evaluate(() => document.querySelector('p')?.textContent),
            'second',
            'main world re-provided',
          )
        },
      )

      await t.step('setContent and input work under stealth', async () => {
        const page = await stealthy!.newPage()
        await page.goto(origin, { waitUntil: 'domcontentloaded' })

        // setContent replaces the document via document.open(); it only completes
        // if the console tag it waits for is replayed to Playwright.
        await page.setContent(
          '<title>Written</title><button id="b" onclick="this.textContent=\'ok\'">x</button>',
        )
        assertEquals(await page.title(), 'Written')

        await page.click('#b')
        assertEquals(await page.textContent('#b'), 'ok')
      })

      await t.step('child frames get working contexts too', async () => {
        const page = await stealthy!.newPage()
        await page.goto(`${origin}/frames`, { waitUntil: 'load' })

        // The utility world of the subframe backs every selector query.
        assertEquals(
          await page.frameLocator('iframe').locator('p').textContent(),
          'second',
        )

        // ...and its main world backs frame.evaluate().
        const child = page.frame({ name: 'kid' })
        assert(child, 'the child frame should be known to Playwright')
        assertEquals(await child.evaluate(() => document.title), 'Second')
      })

      await t.step('web workers still work under stealth', async () => {
        const page = await stealthy!.newPage()
        const appeared = page.waitForEvent('worker')
        await page.goto(`${origin}/worker`, { waitUntil: 'load' })
        const worker = await appeared

        // A worker target has no Page domain, so stealth must leave its runtime
        // alone rather than suppress it and strand Playwright without contexts.
        assertEquals(await worker.evaluate(() => 1 + 1), 2)
        assertEquals(
          await page.evaluate(() => {
            const worker = (self as unknown as { w: Worker }).w
            return new Promise((resolve) => {
              worker.onmessage = (e: MessageEvent) => resolve(e.data)
              worker.postMessage(21)
            })
          }),
          42,
        )
      })

      await t.step('concurrent sessions stay isolated', async () => {
        // Each session gets its own plugin instances, so a plugin that counts
        // what it sees must not observe the other session's traffic.
        const seenA: string[] = []
        const seenB: string[] = []

        const drive = async (who: string, seen: string[]) => {
          const browser = await chromium.launch({
            plugins: [stealth(), tap(seen, 0)],
          })
          const page = await browser.newPage()
          await page.goto(`${origin}/cookie?who=${who}`, {
            waitUntil: 'domcontentloaded',
          })
          const cookies = await page.context().cookies()
          await browser.close()
          return cookies.find((c) => c.name === 'who')?.value
        }

        const [a, b] = await Promise.all([
          drive('alice', seenA),
          drive('bob', seenB),
        ])

        assertEquals(a, 'alice')
        assertEquals(b, 'bob', 'sessions must not share cookie jars')
        assert(seenA.length > 0 && seenB.length > 0, 'both plugins saw traffic')
      })

      await t.step(
        'browser isolation puts each site on its own browser',
        async () => {
          const upstreamOf = async (browser: Browser) => {
            const proxy = rpc(await browser.newBrowserCDPSession())
            return (await proxy.hello()).upstream
          }

          const shared = await Promise.all([
            chromium.launch({ plugins: [] }),
            chromium.launch({ plugins: [] }),
          ])
          const perSite = await Promise.all([
            chromium.launch({ plugins: [], isolation: 'browser' }),
            chromium.launch({ plugins: [], isolation: 'browser' }),
          ])
          try {
            const [s1, s2] = await Promise.all(shared.map(upstreamOf))
            assertEquals(s1, s2, 'context isolation shares one browser')

            const [b1, b2] = await Promise.all(perSite.map(upstreamOf))
            assert(
              b1 !== b2,
              `browser isolation must launch a browser per site, both got ${b1}`,
            )
            assert(
              b1 !== s1 && b2 !== s1,
              'neither may reuse the shared browser',
            )
          } finally {
            await Promise.all(
              [...shared, ...perSite].map((b) => b.close().catch(() => {})),
            )
          }
        },
      )
      await t.step(
        'a bundled plugin can be recorded and queried over RPC',
        async () => {
          const browser = await chromium.launch({
            plugins: [stealth(), recorder()],
          })
          try {
            const page = await browser.newPage()
            await page.goto(origin, { waitUntil: 'domcontentloaded' })

            const proxy = rpc(await browser.newBrowserCDPSession())
            const { entries } = await proxy.send<{ entries: Entry[] }>(
              'Proxy.history',
            )

            assert(entries.length > 0, 'the recorder should have seen traffic')
            assert(
              entries.some((e) => e.method === 'Page.navigate'),
              'the navigation should be in the history',
            )
            assert(
              !entries.some((e) => e.method === 'Proxy.history'),
              'the query itself must not appear in its own answer',
            )

            // The same picture as the trace lines, but assertable from a test.
            // `stealth` is a preset now, so what a session reports is what it
            // expanded to (§8.5): protocol plugins in `plugins`, surfaces in
            // `surfaces`, and nothing anywhere called "stealth".
            const debug = await proxy.debug()
            const names = debug.plugins.map((p) => p.name)
            const recording = debug.plugins.find((p) => p.name === 'recorder')
            assert(recording, `expected recorder in ${names}`)
            assert(
              (recording.calls.onRequest ?? 0) > 0,
              'recorder onRequest should have been counted',
            )
            assertEquals(names.includes('stealth'), false)
            for (
              const surface of [
                'navigator',
                'timezone',
                'canvas',
                'webgl',
                'screen',
              ]
            ) {
              assert(
                debug.surfaces.includes(surface),
                `expected ${surface} in ${debug.surfaces}`,
              )
            }
          } finally {
            await browser.close().catch(() => {})
          }
        },
      )

      await t.step(
        'a session cannot configure another session pages',
        async () => {
          // The stealth browser from the steps above is still open on this same
          // shared browser. Chrome auto-attaches browser-wide, so its plugins used
          // to receive Target.attachedToTarget for pages they did not open and
          // configure them: a plugins:[] session came back de-headlessed.
          const untouched = await chromium.launch({ plugins: [] })
          try {
            const mine = await untouched.newPage()
            await mine.goto(origin, { waitUntil: 'domcontentloaded' })
            const ua = await mine.evaluate(() => navigator.userAgent)
            assertStringIncludes(
              ua,
              'HeadlessChrome',
              'a plugins:[] session must be an untouched browser, but the ' +
                'concurrent stealth session rewrote its User-Agent',
            )

            // The User-Agent is not the only thing stealth's per-page setup
            // changes, and one tell could always come from somewhere else.
            // `Emulation.setUserAgentOverride` carries the Accept-Language too,
            // so an untouched page still reports Chrome's own single entry.
            assertEquals(
              await mine.evaluate(() => navigator.languages.length),
              1,
              'a plugins:[] session must be an untouched browser, but the ' +
                'concurrent stealth session set its Accept-Language',
            )

            // ...while stealth still does its job on the pages that are its own.
            const theirs = await stealthy!.newPage()
            await theirs.goto(origin, { waitUntil: 'domcontentloaded' })
            const spoofed = await theirs.evaluate(() => navigator.userAgent)
            assert(
              !spoofed.includes('HeadlessChrome'),
              `stealth stopped spoofing its own pages: ${spoofed}`,
            )
          } finally {
            await untouched.close().catch(() => {})
          }
        },
      )

      await t.step(
        'a context a plugin opens is its own, and is not stranded',
        async () => {
          const url = `${origin}/second`
          const opener = definePlugin({
            kind: 'protocol',
            name: 'opener',
            setup: (_cfg, ctx) => ({
              async onSessionStart() {
                const { browserContextId } = await ctx.send(
                  'Target.createBrowserContext',
                )
                await ctx.send('Target.createTarget', { url, browserContextId })
              },
            }),
          })()

          let neighbour: Browser | undefined
          let owner: Browser | undefined
          try {
            // Every wait here is bounded as a whole, because losing ownership
            // does not produce a wrong answer — it produces a connect or a
            // navigation that never returns, and an unbounded step would report
            // that as a hung suite rather than as this assertion.
            await bounded(
              'the ownership check',
              60_000,
              (async () => {
                // The neighbour has to be attached before the plugin's target
                // exists: Chrome holds every new target paused until each attached
                // client releases it, so a neighbour that hides one without
                // detaching strands it and its owner hangs on first navigation.
                neighbour = await chromium.launch({ plugins: [] })
                await (await neighbour.newPage()).goto(origin, {
                  waitUntil: 'domcontentloaded',
                })
                owner = await chromium.launch({ plugins: [opener] })

                const find = (browser: Browser) =>
                  browser.contexts().flatMap((c) => c.pages()).find((p) =>
                    p.url() === url
                  )

                const deadline = Date.now() + 20_000
                while (!find(owner) && Date.now() < deadline) {
                  await new Promise((r) => setTimeout(r, 100))
                }
                const mine = find(owner)
                assert(
                  mine,
                  'the plugin-created page never became usable; its target was ' +
                    'hidden from the neighbour without being given up',
                )
                await mine.waitForLoadState('domcontentloaded', {
                  timeout: 15_000,
                })
                assertEquals(await mine.title(), 'Second')

                assertEquals(
                  find(neighbour),
                  undefined,
                  'a plugins:[] session must not be handed the page a neighbour ' +
                    "session's plugin opened in its own context",
                )
              })(),
            )
          } finally {
            for (const browser of [owner, neighbour]) {
              if (browser) {
                await bounded('closing', 20_000, browser.close()).catch(
                  () => {},
                )
              }
            }
          }
        },
      )

      // Everything above is self-contained; this one grades us against a real
      // detector, so it skips itself instead of failing when there is no egress.
      const online = await fetch(SCAN, {
        method: 'HEAD',
        signal: AbortSignal.timeout(10_000),
      }).then((r) => r.ok).catch(() => false)

      await t.step({
        name: 'a real detector grades stealth as human and plain as a bot',
        ignore: !online,
        async fn() {
          const verdictOf = async (plugins: PluginList) => {
            // A verdict is only evidence about this plugin set if nothing else is
            // attached to the browser being graded, so each scan gets its own
            // process rather than sharing one with the sessions above.
            const browser = await chromium.launch({
              plugins,
              isolation: 'browser',
            })
            try {
              const page = await browser.newPage()
              await page.goto(SCAN, {
                waitUntil: 'domcontentloaded',
                timeout: 60_000,
              })
              // The verdict renders client-side under a "Test Results:" label.
              // Read it out of the text: every class on the page is a build hash
              // that changes without notice. Waiting for one of the verdict words
              // rather than any text matters — until the scan resolves, the line
              // below the label is the first result tab ("Webdriver").
              const verdict = await page.waitForFunction(
                () => {
                  const lines = (document.body.innerText || '').split('\n')
                    .map((line) => line.trim())
                  const at = lines.findIndex((l) => /^Test Results:?$/i.test(l))
                  if (at === -1) return ''
                  return lines.slice(at + 1, at + 3)
                    .find((l) => /^(normal|robot|suspect\w*)$/i.test(l)) ?? ''
                },
                undefined,
                { timeout: 45_000 },
              )
              // The UA is what the detector keys most of its verdict on, so a
              // failure is only actionable alongside it.
              return {
                verdict: await verdict.jsonValue(),
                ua: await page.evaluate(() => navigator.userAgent),
              }
            } finally {
              await browser.close().catch(() => {})
            }
          }

          const human = await verdictOf([stealth()])
          assertEquals(
            human.verdict,
            'Normal',
            `stealth should read as a normal browser, got "${human.verdict}" for ${human.ua}`,
          )

          // Without this control the assertion above proves nothing: it would pass
          // just as well if the detector had stopped noticing headless Chrome.
          const bot = await verdictOf('none')
          assertEquals(
            bot.verdict,
            'Robot',
            `the detector no longer flags plain headless Chrome — got "${bot.verdict}" ` +
              `for ${bot.ua}, so the check above has lost its teeth`,
          )

          // Core-only is the third configuration and its grade is published as
          // measured rather than as hoped (§8.6). Core keeps the session
          // controllable and unannounced on the wire; it does not make it look
          // like a person, because the surface that removes `HeadlessChrome` from
          // the User-Agent is authored rather than core (decision 6).
          const bare = await verdictOf([])
          assertEquals(
            bare.verdict,
            'Robot',
            `core-only's grade changed — README documents it as "Robot", got ` +
              `"${bare.verdict}" for ${bare.ua}. Re-measure before rewording.`,
          )
        },
      })
    } finally {
      await plain?.close().catch(() => {})
      await stealthy?.close().catch(() => {})
      await shutdown()
      await site.shutdown()
    }
  },
})
