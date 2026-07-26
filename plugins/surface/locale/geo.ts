/**
 * @module plugins/surface/locale/geo
 * @description Where the Geolocation API says the machine is.
 *
 * Pure `emulate`, like its neighbour: `Emulation.setGeolocationOverride` sits
 * below the JavaScript layer, so there is no `getCurrentPosition` to patch and
 * nothing for the page to find (§4.2).
 *
 * It grants nothing. A page still has to hold the geolocation permission, and a
 * browser that hands out coordinates to anyone who asks is a far stranger
 * machine than one that has never been asked. What the override decides is which
 * coordinates a *granted* page gets — and the point is that they are the
 * profile's, which the timezone and locale were drawn with, rather than the
 * datacentre the browser is actually running in.
 */

import { definePlugin } from '../../../src/plugin.ts'
import type { PluginFactory } from '../../../src/types.ts'

export interface GeoOptions {
  [key: string]: unknown
}

export const geo: PluginFactory<GeoOptions> = definePlugin<GeoOptions>({
  kind: 'surface',
  name: 'geo',
  setup(_options, ctx) {
    const { geo } = ctx.profile
    if (!geo) return {}

    return {
      emulate(realm) {
        return realm.send('Emulation.setGeolocationOverride', {
          latitude: geo.latitude,
          longitude: geo.longitude,
          accuracy: geo.accuracy,
        }, realm.sessionId).then(() => {})
      },
    }
  },
})

export default geo
