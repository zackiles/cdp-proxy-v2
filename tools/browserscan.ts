/**
 * @module tools/browserscan
 * @description Grade stealth against BrowserScan and APIVoid, and write one
 * JSON report covering every check each site surfaces.
 *
 * ```sh
 * deno task browserscan
 * deno task browserscan --out report.json
 * ```
 *
 * BrowserScan has no JSON API — verdicts are scraped from visible text the same
 * way `test/smoke.test.ts` does. APIVoid already renders a full JSON document
 * under its "JSON Output" tab; this tool reads that document directly.
 *
 * @see https://www.browserscan.net/bot-detection
 * @see https://www.apivoid.com/tools/bot-detection-test/
 */

import { parseArgs } from '@std/cli/parse-args'
import type { Browser, Page } from 'playwright'
import { chromium, rpc, shutdown } from '../src/sdk.ts'
import { stealth } from '../plugins/stealth.ts'
import type { Profile } from '../src/types.ts'

const BROWSERSCAN = 'https://www.browserscan.net/bot-detection'
const APIVOID = 'https://www.apivoid.com/tools/bot-detection-test/'

/** Named checks BrowserScan lists on the bot-detection page. */
const BROWSERSCAN_CHECKS = [
  'WebDriver',
  'WebDriver Advance',
  'Selenium',
  'NightmareJS',
  'PhantomJS',
  'Awesomium',
  'Cef',
  'CefSharp',
  'Coaches',
  'FMiner',
  'Born',
  'Phantomas',
  'Rhino',
  'Webdriverio',
  'Headless Chrome',
  'CDP',
  'Dev Tool',
] as const

interface Check {
  name: string
  status: string
  passed: boolean
  points?: number
  severity?: string
  detail?: string
  value?: unknown
}

interface DetectorReport {
  url: string
  passed: boolean
  checks: Check[]
  summary: { total: number; passed: number; failed: number }
}

interface BrowserScanReport extends DetectorReport {
  verdict: string
  userAgent: string
}

interface ApiVoidReport extends DetectorReport {
  riskScore: number
  tampering: { detected: boolean; reasons: string[] }
  fingerprint: { browserId: string }
  /** Full client-side JSON the page publishes under "JSON Output". */
  raw: ApiVoidRaw
}

interface ApiVoidRaw {
  risk: {
    score: number
    reasons: {
      id: string
      name: string
      points: number
      severity: string
    }[]
  }
  tampering: { detected: boolean; reasons: string[] }
  fingerprint: { browserId: string }
  sections: Record<string, unknown>
}

interface Report {
  scannedAt: string
  passed: boolean
  /**
   * The machine the session claimed. A verdict is only re-openable alongside it:
   * the interesting run is the one whose claimed OS is not the host's, because
   * that is where a leak of the real machine shows up as a contradiction.
   */
  profile: {
    id: string
    os: string
    osVersion: string
    chrome: number
    userAgent: string
  } | null
  browserscan: BrowserScanReport
  apivoid: ApiVoidReport
  summary: {
    detectors: number
    passed: number
    failed: number
    checks: { total: number; passed: number; failed: number }
  }
}

function tally(checks: Check[]) {
  const failed = checks.filter((c) => !c.passed).length
  return {
    total: checks.length,
    passed: checks.length - failed,
    failed,
  }
}

