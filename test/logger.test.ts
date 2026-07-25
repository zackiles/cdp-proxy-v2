/**
 * Guards the console sink. An earlier version emitted only through the OTel logs
 * API without registering a provider, so every log line in the project was
 * silently discarded — and no test noticed, because nothing asserted on output.
 */

import { assert, assertEquals, assertStringIncludes } from '@std/assert'
import { Logger } from '../src/logger.ts'

/** Collect everything written to the console while `fn` runs. */
async function captured(fn: () => void | Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const sinks = ['error', 'warn', 'info', 'debug'] as const
  const originals = sinks.map((name) => [name, console[name]] as const)
  for (const name of sinks) {
    console[name] = (...args: unknown[]) =>
      lines.push(args.map(String).join(' '))
  }
  try {
    await fn()
  } finally {
    for (const [name, original] of originals) console[name] = original
  }
  return lines
}

Deno.test('a log line reaches the console with its level and context', async () => {
  const lines = await captured(() => {
    Logger.get('widget', { level: 'debug' }).info('all good', { count: 3 })
  })

  assertEquals(lines.length, 1)
  assertStringIncludes(lines[0], 'INFO')
  assertStringIncludes(lines[0], 'widget')
  assertStringIncludes(lines[0], 'all good')
  assertStringIncludes(lines[0], 'count=3')
})

Deno.test('levels below the configured threshold are dropped', async () => {
  const lines = await captured(() => {
    const log = Logger.get('quiet', { level: 'warn' })
    log.debug('chatter')
    log.info('chatter')
    log.warn('heed me')
    log.error('and me')
  })

  assertEquals(lines.length, 2)
  assertStringIncludes(lines[0], 'heed me')
  assertStringIncludes(lines[1], 'and me')
})

Deno.test('silent emits nothing at all', async () => {
  const lines = await captured(() => {
    Logger.get('mute', { level: 'silent' }).error('boom')
  })
  assertEquals(lines, [])
})

Deno.test('an error is reported with its stack', async () => {
  const lines = await captured(() => {
    Logger.get('failing', { level: 'error' }).error('it broke', {
      error: new Error('root cause'),
    })
  })

  assertEquals(lines.length, 2)
  assertStringIncludes(lines[0], 'it broke')
  assert(lines[1].includes('root cause'), 'the stack should follow the message')
})

Deno.test('logging works with no global Config installed', async () => {
  // Modules build loggers at import time, long before a Config exists.
  const lines = await captured(() => Logger.get('early').info('before config'))
  assertEquals(lines.length, 1)
})
