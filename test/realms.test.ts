/**
 * The realm suite (§7.1, §9.8). Real browser, because the thing under test is
 * whether a patch survives being asked for from somewhere other than the main
 * frame — and no fake CDP stream can answer that.
 *
 * This is corsac's headline failure written as assertions. A surface that only
 * reaches `window` is bypassed by `new Worker()` or by a same-origin iframe, and
 * both bypasses are one line of page JavaScript. The suite runs the same probe
 * in all three realms and requires the same answer.
 *
 * DANGER: §14 puts this suite here on purpose. Phase 7 moves
 * `Target.setAutoAttach` ownership into the broker, and this file is what proves
 * the move did not strand workers. Do not weaken it to make a broker change pass.
 */

import { assert, assertEquals } from '@std/assert'
import { Config } from '../src/config.ts'
import { harness } from '../src/harness.ts'
import { shutdown } from '../src/sdk.ts'
import { definePlugin } from '../src/plugin.ts'
import type { PluginFactory, Realm } from '../src/types.ts'

const options = await Config.create({
  CDP_HEADLESS: 'true',
  CDP_PROXY_HOST: 'localhost',
  CDP_BROWSER_HOST: 'localhost',
  CDP_PROXY_LOG_LEVEL: 'error',
})

/** A surface that plants one readable value, so a realm's answer is unambiguous. */
function marker(
  name: string,
  realms?: Realm[],
): PluginFactory<Record<string, unknown>> {
  return definePlugin<Record<string, unknown>, { name: string }>({
    kind: 'surface',
    name,
    setup: () => ({
      config: { name },
      realms,
      page: (config) => {
        define(globalThis, '__realm', config.name)
      },
    }),
  })
}

Deno.test({
  name: 'realms: a surface reaches every context the page can',
  ignore: !options.browserExecutablePath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    Config.setGlobal(new Config(options))

    try {
      await t.step(
        'the same patch answers in page, iframe, and worker',
        async () => {
          await using it = await harness({ plugins: [marker('everywhere')()] })
          assertEquals(
            await it.eachRealm(() =>
              (globalThis as { __realm?: string }).__realm ?? 'unpatched'
            ),
            {
              page: 'everywhere',
              iframe: 'everywhere',
              worker: 'everywhere',
              service_worker: 'everywhere',
            },
          )
        },
      )

      await t.step('the probe can still fail, in every realm', async () => {
        // Asserting an absence is worthless if the assertion cannot fail
        // (`plugin-developer.md`). Without the surface, all three say so.
        await using it = await harness({ plugins: [] })
        assertEquals(
          await it.eachRealm(() =>
            (globalThis as { __realm?: string }).__realm ?? 'unpatched'
          ),
          {
            page: 'unpatched',
            iframe: 'unpatched',
            worker: 'unpatched',
            service_worker: 'unpatched',
          },
        )
      })

      await t.step(
        'a surface that declines a realm is absent from it',
        async () => {
          // `realms: ['page', 'iframe']` is what a DOM-only surface says, and a
          // worker having no document is why (§4.4). The absence must be real:
          // delivering it anyway would run a patch against globals that do not
          // exist there.
          await using it = await harness({
            plugins: [marker('documents', ['page', 'iframe'])()],
          })
          assertEquals(
            await it.eachRealm(() =>
              (globalThis as { __realm?: string }).__realm ?? 'unpatched'
            ),
            {
              page: 'documents',
              iframe: 'documents',
              worker: 'unpatched',
              service_worker: 'unpatched',
            },
          )
        },
      )

      await t.step(
        'the worker still runs its own code afterwards',
        async () => {
          // The failure mode this guards is the one §15 names: getting the worker
          // path wrong hangs the worker. A patched worker that never answers is
          // worse than an unpatched one.
          await using it = await harness({ plugins: [marker('present')()] })
          const seen = await it.eachRealm(() => {
            const patched = (globalThis as { __realm?: string }).__realm
            return `${patched}:${[1, 2, 3].reduce((a, b) => a + b, 0)}`
          })
          assertEquals(seen.worker, 'present:6')
        },
      )

      await t.step(
        'a worker realm patch survives the OffscreenCanvas bypass',
        async () => {
          // The concrete corsac failure: a `WebGLRenderingContext` patch on
          // `window` is bypassed by asking a worker, which has its own copy.
          const gl = definePlugin({
            kind: 'surface',
            name: 'gl-marker',
            setup: () => ({
              page: () => {
                const proto = (globalThis as {
                  WebGLRenderingContext?: { prototype: WebGLRenderingContext }
                }).WebGLRenderingContext?.prototype
                if (!proto) return
                const was = proto.getParameter
                proto.getParameter = native(
                  function (this: WebGLRenderingContext, p: number) {
                    return p === 0x1f01 ? 'Spoofed Renderer' : was.call(this, p)
                  },
                  'getParameter',
                )
              },
            }),
          })

          await using it = await harness({ plugins: [gl()] })
          const seen = await it.eachRealm(() => {
            const canvas = typeof OffscreenCanvas === 'function'
              ? new OffscreenCanvas(1, 1)
              : document.createElement('canvas')
            const context = canvas.getContext('webgl') as
              | WebGLRenderingContext
              | null
            return context ? String(context.getParameter(0x1f01)) : 'no webgl'
          })
          assertEquals(seen.page, 'Spoofed Renderer')
          assertEquals(seen.iframe, 'Spoofed Renderer')
          assertEquals(
            seen.worker,
            'Spoofed Renderer',
            'a worker got the real renderer: the realm delivery regressed',
          )
        },
      )

      await t.step('the bundle is not a global the page can find', async () => {
        // The main-world exposure is real and mitigated rather than eliminated
        // (§4.5); leaving a global behind would make it trivial instead.
        await using it = await harness({ plugins: [marker('quiet')()] })
        const leaked = await it.eachRealm(() =>
          Object.getOwnPropertyNames(globalThis).filter((k) =>
            k === 'native' || k === 'define' || k === 'noise' || k === 'NATIVE'
          )
        )
        assertEquals(leaked, {
          page: [],
          iframe: [],
          worker: [],
          service_worker: [],
        })
      })

      await t.step('coverage is readable from the harness', async () => {
        await using it = await harness({ plugins: [] })
        assert(it.profile.id.length > 0)
        assert(Array.isArray(it.coverage.uncovered))
      })
    } finally {
      await shutdown()
    }
  },
})
