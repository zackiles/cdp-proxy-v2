/**
 * @module launch
 * @description Resolves a session's `launch` plugins into the one thing a browser
 * process can be started from (§3.1): a flag list, an environment, a set of
 * extensions, and at most one data dir and one credential pair.
 *
 * The merge exists because flags are a flat namespace with no notion of who set
 * what. Two plugins passing `--lang` produce a command line with both on it, and
 * Chrome takes the last — silently, with nothing to say which plugin lost. Here
 * the last one still wins, by name rather than by position, and the loss is
 * reported (§9.5).
 *
 * Three tiers, which `constants.ts` documented and only ever implemented one of:
 *
 * - **Default** is the core `flags` plugin, pinned first, so an authored plugin
 *   overrides a baseline flag by the same last-wins rule as any other conflict
 *   rather than through a second mechanism.
 * - **Reserved** is what the runtime needs to keep hold of the process. A plugin
 *   returning one throws here, at registration, rather than at launch — the
 *   alternative is a browser that starts and never connects, diagnosed by
 *   reading a command line.
 * - **Warned** is `--enable-automation` and `--disable-gpu`: allowed, because a
 *   plugin may genuinely want them, and logged loudly because each one undoes
 *   something the platform went out of its way to arrange.
 */

import type {
  BrowserInfo,
  ConfiguredPlugin,
  Correction,
  LaunchContext,
  LaunchHooks,
  LaunchSpec,
} from './types.ts'
import { order } from './plugin.ts'
import { Logger } from './logger.ts'
import { asError } from './utils.ts'
import type { Debug } from './debug.ts'

const log = Logger.get('launch')

/**
 * Flags the runtime owns. A plugin cannot have these because losing any of them
 * loses the process: the first two are how the proxy reaches the browser, the
 * third is which profile it runs against, and the fourth is a decision `Config`
 * makes for the whole server.
 */
const RESERVED = [
  '--remote-debugging-port',
  '--remote-debugging-address',
  '--user-data-dir',
  '--headless',
]

/** Allowed, but each one quietly undoes something (§3.1). */
const WARNED: Record<string, string> = {
  '--enable-automation': 'it sets navigator.webdriver and shows the ' +
    'automation infobar, which is what this whole platform exists to avoid',
  '--disable-gpu': 'it leaves the page with no WebGL context at all, and ' +
    'every real Chrome has one — `!!canvas.getContext("webgl")` is a one-line ' +
    'headless test',
}

/** Which OS the proxy itself is on, which is not what the profile claims to be. */
export const PLATFORM: 'darwin' | 'linux' | 'windows' =
  Deno.build.os === 'darwin'
    ? 'darwin'
    : Deno.build.os === 'windows'
    ? 'windows'
    : 'linux'

/** `--lang=en-US` and `--lang` are the same flag; the merge is by name. */
function name(flag: string): string {
  return flag.split('=')[0]
}

/** The merge, plus the plugins that asked to see what it produced (§3.2). */
export interface Resolved {
  spec: LaunchSpec
  /**
   * Announce the process to every plugin that wanted to check its own work, and
   * collect what they found the profile was wrong about (§2.6).
   */
  started(browser: BrowserInfo): Promise<{ by: string; fields: Correction }[]>
  stopped(browser: BrowserInfo): Promise<void>
}

/**
 * Resolve every `launch` plugin and merge what they returned.
 *
 * `context` is a factory so each plugin reads the profile through its own
 * recording view, exactly as the other kinds do (§2.8) — `clock` reading
 * `timezone` should show up against `clock`.
 */
