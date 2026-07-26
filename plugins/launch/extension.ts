/**
 * @module plugins/launch/extension
 * @description Load an unpacked extension into the browser (§3.1).
 *
 * Two plugins each loading one is why `extensions` merges by concatenation
 * rather than last-wins: Chrome takes a single `--load-extension` with a
 * comma-separated list, so two of the flag means the second silently replaces
 * the first. The merge in `src/launch.ts` turns the collected list into one
 * flag.
 *
 * IMPORTANT: an extension is visible to the page. `chrome.runtime` responds
 * differently with one installed, and an extension that injects into the page
 * is as detectable as anything it injects. This is for extensions the persona
 * plausibly has, not for carrying the harness's own code — page functions
 * (§4.1) are for that, and they run before any script the page has.
 */

import { definePlugin } from '../../src/plugin.ts'
import type { BrowserInfo, PluginFactory } from '../../src/types.ts'

export interface ExtensionOptions {
  /** Absolute path to an unpacked extension directory. */
  path: string
  [key: string]: unknown
}

export const extension: PluginFactory<ExtensionOptions> = definePlugin<
  ExtensionOptions
>({
  kind: 'launch',
  name: 'extension',
  defaults: { path: '' },
  setup(options, ctx) {
    if (!options.path) {
      throw new Error('extension() needs a path to an unpacked directory')
    }
    return {
      extensions: [options.path],
      // Chrome drops an unloadable extension without a word and starts anyway,
      // so the check is here rather than in a test: `onStart` is exactly the
      // "did my contribution take effect" hook (§3.2).
      onStart(browser: BrowserInfo) {
        const loaded = browser.flags.some((f) =>
          f.startsWith('--load-extension=') && f.includes(options.path)
        )
        if (!loaded) {
          ctx.log(`extension ${options.path} is not on the command line`)
        }
      },
    }
  },
})

export default extension
