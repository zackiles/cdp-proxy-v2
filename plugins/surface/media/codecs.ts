/**
 * @module plugins/surface/media/codecs
 * @description What the build can play: `canPlayType` and `isTypeSupported`.
 *
 * The only surface here that covers a difference in the *binary* rather than in
 * the machine. Google's Chrome ships the proprietary decoders; the Chromium that
 * Playwright downloads does not, so `canPlayType('video/mp4; codecs="avc1…"')`
 * answers `'probably'` on every real desktop and `''` on the browser this proxy
 * is usually driving. No amount of `navigator` spoofing touches it, and a page
 * needs one line to ask.
 *
 * It only ever *adds* support. A profile listing a codec the build genuinely has
 * changes nothing, and a build that supports something the profile does not list
 * keeps saying so — subtracting would mean claiming a Chrome that cannot play
 * WebM, which does not exist (§2.9).
 */

import { definePlugin } from '../../../src/plugin.ts'
import type { PluginFactory } from '../../../src/types.ts'

export interface CodecsOptions {
  [key: string]: unknown
}

interface Config {
  codecs: string[]
}

export const codecs: PluginFactory<CodecsOptions> = definePlugin<
  CodecsOptions,
  Config
>({
  kind: 'surface',
  name: 'codecs',
  setup(_options, ctx) {
    const { media } = ctx.profile
    if (!media) return {}

    return {
      // `MediaSource` is exposed in a dedicated worker, and a page that cannot
      // ask there is a page that asks in the frame instead.
      realms: ['page', 'iframe', 'worker'],
      config: { codecs: [...media.codecs] },
      page(config) {
        // Whitespace and quoting vary between the callers a page copies from,
        // so the claim is matched on the container and the codec ids rather
        // than on the string a profile happens to have been written with.
        const key = (type: string) =>
          type.toLowerCase().replace(/["'\s]/g, '').replace(/;codecs=/, ';')
        const claimed = new Set(config.codecs.map(key))

        const element = globalThis.HTMLMediaElement
        if (element) {
          const canPlayType = element.prototype.canPlayType
          element.prototype.canPlayType = native(
            function (this: HTMLMediaElement, type: string) {
              const answer = canPlayType.call(this, type)
              if (answer !== '' || !claimed.has(key(type))) return answer
              // `probably` and not `maybe`: `maybe` is what Chrome says when it
              // was given a container with no codec ids, and answering it for a
              // fully specified type is a disagreement of its own.
              return key(type).includes(';') ? 'probably' : 'maybe'
            },
            'canPlayType',
          ) as typeof canPlayType
        }

        const source = globalThis.MediaSource
        if (source) {
          const isTypeSupported = source.isTypeSupported
          source.isTypeSupported = native(
            (type: string) =>
              isTypeSupported.call(source, type) || claimed.has(key(type)),
            'isTypeSupported',
          )
        }
      },
    }
  },
})

export default codecs
