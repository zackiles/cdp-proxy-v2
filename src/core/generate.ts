/**
 * @module core/generate
 * @description The terminal profile loader (§2.3). It can satisfy any constraint,
 * which is why it is pinned last in the `profile` order: a loader chain can never
 * fail to answer no matter what an automator passes.
 *
 * Two requirements are routinely confused, and both are required (§2.5).
 *
 * **Coherence** means the fields describe one machine. Sampling each axis
 * independently produces machines that do not exist — `Chrome/147` on `Windows`
 * reporting `ANGLE (Apple, Apple M2, OpenGL 4.1)`. Every table below is therefore
 * sampled **conditionally**: an OS, then an architecture given that OS, then a GPU
 * family given both, then a renderer string given the family, then a font list
 * given the OS.
 *
 * **Rarity** means the machine is not interesting. A perfectly coherent but
 * globally unique configuration has an anonymity set of one and is trackable
 * across sessions with no cookie at all. Draws are therefore weighted by
 * real-world prevalence, never uniformly. A common machine is a better disguise
 * than an interesting one, and the instinct to maximize variety across sessions
 * is wrong past the point where the variety itself becomes the signal.
 *
 * ## Where the weights come from, and how they were adjusted
 *
 * Last checked against published data in **July 2026**, against the figures for
 * June 2026. Each axis below names its source and what was done to it.
 *
 * | Axis                          | Source                                   |
 * | ----------------------------- | ---------------------------------------- |
 * | OS and OS version share       | StatCounter desktop share                |
 * | Screen resolution             | StatCounter desktop screen resolution    |
 * | GPU model, cores, memory      | Steam Hardware Survey                    |
 * | Which Chrome majors are alive | The Chromium release schedule (computed) |
 *
 * > DANGER: Steam's population is gamers. Its GPU shares over-represent discrete
 * > NVIDIA cards by a wide margin against a web population that is mostly
 * > integrated Intel and AMD laptop graphics, and its memory shares over-report
 * > 32 GB. Copying Steam unadjusted yields a fleet where every row is
 * > individually plausible and the fleet as a whole matches no real population —
 * > a rarity failure at the aggregate level, which is the harder one to notice.
 *
 * The adjustments, recorded so the next person can check them:
 *
 * - **OS.** StatCounter June 2026 reads Windows 56.61 / OS X 11.89 / macOS 4.48
 *   / Linux 4.36 / ChromeOS 1.21, with 21.45% unclassified — an artefact
 *   StatCounter later corrected, and one that has to be dropped rather than
 *   distributed. Renormalizing over the classified desktop rows Chrome can
 *   actually be on gives 73 / 21 / 6, which is what this table says.
 * - **Windows version.** 69.92 / 28.1 Win11/Win10 of Windows traffic, and the
 *   value is a UA-CH contract number rather than the marketing one; see
 *   `OS_VERSION`.
 * - **macOS version.** Tahoe (26) ~64%, Sequoia (15) ~20%, Sonoma (14) ~4% of
 *   Macs mid-2026.
 * - **Resolution.** StatCounter's June 2026 desktop rows are 1920×1080 20.2,
 *   1536×864 6.94, 1366×768 5.71 — the same 46 / 16 / 13 shape this table
 *   already had once the bot buckets (800×600, 1280×1200) are dropped. Kept.
 * - **Windows GPU.** Steam is roughly 75% NVIDIA / 15% AMD / 10% Intel. That is
 *   inverted for a web population: this table uses 46% Intel integrated, 32%
 *   NVIDIA, 22% AMD, on the assumption that the median web desktop is a laptop.
 *   Within NVIDIA, June 2026 put the RTX 4060 Laptop GPU (3.81%) ahead of the
 *   desktop RTX 3060 (3.73%) for the first time, and the order here follows.
 * - **Cores.** Steam counts physical cores; `navigator.hardwareConcurrency`
 *   reports logical processors, so Steam's histogram cannot be copied across at
 *   all — its 28% six-core plurality is a 12 on the web. The table is keyed by
 *   platform because Apple silicon has no SMT: a Mac reporting 12 has twelve
 *   cores, and a Windows laptop reporting 12 has six.
 * - **Memory.** Steam June 2026 is 16 GB 41.6 / 32 GB 36.8 / 8 GB 7.8. The 32 GB
 *   share is a gaming artefact; 8 GB is weighted back up for a web population,
 *   with 16 GB as the plurality it has become since this table last read 8.
 *
 * The known ceiling is that hand-written tables encode only the correlations
 * somebody thought to write down. The upgrade is a model trained on captured rows
 * shipped in place of the tables, which is what Phase 5's corpus makes possible.
 */

