/**
 * @module plugins/surface/platform/navigator
 * @description What `navigator` reports about the machine: the User-Agent and its
 * client hints, the platform string, the core and memory counts, and
 * `webdriver`.
 *
 * Everything here comes from the profile, including the whole User-Agent —
 * decision 6 keeps the UA out of core and out of a launch flag so that one
 * surface owns the claim end to end (§8.3). The `HeadlessChrome` token is gone
 * by the time it is read: reconciliation strips it from the drawn identity
 * (§2.6), so this surface never sees it and has no fallback of its own.
 *
 * Three of the five fields take the `emulate` rung (§4.2) —
 * `setUserAgentOverride` and `setHardwareConcurrencyOverride` reach further than
 * a patch can, covering the headers and every realm Chrome creates. Only
 * `platform`, `deviceMemory` and `maxTouchPoints` are left for `page`, because
 * Chrome exposes no override for them.
 */

import { definePlugin } from '../../../src/plugin.ts'
import type { PluginFactory } from '../../../src/types.ts'

export interface NavigatorOptions {
  /**
   * Also assert `navigator.webdriver === false`. Off by default: `constants.ts`
   * omits `--enable-automation`, so the flag is already absent, and a getter
   * returning `false` is a patch where there was nothing to patch (§13.5).
   */
  webdriver?: boolean
  [key: string]: unknown
}

interface Config {
  platform: string
  memory: number
  touch: number
  webdriver: boolean
}

/** What `Emulation.setUserAgentOverride` wants for its `platform` field. */
const PLATFORM = {
  macOS: 'MacIntel',
  Windows: 'Win32',
  Linux: 'Linux x86_64',
} as const

export const navigator: PluginFactory<NavigatorOptions> = definePlugin<
  NavigatorOptions,
  Config
>({
  kind: 'surface',
  name: 'navigator',
  priority: 100,
  defaults: { webdriver: false },
  setup(options, ctx) {
    const { profile } = ctx
    return {
      config: {
        platform: PLATFORM[profile.os],
        // Reported in gibibytes, capped at 8 by the spec so the value cannot be
        // used to identify a machine — a profile drawn with 64 GB must still say
        // 8, or the cap itself becomes the tell.
        memory: Math.min(
          8,
          2 ** Math.floor(Math.log2(profile.hardware.memory)),
        ),
        touch: profile.hardware.touch ? 5 : 0,
        webdriver: options.webdriver === true,
      },
      // `navigator` rather than `Navigator.prototype`: `define` installs on
      // whichever object actually declares the property, and a worker's is
      // `WorkerNavigator`. Naming the instance is what makes one page function
      // correct in every realm (§4.4).
      page(config) {
        define(navigator, 'platform', config.platform)
        define(navigator, 'deviceMemory', config.memory)
        define(navigator, 'maxTouchPoints', config.touch)
        if (config.webdriver) define(navigator, 'webdriver', false)
      },
      emulate(realm) {
        return Promise.all([
          realm.send('Emulation.setUserAgentOverride', {
            userAgent: profile.userAgent,
            // DANGER: the metadata has to agree with the UA string. Claiming
            // macOS in the hints while the UA says Linux is a far louder tell
            // than any single value either one carries.
            userAgentMetadata: {
              brands: profile.brands.map((b) => ({ ...b })),
              fullVersion: `${profile.chrome}.0.0.0`,
              fullVersionList: profile.brands.map((b) => ({
                brand: b.brand,
                version: `${b.version}.0.0.0`,
              })),
              platform: profile.os === 'macOS' ? 'macOS' : profile.os,
              platformVersion: profile.osVersion,
              architecture: profile.arch,
              bitness: '64',
              model: '',
              mobile: false,
              wow64: false,
            },
            // Plain tags rather than a real header's q-weights: Chrome derives
            // `navigator.languages` from this string by splitting it, so a
            // `;q=0.9` arrives in the page as a language in its own right.
            acceptLanguage: profile.languages.join(','),
          }, realm.sessionId),
          realm.send('Emulation.setHardwareConcurrencyOverride', {
            hardwareConcurrency: profile.hardware.cores,
          }, realm.sessionId),
        ]).then(() => {})
      },
    }
  },
})

export default navigator
