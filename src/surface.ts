/**
 * @module surface
 * @description Compiles a session's `surface` plugins (§4) into the things the
 * wire can carry: one injected bundle, a list of `Emulation.*` overrides, a
 * merged header set, and the display claim the broker owns.
 *
 * A surface owns exactly one browser-visible API and says what it should report,
 * using values it reads from the profile rather than values of its own. What it
 * cannot do is choose how it gets there — that ordering is the platform's, and it
 * is the rule the whole kind is organized around:
 *
 * > A launch flag beats an `Emulation.*` override, which beats a page patch.
 *
 * Each rung down is more visible to the page than the one above it, so `emulate`
 * runs for every surface that offers it and `page` carries only what `Emulation.*`
 * cannot express (§4.2).
 *
 * ## Serialization, and the rule it costs
 *
 * A page function is a function, not a string: typechecked, formatted, and
 * refactorable, with the editor aware of `WebGLRenderingContext`. It reaches the
 * page through `Function.prototype.toString()` rather than a bundler, because
 * whatever reaches the page runs in the **main world** (§4.5) and a bundler emits
 * its own scaffolding — interop helpers, `__esModule` markers, source-map
 * comments — which would be running there too. Serialization means the payload
 * contains only what an author wrote, and a reviewer can read all of it.
 *
 * > DANGER: a serialized function closes over nothing. Imports, `cfg`, `ctx` and
 * > any outer variable are `undefined` in the page, with no error, because the
 * > reference simply does not resolve there. Everything comes in through the
 * > single `config` argument, which must be JSON-serializable. `deno task lint`
 * > rejects free identifiers in a `page` function; nothing else will catch it.
 *
 * Three helpers are prepended to the bundle once and are available without an
 * import: {@link HELPERS} documents them. That set is the answer to "surfaces
 * need to share code" — shared page-side logic grows the helper set under review
 * rather than arriving through arbitrary imports.
 *
 * Getting what this produces into the realms that need it is `src/realms.ts`.
 */

import type {
  ConfiguredPlugin,
  Display,
  Profile,
  Realm,
  SurfaceContext,
  SurfaceHooks,
} from './types.ts'
import { REALMS } from './types.ts'
import { order } from './plugin.ts'
import { Logger } from './logger.ts'
import { asError } from './utils.ts'
import type { Debug } from './debug.ts'

/**
 * The page-side helper set, prepended once per bundle rather than once per
 * surface.
 *
 * - `native(fn, name)` makes a patched function's `name` and `toString()` match
 *   the built-in it replaced. Without it, one `Function.prototype.toString` call
 *   finds every patch at once, which is cheaper than any check the patches
 *   defend against.
 * - `define(obj, key, value)` installs a value with the descriptor the original
 *   had, on the object that actually declares it. Patching `navigator.userAgent`
 *   directly leaves an own property on an object whose real one lives on
 *   `Navigator.prototype`, and that difference is one line to detect.
 * - `noise(key)` is deterministic per-profile jitter in `[0, 1)`, seeded from the
 *   identity so a canvas hash is stable across reads, reloads and — for a pinned
 *   profile — runs (§2.10).
 *
 * DANGER: `noise` reimplements `profile.noise` in page JavaScript. The two must
 * agree, or a surface's jitter stops matching what the runtime believes it
 * claimed; `test/surface.test.ts` asserts they do, and that test is what keeps
 * the duplication honest.
 */
const HELPERS = (seed: string) =>
  `
const NATIVE = new WeakMap()
const toSource = Function.prototype.toString
const patchedToSource = function () {
  const faked = NATIVE.get(this)
  return faked === undefined ? toSource.call(this) : faked
}
NATIVE.set(patchedToSource, 'function toString() { [native code] }')
Object.defineProperty(patchedToSource, 'name', { value: 'toString', configurable: true })
Function.prototype.toString = patchedToSource

const native = (fn, name) => {
  NATIVE.set(fn, 'function ' + name + '() { [native code] }')
  Object.defineProperty(fn, 'name', { value: name, configurable: true })
  return fn
}

const define = (obj, key, value) => {
  let owner = obj
  while (owner && !Object.getOwnPropertyDescriptor(owner, key)) {
    owner = Object.getPrototypeOf(owner)
  }
  owner = owner || obj
  const was = Object.getOwnPropertyDescriptor(owner, key)
  const get = native(function () { return value }, 'get ' + key)
  Object.defineProperty(owner, key, {
    get,
    set: was && was.set,
    enumerable: was ? was.enumerable : true,
    configurable: was ? was.configurable : true,
  })
}

const SEED = ${JSON.stringify(seed)}
const noise = (key) => {
  const str = SEED + ':' + key
  let h = 1779033703 ^ str.length
  for (let i = 0; i < str.length; i++) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353)
    h = (h << 13) | (h >>> 19)
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507)
  h = Math.imul(h ^ (h >>> 13), 3266489909)
  return ((h ^= h >>> 16) >>> 0) / 4294967296
}
`.trim()

/** A surface as the runtime resolved it, kept together with who wrote it. */
interface Resolved {
  name: string
  hooks: SurfaceHooks<unknown>
}

