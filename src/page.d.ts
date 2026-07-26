/**
 * The helpers the runtime prepends to every surface bundle (§4.1). Declared
 * globally rather than exported, because a `page` function is serialized and an
 * import would resolve at author time and be `undefined` in the page — the exact
 * capture `tools/lint.ts` exists to reject.
 *
 * `src/surface.ts` holds the implementations; these are the types for them.
 */

/** Make a patched function's `name` and `toString()` match the built-in. */
declare function native<T extends (...args: never[]) => unknown>(
  fn: T,
  name: string,
): T

/** Install `value` with the descriptor the original had, on its real owner. */
declare function define(obj: object, key: string, value: unknown): void

/** Deterministic per-profile jitter in `[0, 1)` for a stable key (§2.10). */
declare function noise(key: string): number

/**
 * The object real Chrome puts on every page, absent in headless until
 * `surface/platform/chrome` installs it. `var` rather than `let` so it is a
 * property of `globalThis` to the compiler, as it is to the page.
 */
// deno-lint-ignore no-var
declare var chrome: Record<string, unknown> | undefined
