**Guide on CDP WebSocket and Session Management (With Examples)**

Chrome DevTools Protocol (CDP) allows external tools to automate Chrome or Chromium-based browsers. Communication happens through one or more WebSocket connections, and each connection can manage one or many “sessions.” A session identifies the debugging context (tab, iframe, worker, or browser-level operations) that a set of commands should apply to.

Below is an overview of how these WebSockets and sessions work, with examples for both the default (non-flattened) approach and the flattened approach.

---

**General Concepts**

• **WebSocket Endpoints**  
  - **Browser** endpoint: `ws://localhost:9222/devtools/browser/<UUID>`  
    Used for high-level, browser-wide commands such as creating targets, listing tabs, or retrieving system info.  
  - **Page** endpoint: `ws://localhost:9222/devtools/page/<UUID>`  
    Used for commands specific to a single tab or frame (e.g., DOM, network interception, JavaScript evaluation).

• **Targets**  
  A target represents any debuggable context. It has a unique `targetId`. A page, iframe, or worker each qualifies as a “target.”

• **Sessions**  
  When you attach to a target, Chrome returns a `sessionId` that you use for sending commands specific to that target.

• **Flatten Mode**  
  Flatten mode (`flatten: true`) eliminates the need to open multiple WebSocket connections. You can stay on one WebSocket (usually the browser’s) and route commands to different sessions by including the appropriate `sessionId`.

---

**Default (Non-Flattened) Approach**

• You often open two WebSockets:  
  1. One to the browser endpoint, which lets you create or list targets via `Target.createTarget`, `Target.getTargets`, etc.  
  2. One to the page endpoint, which you retrieve from an HTTP call to `http://localhost:9222/json` or `json/list`, then connect to `ws://localhost:9222/devtools/page/<PAGE_UUID>`.

• Browser-level commands go to the **browser** WebSocket:
```json
{
  "id": 1,
  "method": "Browser.getVersion"
}
```
• Page-level commands go to the **page** WebSocket:
```json
{
  "id": 1,
  "method": "Page.navigate",
  "params": {
    "url": "https://example.com"
  }
}
```
• If you need to attach to an iframe, you call `Target.attachToTarget` on the page WebSocket (or still on the browser WebSocket) and specify `sessionId` in subsequent commands for that iframe. This can create nested sessions inside the same page connection.

---

**Flattened Approach**

• You can stay on the **browser** WebSocket only (e.g., `ws://localhost:9222/devtools/browser/<UUID>`).  
• When creating or discovering a page target, call `Target.attachToTarget` with `"flatten": true`. Instead of switching to a new page WebSocket, you get a `sessionId`. You use that `sessionId` for page-level commands.  
• All commands—browser-wide or page-specific—flow through the **same** WebSocket, distinguished by which `sessionId` is present.

Example of creating a page and navigating it, all from the browser WebSocket, using flatten mode:
```json
{
  "id": 1,
  "method": "Target.createTarget",
  "params": {
    "url": "about:blank"
  }
}
```
Suppose it returns `targetId: "TARGET_PAGE_1"`. Attach with flatten:
```json
{
  "id": 2,
  "method": "Target.attachToTarget",
  "params": {
    "targetId": "TARGET_PAGE_1",
    "flatten": true
  }
}
```
Suppose that returns `sessionId: "SESSION_PAGE_1"`. Now navigate:
```json
{
  "id": 3,
  "sessionId": "SESSION_PAGE_1",
  "method": "Page.navigate",
  "params": {
    "url": "https://example.com"
  }
}
```

---

**Examples**

**Example 1: Non-Flattened Flow**  

1. Launch Chrome with remote debugging:
  ```
  chrome --remote-debugging-port=9222 --headless
  ```
2. Get the browser WebSocket URL:
  ```
  GET http://localhost:9222/json/version
  ```
  Returns something like:
  ```
  {
    "webSocketDebuggerUrl": "ws://localhost:9222/devtools/browser/ABCD-1234"
  }
  ```
3. Connect to the browser WebSocket.
4. Create a new browser context:
  ```json
  {
    "id": 1,
    "method": "Target.createBrowserContext"
  }
  ```
  Suppose it returns `"browserContextId": "BROWSER_CTX_1"`.
5. Create a new page within that context:
  ```json
  {
    "id": 2,
    "method": "Target.createTarget",
    "params": {
      "url": "about:blank",
      "browserContextId": "BROWSER_CTX_1"
    }
  }
  ```
  Suppose it returns `"targetId": "page-42"`.
6. Query `GET http://localhost:9222/json` to find the new page’s WebSocket:
  ```
  [
    {
      "id": "page-42",
      "type": "page",
      "webSocketDebuggerUrl": "ws://localhost:9222/devtools/page/XYZ-987"
    }
  ]
  ```
7. Open a **new** WebSocket connection to `ws://localhost:9222/devtools/page/XYZ-987`, then send:
  ```json
  {
    "id": 1,
    "method": "Page.navigate",
    "params": { "url": "https://example.com" }
  }
  ```

**Example 2: Flattened Flow**

1. Launch Chrome with remote debugging:
  ```
  chrome --remote-debugging-port=9222 --headless
  ```
2. Get the browser WebSocket URL as before, then connect to it.
3. Create a new browser context:
  ```json
  {
    "id": 1,
    "method": "Target.createBrowserContext"
  }
  ```
  Suppose it returns `"browserContextId": "BROWSER_CTX_2"`.
4. Create a page within that context:
  ```json
  {
    "id": 2,
    "method": "Target.createTarget",
    "params": {
      "url": "about:blank",
      "browserContextId": "BROWSER_CTX_2"
    }
  }
  ```
  Suppose it returns `"targetId": "page-99"`.
5. Attach with flatten:
  ```json
  {
    "id": 3,
    "method": "Target.attachToTarget",
    "params": {
      "targetId": "page-99",
      "flatten": true
    }
  }
  ```
  Suppose it returns `"sessionId": "SESSION_PAGE_99"`.
6. Navigate the page from **the same browser WebSocket**:
  ```json
  {
    "id": 4,
    "sessionId": "SESSION_PAGE_99",
    "method": "Page.navigate",
    "params": { "url": "https://example.com" }
  }
  ```

---

**Key Takeaways**

• **Browser WebSocket** is ideal for high-level tasks: opening tabs (or contexts), retrieving browser info, or enumerating targets.  
• **Page WebSocket** is used, in non-flattened mode, to control a specific page’s DOM, console, or network.  
• **Flattened mode** unifies browser- and page-level commands into a single WebSocket connection. You attach to each target with `"flatten": true`, then include `sessionId` in your messages. This avoids juggling multiple connections.  
• **Sessions** are the logical channels identified by `sessionId`. They let you direct commands to the correct target, whether you open additional WebSockets (traditional) or stay with one (flattened).

All these commands and endpoints use the same underlying CDP interface. The difference is how you route them: by connecting to multiple endpoints or passing the `sessionId` with flatten mode.