/**
 * @module plugins/stealth
 * @description `stealth()` is a preset now, not a plugin (§8.5). It expands to the
 * surfaces that carry the identity, and nothing else.
 *
 * The file it replaces was 460 lines doing five unrelated jobs, and where each
 * job landed is the interesting part (§13.1). The `Runtime.enable` defeat became
 * `src/core/contexts.ts` and is always installed, because it is the precondition
 * everything else rests on rather than a policy choice. `resolveUa()` became
 * profile reconciliation, for every loader at once. What is left here is the
 * policy — which machine to present — and it is a list.
 *
 * Two values that used to live in it are simply gone: the `1920×1080` screen
 * constant, which gave every session in the process the same monitor, and the
 * `'147'` User-Agent fallback, which would have been wrong the day the pinned
 * Chromium moved. Both are the profile's answers now (§0.3).
 *
 * ```ts
 * plugins: [stealth({ without: ['canvas'] })]
 * ```
 */

import { definePreset } from '../src/plugin.ts'
import type { PresetFactory } from '../src/types.ts'
import { screen } from './surface/display/screen.ts'
import { battery } from './surface/battery.ts'
import { permissions } from './surface/permissions.ts'
import { geo } from './surface/locale/geo.ts'
import { timezone } from './surface/locale/timezone.ts'
import { canvas } from './surface/graphics/canvas.ts'
import { webgl } from './surface/graphics/webgl.ts'
import { audio } from './surface/media/audio.ts'
import { codecs } from './surface/media/codecs.ts'
import { devices } from './surface/media/devices.ts'
import { webrtc } from './surface/network/webrtc.ts'
import { chrome } from './surface/platform/chrome.ts'
import { fonts } from './surface/platform/fonts.ts'
import { navigator } from './surface/platform/navigator.ts'

export interface StealthOptions {
  /**
   * Also assert `navigator.webdriver === false`. Off by default because
   * `constants.ts` omits `--enable-automation`, so there is nothing to hide and
   * the getter would be the only evidence of a patch (§13.5).
   */
  webdriver?: boolean
  [key: string]: unknown
}

export const stealth: PresetFactory<StealthOptions> = definePreset<
  StealthOptions
>({
  name: 'stealth',
  defaults: { webdriver: false },
  plugins: (cfg) => [
    navigator({ webdriver: cfg.webdriver }),
    timezone(),
    geo(),
    screen(),
    chrome(),
    fonts(),
    canvas(),
    webgl(),
    audio(),
    codecs(),
    devices(),
    permissions(),
    battery(),
    webrtc(),
  ],
})

export default stealth
