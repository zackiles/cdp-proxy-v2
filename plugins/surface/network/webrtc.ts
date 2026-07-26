/**
 * @module plugins/surface/network/webrtc
 * @description The IP address WebRTC hands out behind the proxy's back.
 *
 * The one surface in this tree that carries no profile field, because what it
 * defends is not a claim about a machine — it is the wire (§10.2). Everything
 * else the proxy does goes over HTTP through whatever upstream the `proxy`
 * launch plugin configured. WebRTC does not: ICE talks to a STUN server over
 * UDP, learns the machine's real public address, and puts it in an
 * `srflx` candidate the page can read with six lines of JavaScript. A session
 * can present a flawless Windows identity from a Frankfurt exit node and still
 * hand the page a residential address in Ohio.
 *
 * Chrome already hides the *local* addresses behind mDNS `.local` names, so the
 * host candidates are not the problem and are left alone. What this surface does
 * is drop the candidates that came back from a STUN or TURN server — from the
 * `icecandidate` event, from the SDP the page can read afterwards, and from
 * `addIceCandidate` on the answering side.
 *
 * > IMPORTANT: dropping them costs peer-to-peer connectivity across NAT. A
 * > session that has to complete a real WebRTC call needs `srflx: true`, and
 * > then the address the proxy exists to hide is the page's to read.
 */

import { definePlugin } from '../../../src/plugin.ts'
import type { PluginFactory } from '../../../src/types.ts'

export interface WebrtcOptions {
  /**
   * Let server-reflexive and relay candidates through. Off by default: the
   * whole point is that they carry the address the proxy replaced.
   */
  srflx?: boolean
  [key: string]: unknown
}

export const webrtc: PluginFactory<WebrtcOptions> = definePlugin<WebrtcOptions>(
  {
    kind: 'surface',
    name: 'webrtc',
    defaults: { srflx: false },
    setup(options) {
      if (options.srflx === true) return {}

      return {
        // `RTCPeerConnection` is not exposed to a worker of any kind.
        realms: ['page', 'iframe'],
        page() {
          const peer = globalThis.RTCPeerConnection
          if (!peer) return

          const leaks = (candidate: string) =>
            / typ (srflx|relay|prflx)\b/.test(candidate)

          // An SDP with the candidate lines removed. `a=end-of-candidates` is
          // kept: a description that gathered and then says nothing about having
          // finished reads as a connection still in progress.
          const strip = (sdp: string) =>
            sdp.split(/(?<=\r?\n)/).filter((line) =>
              !(line.startsWith('a=candidate:') && leaks(line))
            ).join('')

          const described = (
            description: RTCSessionDescription | null,
          ): RTCSessionDescription | null => {
            if (!description) return description
            const patched = Object.create(
              globalThis.RTCSessionDescription.prototype,
            )
            Object.defineProperty(patched, 'type', {
              get: native(() => description.type, 'get type'),
              enumerable: true,
              configurable: true,
            })
            Object.defineProperty(patched, 'sdp', {
              get: native(() => strip(description.sdp), 'get sdp'),
              enumerable: true,
              configurable: true,
            })
            patched.toJSON = native(
              () => ({ type: description.type, sdp: strip(description.sdp) }),
              'toJSON',
            )
            return patched
          }

          for (
            const key of [
              'localDescription',
              'currentLocalDescription',
              'pendingLocalDescription',
            ] as const
          ) {
            const was = Object.getOwnPropertyDescriptor(peer.prototype, key)
            if (!was?.get) continue
            const get = was.get
            Object.defineProperty(peer.prototype, key, {
              ...was,
              get: native(
                function (this: RTCPeerConnection) {
                  return described(get.call(this))
                },
                `get ${key}`,
              ),
            })
          }

          // The event carries the address before any description does, and a page
          // listening either way has to see the same set — so both doors are
          // covered, and a leaking candidate is dropped rather than blanked,
          // which is what a browser that gathered nothing looks like.
          const filtered = (listener: EventListenerOrEventListenerObject) =>
            function (this: RTCPeerConnection, event: Event) {
              const candidate = (event as RTCPeerConnectionIceEvent).candidate
              if (candidate && leaks(candidate.candidate)) return
              if (typeof listener === 'function') listener.call(this, event)
              else listener.handleEvent(event)
            }

          const wrapped = new WeakMap()
          const addEventListener = peer.prototype.addEventListener
          peer.prototype.addEventListener = native(
            function (
              this: RTCPeerConnection,
              type: string,
              listener: EventListenerOrEventListenerObject,
              options?: unknown,
            ) {
              if (type !== 'icecandidate' || !listener) {
                return addEventListener.call(
                  this,
                  type,
                  listener as EventListener,
                  options as AddEventListenerOptions,
                )
              }
              let seen = wrapped.get(listener)
              if (!seen) wrapped.set(listener, seen = filtered(listener))
              return addEventListener.call(
                this,
                type,
                seen,
                options as AddEventListenerOptions,
              )
            },
            'addEventListener',
          ) as typeof addEventListener

          const removeEventListener = peer.prototype.removeEventListener
          peer.prototype.removeEventListener = native(
            function (
              this: RTCPeerConnection,
              type: string,
              listener: EventListenerOrEventListenerObject,
              options?: unknown,
            ) {
              const seen = type === 'icecandidate' && listener
                ? wrapped.get(listener)
                : undefined
              return removeEventListener.call(
                this,
                type,
                (seen ?? listener) as EventListener,
                options as EventListenerOptions,
              )
            },
            'removeEventListener',
          ) as typeof removeEventListener

          const onicecandidate = Object.getOwnPropertyDescriptor(
            peer.prototype,
            'onicecandidate',
          )
          if (onicecandidate?.set) {
            const set = onicecandidate.set
            Object.defineProperty(peer.prototype, 'onicecandidate', {
              ...onicecandidate,
              set: native(
                function (this: RTCPeerConnection, listener: EventListener) {
                  set.call(this, listener ? filtered(listener) : listener)
                },
                'set onicecandidate',
              ),
            })
          }
        },
      }
    },
  },
)

export default webrtc
