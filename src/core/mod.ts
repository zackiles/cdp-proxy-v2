/**
 * @module core
 * @description The core tier (§8): plugins the platform owns, always installed,
 * and not something an author writes or edits.
 *
 * The membership test is narrow and deliberately not "is it important":
 *
 * > Core is what the runtime would have to do anyway if plugins did not exist.
 *
 * A session without `webgl` is more detectable, but the runtime would never spoof
 * a GPU on its own — that is a policy choice about what machine to be, which is
 * what an authored plugin is for. Whereas the runtime must launch a process, so it
 * must decide on flags; it must resolve an identity before it can compute those
 * flags; and it exists in the first place because forwarding `Runtime.enable`
 * announces the client.
 *
 * Core is compiled in rather than discovered, so autoload never walks this
 * directory.
 */

import type { ConfiguredPlugin } from '../types.ts'
import { contexts } from './contexts.ts'
import { flags } from './flags.ts'
import { generate } from './generate.ts'

/**
 * Core is presence, not precedence (§8.4). Each member is pinned to whichever end
 * of its kind's order its job requires, and no authored plugin can take that
 * position by choosing a larger number.
 */
function pin(
  plugin: ConfiguredPlugin,
  end: 'first' | 'last',
): ConfiguredPlugin {
  return { ...plugin, pinned: end, optional: false }
}

/**
 * The core set, one plugin per pre-existing platform obligation.
 *
 * | Plugin     | Kind       | Pinned | The obligation it discharges                     |
 * | ---------- | ---------- | ------ | ------------------------------------------------ |
 * | `generate` | `profile`  | last   | Every session has a sealed identity. As the terminal loader it satisfies any constraint, so the chain can never fail to answer. |
 * | `flags`    | `launch`   | first  | The process starts, stays controllable, and does not defeat itself. |
 * | `contexts` | `protocol` | first  | The client is not announced on the wire.         |
 */
export function core(): ConfiguredPlugin[] {
  return [
    // Last: every other loader gets first refusal, and this one answers whatever
    // is left, so the chain cannot fail to produce an identity.
    pin(generate(), 'last'),
    // First: later flags win by name, so being first is what lets an authored
    // launch plugin override a baseline flag.
    pin(flags(), 'first'),
    // First: it must decide about Runtime.enable before anything else sees it.
    pin(contexts(), 'first'),
  ]
}

export { contexts, flags, generate }
