/**
 * @module plugins/surface/graphics/webgl
 * @description What WebGL says the GPU is.
 *
 * Ported from corsac's `drawing/web_gl.ts` with the three things that were wrong
 * with it fixed (§13.2): the vendor and renderer come from `profile.gpu` rather
 * than a hard-coded RTX 3080 that every session claimed, the `console.debug`
 * calls that announced the patch to anything listening are gone, and the patch
 * is on the context prototypes rather than on `getContext` — wrapping the
 * factory leaves a patched `getContext` for the page to find and misses every
 * context it did not create.
 */

import { definePlugin } from '../../../src/plugin.ts'
import type { PluginFactory } from '../../../src/types.ts'

export interface WebglOptions {
  /** Patch `WebGL2RenderingContext` too. Off only for testing the WebGL1 path. */
  webgl2?: boolean
  [key: string]: unknown
}

interface Config {
  vendor: string
  renderer: string
  /** Extra `getParameter` answers, keyed by the GL enum as a string. */
  params: Record<string, number | string>
  webgl2: boolean
}

export const webgl: PluginFactory<WebglOptions> = definePlugin<
  WebglOptions,
  Config
>({
  kind: 'surface',
  name: 'webgl',
  defaults: { webgl2: true },
  setup(options, ctx) {
    // Stand down rather than invent (§2.9): a profile with no GPU is a profile
    // that makes no claim about one, and a made-up renderer string is worse than
    // whatever the real driver reports.
    const { gpu } = ctx.profile
    if (!gpu) return {}

    return {
      realms: ['page', 'iframe', 'worker'],
      config: {
        vendor: gpu.vendor,
        renderer: gpu.renderer,
        params: Object.fromEntries(
          Object.entries(gpu.params ?? {}).map(([k, v]) => [String(k), v]),
        ),
        webgl2: options.webgl2 !== false,
      },
      page(config) {
        const contexts = [
          typeof WebGLRenderingContext === 'undefined'
            ? undefined
            : WebGLRenderingContext,
          config.webgl2 && typeof WebGL2RenderingContext !== 'undefined'
            ? WebGL2RenderingContext
            : undefined,
        ]

        for (const context of contexts) {
          if (!context) continue
          const proto = context.prototype
          const getParameter = proto.getParameter
          const patch = function (this: WebGLRenderingContext, name: number) {
            if (name === 0x9245) return config.vendor // UNMASKED_VENDOR_WEBGL
            if (name === 0x9246) return config.renderer // UNMASKED_RENDERER_WEBGL
            const override = config.params[String(name)]
            if (override !== undefined) return override
            return getParameter.call(this, name)
          }
          proto.getParameter = native(patch, 'getParameter')

          // A page that cannot get the extension cannot ask for the unmasked
          // pair at all, and a browser that reports a GPU but hides the
          // extension is rarer than either answer on its own.
          const getExtension = proto.getExtension
          proto.getExtension = native(
            function (this: WebGLRenderingContext, extension: string) {
              const got = getExtension.call(this, extension)
              if (got || extension !== 'WEBGL_debug_renderer_info') return got
              return {
                UNMASKED_VENDOR_WEBGL: 0x9245,
                UNMASKED_RENDERER_WEBGL: 0x9246,
              }
            },
            'getExtension',
          )
        }
      },
    }
  },
})

export default webgl
