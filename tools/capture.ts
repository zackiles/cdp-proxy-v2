/**
 * @module tools/capture
 * @description Record a corpus row from a real Chrome on hardware you own (§2.3).
 *
 * ```sh
 * deno task capture --out fingerprints.jsonl --id my-laptop --weight 3
 * ```
 *
 * Opens a headful browser, reads back everything the `Profile` schema has a field
 * for, and appends one JSONL line. What comes out is the highest-fidelity source
 * there is, because it encodes the correlations nobody wrote down: the exact
 * driver build behind that GPU, the font list this machine actually has, the
 * `chromeHeight` this display scale actually produces.
 *
 * DANGER: **capture on hardware you own and are willing to be identified as.** A
 * corpus row is a real machine's fingerprint. Publishing one, or drawing it in a
 * fleet alongside your own browsing, links the two. This is also why the tool
 * refuses to run headless: a headless capture records a machine that does not
 * exist — no real GPU, a `HeadlessChrome` token, a font list from a container —
 * which is a row that is worse than anything `generate` would have invented.
 */

import { parseArgs } from '@std/cli/parse-args'
import { chromium } from 'playwright'
import { Config } from '../src/config.ts'
import { brands, SCHEMA } from '../src/profile.ts'
import type { Draw } from '../src/types.ts'

/**
 * Runs in the page. Everything the schema can ask a browser about, read in one
 * pass so the answers describe one moment on one machine.
 */
function measure() {
  const gl = (() => {
    const context = document.createElement('canvas').getContext('webgl')
    if (!context) return undefined
    const debug = context.getExtension('WEBGL_debug_renderer_info')
    if (!debug) return undefined
    return {
      vendor: context.getParameter(debug.UNMASKED_VENDOR_WEBGL) as string,
      renderer: context.getParameter(debug.UNMASKED_RENDERER_WEBGL) as string,
    }
  })()

  const CANDIDATES = [
    'Arial', 'Arial Black', 'Arial Narrow', 'Avenir', 'Avenir Next',
    'Bahnschrift', 'Baskerville', 'Calibri', 'Cambria', 'Candara', 'Cantarell',
    'Charter', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New',
    'DejaVu Sans', 'DejaVu Serif', 'Didot', 'Ebrima', 'Franklin Gothic Medium',
    'Futura', 'Gabriola', 'Gadugi', 'Geneva', 'Georgia', 'Gill Sans', 'Helvetica',
    'Helvetica Neue', 'Hoefler Text', 'Impact', 'Ink Free', 'Liberation Sans',
    'Liberation Serif', 'Lucida Console', 'Lucida Grande', 'Malgun Gothic',
    'Marlett', 'Menlo', 'Microsoft Sans Serif', 'Monaco', 'MS Gothic', 'MV Boli',
    'Nirmala UI', 'Noto Sans', 'Noto Serif', 'Optima', 'Palatino',
    'Palatino Linotype', 'Papyrus', 'Rockwell', 'Segoe UI', 'Segoe UI Emoji',
    'SimSun', 'Sylfaen', 'Symbol', 'Tahoma', 'Times New Roman', 'Trebuchet MS',
    'Ubuntu', 'Verdana', 'Webdings', 'Wingdings', 'Yu Gothic',
  ]
  // Width against a generic baseline: a family that is not installed falls back
  // to the baseline and measures identically, which is the same test a detector
  // runs and therefore the same answer it will get.
  const context = document.createElement('canvas').getContext('2d')!
  const width = (family: string, base: string) => {
    context.font = `72px ${family}, ${base}`
    return context.measureText('mmmmmmmmmmlli').width
  }
  const fonts = CANDIDATES.filter((family) =>
    ['monospace', 'sans-serif', 'serif'].some((base) =>
      width(family, base) !== width('__missing__', base)
    )
  )

  const CODECS = [
    'video/mp4; codecs="avc1.42E01E"',
    'video/webm; codecs="vp8"',
    'video/webm; codecs="vp9"',
    'video/mp4; codecs="av01.0.05M.08"',
    'audio/mp4; codecs="mp4a.40.2"',
    'audio/webm; codecs="opus"',
    'audio/ogg; codecs="vorbis"',
  ]
  const video = document.createElement('video')
  const audio = document.createElement('audio')
  const codecs = CODECS.filter((codec) =>
    (codec.startsWith('video') ? video : audio).canPlayType(codec) === 'probably'
  )

  const nav = navigator as Navigator & {
    deviceMemory?: number
    userAgentData?: {
      brands: { brand: string; version: string }[]
      getHighEntropyValues(hints: string[]): Promise<Record<string, string>>
    }
  }

  return {
    userAgent: nav.userAgent,
    brands: nav.userAgentData?.brands ?? [],
    hints: nav.userAgentData?.getHighEntropyValues([
      'platformVersion',
      'architecture',
      'fullVersionList',
    ]) ?? Promise.resolve({}),
    languages: [...nav.languages],
    locale: Intl.DateTimeFormat().resolvedOptions().locale,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    screen: {
      width: screen.width,
      height: screen.height,
      scale: devicePixelRatio,
      depth: screen.colorDepth,
    },
    viewport: { width: globalThis.innerWidth, height: globalThis.innerHeight },
    chromeHeight: globalThis.outerHeight - globalThis.innerHeight,
    hardware: {
      cores: nav.hardwareConcurrency,
      memory: nav.deviceMemory ?? 0,
      touch: nav.maxTouchPoints > 0,
    },
    gl,
    fonts,
    codecs,
  }
}

