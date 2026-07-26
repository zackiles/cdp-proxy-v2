/**
 * @module plugins/actor/banner
 * @description Dismiss cookie and consent banners (§6).
 *
 * The simplest thing that is genuinely an actor: it watches a page, decides, and
 * clicks. It could not be a `surface` — there is no browser API involved — and
 * writing it as a `protocol` plugin would mean per-connection instantiation and
 * a hand-rolled map from session id to "have I already dismissed this one".
 *
 * ## Why it clicks rather than hides
 *
 * Hiding the banner with CSS is one line and is the wrong line. Consent state
 * lives in a cookie the banner sets when it is dismissed, so a hidden banner
 * comes back on every navigation, and a page that checks whether its own consent
 * element is visible finds a `display: none` nothing put there. Clicking through
 * `Input` leaves the site in the state a user would have left it in.
 *
 * IMPORTANT: this accepts. That is a real choice with real consequences and it
 * is the honest default for automation whose purpose is to see the page a user
 * sees — a rejected banner leaves a site rendering differently from the one
 * anybody is looking at. Pass `accept: false` to take the reject path where the
 * site offers one.
 */

import { definePlugin } from '../../src/plugin.ts'
import type { PluginFactory } from '../../src/types.ts'

export interface BannerOptions {
  /** Take the accept path rather than the reject path. */
  accept?: boolean
  /** Extra selectors, tried before the built-in list. */
  selectors?: string[]
  /** How long to keep looking after each document. */
  timeout?: number
  [key: string]: unknown
}

/**
 * The consent frameworks with enough market share to be worth naming, plus the
 * generic id conventions the rest of the web converged on.
 *
 * Ordered most specific first: a framework's own button is a safer click than
 * anything matched by text, because a text match on "Accept" will eventually
 * find "Accept the terms of sale" on a checkout page.
 */
const ACCEPT = [
  '#onetrust-accept-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyButtonAccept',
  'button[mode="primary"][aria-label*="Accept" i]',
  '.fc-cta-consent',
  '.qc-cmp2-summary-buttons button[mode="primary"]',
  'button.sp_choice_type_11',
  '#didomi-notice-agree-button',
  '.cc-btn.cc-allow',
  '[data-testid="cookie-policy-manage-dialog-accept-button"]',
  '#accept-cookies',
  '#acceptCookies',
  '#cookie-accept',
]

const REJECT = [
  '#onetrust-reject-all-handler',
  '#CybotCookiebotDialogBodyButtonDecline',
  '.qc-cmp2-summary-buttons button[mode="secondary"]',
  'button.sp_choice_type_13',
  '#didomi-notice-disagree-button',
  '.cc-btn.cc-deny',
  '#reject-cookies',
]

export const banner: PluginFactory<BannerOptions> = definePlugin<BannerOptions>(
  {
    kind: 'actor',
    name: 'banner',
    defaults: { accept: true, selectors: [], timeout: 4_000 },
    setup(options, page) {
      const candidates = [
        ...options.selectors ?? [],
        ...(options.accept ? ACCEPT : REJECT),
      ]

      page.on('document', async () => {
        // Waiting on the whole list at once rather than each in turn: banners
        // are injected late by a tag manager, and serial waits would spend the
        // timeout on the first selector the site does not use.
        const selector = candidates.join(', ')
        if (!await page.wait(selector, options.timeout)) return

        try {
          await page.click(selector)
          page.log(`dismissed a consent banner at ${new URL(page.url).host}`)
        } catch (err) {
          // A banner that vanished between the wait and the click is the
          // ordinary case — the site's own script got there first.
          if (page.signal.aborted) return
          page.log(`could not dismiss the banner: ${(err as Error).message}`)
        }
      })
    },
  },
)

export default banner
