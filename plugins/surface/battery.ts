/**
 * @module plugins/surface/battery
 * @description What `navigator.getBattery()` reports.
 *
 * Another root surface (§10.2): there is no battery field in the profile, and
 * adding one would be adding a field so that a plugin could read it. What there
 * is instead is the identity's seed, and that is enough, because the tell here
 * is not the value — it is that every session has the *same* value.
 *
 * Headless Chrome has no battery service, so it answers the specified fallback:
 * `charging: true`, `level: 1`, `chargingTime: 0`, `dischargingTime: Infinity`.
 * That is a perfectly ordinary answer from a desktop, which is why this surface
 * is not urgent — and a perfectly damning one from ten thousand sessions, which
 * is why it exists. `noise('battery.*')` spreads the fleet across the states a
 * population of real machines would be in, and pins each one for the life of its
 * identity so a page that reads twice sees a battery, not a dice roll.
 *
 * Every derived value is kept consistent with the others: a full battery on the
 * charger reports `chargingTime: 0`, a discharging one reports `Infinity` for
 * the charging time, and the remaining times are the level scaled to a plausible
 * total, rounded to the whole minute Chrome rounds to.
 */

import { definePlugin } from '../../src/plugin.ts'
import type { PluginFactory } from '../../src/types.ts'

export interface BatteryOptions {
  [key: string]: unknown
}

interface Config {
  charging: boolean
  level: number
  /** Seconds, or `null` for the `Infinity` that JSON cannot carry. */
  chargingTime: number | null
  dischargingTime: number | null
}

/** Hours a full charge lasts, and hours an empty one takes to fill. */
const DISCHARGE = 5
const CHARGE = 2

export const battery: PluginFactory<BatteryOptions> = definePlugin<
  BatteryOptions,
  Config
>({
  kind: 'surface',
  name: 'battery',
  setup(_options, ctx) {
    const { noise } = ctx.profile
    // Slightly more machines plugged in than not, which is what a population of
    // desktops and docked laptops looks like.
    const charging = noise('battery.charging') < 0.62
    // Never below 15%: a fleet that is always nearly flat is its own pattern,
    // and the low-battery range is where sites start changing behaviour.
    const level = Math.round((0.15 + noise('battery.level') * 0.85) * 100) / 100
    const minutes = (hours: number) => Math.round(hours * 60) * 60

    return {
      // `navigator.getBattery` is a window API.
      realms: ['page', 'iframe'],
      config: {
        charging,
        level: charging && level > 0.97 ? 1 : level,
        chargingTime: charging ? minutes((1 - level) * CHARGE) : null,
        dischargingTime: charging ? null : minutes(level * DISCHARGE),
      },
      page(config) {
        // `getBattery` is Chrome-only and absent from the DOM lib, so it is
        // named here rather than typed; the annotation is erased on the way to
        // the page either way (§4.1).
        const owner = globalThis.navigator as Navigator & {
          getBattery?: () => Promise<Record<string, unknown>>
        }
        const get = owner?.getBattery
        if (!get) return

        owner.getBattery = native(async function (this: Navigator) {
          const manager = await get.call(this)
          // Own properties over the prototype's getters, so the page keeps the
          // real `BatteryManager` — its class, its `onlevelchange`, and the
          // events the browser will go on firing on it.
          const fields = {
            charging: config.charging,
            level: config.level,
            chargingTime: config.chargingTime ?? Infinity,
            dischargingTime: config.dischargingTime ?? Infinity,
          }
          for (const [key, value] of Object.entries(fields)) {
            Object.defineProperty(manager, key, {
              get: native(() => value, `get ${key}`),
              enumerable: true,
              configurable: true,
            })
          }
          return manager
        }, 'getBattery')
      },
    }
  },
})

export default battery
