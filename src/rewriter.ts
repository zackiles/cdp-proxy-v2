/**
 * A middleware class for Deno 2.0 that rewrites Chrome DevTools Protocol URLs in responses,
 * ensuring only the specified host and port are used. To be used in a transparent MitM proxy.
 * Handles HTTP(S) and WebSocket URLs found in both headers and JSON response bodies. Ensures
 * clients like Playwright are never exposed the source host or port of the browser CDP instance.
 *
 * Usage example:
 *
 * const proxyPort = 3000
 * const proxyHostname = "127.0.0.1"
 * const rewriter = new ProxyRewriter(proxyPort, proxyHostname)
 * const server = Deno.serve({
 *   port: proxyPort,
 *   hostname: proxyHostname,
 *   handler: await rewriter.handler([finalResponseHandler]),
 * })
 *
 * @throws Error if handler is called without handlers or if the final handler returns null
 */
class ProxyRewriter {
  #targetPort: number
  #targetHost: string

  /**
   * Creates an instance of ProxyRewriter.
   * @param targetPort - The new port to use for debugger URLs.
   * @param targetHost - The new host to use for debugger URLs.
   */
  constructor(targetPort: number, targetHost: string) {
    this.#targetPort = targetPort
    this.#targetHost = targetHost
  }

  /**
   * Returns a middleware handler function that processes requests through the provided handlers.
   * If any handler returns a Response, that Response is immediately returned, and subsequent handlers are skipped (short-circuiting).
   * The final handler *must* return a Response if no previous handler has short-circuited.
   *
   * @param handlers - Array of middleware functions.
   * @throws Error if no handlers are provided or if no handler returns a Response.
   * @returns A function that takes a Request and returns a Promise resolving to a Response.
   */
  public handler(
    handlers?: Array<(req: Request) => Promise<Response | null>>,
  ): (req: Request) => Promise<Response> {
    if (!handlers?.length) {
      throw new Error('ProxyRewriter requires at least one handler')
    }

    return async (req: Request): Promise<Response> => {
      let response: Response | null = null

      // Invoke all handlers in order
      for (let i = 0; i < handlers.length; i++) {
        response = await handlers[i](req)
        // If any handler returns a Response, short-circuit
        if (response) {
          break
        }
      }

      // Ensure we have a response from the final handler or a short-circuit
      if (!response) {
        throw new Error(
          'Final handler must return a Response or a middleware short-circuited',
        )
      }

      // Rewrite and return the response
      return this.#rewriteResponse(response)
    }
  }

  /**
   * Checks if a string contains a URL that should be rewritten
   * @param value - The string to check
   * @returns boolean indicating if the string contains a rewritable URL
   */
  private static shouldRewriteUrl(value: string): boolean {
    return (
      value.includes('ws://') ||
      value.includes('wss://') ||
      value.includes('http://') ||
      value.includes('https://')
    )
  }

  /**
   * Rewrites debugger-related URLs in the given headers.
   * @param headers - The headers to be processed.
   * @returns A new Headers instance with debugger URLs rewritten.
   */
  #rewriteHeaders(headers: Headers): Headers {
    const newHeaders = new Headers(headers)
    for (const [key, value] of headers.entries()) {
      if (value && ProxyRewriter.shouldRewriteUrl(value)) {
        newHeaders.set(key, this.#rewriteHostAndPort(value))
      }
    }
    return newHeaders
  }

  /**
   * Rewrites the response by modifying its headers and, if applicable, its JSON body containing debugger URLs.
   * For non-JSON responses, it returns a new Response with the rewritten headers.
   * @param response - The original Response object.
   * @returns A Promise that resolves to the modified Response.
   */
  async #rewriteResponse(response: Response): Promise<Response> {
    const headers = this.#rewriteHeaders(response.headers)
    const contentType = headers.get('content-type') ?? ''
    if (contentType.includes('application/json')) {
      const text = await response.text()
      try {
        const body = JSON.parse(text)
        const rewrittenBody = JSON.stringify(
          this.#rewriteDebuggerUrlsInBody(body),
        )
        return new Response(rewrittenBody, {
          status: response.status,
          headers,
        })
      } catch {
        return new Response(text, { status: response.status, headers })
      }
    }
    return new Response(response.body, { status: response.status, headers })
  }

  /**
   * Recursively rewrites debugger-related URLs in a JSON response body.
   * @param data - The JSON data to process.
   * @returns The modified JSON data with debugger URLs rewritten.
   */
  #rewriteDebuggerUrlsInBody(data: unknown): unknown {
    if (data === null || typeof data !== 'object') return data
    if (Array.isArray(data)) {
      return data.map((item) => this.#rewriteDebuggerUrlsInBody(item))
    }
    const modified = { ...data } as Record<string, unknown>
    for (const key of Object.keys(modified)) {
      if (
        typeof modified[key] === 'string' &&
        ProxyRewriter.shouldRewriteUrl(modified[key] as string)
      ) {
        modified[key] = this.#rewriteHostAndPort(modified[key] as string)
      } else if (modified[key] && typeof modified[key] === 'object') {
        modified[key] = this.#rewriteDebuggerUrlsInBody(modified[key])
      }
    }
    return modified
  }

  /**
   * Rewrites both the host and port of a given WebSocket URL.
   * @param url - The original URL string.
   * @returns The modified URL string with the new host and port, or the original URL if parsing fails.
   */
  #rewriteHostAndPort(url: string): string {
    try {
      const parsedUrl = new URL(url)
      parsedUrl.hostname = this.#targetHost
      parsedUrl.port = this.#targetPort.toString()
      return parsedUrl.toString()
    } catch {
      return url
    }
  }
}

export { ProxyRewriter }
