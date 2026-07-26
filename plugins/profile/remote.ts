/**
 * @module plugins/profile/remote
 * @description Draw from an HTTP service, for fleets that must not hand the same
 * identity to two machines (§2.3).
 *
 * `corpus` solves fidelity and `remote` solves *coordination*. A burn is the
 * reason it exists: `corpus` withdraws a blocked row for the life of one process,
 * which is no use at all when the fleet is thirty processes and the row is still
 * being handed out by the other twenty-nine. Only something outside every process
 * can answer "has this machine been burnt anywhere".
 *
 * ## The contract
 *
 * Two endpoints, and the shapes are deliberately the ones the platform already
 * has so a service can be forty lines:
 *
 * ```
 * POST {url}/draw   { constraint, seed }  → 200 <Draw row> | 204 (nothing fits)
 * POST {url}/burn   { id, reason }        → any 2xx
 * ```
 *
 * A `token` is sent as `Authorization: Bearer …`, and each call is tried twice
 * before the chain degrades: the failure being survived is a connection reset or
 * a rolling restart, and anything longer than that is a coordinator that is
 * really down.
 *
 * `204` rather than an error for "nothing fits" is what lets the chain fall
 * through to `corpus` or `generate` (§2.3). So does an unreachable service: a
 * loader that throws is skipped, so a fleet whose coordinator is down degrades to
 * drawing locally rather than stopping.
 *
 * DANGER: degrading is the right default and it is not free. A fleet that falls
 * back to `generate` has silently stopped coordinating, so two machines can draw
 * the same identity and a burnt row can come back. The chain logs the refusal
 * with the reason for exactly that reason; a deployment that would rather fail
 * than correlate should configure `remote` as the only loader, where a chain
 * with nothing left to try throws.
 */

import { definePlugin } from '../../src/plugin.ts'
import type { Draw, PluginFactory } from '../../src/types.ts'

export interface RemoteOptions {
  /** Base URL of the coordinator, e.g. `http://profiles.internal:8080`. */
  url: string
  /** How long to wait before drawing locally instead. */
  timeout?: number
  /** Sent as `Authorization: Bearer …`; a coordinator on a shared network needs one. */
  token?: string
  [key: string]: unknown
}

/**
 * Attempts per call, including the first. Two rather than one because the thing
 * being survived is a connection reset or a rolling restart, and two rather than
 * five because every attempt is a session waiting to start: a coordinator that
 * is really down should be given up on quickly and degraded from (§2.3).
 */
const ATTEMPTS = 2

export const remote: PluginFactory<RemoteOptions> = definePlugin<RemoteOptions>(
  {
    kind: 'profile',
    // Above `corpus`: a coordinated identity outranks an uncoordinated one, and
    // the whole point is that nothing else gets first refusal.
    priority: 70,
    name: 'remote',
    defaults: { url: '', timeout: 5_000 },
    setup(options, ctx) {
      const once = async (path: string, body: unknown) => {
        const abort = new AbortController()
        const timer = setTimeout(() => abort.abort(), options.timeout)
        // The session's own abort has to reach the fetch too, or a coordinator
        // that never answers keeps the connection alive past teardown.
        ctx.signal.addEventListener('abort', () => abort.abort(), {
          once: true,
        })
        try {
          return await fetch(new URL(path, options.url), {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...options.token
                ? { authorization: `Bearer ${options.token}` }
                : {},
            },
            body: JSON.stringify(body),
            signal: abort.signal,
          })
        } finally {
          clearTimeout(timer)
        }
      }

      const post = async (path: string, body: unknown) => {
        for (let attempt = 1;; attempt++) {
          try {
            const res = await once(path, body)
            // A 5xx is the coordinator having a bad moment; a 4xx is this request
            // being wrong, and sending it again would only be wrong twice.
            if (res.status < 500 || attempt === ATTEMPTS) return res
            // Read to the end rather than cancelled: an abandoned response holds
            // the connection open, and the next attempt is about to want it.
            await res.text().catch(() => {})
          } catch (err) {
            if (attempt === ATTEMPTS || ctx.signal.aborted) throw err
          }
          ctx.log(`${path} failed, trying once more`)
        }
      }

      return {
        async draw(constraint) {
          if (!options.url) return undefined
          const res = await post('/draw', { constraint, seed: ctx.seed })
          // Read to the end even when there is nothing to read: an unconsumed
          // response holds its connection open for as long as the process lives.
          if (res.status === 204) {
            await res.text().catch(() => {})
            return undefined
          }
          if (!res.ok) {
            await res.text().catch(() => {})
            throw new Error(`coordinator answered ${res.status}`)
          }
          const row = await res.json()
          // `source` is stamped by the runtime anyway, but the seed is not: a
          // coordinator handing back the same row twice must hand back the same
          // seed with it, or the two draws have different canvas hashes (§2.10).
          return { ...row, seed: row.seed || `${row.id}:${ctx.seed}` } as Draw
        },

        async burn(id, reason) {
          const res = await post('/burn', { id, reason })
          await res.text().catch(() => {})
          if (!res.ok) {
            ctx.log(`coordinator would not record the burn: ${res.status}`)
          }
        },
      }
    },
  },
)

export default remote
