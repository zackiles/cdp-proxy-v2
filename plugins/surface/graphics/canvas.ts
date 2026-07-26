/**
 * @module plugins/surface/graphics/canvas
 * @description Canvas fingerprinting: the same drawing, rendered on two machines,
 * comes out a few least-significant bits apart because the GPU, the driver and
 * the font rasterizer are not the same. A detector hashes the pixels and gets a
 * number that identifies the machine.
 *
 * The defence is to move the hash — not to randomize it. Corsac seeded its
 * jitter from the clock, so the same page hashed differently on every read,
 * which is a stronger signal than any fixed hash: no real machine's canvas
 * changes between two calls. Here the offsets come from `profile.noise`, so a
 * profile's canvas hash is one specific wrong answer, stable across reads,
 * reloads and — for a pinned identity — runs (§2.10).
 *
 * The jitter is deliberately tiny. It has to change the hash, which one bit in
 * one channel does, and it must not change what the page looks like.
 */

import { definePlugin } from '../../../src/plugin.ts'
import type { PluginFactory } from '../../../src/types.ts'

export interface CanvasOptions {
  [key: string]: unknown
}

interface Config {
  /** Per-channel offsets in [-1, 1], applied to the pixels the seed picks. */
  offsets: number[]
  /** Which pixels get touched: every `stride`-th one, from `start`. */
  stride: number
  start: number
}

export const canvas: PluginFactory<CanvasOptions> = definePlugin<
  CanvasOptions,
  Config
>({
  kind: 'surface',
  name: 'canvas',
  setup(_options, ctx) {
    const { noise } = ctx.profile
    return {
      realms: ['page', 'iframe', 'worker'],
      config: {
        offsets: [0, 1, 2].map((c) =>
          noise(`canvas.channel.${c}`) < 0.5 ? -1 : 1
        ),
        stride: 251 + Math.floor(noise('canvas.stride') * 250),
        start: Math.floor(noise('canvas.start') * 251),
      },
      page(config) {
        const shift = (pixels: Uint8ClampedArray) => {
          for (
            let i = config.start * 4;
            i < pixels.length;
            i += config.stride * 4
          ) {
            for (let c = 0; c < 3; c++) {
              pixels[i + c] = pixels[i + c] + config.offsets[c]
            }
          }
        }

        if (typeof CanvasRenderingContext2D !== 'undefined') {
          const getImageData = CanvasRenderingContext2D.prototype.getImageData
          CanvasRenderingContext2D.prototype.getImageData = native(
            function (
              this: CanvasRenderingContext2D,
              x: number,
              y: number,
              w: number,
              h: number,
              settings?: ImageDataSettings,
            ) {
              const data = getImageData.call(this, x, y, w, h, settings)
              shift(data.data)
              return data
            },
            'getImageData',
          )
        }

        if (typeof HTMLCanvasElement === 'undefined') return

        // Read-modify-write on a copy rather than on the canvas itself: putting
        // the shifted pixels back would make the jitter visible to the next
        // `getImageData`, which would then shift them again, and a page that
        // exports twice would get two different hashes.
        const shifted = (source: HTMLCanvasElement) => {
          const copy = document.createElement('canvas')
          copy.width = source.width
          copy.height = source.height
          const context = copy.getContext('2d')
          if (!context) return source
          context.drawImage(source, 0, 0)
          const data = context.getImageData(0, 0, copy.width, copy.height)
          context.putImageData(data, 0, 0)
          return copy
        }

        const toDataURL = HTMLCanvasElement.prototype.toDataURL
        HTMLCanvasElement.prototype.toDataURL = native(
          function (this: HTMLCanvasElement, type?: string, quality?: number) {
            return toDataURL.call(shifted(this), type, quality)
          },
          'toDataURL',
        )

        const toBlob = HTMLCanvasElement.prototype.toBlob
        HTMLCanvasElement.prototype.toBlob = native(
          function (
            this: HTMLCanvasElement,
            callback: BlobCallback,
            type?: string,
            quality?: number,
          ) {
            return toBlob.call(shifted(this), callback, type, quality)
          },
          'toBlob',
        )
      },
    }
  },
})

export default canvas
