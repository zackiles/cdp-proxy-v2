/**
 * The Phase 9 surfaces, against a real browser (§14).
 *
 * Each one exists because of a specific question a page can ask, so each step
 * asks that question and then asks it again without the surface. The second half
 * is not padding: a probe that cannot fail proves nothing, and every one of
 * these patches an API that would answer *something* either way.
 */

import { assert, assertEquals, assertNotEquals } from '@std/assert'
import { Config } from '../src/config.ts'
import { harness } from '../src/harness.ts'
import { shutdown } from '../src/sdk.ts'
import { audio } from '../plugins/surface/media/audio.ts'
import { codecs } from '../plugins/surface/media/codecs.ts'
import { devices } from '../plugins/surface/media/devices.ts'
import { webrtc } from '../plugins/surface/network/webrtc.ts'
import { permissions } from '../plugins/surface/permissions.ts'
import { battery } from '../plugins/surface/battery.ts'
import { geo } from '../plugins/surface/locale/geo.ts'

const options = await Config.create({
  CDP_HEADLESS: 'true',
  CDP_PROXY_HOST: 'localhost',
  CDP_BROWSER_HOST: 'localhost',
  CDP_PROXY_LOG_LEVEL: 'error',
})

const H264 = 'video/mp4; codecs="avc1.42E01E"'

