/**
 * Handles HTTP request/response forwarding for the proxy.
 * @see {@link https://chromium.googlesource.com/chromium/src/+/master/content/browser/devtools/devtools_http_handler.cc} Chromium HTTP handler source code.
 * @see {@link CDP_HTTP_PATHS} for HTTP endpoints
 * @see {@link CDP_HTTP_PATHS_TO_REWRITE} for HTTP paths that need to be rewritten
 */

import { replaceInResponse } from '@zackiles/response-rewriter'
import { CDP_HTTP_PATHS, CDP_HTTP_PATHS_TO_REWRITE } from './constants.ts'
import type { HandlerInterface, HandlerOptions } from './types.ts'

class HttpHandler implements HandlerInterface {
  private browserHost: string
  private browserPort: number

  /**
   * Creates a new HTTP handler for the CDP proxy
   * @param options Configuration options for the handler
   */
  constructor(options: HandlerOptions) {
    this.browserHost = options.browserHost
    this.browserPort = options.browserPort
  }

  private async handleHttp(
    request: Request,
    requestUrl: URL,
  ): Promise<Response> {
    const handlerHost = requestUrl.hostname
    const handlerPort = requestUrl.port
    let response = await fetch(request)
    // These paths contain the webSocketDebuggerUrl, which needs to be rewritten to use the proxy host and port not the browser's
    if (
      CDP_HTTP_PATHS_TO_REWRITE.includes(
        requestUrl.pathname as (typeof CDP_HTTP_PATHS_TO_REWRITE)[number],
      )
    ) {
      response = await replaceInResponse(
        `${this.browserHost}:${this.browserPort}`,
        `${handlerHost}:${handlerPort}`,
        response,
      )
    }
    return response
  }

  async handle(request: Request): Promise<Response> {
    const requestUrl = new URL(request.url)
    const requestPath = requestUrl.pathname
    console.debug('HttpHandler.handle()', {
      requestUrl,
      requestPath,
    })

    try {
      const routeHandlers = CDP_HTTP_PATHS.map((path) => ({
        pattern: path,
        exact: path.indexOf('/') === path.lastIndexOf('/'),
        handler: async () => this.handleHttp(request, requestUrl),
      }))

      const matchingRoute = routeHandlers.find(({ pattern, exact }) =>
        exact ? requestPath === pattern : requestPath.startsWith(pattern),
      )

      if (matchingRoute) {
        return await matchingRoute.handler()
      }

      return new Response(
        `Not implemented. The path ${requestPath} is not found or supported by the CDP proxy`,
        { status: 404 },
      )
    } catch (error: unknown) {
      console.error('Error in HttpHandler.handle():', error)
      const errorMessage =
        error instanceof Error ? error.message : String(error)
      return new Response(`Internal Server Error: ${errorMessage}`, {
        status: 500,
      })
    }
  }
}

export { HttpHandler }
