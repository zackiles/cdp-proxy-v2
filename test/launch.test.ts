/**
 * Covers the `launch` kind (§3): the contribution merge, the reserved and warn
 * lists, and whether a pool slot can honestly answer a session's constraint.
 *
 * The merge tests are the ones with teeth. Flags are a flat namespace with no
 * notion of who set what, so two plugins passing `--lang` produce a command line
 * with both on it and Chrome takes the last, silently. Every test here is about
 * making that silence into a reported decision.
 */

import { assert, assertEquals, assertRejects } from '@std/assert'
import { definePlugin } from '../src/plugin.ts'
import { flagName, pair, resolve } from '../src/launch.ts'
import { machine } from '../src/core/generate.ts'
import { random, satisfies, seal } from '../src/profile.ts'
import { flags as coreFlags } from '../src/core/flags.ts'
import { clock } from '../plugins/launch/clock.ts'
import { proxy } from '../plugins/launch/proxy.ts'
import { extension } from '../plugins/launch/extension.ts'
import { Debug } from '../src/debug.ts'
import type { ConfiguredPlugin, LaunchHooks, Profile } from '../src/types.ts'

const row = (seed = 'launch') => machine({}, random(seed), seed)
const profile = (seed?: string): Profile => seal(row(seed))

const plugin = (
  name: string,
  hooks: LaunchHooks | ((profile: Profile) => LaunchHooks),
  priority = 0,
): ConfiguredPlugin =>
  definePlugin({
    kind: 'launch',
    name,
    priority,
    setup: (_options, ctx) =>
      typeof hooks === 'function' ? hooks(ctx.profile) : hooks,
  })()

function context(sealed: Profile) {
  return () => ({
    profile: sealed,
    platform: 'darwin' as const,
    signal: new AbortController().signal,
    log: () => {},
  })
}

const merge = (
  plugins: ConfiguredPlugin[],
  sealed = profile(),
  debug?: Debug,
) => resolve(plugins, context(sealed), debug)

// ─── the merge ────────────────────────────────────────────────────────────────

Deno.test('a flag is merged by name, so a value change is a conflict', async () => {
  const debug = Debug.using('1')
  const { spec } = await merge(
    [
      plugin('first', { flags: ['--lang=en-US', '--mute-audio'] }),
      plugin('second', { flags: ['--lang=de-DE'] }, -1),
    ],
    profile(),
    debug,
  )

  assertEquals(spec.flags.filter((f) => f.startsWith('--lang')).length, 1)
  assert(spec.flags.includes('--lang=de-DE'))
  assert(spec.flags.includes('--mute-audio'))
  assert(
    spec.conflicts.some((c) =>
      c.includes('--lang') && c.includes('first') && c.includes('second')
    ),
    `expected the conflict to name both sides, got ${
      spec.conflicts.join('; ')
    }`,
  )
})

Deno.test('the last plugin wins by order, not by position in the array', async () => {
  const { spec } = await merge([
    plugin('low', { flags: ['--lang=de-DE'] }, -10),
    plugin('high', { flags: ['--lang=en-US'] }, 10),
  ])
  // `order` puts the higher priority first, so the lower one is the last word.
  assert(spec.flags.includes('--lang=de-DE'))
})

Deno.test('two plugins passing the identical flag is agreement, not conflict', async () => {
  const { spec } = await merge([
    plugin('a', { flags: ['--mute-audio'] }),
    plugin('b', { flags: ['--mute-audio'] }),
  ])
  assertEquals(spec.flags, ['--mute-audio'])
  assertEquals(spec.conflicts, [])
})

Deno.test('extensions concatenate into the one flag Chrome accepts', async () => {
  const { spec } = await merge([
    plugin('a', { extensions: ['/tmp/one'] }),
    plugin('b', { extensions: ['/tmp/two'] }),
  ])
  // Two `--load-extension` flags means the second silently replaces the first.
  assertEquals(spec.flags, ['--load-extension=/tmp/one,/tmp/two'])
})

Deno.test('env merges by key and reports the override', async () => {
  const { spec } = await merge([
    plugin('a', { env: { TZ: 'UTC' } }),
    plugin('b', { env: { TZ: 'Europe/Berlin' } }, -1),
  ])
  assertEquals(spec.env.TZ, 'Europe/Berlin')
  assert(spec.conflicts.some((c) => c.includes('TZ')))
})

Deno.test('a data dir remembers the machine it was created under', async () => {
  // Across restarts, which is the case the pool cannot answer: the marker is a
  // file in the directory, so it outlives every process that opens it (§2.7).
  const dir = await Deno.makeTempDir()
  await pair(dir, 'first')
  await pair(dir, 'first')
  assertEquals((await Deno.readTextFile(`${dir}/.cdp-profile`)).trim(), 'first')

  const err = await assertRejects(() => pair(dir, 'second'), Error)
  assert(err.message.includes('first'), err.message)
  assert(err.message.includes('second'), err.message)
})

Deno.test('two plugins claiming a userDataDir is an error, not last-wins', async () => {
  // A data dir is a persona's storage; running one plugin's persona out of
  // another's cookies is not a resolvable conflict (§2.7).
  await assertRejects(
    () =>
      merge([
        plugin('a', { userDataDir: '/tmp/a' }),
        plugin('b', { userDataDir: '/tmp/b' }),
      ]),
    Error,
    'userDataDir',
  )
})

// ─── reserved and warned ──────────────────────────────────────────────────────

