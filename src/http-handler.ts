import { replaceInResponse } from '@zackiles/response-rewriter'

class HttpHandler {
  private browserWebSocketDebuggerUrl: string
  constructor(browserWebSocketDebuggerUrl: string) {
    this.browserWebSocketDebuggerUrl = browserWebSocketDebuggerUrl
  }

  async handle(req: Request): Promise<Response> {
  const proxyHost = 
    const proxyPort = ''
    const response = await fetch(req)
    const rewrittenResponse = await replaceInResponse(response)
    return rewrittenResponse
  }
}

export async function httpHandler(req: Request): Promise<Response> {
  console.log(Deno.inspect(req))
  const response = await fetch(req)
  const rewrittenResponse =  , {
    'https://www.google.com': 'https://www.google.com/123',
  })
  return await replaceInResponse(response)
}