import { definePlugin } from '../plugin.ts'
import type { Constraint, Draw, PluginFactory, Profile } from '../types.ts'
import { brands, SCHEMA } from '../profile.ts'

/** A weighted row: `[value, share]`. Shares are relative, not required to sum. */
type Weighted<T> = readonly (readonly [T, number])[]

function pick<T>(rows: Weighted<T>, random: () => number): T {
  const total = rows.reduce((sum, [, weight]) => sum + weight, 0)
  let point = random() * total
  for (const [value, weight] of rows) {
    if ((point -= weight) <= 0) return value
  }
  return rows[rows.length - 1][0]
}

// ─── platform ─────────────────────────────────────────────────────────────────

const OS: Weighted<Profile['os']> = [
  ['Windows', 73],
  ['macOS', 21],
  ['Linux', 6],
]

/**
 * What `Sec-CH-UA-Platform-Version` says, which is not what the marketing says.
 *
 * DANGER: on Windows this is the `Windows.Foundation.UniversalApiContract`
 * version, not the release number. Windows 10 is 1–10, Windows 11 is 13 and up
 * (15 for 22H2/23H2, 19 for 24H2 and later), and every version of Windows since
 * 7 reports `Windows NT 10.0` in the User-Agent regardless. A profile claiming
 * `11` here is claiming a number no Chrome has ever sent: sites test
 * `major >= 13` for Windows 11, so `11` reads as a Windows 10 that is also not a
 * value Windows 10 produces. macOS and Android send the real version; Linux
 * sends the empty string, and inventing one there is its own tell.
 */
const OS_VERSION: Record<Profile['os'], Weighted<string>> = {
  Windows: [['19.0.0', 55], ['15.0.0', 16], ['10.0.0', 29]],
  macOS: [['26.5.0', 68], ['15.7.0', 24], ['14.7.0', 8]],
  Linux: [['', 100]],
}

/** Apple has shipped no Intel Mac since 2023, and Windows-on-arm is still rare. */
const ARCH: Record<Profile['os'], Weighted<Profile['arch']>> = {
  Windows: [['x86', 97], ['arm', 3]],
  macOS: [['arm', 76], ['x86', 24]],
  Linux: [['x86', 98], ['arm', 2]],
}

/**
 * Which Chrome majors are plausibly alive today, computed from the release
 * schedule rather than hard-coded: a table of version numbers is stale the month
 * after it is written, and a stale version is a claim a page can check against
 * feature detection.
 *
 * Chrome 138 reached stable on 2025-06-24 and majors ship roughly every four
 * weeks. Reconciliation replaces whatever this returns with the binary's actual
 * version (§2.6), so this only has to be close enough that a session which never
 * reconciled is not obviously wrong.
 */
function majors(now: Date): Weighted<number> {
  const anchor = Date.UTC(2025, 5, 24)
  const weeks = (now.getTime() - anchor) / (7 * 24 * 3600_000)
  const latest = 138 + Math.max(0, Math.floor(weeks / 4))
  return [[latest, 55], [latest - 1, 30], [latest - 2, 15]]
}

