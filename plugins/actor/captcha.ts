/**
 * @module plugins/actor/captcha
 * @description Detect a reCAPTCHA or hCaptcha challenge and hand it to a solver
 * (§6).
 *
 * This is the plugin the `actor` kind exists for. Solving takes an HTTP round
 * trip to a third party that routinely takes ten to sixty seconds, and every
 * `protocol` hook runs *inside* the message path — so writing this as a
 * `protocol` plugin would stall the session's entire CDP stream for a minute
 * while it waited. An actor's callbacks are scheduled on their own task per
 * page, so it can await freely and the page's traffic keeps flowing (§6.1).
 *
 * ## What ships and what does not
 *
 * The detection, the token injection, and the callback dispatch ship. The solver
 * does not: solving is a paid third-party service, the vendors' APIs differ, and
 * baking one in would make the plugin a client for a company rather than a
 * platform capability. `solve` is a function you pass.
 *
 * ```ts
 * captcha({
 *   solve: async ({ kind, sitekey, url }) => {
 *     const created = await fetch('https://api.example/createTask', { … })
 *     return await poll(created.taskId)
 *   },
 * })
 * ```
 *
 * IMPORTANT: the token is delivered by calling the page's own callback, not by
 * filling the textarea and submitting. reCAPTCHA's `data-callback` is what the
 * site registered to run when a human passed, so calling it is the difference
 * between a form that submits and a form whose token is present but which never
 * learned it arrived.
 */

import { definePlugin } from '../../src/plugin.ts'
import type { PluginFactory } from '../../src/types.ts'

export interface Challenge {
  kind: 'recaptcha' | 'hcaptcha'
  /** The site key the challenge was rendered with. */
  sitekey: string
  /** The page the challenge is on, which most solvers require. */
  url: string
}

export interface CaptchaOptions {
  /** Exchange a challenge for a token. Throw or return nothing to give up. */
  solve?: (challenge: Challenge) => Promise<string | undefined>
  /** How long to wait for a challenge to render after each document. */
  timeout?: number
  [key: string]: unknown
}

const FRAMES =
  'iframe[src*="recaptcha/api2"], iframe[src*="recaptcha/enterprise"], ' +
  'iframe[src*="hcaptcha.com"]'

export const captcha: PluginFactory<CaptchaOptions> = definePlugin<
  CaptchaOptions
>({
  kind: 'actor',
  name: 'captcha',
  urls: ['http://*', 'https://*'],
  defaults: { timeout: 8_000 },
  setup(options, page) {
    if (!options.solve) {
      // Refusing at setup rather than at the first challenge: a captcha plugin
      // that silently does nothing until a site happens to challenge you is a
      // configuration error you find in production.
      throw new Error(
        'captcha needs a `solve` function. Solving is a paid third-party ' +
          'service with no common API, so the platform detects and delivers ' +
          'and you supply the exchange',
      )
    }

    page.on('document', async () => {
      if (!await page.wait(FRAMES, options.timeout)) return

      const found = await page.eval(() => {
        const el = document.querySelector(
          '.g-recaptcha[data-sitekey], .h-captcha[data-sitekey], ' +
            '[data-sitekey]',
        )
        const sitekey = el?.getAttribute('data-sitekey')
        if (!sitekey) return null
        const hcaptcha = el!.classList.contains('h-captcha') ||
          document.querySelector('iframe[src*="hcaptcha.com"]') !== null
        return { sitekey, kind: hcaptcha ? 'hcaptcha' : 'recaptcha' }
      })
      if (!found) {
        page.log('a challenge frame is present but carries no data-sitekey')
        return
      }

      page.log(`${found.kind} challenge detected, solving`)
      let token: string | undefined
      try {
        token = await options.solve!({
          kind: found.kind as Challenge['kind'],
          sitekey: found.sitekey,
          url: page.url,
        })
      } catch (err) {
        if (page.signal.aborted) return
        page.log(`the solver failed: ${(err as Error).message}`)
        return
      }
      if (!token) return

      // The page may have navigated while the solver was working — an actor's
      // callbacks run off the queue, which is what makes the wait affordable and
      // also what makes "the page has moved on" the normal case (§6.4).
      if (page.signal.aborted) return

      const delivered = await page.eval((value: string) => {
        for (const id of ['g-recaptcha-response', 'h-captcha-response']) {
          const field = document.getElementById(id) as
            | HTMLTextAreaElement
            | null
          if (field) field.value = value
        }
        // The site's own callback, which is what it registered to run when a
        // human passed. Filling the field without calling it leaves a form that
        // has the token and does not know it.
        const named = document
          .querySelector('[data-callback]')
          ?.getAttribute('data-callback')
        const fn = named
          ? (globalThis as Record<string, unknown>)[named]
          : undefined
        if (typeof fn === 'function') {
          ;(fn as (t: string) => void)(value)
          return 'callback'
        }
        return document.getElementById('g-recaptcha-response') ||
            document.getElementById('h-captcha-response')
          ? 'field'
          : 'nothing'
      }, token)

      page.log(`token delivered via ${delivered}`)
    })
  },
})

export default captcha