Deno.test({
  name: 'surfaces: the questions corsac never answered',
  ignore: !options.browserExecutablePath,
  sanitizeResources: false,
  sanitizeOps: false,
  async fn(t) {
    Config.setGlobal(new Config(options))

    try {
      await t.step(
        'codecs: the build claims the decoders Chrome ships',
        async () => {
          await using bare = await harness({ plugins: [] })
          const real = await bare.page.eval(() =>
            document.createElement('video').canPlayType(
              'video/mp4; codecs="avc1.42E01E"',
            )
          )

          await using it = await harness({ plugins: [codecs()] })
          assertEquals(
            await it.page.eval(() =>
              document.createElement('video').canPlayType(
                'video/mp4; codecs="avc1.42E01E"',
              )
            ),
            'probably',
          )
          // The claim is only interesting if the browser disagreed; on a build
          // that ships H.264 the surface is a no-op and says so.
          it.page.log(`bare canPlayType(${H264}) = ${JSON.stringify(real)}`)

          // Whitespace and quoting vary between callers, and a claim that only
          // matches the profile's exact spelling is a claim with a hole in it.
          assertEquals(
            await it.page.eval(() =>
              globalThis.MediaSource?.isTypeSupported(
                'video/mp4;codecs=avc1.42E01E',
              )
            ),
            true,
          )
        },
      )

      await t.step(
        'codecs: a type nobody claims is still refused',
        async () => {
          await using it = await harness({ plugins: [codecs()] })
          assertEquals(
            await it.page.eval(() =>
              document.createElement('video').canPlayType('video/x-made-up')
            ),
            '',
          )
        },
      )

      await t.step(
        'devices: a machine with no microphone is not a machine',
        async () => {
          // A secure context, because `navigator.mediaDevices` does not exist
          // outside one and an absent API would pass any assertion below.
          await using it = await harness({ plugins: [devices()] })
          await it.origin()
          const found = await it.page.eval(async () =>
            (await navigator.mediaDevices.enumerateDevices()).map((d) => ({
              kind: d.kind,
              label: d.label,
              deviceId: d.deviceId,
              group: d.groupId.length,
              info: d instanceof MediaDeviceInfo,
            }))
          )
          // The list is the profile's, whatever the host running the test happens
          // to have plugged in — which is the claim, and the reason this suite
          // cannot assert against the browser's own answer here.
          assertEquals(
            found.map((d) => d.kind),
            it.profile.media!.devices.map((d) => d.kind),
          )
          // Labels are the browser's to release, and this page holds no grant.
          assertEquals(found.filter((d) => d.label !== ''), [])
          assert(found.every((d) => d.info), 'not a real MediaDeviceInfo')
          assert(
            found.every((d) => d.group === 64),
            'group ids are not Chrome-shaped',
          )
          assert(
            found.some((d) => d.deviceId === 'default'),
            'no device is the default one',
          )
        },
      )

      await t.step(
        'audio: the fingerprint moves, and then holds still',
        async () => {
          const render = () =>
            new Promise<number>((resolve) => {
              const ctx = new OfflineAudioContext(1, 44100, 44100)
              const oscillator = ctx.createOscillator()
              oscillator.type = 'triangle'
              oscillator.frequency.value = 10000
              const compressor = ctx.createDynamicsCompressor()
              oscillator.connect(compressor)
              compressor.connect(ctx.destination)
              oscillator.start(0)
              ctx.startRendering().then((buffer) => {
                const samples = buffer.getChannelData(0)
                let sum = 0
                for (let i = 4500; i < 5000; i++) sum += Math.abs(samples[i])
                resolve(sum)
              })
            })

          await using bare = await harness({ plugins: [] })
          const clean = await bare.page.eval(render)

          await using it = await harness({ plugins: [audio()] })
          const perturbed = await it.page.eval(render)
          assertNotEquals(perturbed, clean, 'the audio hash did not move')
          assert(
            Math.abs(perturbed - clean) / clean < 1e-3,
            `the perturbation is audible: ${clean} -> ${perturbed}`,
          )

          // Reading the same buffer twice must give the same samples; a detector
          // comparing two reads is the cheapest check there is.
          assertEquals(
            await it.page.eval(async () => {
              const ctx = new OfflineAudioContext(1, 1024, 44100)
              const source = ctx.createOscillator()
              source.connect(ctx.destination)
              source.start(0)
              const buffer = await ctx.startRendering()
              const once = Array.from(buffer.getChannelData(0).slice(0, 8))
              const twice = Array.from(buffer.getChannelData(0).slice(0, 8))
              const copied = new Float32Array(8)
              buffer.copyFromChannel(copied, 0)
              return {
                stable: once.every((v, i) => v === twice[i]),
                agrees: once.every((v, i) => v === copied[i]),
              }
            }),
            { stable: true, agrees: true },
          )
        },
      )

      await t.step(
        'permissions: the notification answer agrees with itself',
        async () => {
          const ask = async (
            it: { page: { eval: <T>(fn: () => T) => Promise<T> } },
          ) =>
            await it.page.eval(async () => ({
              notification: Notification.permission as string,
              notifications: (await navigator.permissions.query({
                name: 'notifications',
              })).state as string,
              geolocation: (await navigator.permissions.query({
                name: 'geolocation',
              })).state as string,
            }))

          await using bare = await harness({ plugins: [] })
          await bare.origin()
          const before = await ask(bare)

          await using it = await harness({ plugins: [permissions()] })
          await it.origin()
          const after = await ask(it)

          assertEquals(
            after.notifications,
            after.notification === 'default' ? 'prompt' : after.notification,
            `the two answers still disagree: ${JSON.stringify(after)}`,
          )
          it.page.log(`bare permissions = ${JSON.stringify(before)}`)

          // Every other permission is left exactly as the browser answered it: a
          // surface that repairs one contradiction must not invent another.
          assertEquals(after.geolocation, before.geolocation)
        },
      )

      await t.step(
        'battery: not the specified fallback, and not a dice roll',
        async () => {
          await using it = await harness({ plugins: [battery()] })
          await it.origin()
          const read = () =>
            it.page.eval(async () => {
              const scope = globalThis as unknown as {
                navigator: {
                  getBattery(): Promise<Record<string, number | boolean>>
                }
                BatteryManager: new () => unknown
              }
              const manager = await scope.navigator.getBattery()
              return {
                charging: manager.charging as boolean,
                level: manager.level as number,
                chargingTime: manager.chargingTime as number,
                dischargingTime: manager.dischargingTime as number,
                manager: manager instanceof scope.BatteryManager,
              }
            })

          const seen = await read()
          assert(seen.manager, 'the page no longer holds a real BatteryManager')
          assert(seen.level > 0 && seen.level <= 1, `level ${seen.level}`)
          assertEquals(
            seen.charging
              ? seen.dischargingTime === Infinity
              : seen.chargingTime === Infinity,
            true,
            `the two times contradict the charging state: ${
              JSON.stringify(seen)
            }`,
          )
          assertEquals(await read(), seen, 'the battery changed between reads')
        },
      )

      await t.step(
        'webrtc: the address the proxy replaced does not leak',
        async () => {
          await using it = await harness({ plugins: [webrtc()] })
          const gathered = await it.page.eval(() =>
            new Promise<string[]>((resolve) => {
              const peer = new RTCPeerConnection({
                iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
              })
              const seen: string[] = []
              peer.onicecandidate = (event) => {
                if (event.candidate) seen.push(event.candidate.candidate)
                else resolve(seen)
              }
              peer.createDataChannel('probe')
              peer.createOffer().then((offer) =>
                peer.setLocalDescription(offer)
              )
              setTimeout(() => resolve(seen), 4000)
            })
          )
          assertEquals(
            gathered.filter((c) => / typ (srflx|relay|prflx)/.test(c)),
            [],
            'a reflexive candidate reached the page',
          )

          // And the second door: the SDP the page can read afterwards.
          assertEquals(
            await it.page.eval(() =>
              new Promise<boolean>((resolve) => {
                const peer = new RTCPeerConnection()
                peer.createDataChannel('probe')
                peer.onicegatheringstatechange = () => {
                  if (peer.iceGatheringState !== 'complete') return
                  resolve(
                    / typ (srflx|relay|prflx)/.test(
                      peer.localDescription?.sdp ?? '',
                    ),
                  )
                }
                peer.createOffer().then((offer) =>
                  peer.setLocalDescription(offer)
                )
                setTimeout(() => resolve(false), 4000)
              })
            ),
            false,
          )
        },
      )

      await t.step(
        'geo: the profile carries the coordinates, and grants nothing',
        async () => {
          await using bare = await harness({ plugins: [] })
          await bare.origin()
          const ungranted = await bare.page.eval(async () =>
            (await navigator.permissions.query({ name: 'geolocation' })).state
          )

          await using it = await harness({ plugins: [geo()] })
          await it.origin()
          // The override decides which coordinates a *granted* page gets. It
          // grants nothing, and a browser that hands them to anyone who asks is
          // the stranger machine.
          assertEquals(
            await it.page.eval(async () =>
              (await navigator.permissions.query({ name: 'geolocation' })).state
            ),
            ungranted,
          )
          assertEquals(it.coverage.uncovered.includes('geo'), false)
        },
      )

      await t.step(
        'every field of the identity is carried by something',
        async () => {
          // The §2.8 report is the phase's own acceptance test: a green uncovered
          // line is what "the surfaces corsac never had" was for.
          const { stealth } = await import('../plugins/stealth.ts')
          await using it = await harness({ plugins: [stealth()] })
          assertEquals(
            it.coverage.uncovered,
            [],
            `nothing is carrying ${it.coverage.uncovered.join(' ')}`,
          )
        },
      )
    } finally {
      await shutdown()
    }
  },
})
