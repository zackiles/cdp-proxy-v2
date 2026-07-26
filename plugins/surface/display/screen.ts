/**
 * @module plugins/surface/display/screen
 * @description The display the session claims: a monitor bigger than the
 * viewport, and a window with a tab strip and a toolbar taking up room above it.
 *
 * Headless gets both wrong in the same direction. Playwright pins the screen to
 * the viewport it was asked for, so `screen.width === innerWidth`, which no real
 * monitor does; then it sizes the window to the viewport exactly, leaving
 * `outerHeight === innerHeight`, which no real window does. Two lines of page
 * JavaScript, and nothing to patch: both come from a CDP command.
 *
 * Which is why this declares rather than sends. `Emulation.setDeviceMetricsOverride`
 * is whole-state and the client is a caller too, so a command sent from `emulate`
 * is replaced the moment Playwright sets its viewport. The broker owns the domain
 * and folds this claim into the client's own call (§7.2), leaving the page with a
 * metrics override it would have received anyway — the higher rung of §4.2, with
 * no patched function on any prototype.
 */

import { definePlugin } from '../../../src/plugin.ts'
import type { PluginFactory } from '../../../src/types.ts'

export interface ScreenOptions {
  [key: string]: unknown
}

export const screen: PluginFactory<ScreenOptions> = definePlugin<ScreenOptions>(
  {
    kind: 'surface',
    name: 'screen',
    priority: 100,
    setup(_options, ctx) {
      const { screen, chromeHeight } = ctx.profile
      return {
        display: {
          screen: {
            width: screen.width,
            height: screen.height,
            scale: screen.scale,
          },
          chrome: chromeHeight,
        },
      }
    },
  },
)

export default screen