async function main(): Promise<number> {
  const args = parseArgs(Deno.args, {
    string: ['out', 'id', 'weight', 'executable'],
    default: { out: 'fingerprints.jsonl', weight: '1' },
  })

  const executable = args.executable ||
    (await Config.create({})).browserExecutablePath
  const browser = await chromium.launch({
    executablePath: executable,
    headless: false,
    // Nothing of ours: the whole point is a row that describes this machine as
    // it is, not as the platform would have configured it.
    args: ['--start-maximized'],
  })

  try {
    const page = await browser.newPage({ viewport: null })
    await page.goto('about:blank')
    const seen = await page.evaluate(measure)
    const hints: Record<string, string> = await seen.hints

    const platform = seen.userAgent.includes('Windows')
      ? 'Windows' as const
      : seen.userAgent.includes('Mac OS X')
      ? 'macOS' as const
      : 'Linux' as const
    const chrome = Number(seen.userAgent.match(/Chrome\/(\d+)/)?.[1] ?? 0)

    if (seen.userAgent.includes('Headless')) {
      console.error(
        'refusing to write a headless capture: the row would describe a ' +
          'machine that does not exist',
      )
      return 1
    }

    const row: Draw & { weight?: number } = {
      id: args.id || `capture-${Date.now().toString(36)}`,
      seed: '',
      source: 'corpus',
      schema: SCHEMA,
      os: platform,
      osVersion: hints.platformVersion ?? '',
      arch: hints.architecture === 'arm' ? 'arm' : 'x86',
      chrome,
      userAgent: seen.userAgent,
      brands: seen.brands.length > 0 ? seen.brands : brands(chrome),
      languages: seen.languages,
      locale: seen.locale,
      timezone: seen.timezone,
      screen: seen.screen,
      viewport: seen.viewport,
      chromeHeight: seen.chromeHeight,
      hardware: seen.hardware,
      gpu: seen.gl
        ? {
          vendor: seen.gl.vendor,
          renderer: seen.gl.renderer,
          angle: seen.gl.renderer.includes('Direct3D')
            ? 'D3D11'
            : seen.gl.renderer.includes('Metal')
            ? 'Metal'
            : 'OpenGL',
        }
        : undefined,
      fonts: seen.fonts,
      media: { codecs: seen.codecs, devices: [] },
      weight: Number(args.weight) || 1,
    }
    // `seed` belongs to the run that draws the row, not to the row: `corpus`
    // derives one per session so two sessions on the same machine still get
    // different jitter (§2.10).
    delete (row as { seed?: string }).seed

    await Deno.writeTextFile(args.out, `${JSON.stringify(row)}\n`, {
      append: true,
    })
    console.log(`wrote ${row.id} to ${args.out}`)
    console.log(
      `  ${row.os} ${row.osVersion} / Chrome ${row.chrome} / ${row.locale} / ` +
        `${row.timezone}`,
    )
    console.log(`  ${row.gpu?.renderer ?? 'no WEBGL_debug_renderer_info'}`)
    console.log(`  ${row.fonts?.length} fonts, ${row.media?.codecs.length} codecs`)
    return 0
  } finally {
    await browser.close()
  }
}

if (import.meta.main) Deno.exit(await main())