/** What a session's surfaces come to, once compiled. */
export interface Compiled {
  /**
   * The main-world payload for one realm, or `''` when no surface patches it.
   * Per realm rather than one blob because a surface can decline realms its API
   * is meaningless in — a DOM patch has nothing to do in a worker (§4.4).
   */
  bundle(realm: Realm): string
  /** Surfaces with an `emulate` hook, in resolution order. */
  emulate: Resolved[]
  /** Every surface's headers, merged, later contributions losing to earlier. */
  headers: Record<string, string>
  /** The display claim, if a surface made one, for the broker to own (§7.2). */
  display: Display
  /** Every realm at least one surface claims, for the broker's auto-attach. */
  realms: Realm[]
  /** The surfaces that resolved, in the order they run. */
  names: string[]
}

/**
 * Turn a function back into source that can be evaluated as an expression.
 *
 * `Function.prototype.toString()` returns a method shorthand verbatim —
 * `page(config) { … }` — which is a syntax error on its own. Wrapping it back in
 * an object literal is what makes the RFC's own example, written as a method,
 * work at all.
 */
function callable(fn: (config: never) => void): string {
  const source = fn.toString().trim()
  if (
    /^(async\s+)?function\b/.test(source) || source.startsWith('(') ||
    /^(async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(source)
  ) {
    return `(${source})`
  }
  const method = source.match(/^(?:async\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*\(/)
    ?.[1]
  if (method) return `({${source}}).${method}`
  throw new Error(`cannot serialize the page function: ${source.slice(0, 60)}…`)
}

/**
 * Everything a surface's page function needs, as JSON.
 *
 * The check is worth its cost because `JSON.stringify` drops functions and
 * `undefined` silently, so a config carrying either arrives in the page missing
 * exactly the field the author was relying on — the same silent half-application
 * the free-identifier rule exists to prevent.
 */
function serialize(name: string, config: unknown): string {
  const json = JSON.stringify(config ?? null)
  if (json === undefined) {
    throw new Error(`${name}: config is not JSON-serializable`)
  }
  return json
}

/**
 * Resolve every surface, then compile what they returned.
 *
 * `context` is a factory so each surface reads the profile through its own
 * recording view: coverage attributes a read to `webgl` rather than to the
 * runtime that installed it (§2.8).
 */
export async function compile(
  surfaces: ConfiguredPlugin[],
  context: (surface: string) => SurfaceContext,
  profile: Profile,
  debug?: Debug,
): Promise<Compiled> {
  const resolved: Resolved[] = []
  for (const surface of order(surfaces)) {
    try {
      const hooks: SurfaceHooks<unknown> = await surface.setup(
        context(surface.name),
      )
      resolved.push({ name: surface.name, hooks })
    } catch (err) {
      // A surface that cannot set up installs nothing, which is the same
      // stand-down an absent profile field produces (§2.9) — and far better than
      // a half-applied patch that reports success.
      Logger.get(`plugin:${surface.name}`).error('setup failed', {
        error: asError(err),
      })
      debug?.conflict(`${surface.name} installed nothing: it failed to set up`)
    }
  }

  const parts: { realms: Realm[]; source: string }[] = []
  const headers: Record<string, string> = {}
  const display: Display = {}
  const claimed = new Map<keyof Display, string>()

  for (const { name, hooks } of resolved) {
    if (hooks.page) {
      parts.push({
        realms: hooks.realms ?? [...REALMS],
        // Per-surface isolation: one surface throwing must not stop the ones
        // after it from installing, and there is no channel out of the page to
        // report on, so it fails closed rather than half-way.
        source: `try { ${callable(hooks.page)}(${
          serialize(name, hooks.config)
        }) } catch (e) {}`,
      })
    }
    for (const [header, value] of Object.entries(hooks.headers ?? {})) {
      if (header in headers && headers[header] !== value) {
        // Two surfaces wanting different values for one header is a coherence
        // question the runtime cannot answer, so it picks the earlier one and
        // says so rather than letting the later silently win (§9.5).
        debug?.conflict(
          `${header}: ${name} wanted "${value}", keeping "${headers[header]}"`,
        )
        continue
      }
      headers[header] = value
    }
    for (const [part, value] of Object.entries(hooks.display ?? {})) {
      const key = part as keyof Display
      const held = claimed.get(key)
      if (held) {
        // The same rule the headers take, for the same reason: two surfaces with
        // different ideas about the monitor is a coherence question the runtime
        // cannot answer, so the earlier one keeps it and the later is named.
        debug?.conflict(`display.${part}: ${name} wanted it, ${held} has it`)
        continue
      }
      claimed.set(key, name)
      Object.assign(display, { [key]: value })
    }
  }

  const cache = new Map<Realm, string>()
  return {
    bundle(realm: Realm): string {
      let built = cache.get(realm)
      if (built === undefined) {
        const wanted = parts.filter((p) => p.realms.includes(realm))
        built = wanted.length === 0
          ? ''
          : `(() => {\n${HELPERS(profile.seed)}\n${
            wanted.map((p) => p.source).join('\n')
          }\n})()`
        cache.set(realm, built)
      }
      return built
    },
    emulate: resolved.filter((r) => r.hooks.emulate),
    headers,
    display,
    realms: REALMS.filter((realm) =>
      parts.some((p) => p.realms.includes(realm))
    ),
    names: resolved.map((r) => r.name),
  }
}

export type { Realm }
