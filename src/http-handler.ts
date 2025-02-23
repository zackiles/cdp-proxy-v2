import { replaceInResponse } from '@zackiles/response-rewriter'

class HttpHandler {
  private browserHost: string
  private browserPort: number
  constructor(browserHost: string, browserPort: number) {
    this.browserHost = browserHost
    this.browserPort = browserPort
  }

  private async handleWebSocket(request: Request, requestUrl: URL): Promise<Response> {
    const { socket, response } = Deno.upgradeWebSocket(request)
    socket.addEventListener("open", () => {
      console.log("a client connected!");
      setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send('ping');
        }
      }, 30000);
    })
    socket.addEventListener("pong", () => {
      console.log("Received pong, connection is healthy");
    })
    socket.addEventListener("error", (error) => {
      console.error("WebSocket error:", error);
    })

    socket.addEventListener("close", () => {
      console.log("Client disconnected");
    })

    socket.addEventListener("message", (event) => {
      if (event.data === "ping") {
        socket.send("pong");
      }
    })

    return response
  }

  private async handleHttp(request: Request, requestUrl: URL): Promise<Response> {
    const handlerHost = requestUrl.hostname
    const handlerPort = requestUrl.port
    let response = await fetch(request)
    // These paths contain the webSocketDebuggerUrl, which needs to be rewritten to use the proxy host and port not the browser's
    const responsesToRewrite = ['/json/version', '/json', '/json/list', '/json/new']
    if (responsesToRewrite.includes(requestUrl.pathname)) {
      response = await replaceInResponse(`${this.browserHost}:${this.browserPort}`, `${handlerHost}:${handlerPort}`, response)
    }
    return response
  }

  async handle(request: Request): Promise<Response> {
    const requestUrl = new URL(request.url)
    const requestPath = requestUrl.pathname

    switch (true) {
      case requestPath === "/json/version":
        return await this.handleHttp(request, requestUrl)
  
      case (requestPath === "/json" || requestPath === "/json/list"):
        return await this.handleHttp(request, requestUrl)
  
      case requestPath.startsWith("/json/protocol"):
        return await this.handleHttp(request, requestUrl)
  
      case requestPath.startsWith("/json/new"):
        return await this.handleHttp(request, requestUrl)

      case requestPath.startsWith("/json/activate/"):
        return await this.handleHttp(request, requestUrl)
  
      case requestPath.startsWith("/json/close/"):
        return await this.handleHttp(request, requestUrl)
  
      case requestPath.startsWith("/devtools/inspector.html"):
        return await this.handleHttp(request, requestUrl)
  
      case requestPath.startsWith("/devtools/page/"):
        return new Response("Not implemented. The CDP proxy only supports browser target commands using flatten=true", {
          status: 404
        })

      case requestPath.startsWith("/devtools/browser"):
        return await this.handleWebSocket(request, requestUrl)

      default:
        return new Response(`Not implemented. The path ${requestPath} is not found or supported by the CDP proxy`, {
          status: 404
        })
    }

  }
}

export { HttpHandler }