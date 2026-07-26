/**
 * @module core/flags
 * @description The baseline the browser process starts from (§8.3): the flags
 * that keep it controllable, the flags that stop it defeating itself, and the
 * two the profile decides.
 *
 * This is `BROWSER_LAUNCH_FLAGS` from `constants.ts`, moved rather than copied.
 * Moving it removes a mechanism instead of adding one — baseline flags used to
 * live in a constant while contributed flags came from plugins, arbitrated by
 * two different rules. Now there is one list and one merge policy, and being
 * pinned first is exactly what lets an authored plugin override a baseline flag
 * by the ordinary last-wins rule (§8.4).
 *
 * `BASELINE` is exported separately from the plugin because a process can start
 * with no session behind it — `plugins: 'none'` claims nothing, so there is no
 * profile for the two derived flags to come from and nothing for a plugin to
 * contribute.
 *
 * DANGER: no `--user-agent=` here, and that is settled (§8.3, decision 6). It
 * would let core drop the harness's own signature without choosing a persona,
 * but it puts core in the business of composing a User-Agent, which is the first
 * half of choosing an identity. The whole UA belongs to
 * `surface/platform/navigator.ts`, including the `HeadlessChrome` token — so a
 * core-only session still reports it.
 */

import { definePlugin } from '../plugin.ts'
import { Config } from '../config.ts'
import type { PluginFactory } from '../types.ts'

/**
 * Automation hygiene, and the two flags a headless page needs to look like a
 * browser rather than like a renderer somebody forgot to give a GPU.
 *
 * @see docs/chromium-launch-flags.json for the full set Chromium accepts
 */
export const BASELINE = [
  '--no-default-browser-check', // Skip default browser check
  '--no-first-run', // Skip first run wizards
  // DANGER: without this, `requestAnimationFrame` never fires in a page opened
  // over CDP. Chrome fetches a server-side variations config at startup and one
  // of the trials currently in it stops producing frames for such a page, which
  // takes out everything in Playwright that waits on a frame: `click` hangs on
  // its stability check and `waitForFunction` polls forever. It reproduces with
  // no flags of ours at all and disappears the moment the trials are off, which
  // is why Playwright passes this on every launch. Nothing about it announces
  // automation — it opts out of experiments, it does not describe the client.
  '--disable-field-trial-config',
  // DANGER: do not add --disable-gpu. It leaves the page with no WebGL context at
  // all, and every real Chrome has one — checking `!!canvas.getContext('webgl')`
  // is a one-line headless test. ANGLE over SwiftShader gives a working context
  // without needing a GPU, so it holds up in a container too, and the unsafe flag
  // is what lifts Chrome's own block on software WebGL.
  '--use-gl=angle',
  '--enable-unsafe-swiftshader',
  '--no-sandbox', // Disable sandbox security feature
  '--enable-features=NetworkService,NetworkServiceInProcess', // Enable required network features
  '--allow-pre-commit-input', // Allow input before commit
  '--disable-background-networking', // Disable background network tasks
  '--disable-default-apps', // Disable installation of default apps
  '--disable-extensions', // Disable browser extensions
  '--disable-sync', // Disable browser sync features
  '--password-store=basic', // Use basic password store
]

export const flags: PluginFactory<Record<string, unknown>> = definePlugin({
  kind: 'launch',
  name: 'flags',
  setup: (_options, ctx) => {
    const contributed: string[] = [...BASELINE]

    // `--headless` is reserved (§3.1), so it is not contributed here: the
    // runtime appends it from `Config` where it cannot be overridden.
    try {
      contributed.push(Config.get('cdpLogLevelFlag'))
    } catch {
      // Embedded or under test with no global config: the log-level flag is a
      // diagnostic, and a browser starts fine without one.
    }

    // The two rungs the profile can climb without any JavaScript (§4.2). `--lang`
    // reaches `navigator.language` and the `Accept-Language` header before any
    // override does, and the window size is what `outerWidth` and the initial
    // viewport are measured from, neither of which a page patch can reach
    // convincingly.
    contributed.push(`--lang=${ctx.profile.locale}`)
    contributed.push(
      `--window-size=${ctx.profile.viewport.width},${
        ctx.profile.viewport.height + ctx.profile.chromeHeight
      }`,
    )

    return {
      flags: contributed,

      /**
       * Check that the window the profile asked for is the window the process
       * got, and correct the profile where it is not (§3.2).
       *
       * The merge is last-wins by flag name, so an authored `launch` plugin
       * passing its own `--window-size` beats this one — correctly, and silently
       * as far as the identity is concerned: every surface would go on claiming
       * a viewport that `window.outerWidth` disagrees with on the first page
       * that reads it. Reading the size back off the command line the process
       * actually started with is what closes that gap.
       */
      onStart(browser) {
        const size = browser.flags.filter((f) => f.startsWith('--window-size='))
          .at(-1)
        const [width, outer] = size?.slice('--window-size='.length).split(',')
          .map(Number) ?? []
        if (!width || !outer) return
        const height = outer - ctx.profile.chromeHeight
        const { viewport } = ctx.profile
        if (width === viewport.width && height === viewport.height) return
        return { viewport: { width, height } }
      },
    }
  },
})

export default flags
