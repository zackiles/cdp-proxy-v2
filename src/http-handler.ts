/**
 * @module http-handler
 * @description Serves the CDP HTTP discovery surface by forwarding it to the
 * upstream browser and rewriting the `webSocketDebuggerUrl`s it hands back so
 * clients dial the proxy instead of the browser.
 *
 * @see {@link https://chromium.googlesource.com/chromium/src/+/master/content/browser/devtools/devtools_http_handler.cc}
 */

import { replaceInResponse } from '@zackiles/response-rewriter'
import { CDP_HTTP_PATHS, CDP_HTTP_PATHS_TO_REWRITE } from './constants.ts'
import type { HandlerInterface } from './types.ts'
import { trace } from '@opentelemetry/api'
import { Logger } from './logger.ts'

/** Resolves the upstream browser (host/port) to forward an HTTP request to. */
export type UpstreamResolver = (
  request: Request,
) => { host: string; port: number }

class HttpHandler implements HandlerInterface {
  readonly #resolveUpstream: UpstreamResolver
  readonly #log = Logger.get('http')

  constructor(resolveUpstream: UpstreamResolver) {
    this.#resolveUpstream = resolveUpstream
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url)
    // DANGER: Playwright's connectOverCDP asks for `/json/version/` with a
    // trailing slash. Without normalizing it, exact-path matching 404s.
    const path = url.pathname.replace(/\/+$/, '') || '/'
    const span = trace.getActiveSpan()

    try {
      if (!CDP_HTTP_PATHS.includes(path as (typeof CDP_HTTP_PATHS)[number])) {
        span?.setAttribute('cdp.error', 'unsupported_path')
        this.#log.debug(`unsupported path ${path}`, {
          supported: CDP_HTTP_PATHS,
        })
        return new Response('Not found', { status: 404 })
      }

      const { host, port } = this.#resolveUpstream(request)
      const upstream = new URL(path + url.search, `http://${host}:${port}`)
      span?.setAttribute('cdp.request.target_url', upstream.toString())

      const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
      let response = await fetch(
        new Request(upstream, {
          method: request.method,
          headers: request.headers,
          body: hasBody ? request.body : undefined,
        }),
      )
      span?.setAttribute('cdp.response.status', response.status)

      if (
        CDP_HTTP_PATHS_TO_REWRITE.includes(
          path as (typeof CDP_HTTP_PATHS_TO_REWRITE)[number],
        )
      ) {
        const proxyPort = url.port || (url.protocol === 'https:' ? '443' : '80')
        span?.setAttribute('cdp.response.rewritten', true)
        response = await replaceInResponse(
          `${host}:${port}`,
          `${url.hostname}:${proxyPort}`,
          response,
        )
      }

      return response
    } catch (cause: unknown) {
      const error = cause instanceof Error ? cause : new Error(String(cause))
      span?.setAttribute('error', true)
      span?.setAttribute('error.message', error.message)
      this.#log.error(`${request.method} ${path} failed`, { error })
      return new Response(`Internal Server Error: ${error.message}`, {
        status: 500,
      })
    }
  }
}

export { HttpHandler }
