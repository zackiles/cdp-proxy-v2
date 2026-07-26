/**
 * @module plugins/surface/media/devices
 * @description The cameras, microphones and speakers `enumerateDevices` finds.
 *
 * Headless Chrome finds none, and a desktop with no audio output at all is
 * rarer than any single value this platform spoofs — one `await
 * navigator.mediaDevices.enumerateDevices()` returning `[]` is the whole test.
 *
 * The labels are the part that has to be handled carefully, because a real
 * browser hides them: until the page holds a camera or microphone permission
 * every `label` is `''`, and a list that names a FaceTime camera to an
 * unpermissioned page is a louder tell than the empty list it replaced. So the
 * surface asks the browser what it can see first, and only fills in labels when
 * the browser was already willing to give one.
 */

import { definePlugin } from '../../../src/plugin.ts'
import type { PluginFactory } from '../../../src/types.ts'

export interface DevicesOptions {
  [key: string]: unknown
}

interface Device {
  kind: string
  label: string
  deviceId: string
  groupId: string
}

interface Config {
  devices: Device[]
}

/** A 64-hex id, the shape of every Chrome device id that is not `default`. */
function identify(noise: (key: string) => number, key: string): string {
  let out = ''
  for (let i = 0; out.length < 64; i++) {
    out += Math.floor(noise(`${key}:${i}`) * 0x100000000).toString(16)
      .padStart(8, '0')
  }
  return out.slice(0, 64)
}

export const devices: PluginFactory<DevicesOptions> = definePlugin<
  DevicesOptions,
  Config
>({
  kind: 'surface',
  name: 'devices',
  setup(_options, ctx) {
    const { media, noise } = ctx.profile
    if (!media) return {}

    const seen = new Set<string>()
    return {
      // `navigator.mediaDevices` is a window API; a worker has no such thing to
      // patch, and declining the realm is how a surface says so (§4.4).
      realms: ['page', 'iframe'],
      config: {
        devices: media.devices.map((device, index) => {
          // Chrome calls the first of each kind `default` and hashes the rest.
          // The hashes are stable for the life of the machine, which is what
          // makes deriving them from the identity's seed right rather than
          // merely convenient (§2.10).
          const first = !seen.has(device.kind)
          seen.add(device.kind)
          return {
            kind: device.kind,
            label: device.label,
            deviceId: first && device.kind !== 'videoinput'
              ? 'default'
              : identify(noise, `device:${index}`),
            // One group per physical unit: a laptop's microphone and speakers
            // share one, and a webcam brings its own.
            groupId: identify(noise, `group:${device.label}`),
          }
        }),
      },
      page(config) {
        const media = globalThis.navigator?.mediaDevices
        if (!media) return

        const enumerate = media.enumerateDevices
        // `Object.create` rather than an object literal: the page can ask
        // `x instanceof MediaDeviceInfo` and the own properties installed below
        // shadow the prototype's getters, so the answer stays yes.
        const build = (device: Device, named: boolean) => {
          const info = Object.create(globalThis.MediaDeviceInfo.prototype)
          const fields = {
            deviceId: device.deviceId,
            kind: device.kind,
            label: named ? device.label : '',
            groupId: device.groupId,
          }
          for (const [key, value] of Object.entries(fields)) {
            Object.defineProperty(info, key, {
              get: native(() => value, `get ${key}`),
              enumerable: true,
              configurable: true,
            })
          }
          info.toJSON = native(() => fields, 'toJSON')
          return info
        }

        media.enumerateDevices = native(async function () {
          const real = await enumerate.call(media)
          // Whether the page holds the grant is the browser's answer to give,
          // not this surface's: a real label in the real list means it does.
          const named = real.some((device) => device.label !== '')
          return config.devices.map((device) => build(device, named))
        }, 'enumerateDevices') as typeof enumerate
      },
    }
  },
})

export default devices