function userAgent(os: Profile['os'], major: number): string {
  // Chrome reports a frozen platform string and a reduced version: the minor
  // parts are always `0.0.0`, and macOS is always `10_15_7` on `Intel` even on
  // Apple silicon. Inventing detail here would be inventing a tell.
  const platform = os === 'Windows'
    ? 'Windows NT 10.0; Win64; x64'
    : os === 'macOS'
    ? 'Macintosh; Intel Mac OS X 10_15_7'
    : 'X11; Linux x86_64'
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) ` +
    `Chrome/${major}.0.0.0 Safari/537.36`
}

// ─── graphics ─────────────────────────────────────────────────────────────────

interface Gpu {
  vendor: string
  renderer: string
  angle: string
}

/**
 * ANGLE renderer strings are mechanical once the model is chosen, which is what
 * makes a table of models sufficient: Direct3D11 on Windows, Metal on Apple
 * silicon, OpenGL elsewhere.
 */
const d3d = (vendor: string, model: string): Gpu => ({
  vendor: `Google Inc. (${vendor})`,
  renderer:
    `ANGLE (${vendor}, ${model} Direct3D11 vs_5_0 ps_5_0, D3D11-31.0.15.5222)`,
  angle: 'D3D11',
})

const metal = (model: string): Gpu => ({
  vendor: 'Google Inc. (Apple)',
  renderer:
    `ANGLE (Apple, ANGLE Metal Renderer: Apple ${model}, Unspecified Version)`,
  angle: 'Metal',
})

const gl = (vendor: string, model: string): Gpu => ({
  vendor: `Google Inc. (${vendor})`,
  renderer: `ANGLE (${vendor}, ${model}, OpenGL 4.6)`,
  angle: 'OpenGL',
})

const GPU: Record<string, Weighted<Gpu>> = {
  'Windows/x86': [
    [d3d('Intel', 'Intel(R) Iris(R) Xe Graphics'), 26],
    [d3d('Intel', 'Intel(R) UHD Graphics 630'), 12],
    [d3d('Intel', 'Intel(R) UHD Graphics 620'), 8],
    [d3d('NVIDIA', 'NVIDIA GeForce RTX 4060 Laptop GPU'), 10],
    [d3d('NVIDIA', 'NVIDIA GeForce RTX 3060'), 9],
    [d3d('NVIDIA', 'NVIDIA GeForce GTX 1650'), 7],
    [d3d('NVIDIA', 'NVIDIA GeForce RTX 3070'), 6],
    [d3d('AMD', 'AMD Radeon(TM) Graphics'), 13],
    [d3d('AMD', 'AMD Radeon RX 6600'), 5],
    [d3d('AMD', 'AMD Radeon(TM) Vega 8 Graphics'), 4],
  ],
  'Windows/arm': [
    [d3d('Qualcomm', 'Qualcomm(R) Adreno(TM) X1-85 GPU'), 100],
  ],
  'macOS/arm': [
    [metal('M1'), 26],
    [metal('M2'), 30],
    [metal('M3'), 24],
    [metal('M4'), 20],
  ],
  'macOS/x86': [
    [gl('Intel', 'Intel(R) Iris(TM) Plus Graphics 655'), 45],
    [gl('AMD', 'AMD Radeon Pro 5500M OpenGL Engine'), 30],
    [gl('Intel', 'Intel(R) UHD Graphics 630'), 25],
  ],
  'Linux/x86': [
    [gl('Intel', 'Mesa Intel(R) UHD Graphics (CML GT2)'), 40],
    [gl('Intel', 'Mesa Intel(R) Iris(R) Xe Graphics (TGL GT2)'), 25],
    [gl('AMD', 'AMD Radeon Graphics (radeonsi, renoir, LLVM 17.0.6)'), 22],
    [gl('NVIDIA', 'NVIDIA GeForce RTX 3060/PCIe/SSE2'), 13],
  ],
  'Linux/arm': [
    [gl('ARM', 'Mali-G610'), 100],
  ],
}

// ─── display ──────────────────────────────────────────────────────────────────

interface Display {
  width: number
  height: number
  scale: number
}

const DISPLAY: Record<Profile['os'], Weighted<Display>> = {
  Windows: [
    [{ width: 1920, height: 1080, scale: 1 }, 46],
    [{ width: 1536, height: 864, scale: 1.25 }, 18],
    [{ width: 1366, height: 768, scale: 1 }, 12],
    [{ width: 2560, height: 1440, scale: 1 }, 10],
    [{ width: 1600, height: 900, scale: 1 }, 6],
    [{ width: 1920, height: 1200, scale: 1 }, 5],
    [{ width: 3840, height: 2160, scale: 1.5 }, 3],
  ],
  // Retina reports CSS pixels: a 13" Air is 1470×956 at a scale of 2.
  macOS: [
    [{ width: 1512, height: 982, scale: 2 }, 30],
    [{ width: 1470, height: 956, scale: 2 }, 22],
    [{ width: 1728, height: 1117, scale: 2 }, 20],
    [{ width: 2560, height: 1440, scale: 1 }, 16],
    [{ width: 1920, height: 1080, scale: 1 }, 12],
  ],
  Linux: [
    [{ width: 1920, height: 1080, scale: 1 }, 62],
    [{ width: 1366, height: 768, scale: 1 }, 14],
    [{ width: 2560, height: 1440, scale: 1 }, 14],
    [{ width: 3840, height: 2160, scale: 2 }, 10],
  ],
}

/** Tab strip plus toolbar: the gap between `outerHeight` and `innerHeight`. */
const CHROME_HEIGHT: Record<Profile['os'], number> = {
  Windows: 105,
  macOS: 87,
  Linux: 100,
}

/** Taskbar, dock, or panel: screen height a maximized window does not get. */
const OS_CHROME: Record<Profile['os'], number> = {
  Windows: 48,
  macOS: 25,
  Linux: 27,
}

// ─── hardware ─────────────────────────────────────────────────────────────────

/**
 * Logical processors, keyed by platform because SMT is what the count means.
 *
 * A Windows laptop reporting 8 is a four-core part with hyper-threading, and an
 * odd count there barely exists; an Apple silicon Mac has no SMT at all, so its
 * count is its core count and the M-series lands on 8, 10, 12 and 14.
 */
const CORES: Record<string, Weighted<number>> = {
  'Windows/x86': [[4, 20], [8, 34], [12, 18], [16, 16], [20, 8], [24, 4]],
  'Windows/arm': [[8, 30], [10, 40], [12, 30]],
  'macOS/arm': [[8, 42], [10, 30], [12, 16], [14, 12]],
  'macOS/x86': [[4, 30], [8, 46], [12, 24]],
  'Linux/x86': [[4, 22], [8, 34], [12, 18], [16, 18], [24, 8]],
  'Linux/arm': [[4, 40], [6, 30], [8, 30]],
}

/** Real installed memory. `navigator.deviceMemory` clamps this, a surface does not. */
const MEMORY: Record<Profile['os'], Weighted<number>> = {
  Windows: [[16, 44], [8, 34], [32, 18], [4, 4]],
  // No Mac has shipped with 4 GB in a decade, and the M-series base is 8 or 16.
  macOS: [[16, 46], [8, 26], [24, 12], [32, 16]],
  Linux: [[16, 44], [8, 28], [32, 24], [64, 4]],
}

// ─── locale ───────────────────────────────────────────────────────────────────

interface Locale {
  locale: string
  languages: readonly string[]
  timezone: string
  geo: { latitude: number; longitude: number; accuracy: number }
}

/**
 * Locale, language list, timezone and coordinates travel together because they
 * are one claim: `en-US` in `Europe/Berlin` is a machine that exists, and
 * `de-DE` in `America/New_York` with US coordinates is not.
 */
const LOCALE: Weighted<Locale> = [
  [{
    locale: 'en-US',
    languages: ['en-US', 'en'],
    timezone: 'America/New_York',
    geo: { latitude: 40.7128, longitude: -74.006, accuracy: 100 },
  }, 22],
  [{
    locale: 'en-US',
    languages: ['en-US', 'en'],
    timezone: 'America/Chicago',
    geo: { latitude: 41.8781, longitude: -87.6298, accuracy: 100 },
  }, 12],
  [{
    locale: 'en-US',
    languages: ['en-US', 'en'],
    timezone: 'America/Los_Angeles',
    geo: { latitude: 34.0522, longitude: -118.2437, accuracy: 100 },
  }, 14],
  [{
    locale: 'en-GB',
    languages: ['en-GB', 'en'],
    timezone: 'Europe/London',
    geo: { latitude: 51.5072, longitude: -0.1276, accuracy: 100 },
  }, 10],
  [{
    locale: 'de-DE',
    languages: ['de-DE', 'de', 'en-US', 'en'],
    timezone: 'Europe/Berlin',
    geo: { latitude: 52.52, longitude: 13.405, accuracy: 100 },
  }, 8],
  [{
    locale: 'fr-FR',
    languages: ['fr-FR', 'fr', 'en-US', 'en'],
    timezone: 'Europe/Paris',
    geo: { latitude: 48.8566, longitude: 2.3522, accuracy: 100 },
  }, 7],
  [{
    locale: 'es-ES',
    languages: ['es-ES', 'es', 'en'],
    timezone: 'Europe/Madrid',
    geo: { latitude: 40.4168, longitude: -3.7038, accuracy: 100 },
  }, 5],
  [{
    locale: 'pt-BR',
    languages: ['pt-BR', 'pt', 'en-US', 'en'],
    timezone: 'America/Sao_Paulo',
    geo: { latitude: -23.5558, longitude: -46.6396, accuracy: 100 },
  }, 6],
  [{
    locale: 'en-CA',
    languages: ['en-CA', 'en', 'fr-CA', 'fr'],
    timezone: 'America/Toronto',
    geo: { latitude: 43.6532, longitude: -79.3832, accuracy: 100 },
  }, 5],
  [{
    locale: 'en-AU',
    languages: ['en-AU', 'en'],
    timezone: 'Australia/Sydney',
    geo: { latitude: -33.8688, longitude: 151.2093, accuracy: 100 },
  }, 4],
  [{
    locale: 'ja-JP',
    languages: ['ja-JP', 'ja', 'en-US', 'en'],
    timezone: 'Asia/Tokyo',
    geo: { latitude: 35.6762, longitude: 139.6503, accuracy: 100 },
  }, 4],
  [{
    locale: 'nl-NL',
    languages: ['nl-NL', 'nl', 'en-US', 'en'],
    timezone: 'Europe/Amsterdam',
    geo: { latitude: 52.3676, longitude: 4.9041, accuracy: 100 },
  }, 3],
]

// ─── media ────────────────────────────────────────────────────────────────────

/**
 * What a branded Chrome plays and an open-source Chromium does not.
 *
 * This is one list rather than a per-OS table because the difference it exists
 * to cover is the *build*, not the machine: Google ships the proprietary
 * decoders, the Chromium that Playwright downloads does not, and
 * `canPlayType('video/mp4; codecs="avc1.42E01E"')` answering `''` is a one-line
 * test that no amount of `navigator` spoofing survives. Everything here is
 * something every real desktop Chrome answers `probably` to.
 */
const CODECS: readonly string[] = [
  'audio/mpeg',
  'audio/mp4; codecs="mp4a.40.2"',
  'audio/ogg; codecs="opus"',
  'audio/webm; codecs="opus"',
  'audio/webm; codecs="vorbis"',
  'video/mp4; codecs="avc1.42E01E"',
  'video/mp4; codecs="avc1.42E01E, mp4a.40.2"',
  'video/mp4; codecs="avc1.64001E, mp4a.40.2"',
  'video/webm; codecs="vp8, vorbis"',
  'video/webm; codecs="vp9"',
  'video/webm; codecs="vp9, opus"',
  'video/mp4; codecs="av01.0.05M.08"',
]

/**
 * Attached capture and playback hardware, as `enumerateDevices` reports it.
 *
 * Headless Chrome enumerates *nothing*, and an empty device list is as rare on a
 * real desktop as no GPU: the tell is the count and the kinds, not the labels,
 * which a page cannot read until it holds a camera or microphone permission. The
 * sets below are the ordinary shapes — a laptop with its built-in trio, a
 * desktop with a webcam or without one.
 */
const DEVICES: Record<
  Profile['os'],
  Weighted<readonly { kind: string; label: string }[]>
> = {
  macOS: [
    [[
      { kind: 'audioinput', label: 'MacBook Pro Microphone' },
      { kind: 'videoinput', label: 'FaceTime HD Camera' },
      { kind: 'audiooutput', label: 'MacBook Pro Speakers' },
    ], 70],
    [[
      { kind: 'audioinput', label: 'Studio Display Microphone' },
      { kind: 'videoinput', label: 'Studio Display Camera' },
      { kind: 'audiooutput', label: 'Studio Display Speakers' },
    ], 30],
  ],
  Windows: [
    [[
      { kind: 'audioinput', label: 'Microphone Array (Realtek(R) Audio)' },
      { kind: 'videoinput', label: 'Integrated Camera' },
      { kind: 'audiooutput', label: 'Speakers (Realtek(R) Audio)' },
    ], 55],
    [[
      { kind: 'audioinput', label: 'Microphone (USB Audio Device)' },
      { kind: 'audiooutput', label: 'Speakers (USB Audio Device)' },
    ], 25],
    [[
      { kind: 'audioinput', label: 'Microphone (HD Webcam C270)' },
      { kind: 'videoinput', label: 'HD Webcam C270' },
      { kind: 'audiooutput', label: 'Speakers (Realtek(R) Audio)' },
    ], 20],
  ],
  Linux: [
    [[
      { kind: 'audioinput', label: 'Built-in Audio Analog Stereo' },
      { kind: 'audiooutput', label: 'Built-in Audio Analog Stereo' },
    ], 60],
    [[
      { kind: 'audioinput', label: 'Built-in Audio Analog Stereo' },
      { kind: 'videoinput', label: 'Integrated_Webcam_HD' },
      { kind: 'audiooutput', label: 'Built-in Audio Analog Stereo' },
    ], 40],
  ],
}

// ─── fonts ────────────────────────────────────────────────────────────────────

/**
 * The installed set follows the OS, which is why fonts sit in the platform group
 * (§10.2). These are the families a stock install has — no third-party additions,
 * because a font a machine has no reason to own is exactly the kind of rarity
 * §2.5 warns about.
 */
const FONTS: Record<Profile['os'], readonly string[]> = {
  Windows: [
    'Arial',
    'Arial Black',
    'Bahnschrift',
    'Calibri',
    'Cambria',
    'Candara',
    'Comic Sans MS',
    'Consolas',
    'Constantia',
    'Corbel',
    'Courier New',
    'Ebrima',
    'Franklin Gothic Medium',
    'Gabriola',
    'Gadugi',
    'Georgia',
    'Impact',
    'Ink Free',
    'Javanese Text',
    'Leelawadee UI',
    'Lucida Console',
    'Lucida Sans Unicode',
    'Malgun Gothic',
    'Marlett',
    'Microsoft Himalaya',
    'Microsoft JhengHei',
    'Microsoft New Tai Lue',
    'Microsoft PhagsPa',
    'Microsoft Sans Serif',
    'Microsoft Tai Le',
    'Microsoft YaHei',
    'MingLiU-ExtB',
    'Mongolian Baiti',
    'MS Gothic',
    'MV Boli',
    'Myanmar Text',
    'Nirmala UI',
    'Palatino Linotype',
    'Segoe MDL2 Assets',
    'Segoe Print',
    'Segoe Script',
    'Segoe UI',
    'Segoe UI Emoji',
    'Segoe UI Historic',
    'Segoe UI Symbol',
    'SimSun',
    'Sitka',
    'Sylfaen',
    'Symbol',
    'Tahoma',
    'Times New Roman',
    'Trebuchet MS',
    'Verdana',
    'Webdings',
    'Wingdings',
    'Yu Gothic',
  ],
  macOS: [
    'American Typewriter',
    'Andale Mono',
    'Arial',
    'Arial Black',
    'Arial Narrow',
    'Arial Rounded MT Bold',
    'Arial Unicode MS',
    'Avenir',
    'Avenir Next',
    'Baskerville',
    'Big Caslon',
    'Bodoni 72',
    'Bradley Hand',
    'Brush Script MT',
    'Chalkboard',
    'Chalkduster',
    'Charter',
    'Cochin',
    'Comic Sans MS',
    'Copperplate',
    'Courier New',
    'Didot',
    'Futura',
    'Geneva',
    'Georgia',
    'Gill Sans',
    'Helvetica',
    'Helvetica Neue',
    'Herculanum',
    'Hoefler Text',
    'Impact',
    'Lucida Grande',
    'Luminari',
    'Marker Felt',
    'Menlo',
    'Monaco',
    'Noteworthy',
    'Optima',
    'Palatino',
    'Papyrus',
    'Phosphate',
    'Rockwell',
    'Savoye LET',
    'SignPainter',
    'Skia',
    'Snell Roundhand',
    'Tahoma',
    'Times New Roman',
    'Trattatello',
    'Trebuchet MS',
    'Verdana',
    'Zapfino',
  ],
  Linux: [
    'Cantarell',
    'DejaVu Sans',
    'DejaVu Sans Mono',
    'DejaVu Serif',
    'FreeMono',
    'FreeSans',
    'FreeSerif',
    'Liberation Mono',
    'Liberation Sans',
    'Liberation Serif',
    'Noto Color Emoji',
    'Noto Mono',
    'Noto Sans',
    'Noto Sans Mono',
    'Noto Serif',
    'Ubuntu',
    'Ubuntu Condensed',
    'Ubuntu Mono',
  ],
}

// ─── the draw ─────────────────────────────────────────────────────────────────

/** Narrow a table to the values a constraint allows, or throw naming the axis. */
function allow<T>(
  rows: Weighted<T>,
  axis: string,
  accept?: (value: T) => boolean,
): Weighted<T> {
  if (!accept) return rows
  const kept = rows.filter(([value]) => accept(value))
  if (kept.length === 0) {
    throw new Error(`generate has no ${axis} satisfying the constraint`)
  }
  return kept
}

/**
 * Draw one coherent machine. Exported because `pin` reproduces a row from an id
 * rather than storing one: same id, same seed, same machine, which is what makes
 * a failure re-openable tomorrow.
 */
export function machine(
  constraint: Constraint,
  random: () => number,
  seed: string,
  now: Date = new Date(),
): Draw {
  const os = pick(
    allow(OS, 'os', constraint.os && ((o) => constraint.os!.includes(o))),
    random,
  )
  const arch = pick(ARCH[os], random)
  const osVersion = pick(OS_VERSION[os], random)
  const chrome = pick(
    allow(
      majors(now),
      'chrome version',
      constraint.minChrome !== undefined
        ? (m) => m >= constraint.minChrome!
        : undefined,
    ),
    random,
  )

  const locale = pick(
    allow(
      allow(
        LOCALE,
        'locale',
        constraint.locale && ((l) => constraint.locale!.includes(l.locale)),
      ),
      'timezone',
      constraint.timezone &&
        ((l) => constraint.timezone!.includes(l.timezone)),
    ),
    random,
  )

  const display = pick(DISPLAY[os], random)
  const gpu = pick(GPU[`${os}/${arch}`] ?? GPU['Linux/x86'], random)

  const row: Omit<Draw, 'id'> = {
    seed,
    source: 'generate',
    schema: SCHEMA,
    os,
    osVersion,
    arch,
    chrome,
    userAgent: userAgent(os, chrome),
    brands: brands(chrome),
    languages: locale.languages,
    locale: locale.locale,
    timezone: locale.timezone,
    geo: locale.geo,
    screen: { ...display, depth: 24 },
    viewport: {
      width: display.width,
      height: display.height - OS_CHROME[os] - CHROME_HEIGHT[os],
    },
    chromeHeight: CHROME_HEIGHT[os],
    hardware: {
      cores: pick(CORES[`${os}/${arch}`] ?? CORES['Linux/x86'], random),
      memory: pick(MEMORY[os], random),
      touch: os === 'Windows' ? random() < 0.12 : false,
    },
    gpu,
    fonts: FONTS[os],
    media: { codecs: CODECS, devices: pick(DEVICES[os], random) },
  }

  return { ...row, id: constraint.id ?? identify(row) }
}

/** A short stable name for a row, for the trace and for pairing with a data dir. */
function identify(row: Omit<Draw, 'id'>): string {
  const material = [
    row.seed,
    row.os,
    row.osVersion,
    row.chrome,
    row.locale,
    row.timezone,
    row.gpu?.renderer,
    row.screen.width,
    row.screen.height,
  ].join('|')
  let h = 2166136261
  for (let i = 0; i < material.length; i++) {
    h = Math.imul(h ^ material.charCodeAt(i), 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export const generate: PluginFactory<Record<string, unknown>> = definePlugin({
  kind: 'profile',
  name: 'generate',
  setup: (_options, ctx) => ({
    draw: (constraint) => machine(constraint, ctx.random, ctx.seed),
  }),
})