async function browserscan(page: Page): Promise<BrowserScanReport> {
  await page.goto(BROWSERSCAN, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })

  // Tabs reuse names like "CDP", so only a line whose *next* line is a
  // verdict word counts as a check — never a bare `indexOf`.
  const scraped = await page.waitForFunction(
    (names: string[]) => {
      const lines = (document.body.innerText || '').split('\n')
        .map((line) => line.trim())
      const verdictOf = (label: string) => {
        for (let i = 0; i < lines.length - 1; i++) {
          if (
            lines[i] === label &&
            /^(normal|robot|suspect\w*)$/i.test(lines[i + 1] ?? '')
          ) {
            return lines[i + 1]!
          }
        }
        return ''
      }
      const verdict = verdictOf('Test Results:')
      if (!verdict) return null
      const checks = names.map((name) => ({
        name,
        status: verdictOf(name),
      }))
      if (checks.some((c) => !c.status)) return null
      return { verdict, ua: navigator.userAgent, checks }
    },
    [...BROWSERSCAN_CHECKS],
    { timeout: 45_000 },
  )

  const { verdict, ua, checks } = await scraped.jsonValue() as {
    verdict: string
    ua: string
    checks: { name: string; status: string }[]
  }

  const graded: Check[] = checks.map((check) => ({
    name: check.name,
    status: check.status || 'missing',
    passed: /^normal$/i.test(check.status),
  }))
  const summary = tally(graded)

  return {
    url: BROWSERSCAN,
    verdict,
    userAgent: ua,
    passed: /^normal$/i.test(verdict) && summary.failed === 0,
    checks: graded,
    summary,
  }
}

/** Turn APIVoid's published JSON into a flat pass/fail check list. */
function apivoidChecks(raw: ApiVoidRaw): Check[] {
  const checks: Check[] = []
  const sections = raw.sections as {
    navigator?: { webdriver?: boolean }
    browserKernel?: { engineMismatch?: boolean }
    webrtc?: { possibleProxy?: boolean; multiplePublicIPs?: boolean }
    extraSignals?: {
      developerTools?: boolean
      automationProps?: unknown[]
    }
  }

  checks.push({
    name: 'riskScore',
    status: raw.risk.score === 0 ? 'pass' : 'fail',
    passed: raw.risk.score === 0,
    points: raw.risk.score,
    detail: `score ${raw.risk.score} (0 = likely human, 100 = likely bot)`,
  })

  checks.push({
    name: 'tampering',
    status: raw.tampering.detected ? 'fail' : 'pass',
    passed: !raw.tampering.detected,
    detail: raw.tampering.reasons.join('; ') || undefined,
  })

  for (const reason of raw.risk.reasons) {
    checks.push({
      name: reason.id,
      status: 'fail',
      passed: false,
      points: reason.points,
      severity: reason.severity,
      detail: reason.name,
    })
  }

  const signal = (
    name: string,
    bad: boolean,
    value: unknown,
    detail?: string,
  ) => {
    checks.push({
      name,
      status: bad ? 'fail' : 'pass',
      passed: !bad,
      value,
      detail,
    })
  }

  signal(
    'webdriver',
    sections.navigator?.webdriver === true,
    sections.navigator?.webdriver ?? null,
  )
  signal(
    'engineMismatch',
    sections.browserKernel?.engineMismatch === true,
    sections.browserKernel?.engineMismatch ?? null,
  )
  signal(
    'developerTools',
    sections.extraSignals?.developerTools === true,
    sections.extraSignals?.developerTools ?? null,
  )
  signal(
    'automationProps',
    (sections.extraSignals?.automationProps?.length ?? 0) > 0,
    sections.extraSignals?.automationProps ?? [],
  )
  signal(
    'possibleProxy',
    sections.webrtc?.possibleProxy === true,
    sections.webrtc?.possibleProxy ?? null,
  )
  signal(
    'multiplePublicIPs',
    sections.webrtc?.multiplePublicIPs === true,
    sections.webrtc?.multiplePublicIPs ?? null,
  )

  return checks
}

