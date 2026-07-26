/**
 * @module plugins/surface/platform/chrome
 * @description `window.chrome`, the object real Chrome puts on every page and
 * headless leaves off entirely.
 *
 * Merged from corsac's `runtime/chrome.ts` and `runtime/window.ts`, which were
 * two files only because one built the object and the other installed it
 * (§13.2). The per-call randomness in `csi()` is gone: corsac drew a fresh
 * number on every call, so two reads a millisecond apart disagreed about when
 * the page started loading. The numbers here are derived from real timing where
 * there is any, and from `noise` where there is not, so they are stable for the
 * life of the profile (§2.10).
 */

import { definePlugin } from '../../../src/plugin.ts'
import type { PluginFactory } from '../../../src/types.ts'

export interface ChromeOptions {
  [key: string]: unknown
}

interface Config {
  /** Stable stand-in for the transition type `csi()` reports. */
  tran: number
  /** The negotiated protocol `loadTimes()` claims, as a real Chrome would. */
  connection: string
}

export const chrome: PluginFactory<ChromeOptions> = definePlugin<
  ChromeOptions,
  Config
>({
  kind: 'surface',
  name: 'chrome',
  setup(_options, ctx) {
    return {
      // A worker has no `window`, and nothing in this surface exists there.
      realms: ['page', 'iframe'],
      config: {
        tran: 1 + Math.floor(ctx.profile.noise('chrome.tran') * 14),
        connection: 'h2',
      },
      page(config) {
        if (globalThis.chrome) return

        const started = performance.timeOrigin

        const timing = () =>
          performance.getEntriesByType('navigation')[0] as
            | PerformanceNavigationTiming
            | undefined

        const loadTimes = native(function () {
          const nav = timing()
          const seconds = (ms: number) => (started + ms) / 1000
          return {
            requestTime: seconds(nav ? nav.startTime : 0),
            startLoadTime: seconds(nav ? nav.startTime : 0),
            commitLoadTime: seconds(nav ? nav.responseStart : 0),
            finishDocumentLoadTime: seconds(
              nav ? nav.domContentLoadedEventEnd : 0,
            ),
            finishLoadTime: seconds(nav ? nav.loadEventEnd : 0),
            firstPaintTime: seconds(nav ? nav.responseEnd : 0),
            firstPaintAfterLoadTime: 0,
            navigationType: 'Other',
            wasFetchedViaSpdy: true,
            wasNpnNegotiated: true,
            npnNegotiatedProtocol: config.connection,
            wasAlternateProtocolAvailable: false,
            connectionInfo: config.connection,
          }
        }, 'loadTimes')

        const csi = native(function () {
          const nav = timing()
          return {
            startE: Math.round(started),
            onloadT: Math.round(started + (nav ? nav.loadEventEnd : 0)),
            pageT: Math.round(performance.now()),
            tran: config.tran,
          }
        }, 'csi')

        // Real Chrome's `runtime` on a page with no extension has the enums and
        // nothing else. Faking `sendMessage` would be worse than omitting it: a
        // call to it on real Chrome throws, and a stub that resolves is a tell.
        globalThis.chrome = {
          app: {
            isInstalled: false,
            InstallState: {
              DISABLED: 'disabled',
              INSTALLED: 'installed',
              NOT_INSTALLED: 'not_installed',
            },
            RunningState: {
              CANNOT_RUN: 'cannot_run',
              READY_TO_RUN: 'ready_to_run',
              RUNNING: 'running',
            },
            getDetails: native(function () {
              return null
            }, 'getDetails'),
            getIsInstalled: native(function () {
              return false
            }, 'getIsInstalled'),
          },
          csi,
          loadTimes,
          runtime: {
            OnInstalledReason: {
              CHROME_UPDATE: 'chrome_update',
              INSTALL: 'install',
              SHARED_MODULE_UPDATE: 'shared_module_update',
              UPDATE: 'update',
            },
            OnRestartRequiredReason: {
              APP_UPDATE: 'app_update',
              OS_UPDATE: 'os_update',
              PERIODIC: 'periodic',
            },
            PlatformArch: {
              ARM: 'arm',
              ARM64: 'arm64',
              MIPS: 'mips',
              MIPS64: 'mips64',
              X86_32: 'x86-32',
              X86_64: 'x86-64',
            },
            PlatformOs: {
              ANDROID: 'android',
              CROS: 'cros',
              LINUX: 'linux',
              MAC: 'mac',
              OPENBSD: 'openbsd',
              WIN: 'win',
            },
            RequestUpdateCheckStatus: {
              NO_UPDATE: 'no_update',
              THROTTLED: 'throttled',
              UPDATE_AVAILABLE: 'update_available',
            },
          },
        }
      },
    }
  },
})

export default chrome
