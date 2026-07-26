/**
 * @module plugins/surface/locale/timezone
 * @description Where the machine says it is: the IANA timezone and the locale
 * every `Intl` and `toLocaleString` call resolves against.
 *
 * Pure `emulate`, and the clearest case for §4.2's ladder. Corsac patched `Date`
 * to shift the clock, which breaks real time for the page and is detectable by
 * comparing `Date.now()` against a network timestamp. `Emulation.setTimezoneOverride`
 * moves the timezone below the JavaScript layer, where the page has nothing to
 * compare against and nothing to find. This surface injects no page code at all
 * (§13.2 rejects `language/date.ts` on exactly these grounds).
 */

import { definePlugin } from '../../../src/plugin.ts'
import type { PluginFactory } from '../../../src/types.ts'

export interface TimezoneOptions {
  [key: string]: unknown
}

export const timezone: PluginFactory<TimezoneOptions> = definePlugin<
  TimezoneOptions
>({
  kind: 'surface',
  name: 'timezone',
  setup(_options, ctx) {
    const { profile } = ctx
    return {
      emulate(realm) {
        return Promise.all([
          realm.send('Emulation.setTimezoneOverride', {
            timezoneId: profile.timezone,
          }, realm.sessionId),
          realm.send('Emulation.setLocaleOverride', {
            locale: profile.locale,
          }, realm.sessionId),
        ]).then(() => {})
      },
    }
  },
})

export default timezone
