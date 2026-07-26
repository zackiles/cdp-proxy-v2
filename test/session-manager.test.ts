import { assert, assertEquals, assertNotEquals } from '@std/assert'
import { SessionManager } from '../src/session-manager.ts'
import { definePlugin, partition } from '../src/plugin.ts'

const plugin = definePlugin({ kind: 'protocol', name: 'p', setup: () => ({}) })
const none = () => partition([])

Deno.test('register issues a unique token carrying the plugin set', () => {
  const sessions = new SessionManager({ defaultIsolation: 'context' })
  const configured = plugin()

  const a = sessions.register(partition([configured]))
  const b = sessions.register(none())
  assertNotEquals(a, b)

  const record = sessions.resolve(a)
  assertEquals(record?.plugins.protocol, [configured])
  assertEquals(record?.isolation, 'context')
  assertEquals(record?.connections, 0)
})

Deno.test('register honours the default and explicit isolation mode', () => {
  const sessions = new SessionManager({ defaultIsolation: 'browser' })
  assertEquals(
    sessions.resolve(sessions.register(none()))?.isolation,
    'browser',
  )
  assertEquals(
    sessions.resolve(sessions.register(none(), 'context'))?.isolation,
    'context',
  )
})

Deno.test('resolve rejects absent and unknown tokens', () => {
  const sessions = new SessionManager({ defaultIsolation: 'context' })
  assertEquals(sessions.resolve(null), undefined)
  assertEquals(sessions.resolve(undefined), undefined)
  assertEquals(sessions.resolve('not-a-token'), undefined)
})

Deno.test('a session survives until its last connection is released', () => {
  const sessions = new SessionManager({ defaultIsolation: 'context' })
  const token = sessions.register(none())

  assert(sessions.acquire(token))
  assert(sessions.acquire(token))
  assertEquals(sessions.resolve(token)?.connections, 2)

  sessions.release(token)
  assertEquals(sessions.resolve(token)?.connections, 1)

  sessions.release(token)
  assertEquals(sessions.resolve(token), undefined, 'reaped after last release')
  assertEquals(sessions.active, 0)
})

Deno.test('acquire refuses connections beyond the concurrency ceiling', () => {
  const sessions = new SessionManager({
    defaultIsolation: 'context',
    maxConcurrent: 2,
  })
  const token = sessions.register(none())

  assert(sessions.acquire(token))
  assert(sessions.acquire(token))
  assert(sessions.atCapacity)
  assertEquals(sessions.acquire(token), false, 'third connection rejected')
  assertEquals(sessions.active, 2, 'a rejected acquire must not consume a slot')

  sessions.release(token)
  assert(!sessions.atCapacity)
  assert(sessions.acquire(token))
})

Deno.test('acquire on an unknown token consumes no slot', () => {
  const sessions = new SessionManager({ defaultIsolation: 'context' })
  assertEquals(sessions.acquire('not-a-token'), false)
  assertEquals(sessions.active, 0)
})

Deno.test('release is inert for unknown tokens', () => {
  const sessions = new SessionManager({ defaultIsolation: 'context' })
  const token = sessions.register(none())
  assert(sessions.acquire(token))

  sessions.release('not-a-token')
  assertEquals(sessions.active, 1, 'a stray release must not free a real slot')
  assertEquals(sessions.resolve(token)?.connections, 1)
})

Deno.test('a token that is never connected expires instead of leaking', async () => {
  const sessions = new SessionManager({
    defaultIsolation: 'context',
    tokenTtlMs: 20,
  })
  const token = sessions.register(none())

  assert(sessions.resolve(token), 'usable immediately')
  await new Promise((r) => setTimeout(r, 40))
  assertEquals(sessions.resolve(token), undefined, 'expired token is unusable')
  assertEquals(sessions.acquire(token), false)
})

Deno.test('a session going away hands back what was reserved for it', async () => {
  // Registering can start a browser process, before the client's first message
  // and deliberately (§3.3). A record dropped without saying so leaves that
  // process running for the life of the proxy.
  const released: string[] = []
  const sessions = new SessionManager({
    defaultIsolation: 'browser',
    tokenTtlMs: 20,
    onRelease: (token) => released.push(token),
  })

  const connected = sessions.register(none())
  assert(sessions.acquire(connected))
  sessions.release(connected)
  assertEquals(released, [connected])

  const abandoned = sessions.register(none())
  await new Promise((r) => setTimeout(r, 40))
  assertEquals(sessions.resolve(abandoned), undefined)
  assertEquals(released, [connected, abandoned])
})

Deno.test('an established connection keeps a session past the token ttl', async () => {
  const sessions = new SessionManager({
    defaultIsolation: 'context',
    tokenTtlMs: 20,
  })
  const token = sessions.register(none())
  assert(sessions.acquire(token))

  await new Promise((r) => setTimeout(r, 40))
  assert(sessions.resolve(token), 'connected sessions do not expire')

  sessions.release(token)
  assertEquals(sessions.resolve(token), undefined)
})
