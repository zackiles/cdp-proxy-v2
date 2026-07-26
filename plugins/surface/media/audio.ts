/**
 * @module plugins/surface/media/audio
 * @description The AudioContext fingerprint.
 *
 * The vector is not a value the page reads; it is a number the page *computes*.
 * A detector renders a fixed oscillator through a `DynamicsCompressorNode` in an
 * `OfflineAudioContext` and hashes the samples, and the result is stable to the
 * last bit for a given build on a given audio stack — so every session this
 * proxy runs hashes identically, and a fleet is one query away from being one
 * machine.
 *
 * The answer is the same as `canvas`'s (§13.2): not a different number, which
 * would be a different constant, but a per-identity perturbation too small to
 * hear and too large to collide. `noise('audio')` seeds it, so a pinned profile
 * hashes the same tomorrow.
 *
 * Two details are what make it survive a second look. The perturbation is
 * applied **once per buffer**, so a page reading the same channel twice gets the
 * same samples — a detector comparing two reads is the cheapest possible check.
 * And it is *multiplicative*, so digital silence stays silent: an offset would
 * put energy into a buffer the page knows is empty.
 */

import { definePlugin } from '../../../src/plugin.ts'
import type { PluginFactory } from '../../../src/types.ts'

export interface AudioOptions {
  [key: string]: unknown
}

interface Config {
  /**
   * Multiplier applied to every sample, within one part in ten thousand of 1.
   *
   * DANGER: this cannot be made much smaller. The samples are `Float32Array`,
   * whose relative epsilon is about 1.2e-7, so a perturbation near that size
   * rounds straight back to the value it started from and the surface silently
   * does nothing. The size chosen here is inaudible — a thousandth of a decibel
   * — and still sits inside the spread real audio stacks show each other.
   */
  factor: number
}

export const audio: PluginFactory<AudioOptions> = definePlugin<
  AudioOptions,
  Config
>({
  kind: 'surface',
  name: 'audio',
  setup(_options, ctx) {
    return {
      // Neither `AudioContext` nor `OfflineAudioContext` is exposed to a worker.
      realms: ['page', 'iframe'],
      config: { factor: 1 + (ctx.profile.noise('audio') - 0.5) * 2e-4 },
      page(config) {
        const perturbed = new WeakSet()

        const buffer = globalThis.AudioBuffer
        if (buffer) {
          const getChannelData = buffer.prototype.getChannelData
          buffer.prototype.getChannelData = native(
            function (this: AudioBuffer, channel: number) {
              const samples = getChannelData.call(this, channel)
              if (!perturbed.has(samples)) {
                perturbed.add(samples)
                for (let i = 0; i < samples.length; i++) {
                  samples[i] *= config.factor
                }
              }
              return samples
            },
            'getChannelData',
          )

          // `copyFromChannel` reads the same samples by another door, so it is
          // routed through the patched getter rather than perturbed again —
          // perturbing twice would make the two doors disagree.
          buffer.prototype.copyFromChannel = native(
            function (
              this: AudioBuffer,
              destination: Float32Array,
              channel: number,
              offset = 0,
            ) {
              destination.set(
                this.getChannelData(channel).subarray(
                  offset,
                  offset + destination.length,
                ),
              )
            },
            'copyFromChannel',
          )
        }

        const analyser = globalThis.AnalyserNode
        if (analyser) {
          const getFloatFrequencyData = analyser.prototype.getFloatFrequencyData
          analyser.prototype.getFloatFrequencyData = native(
            function (this: AnalyserNode, array: Float32Array<ArrayBuffer>) {
              getFloatFrequencyData.call(this, array)
              // Decibels, so the multiplier goes on the linear amplitude the
              // value stands for rather than on the logarithm of it.
              const shift = 20 * Math.log10(config.factor)
              for (let i = 0; i < array.length; i++) array[i] += shift
            },
            'getFloatFrequencyData',
          )
        }
      },
    }
  },
})

export default audio