Deno.test('a reserved flag is refused at registration, not at launch', async () => {
  for (
    const flag of [
      '--remote-debugging-port=1',
      '--user-data-dir=/tmp/x',
      '--headless',
    ]
  ) {
    await assertRejects(
      () => merge([plugin('greedy', { flags: [flag] })]),
      Error,
      flagName(flag),
    )
  }
})

Deno.test('the warn list is allowed and loud', async () => {
  const { spec } = await merge([
    plugin('careless', { flags: ['--enable-automation', '--disable-gpu'] }),
  ])
  assert(spec.flags.includes('--enable-automation'))
  assertEquals(spec.conflicts.length, 2)
  assert(spec.conflicts.some((c) => c.includes('navigator.webdriver')))
  assert(spec.conflicts.some((c) => c.includes('WebGL')))
})

Deno.test('a launch plugin that cannot set up fails the session', async () => {
  // Unlike a surface, the process would start without the flag the session was
  // configured around and every later phase would believe it was there.
  await assertRejects(
    () =>
      merge([
        definePlugin({
          kind: 'launch',
          name: 'broken',
          setup: () => {
            throw new Error('no proxy configured')
          },
        })(),
      ]),
    Error,
    'no proxy configured',
  )
})

// ─── core flags ───────────────────────────────────────────────────────────────

Deno.test('core flags carries the two rungs no page patch can reach', async () => {
  const sealed = profile('core')
  const { spec } = await merge([coreFlags()], sealed)
  assert(spec.flags.includes(`--lang=${sealed.locale}`))
  assert(
    spec.flags.includes(
      `--window-size=${sealed.viewport.width},${
        sealed.viewport.height + sealed.chromeHeight
      }`,
    ),
  )
  // Decision 6: the whole User-Agent stays in `surface/platform/navigator.ts`.
  assert(!spec.flags.some((f) => f.startsWith('--user-agent')))
})

Deno.test('an authored plugin overrides a baseline flag by the ordinary rule', async () => {
  const sealed = profile('override')
  const { spec } = await merge([
    coreFlags(),
    plugin('picky', { flags: ['--lang=ja-JP'] }),
  ], sealed)
  assert(spec.flags.includes('--lang=ja-JP'))
  assertEquals(spec.flags.filter((f) => f.startsWith('--lang')).length, 1)
})

// ─── the authored three ───────────────────────────────────────────────────────

Deno.test('clock puts the process in the timezone the profile claims', async () => {
  const sealed = profile('clock')
  const { spec } = await merge([clock()], sealed)
  assertEquals(spec.env.TZ, sealed.timezone)
})

Deno.test('proxy credentials go to the broker, never onto the command line', async () => {
  const { spec } = await merge([
    proxy({
      url: 'http://bob:hunter2@gw.example:8080',
      bypass: ['*.internal'],
    }),
  ])
  assertEquals(spec.auth, { username: 'bob', password: 'hunter2' })
  assert(spec.flags.includes('--proxy-server=http://gw.example:8080'))
  assert(spec.flags.includes('--proxy-bypass-list=*.internal'))
  assert(
    !spec.flags.some((f) => f.includes('hunter2')),
    'a running process has a world-readable command line',
  )
})

Deno.test('extension checks its own contribution took effect', async () => {
  const warned: string[] = []
  const configured = extension({ path: '/tmp/ext' })
  const resolved = await resolve([configured], () => ({
    profile: profile(),
    platform: 'darwin',
    signal: new AbortController().signal,
    log: (...args: unknown[]) => warned.push(args.map(String).join(' ')),
  }))
  assertEquals(resolved.spec.flags, ['--load-extension=/tmp/ext'])

  await resolved.started({
    pid: 1,
    host: 'localhost',
    port: 9222,
    flags: ['--no-first-run'],
    executablePath: '/chrome',
  })
  assert(warned.some((w) => w.includes('/tmp/ext')))
})

Deno.test('the window the process got beats the window the profile asked for', async () => {
  // Last-wins is right for the flag and wrong for the identity: an authored
  // plugin's `--window-size` takes the command line, and without this every
  // surface goes on claiming a viewport `window.outerWidth` disagrees with.
  const sealed = profile('window')
  const resolved = await merge([
    coreFlags(),
    plugin('kiosk', { flags: ['--window-size=1024,768'] }),
  ], sealed)
  assert(resolved.spec.flags.includes('--window-size=1024,768'))

  const [correction] = await resolved.started({
    pid: 1,
    host: 'localhost',
    port: 9222,
    flags: resolved.spec.flags,
    executablePath: '/chrome',
  })
  assertEquals(correction.by, 'flags')
  assertEquals(correction.fields.viewport, {
    width: 1024,
    height: 768 - sealed.chromeHeight,
  })
})

Deno.test('a process that honoured the flag has nothing to correct', async () => {
  const sealed = profile('honoured')
  const resolved = await merge([coreFlags()], sealed)
  assertEquals(
    await resolved.started({
      pid: 1,
      host: 'localhost',
      port: 9222,
      flags: resolved.spec.flags,
      executablePath: '/chrome',
    }),
    [],
  )
})

// ─── placement ────────────────────────────────────────────────────────────────

Deno.test('a slot answers a constraint its identity satisfies, and no other', () => {
  const drawn = row('slot')
  assert(satisfies(drawn, {}))
  assert(satisfies(drawn, { os: [drawn.os], locale: [drawn.locale] }))
  assert(satisfies(drawn, { minChrome: drawn.chrome }))
  assert(!satisfies(drawn, { minChrome: drawn.chrome + 1 }))
  assert(!satisfies(drawn, { id: 'someone-else' }))
  assert(!satisfies(drawn, { timezone: ['Antarctica/Troll'] }))
})
