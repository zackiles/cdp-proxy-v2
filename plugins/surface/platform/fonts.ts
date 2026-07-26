/**
 * @module plugins/surface/platform/fonts
 * @description Which fonts the machine has installed.
 *
 * A detector never asks directly. It measures a string in the font it is testing
 * for, measures it again in a generic fallback, and calls the font installed if
 * the two widths differ. The set of fonts that answer "installed" is close to
 * unique per machine, and a headless Linux container answering for a list of
 * macOS fonts is a contradiction with everything else the profile claims.
 *
 * Ported from corsac's `styling/fonts.ts` with its two bugs fixed (§13.2). It
 * left `this.font` set to whatever it measured with, so a page that measured and
 * then drew got the wrong font on the canvas; the assignment here is restored in
 * a `finally`, which makes it unobservable to synchronous code. And it answered
 * `false` to every `document.fonts.check`, including for web fonts the page had
 * loaded itself — a page whose own `@font-face` reports missing is a louder
 * signal than any font list.
 */

import { definePlugin } from '../../../src/plugin.ts'
import type { PluginFactory } from '../../../src/types.ts'

export interface FontsOptions {
  [key: string]: unknown
}

interface Config {
  installed: string[]
}

export const fonts: PluginFactory<FontsOptions> = definePlugin<
  FontsOptions,
  Config
>({
  kind: 'surface',
  name: 'fonts',
  setup(_options, ctx) {
    const installed = ctx.profile.fonts
    if (!installed) return {}

    return {
      realms: ['page', 'iframe'],
      config: { installed: [...installed] },
      page(config) {
        // Generic families are keywords rather than fonts: every machine
        // resolves them, so answering "missing" for one is a contradiction.
        const GENERIC = [
          'serif',
          'sans-serif',
          'monospace',
          'cursive',
          'fantasy',
          'system-ui',
          'ui-serif',
          'ui-sans-serif',
          'ui-monospace',
          'ui-rounded',
          'math',
          'emoji',
          'fangsong',
        ]
        const have = new Set(config.installed.map((f) => f.toLowerCase()))

        const families = (font: string) => {
          const list = font.match(
            /(?:\d*\.?\d+(?:px|pt|pc|em|rem|ex|ch|vh|vw|%)|xx?-(?:small|large)|small|medium|large|larger|smaller)\s+(.+)$/,
          )
          return (list ? list[1] : font)
            .split(',')
            .map((name) => name.trim().replace(/^['"]|['"]$/g, ''))
            .filter(Boolean)
        }

        const known = (name: string) => {
          const lower = name.toLowerCase()
          return have.has(lower) || GENERIC.indexOf(lower) !== -1
        }

        if (typeof CanvasRenderingContext2D !== 'undefined') {
          const measureText = CanvasRenderingContext2D.prototype.measureText
          CanvasRenderingContext2D.prototype.measureText = native(
            function (this: CanvasRenderingContext2D, text: string) {
              const font = this.font
              const wanted = families(font)
              const allowed = wanted.filter(known)
              if (allowed.length === wanted.length) {
                return measureText.call(this, text)
              }
              // Measuring in what the machine would actually fall back to is
              // what makes the font read as absent — the detector compares this
              // width against the fallback's and finds them equal.
              const size = font.slice(0, font.length - wanted.join(', ').length)
              try {
                this.font = size + (allowed.join(', ') || 'sans-serif')
                return measureText.call(this, text)
              } finally {
                this.font = font
              }
            },
            'measureText',
          )
        }

        const set = document.fonts
        if (!set) return
        const check = set.check
        set.check = native(function (
          this: FontFaceSet,
          font: string,
          text?: string,
        ) {
          const wanted = families(font)
          // A face the page loaded itself is present whatever the profile says,
          // so the real answer wins wherever it is `false`.
          if (!check.call(this, font, text)) return false
          return wanted.every(known)
        }, 'check')
      },
    }
  },
})

export default fonts