async function apivoid(page: Page): Promise<ApiVoidReport> {
  await page.goto(APIVOID, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  })

  // APIVoid's CSP forbids `unsafe-eval`, so Playwright's waitForFunction cannot
  // run here. Poll with CDP evaluate instead, which is not subject to that.
  const deadline = Date.now() + 60_000
  let raw: ApiVoidRaw | null = null
  while (Date.now() < deadline) {
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('a, button, li, span, div')]
        .find((n) => /^JSON Output$/i.test((n.textContent || '').trim())) as
          | HTMLElement
          | undefined
      el?.click()
    }).catch(() => {})

    raw = await page.evaluate(() => {
      const blocks = [...document.querySelectorAll('pre, code')]
        .map((el) => (el.textContent || '').trim())
        .filter((t) => t.startsWith('{') && t.includes('"risk"'))
        .sort((a, b) => b.length - a.length)
      for (const text of blocks) {
        try {
          const parsed = JSON.parse(text)
          if (
            parsed?.risk && typeof parsed.risk.score === 'number' &&
            parsed.sections
          ) {
            return parsed
          }
        } catch {
          // keep looking
        }
      }
      return null
    })
    if (raw) break
    await new Promise((r) => setTimeout(r, 500))
  }

  if (!raw) {
    throw new Error(`APIVoid JSON Output never appeared within 60s at ${APIVOID}`)
  }

  const checks = apivoidChecks(raw)
  const summary = tally(checks)

  return {
    url: APIVOID,
    riskScore: raw.risk.score,
    passed: raw.risk.score === 0 && !raw.tampering.detected &&
      summary.failed === 0,
    checks,
    summary,
    tampering: raw.tampering,
    fingerprint: raw.fingerprint,
    raw,
  }
}

async function grade(browser: Browser): Promise<Report> {
  const page = await browser.newPage()
  try {
    const drawn = (await rpc(await browser.newBrowserCDPSession()).profile())
      .profile as Omit<Profile, 'noise'> | null

    const browserscanReport = await browserscan(page)
    const apivoidReport = await apivoid(page)
    const detectors = [browserscanReport, apivoidReport]
    const failedDetectors = detectors.filter((d) => !d.passed).length
    const checkTotal = detectors.reduce((n, d) => n + d.summary.total, 0)
    const checkFailed = detectors.reduce((n, d) => n + d.summary.failed, 0)

    return {
      scannedAt: new Date().toISOString(),
      passed: failedDetectors === 0,
      profile: drawn
        ? {
          id: drawn.id,
          os: drawn.os,
          osVersion: drawn.osVersion,
          chrome: drawn.chrome,
          userAgent: drawn.userAgent,
        }
        : null,
      browserscan: browserscanReport,
      apivoid: apivoidReport,
      summary: {
        detectors: detectors.length,
        passed: detectors.length - failedDetectors,
        failed: failedDetectors,
        checks: {
          total: checkTotal,
          passed: checkTotal - checkFailed,
          failed: checkFailed,
        },
      },
    }
  } finally {
    await page.close().catch(() => {})
  }
}

async function main(): Promise<number> {
  const args = parseArgs(Deno.args, {
    string: ['out', 'os', 'id'],
    default: { out: 'report.json' },
  })

  const browser = await chromium.launch({
    plugins: [stealth()],
    isolation: 'browser',
    // `--os Windows` on a Mac is the run worth grading: every leak of the real
    // machine reads as a contradiction rather than as a coincidence.
    profile: {
      ...(args.os ? { os: [args.os as Profile['os']] } : {}),
      ...(args.id ? { id: args.id } : {}),
    },
  })

  try {
    const report = await grade(browser)
    await Deno.writeTextFile(args.out, `${JSON.stringify(report, null, 2)}\n`)

    console.log(
      `wrote ${args.out}: ` +
        `profile=${report.profile?.os ?? '?'} ${report.profile?.id ?? ''} ` +
        `browserscan=${report.browserscan.verdict} ` +
        `(${report.browserscan.summary.passed}/` +
        `${report.browserscan.summary.total}) ` +
        `apivoid=score ${report.apivoid.riskScore} ` +
        `(${report.apivoid.summary.passed}/${report.apivoid.summary.total})`,
    )

    for (
      const [label, detector] of [
        ['browserscan', report.browserscan],
        ['apivoid', report.apivoid],
      ] as const
    ) {
      for (const check of detector.checks.filter((c) => !c.passed)) {
        const extra = check.detail ? ` — ${check.detail}` : ''
        console.log(`  FAIL  ${label}/${check.name}: ${check.status}${extra}`)
      }
    }

    return report.passed ? 0 : 1
  } finally {
    await browser.close().catch(() => {})
    await shutdown()
  }
}

if (import.meta.main) Deno.exit(await main())
