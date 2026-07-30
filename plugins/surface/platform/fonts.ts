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
 *
 * The canvas is the *cheapest* way to run that measurement, not the only one,
 * and patching it alone is why a Windows profile on a Mac still read as macOS.
 * The measurement detectors actually reach for is layout: append a span in
 * `Font, monospace`, append another in `monospace`, and compare `offsetWidth`.
 * There is no measurement API to intercept on that path — the width is whatever
 * the font system rasterized. So the filtering happens one step earlier, on the
 * declaration itself: a family the profile does not claim never reaches layout,
 * and every way of measuring it agrees on the fallback.
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
          'initial',
          'inherit',
          'revert',
          'unset',
          'default',
        ]
        const have = new Set(config.installed.map((f) => f.toLowerCase()))

        // A face the page loaded itself is present whatever the profile says: a
        // site whose own `@font-face` measures as missing is a louder signal
        // than any font list. Rebuilt only when the set changes, because the
        // layout probe below asks this once per family per baseline.
        let counted = -1
        let loaded = new Set<string>()
        const known = (name: string) => {
          const lower = name.toLowerCase()
          if (have.has(lower) || GENERIC.indexOf(lower) !== -1) return true
          try {
            const faces = document.fonts as unknown as {
              size: number
              forEach(fn: (face: { family: string }) => void): void
            }
            if (faces.size !== counted) {
              counted = faces.size
              loaded = new Set()
              faces.forEach((face) => {
                loaded.add(
                  String(face.family).replace(/^['"]|['"]$/g, '').toLowerCase(),
                )
              })
            }
          } catch {
            /* a document with no font set has nothing to add */
          }
          return loaded.has(lower)
        }

        const SHORTHAND =
          /(?:\d*\.?\d+(?:px|pt|pc|em|rem|ex|ch|vh|vw|%)|xx?-(?:small|large)|small|medium|large|larger|smaller)(?:\s*\/\s*[^\s]+)?\s+(.+)$/

        // A family Chrome cannot resolve, so an all-absent list falls back to
        // the default font exactly as it would on a machine lacking the font.
        // Dropping the declaration instead would inherit the parent's family,
        // which is a different font and a different width.
        const ABSENT = 'f' + Math.floor(noise('fonts') * 2176782336).toString(36)

        /**
         * A family list the profile does not fully claim, as `keep` (what
         * layout is allowed to see) and `echo` (what the page should read back).
         * `null` when every family is claimed and there is nothing to do.
         *
         * `echo` is spelled here rather than round-tripped through a real
         * declaration because that round trip would go through whatever
         * `setProperty` is by then — including this surface's own.
         */
        const list = (value: string) => {
          const wanted = value.split(',').map((name) => name.trim()).filter(
            Boolean,
          )
          if (wanted.length === 0) return null
          const allowed = wanted.filter((name) =>
            known(name.replace(/^['"]|['"]$/g, ''))
          )
          if (allowed.length === wanted.length) return null
          return { echo: wanted.join(', '), keep: allowed.join(', ') || ABSENT }
        }

        /** The same, for anything shaped like the `font` shorthand. */
        const shorthand = (value: string) => {
          const found = value.match(SHORTHAND)
          if (!found) return null
          const sifted = list(found[1])
          if (!sifted) return null
          const head = value.slice(0, value.length - found[1].length)
          return { echo: head + sifted.echo, keep: head + sifted.keep }
        }

        if (typeof CanvasRenderingContext2D !== 'undefined') {
          const measureText = CanvasRenderingContext2D.prototype.measureText
          CanvasRenderingContext2D.prototype.measureText = native(
            function (this: CanvasRenderingContext2D, text: string) {
              const font = this.font
              const sifted = shorthand(font)
              if (!sifted) return measureText.call(this, text)
              // Measuring in what the machine would actually fall back to is
              // what makes the font read as absent — the detector compares this
              // width against the fallback's and finds them equal.
              try {
                this.font = sifted.keep
                return measureText.call(this, text)
              } finally {
                this.font = font
              }
            },
            'measureText',
          )
        }

        if (typeof CSSStyleDeclaration !== 'undefined') {
          const setProperty = CSSStyleDeclaration.prototype.setProperty
          const getPropertyValue = CSSStyleDeclaration.prototype.getPropertyValue

          // What the page set, so reading a declaration back returns the string
          // it assigned rather than the filtered one: a `style.fontFamily` that
          // answers with the fallback is a cheaper tell than any width.
          const asked = new WeakMap<CSSStyleDeclaration, Record<string, string>>()
          const shadowed = new WeakSet<CSSStyleDeclaration>()

          /**
           * IMPORTANT: Chrome exposes CSS properties as V8 named-property
           * interceptors on each declaration — `fontFamily` is an own *data*
           * descriptor with no setter to wrap, and `CSSStyleDeclaration.prototype`
           * carries nothing at all. Defining a real accessor on the instance
           * shadows the interceptor, and is the only place `style.fontFamily = …`
           * can be caught before layout resolves the family.
           */
          const shadow = (decl: CSSStyleDeclaration) => {
            if (!decl || shadowed.has(decl)) return decl
            shadowed.add(decl)
            for (
              const [key, property, filter] of [
                ['fontFamily', 'font-family', list],
                ['font', 'font', shorthand],
              ] as const
            ) {
              const was = Object.getOwnPropertyDescriptor(decl, key)
              if (!was || !was.configurable) continue
              Object.defineProperty(decl, key, {
                get: native(function (this: CSSStyleDeclaration) {
                  const kept = asked.get(this)
                  const held = kept && kept[key]
                  return held === undefined
                    ? getPropertyValue.call(this, property)
                    : held
                }, 'get ' + key),
                set: native(function (this: CSSStyleDeclaration, value: string) {
                  const text = value === null || value === undefined
                    ? ''
                    : String(value)
                  const sifted = filter(text)
                  setProperty.call(this, property, sifted ? sifted.keep : text)
                  let kept = asked.get(this)
                  if (!sifted) {
                    if (kept) delete kept[key]
                    return
                  }
                  if (!kept) asked.set(this, kept = {})
                  kept[key] = sifted.echo
                }, 'set ' + key),
                enumerable: was.enumerable,
                configurable: true,
              })
            }
            return decl
          }

          for (const owner of [HTMLElement.prototype, SVGElement.prototype]) {
            const was = Object.getOwnPropertyDescriptor(owner, 'style')
            if (!was || !was.get) continue
            const read = was.get
            Object.defineProperty(owner, 'style', {
              get: native(function (this: HTMLElement) {
                return shadow(read.call(this))
              }, 'get style'),
              set: was.set,
              enumerable: was.enumerable,
              configurable: was.configurable,
            })
          }

          CSSStyleDeclaration.prototype.setProperty = native(function (
            this: CSSStyleDeclaration,
            name: string,
            value: string,
            priority?: string,
          ) {
            const key = String(name).toLowerCase()
            if (key === 'font-family' || key === 'font') {
              const text = value === null || value === undefined
                ? ''
                : String(value)
              const sifted = key === 'font' ? shorthand(text) : list(text)
              if (sifted) {
                return setProperty.call(this, name, sifted.keep, priority)
              }
            }
            return setProperty.call(this, name, value, priority)
          }, 'setProperty')

          // `style.cssText` and `setAttribute('style', …)` reach the same
          // declaration without going through either accessor above.
          const rewrite = (text: string) =>
            text.replace(
              /(^|;)(\s*)(font-family|font)(\s*:\s*)([^;]+)/gi,
              (whole, lead, space, name, colon, value) => {
                const sifted = String(name).toLowerCase() === 'font'
                  ? shorthand(value)
                  : list(value)
                return sifted ? lead + space + name + colon + sifted.keep : whole
              },
            )

          const cssText = Object.getOwnPropertyDescriptor(
            CSSStyleDeclaration.prototype,
            'cssText',
          )
          if (cssText && cssText.get && cssText.set) {
            const write = cssText.set
            Object.defineProperty(CSSStyleDeclaration.prototype, 'cssText', {
              get: cssText.get,
              set: native(function (this: CSSStyleDeclaration, value: string) {
                write.call(this, rewrite(String(value ?? '')))
              }, 'set cssText'),
              enumerable: cssText.enumerable,
              configurable: cssText.configurable,
            })
          }

          const setAttribute = Element.prototype.setAttribute
          Element.prototype.setAttribute = native(function (
            this: Element,
            name: string,
            value: string,
          ) {
            return setAttribute.call(
              this,
              name,
              String(name).toLowerCase() === 'style'
                ? rewrite(String(value ?? ''))
                : value,
            )
          }, 'setAttribute')
        }

        const set = document.fonts
        if (!set) return
        const check = set.check
        set.check = native(function (
          this: FontFaceSet,
          font: string,
          text?: string,
        ) {
          const found = font.match(SHORTHAND)
          const wanted = (found ? found[1] : font)
            .split(',')
            .map((name) => name.trim().replace(/^['"]|['"]$/g, ''))
            .filter(Boolean)
          // The real answer wins wherever it is `false`.
          if (!check.call(this, font, text)) return false
          return wanted.every(known)
        }, 'check')
      },
    }
  },
})

export default fonts