export async function resolve(
  plugins: ConfiguredPlugin[],
  context: (plugin: string) => LaunchContext,
  debug?: Debug,
): Promise<Resolved> {
  const spec: LaunchSpec = {
    flags: [],
    env: {},
    extensions: [],
    conflicts: [],
  }
  /** flag name → who last set it, so a conflict can name both sides. */
  const owners = new Map<string, string>()
  const byName = new Map<string, string>()
  const observers: { name: string; hooks: LaunchHooks }[] = []

  const note = (text: string) => {
    spec.conflicts.push(text)
    debug?.conflict(text)
    log.warn(text)
  }

  for (const plugin of order(plugins)) {
    let hooks: LaunchHooks
    try {
      hooks = await plugin.setup(context(plugin.name))
    } catch (err) {
      // Unlike a surface, a launch plugin that cannot set up is fatal: the
      // process would start without the flag the session was configured around,
      // and every later phase would run believing it was there.
      throw new Error(
        `${plugin.name} could not contribute to the launch: ${
          asError(err).message
        }`,
      )
    }

    if (hooks.onStart || hooks.onStop) {
      observers.push({ name: plugin.name, hooks })
    }

    for (const flag of hooks.flags ?? []) {
      const key = name(flag)
      if (RESERVED.includes(key)) {
        throw new Error(
          `${plugin.name} returned ${key}, which the runtime owns: it is how ` +
            'the proxy keeps hold of the process. Refused at registration ' +
            'rather than at launch, where it would be a browser that starts ' +
            'and never connects',
        )
      }
      if (WARNED[key]) {
        note(`${plugin.name} set ${key}: ${WARNED[key]}`)
      }
      const owner = owners.get(key)
      if (owner && byName.get(key) !== flag) {
        note(
          `${key}: ${plugin.name} set "${flag}", overriding ${owner}'s ` +
            `"${byName.get(key)}"`,
        )
      }
      owners.set(key, plugin.name)
      byName.set(key, flag)
    }

    for (const [key, value] of Object.entries(hooks.env ?? {})) {
      if (key in spec.env && spec.env[key] !== value) {
        note(
          `${key}: ${plugin.name} set "${value}", overriding "${
            spec.env[key]
          }"`,
        )
      }
      spec.env[key] = value
    }

    spec.extensions.push(...hooks.extensions ?? [])

    if (hooks.userDataDir) {
      if (spec.userDataDir && spec.userDataDir !== hooks.userDataDir) {
        // Last-wins is wrong here: a data dir is a persona's storage, and
        // running one plugin's persona out of another's cookies is not a
        // resolvable conflict (§2.7).
        throw new Error(
          `two launch plugins claim a userDataDir: "${spec.userDataDir}" and ` +
            `${plugin.name}'s "${hooks.userDataDir}". Only one session can own ` +
            'a profile directory',
        )
      }
      spec.userDataDir = hooks.userDataDir
    }

    if (hooks.auth) {
      if (spec.auth && spec.auth.username !== hooks.auth.username) {
        throw new Error(
          `two launch plugins claim proxy credentials: "${spec.auth.username}" ` +
            `and ${plugin.name}'s "${hooks.auth.username}"`,
        )
      }
      spec.auth = hooks.auth
    }
  }

  spec.flags = [...byName.values()]
  // Chrome takes one `--load-extension` with a comma-separated list, so two
  // plugins each loading an extension have to become one flag or the second
  // silently replaces the first.
  if (spec.extensions.length > 0) {
    spec.flags.push(`--load-extension=${spec.extensions.join(',')}`)
  }

  debug?.launched(spec)

  // An observer that throws is not fatal the way a contribution is: the process
  // is already up, and a plugin failing to verify its own work should be a
  // warning against a running browser rather than a session that never starts.
  const announce = async (hook: 'onStart' | 'onStop', browser: BrowserInfo) => {
    const corrections: { by: string; fields: Correction }[] = []
    for (const { name: plugin, hooks } of observers) {
      try {
        const found = await hooks[hook]?.(browser)
        if (found) corrections.push({ by: plugin, fields: found })
      } catch (err) {
        log.warn(`${plugin}.${hook} failed`, { error: asError(err) })
      }
    }
    return corrections
  }

  return {
    spec,
    started: (browser) => announce('onStart', browser),
    stopped: async (browser) => void await announce('onStop', browser),
  }
}

/**
 * Bind a data directory to the identity it was created under, and refuse to open
 * it under any other (§2.7).
 *
 * A persona is a profile plus its storage, and reusing a directory under a newly
 * drawn profile is worse than either mistake alone: the site sees returning
 * cookies from a machine that has changed its GPU, which is a stronger signal
 * than either a fresh machine or a fresh session would have been. The marker is
 * a file in the directory rather than a registry somewhere, so it survives the
 * process that wrote it and travels with the thing it describes.
 */
export async function pair(dir: string, id: string): Promise<void> {
  const marker = `${dir}/.cdp-profile`
  let recorded: string | undefined
  try {
    recorded = (await Deno.readTextFile(marker)).trim()
  } catch {
    // No marker: either a fresh directory or one from before this existed.
    // Claiming it is the only option that does not refuse every existing dir.
  }
  if (recorded && recorded !== id) {
    throw new Error(
      `userDataDir "${dir}" holds the storage of profile ${recorded}, and this ` +
        `session is ${id}. Returning cookies from a machine that has changed ` +
        'its GPU is a stronger tell than either a new machine or a new session',
    )
  }
  if (recorded) return
  await Deno.mkdir(dir, { recursive: true })
  await Deno.writeTextFile(marker, id)
}

export { name as flagName, RESERVED, WARNED }
