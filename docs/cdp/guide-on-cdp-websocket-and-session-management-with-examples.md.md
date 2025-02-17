### **CDP Websocket Session Management - `flatten: true` vs`flatten: true`**  
This example follows **step-by-step** how to **connect to a fresh Chrome instance, create a browser context, open a page, and navigate that page** using **traditional (non-flattened) CDP**, and then compares **how it would work with `flatten: true`** at each step.

---

## **Step 1: Start a Fresh Chrome Instance and Get the Browser WebSocket URL**
Run **headless Chrome**:
```sh
chrome --remote-debugging-port=9222 --headless=new
```
Query Chrome’s **version endpoint** to retrieve the WebSocket URL:
```
GET http://localhost:9222/json/version
```
Example response:
```json
{
  "webSocketDebuggerUrl": "ws://localhost:9222/devtools/browser/2B89D8C3-5F39-4A12-8D55-90B68D2C64E2"
}
```
- This WebSocket (`/devtools/browser/...`) is **only for browser-wide operations**.

### **🚀 If Using `flatten: true`:**
✅ **No change** at this step. You still need to connect to the **browser WebSocket**.

---

## **Step 2: Open a WebSocket Connection to the Browser**
Now, open a **WebSocket connection** to:
```
ws://localhost:9222/devtools/browser/2B89D8C3-5F39-4A12-8D55-90B68D2C64E2
```
- This lets us issue **browser-wide** commands.

### **🚀 If Using `flatten: true`:**
✅ **No change** at this step. You still connect to the **browser WebSocket**.

---

## **Step 3: Create a New Browser Context**
Send the following command to create a **new browser context**:
```json
{
  "id": 1,
  "method": "Target.createBrowserContext"
}
```
Example response:
```json
{
  "id": 1,
  "result": {
    "browserContextId": "BROWSER_CONTEXT_1"
  }
}
```
- `BROWSER_CONTEXT_1` is an **isolated browsing session**.

### **🚀 If Using `flatten: true`:**
✅ **No change** at this step. The browser context creation is the same.

---

## **Step 4: Create a New Page in This Context**
Send a command to **create a new page**:
```json
{
  "id": 2,
  "method": "Target.createTarget",
  "params": {
    "url": "about:blank",
    "browserContextId": "BROWSER_CONTEXT_1"
  }
}
```
Example response:
```json
{
  "id": 2,
  "result": {
    "targetId": "TARGET_PAGE_1"
  }
}
```
- The new page exists with `targetId: TARGET_PAGE_1`, but **we cannot interact with it yet**.

### **🚀 If Using `flatten: true`:**
✅ **No change** at this step. The page is created the same way.

---

## **Step 5: Get the Page's WebSocket URL**
Since `TARGET_PAGE_1` is now created, we need to find its **WebSocket URL**.  
To do this, call:
```
GET http://localhost:9222/json
```
Example response:
```json
[
  {
    "id": "TARGET_PAGE_1",
    "type": "page",
    "webSocketDebuggerUrl": "ws://localhost:9222/devtools/page/7DFA92E3-1B47-4215-9D8C-8F1E90BFD12E"
  }
]
```
- The WebSocket URL for the page is:
  ```
  ws://localhost:9222/devtools/page/7DFA92E3-1B47-4215-9D8C-8F1E90BFD12E
  ```
- **We must open a new WebSocket connection to this URL to control the page.**

### **🚀 If Using `flatten: true`:**
🚨 **This step is skipped entirely!**  
✅ You **do not need to fetch a WebSocket URL for the page**.  
✅ You **do not need to open a second WebSocket connection**.  
👉 Instead, **all interactions happen via the same browser WebSocket, using `sessionId`**.

---

## **Step 6: Open a WebSocket Connection to the Page**
Now, **disconnect from the browser WebSocket** and **open a new WebSocket connection** to:
```
ws://localhost:9222/devtools/page/7DFA92E3-1B47-4215-9D8C-8F1E90BFD12E
```
- This WebSocket **only controls this page**.

### **🚀 If Using `flatten: true`:**
🚨 **This step is skipped entirely!**  
✅ You continue using the **same browser WebSocket**.  
✅ **No need to switch WebSockets**.

---

## **Step 7: Navigate the Page**
Since we're connected to the **page's WebSocket**, send:
```json
{
  "id": 3,
  "method": "Page.navigate",
  "params": {
    "url": "https://example.com"
  }
}
```
Example response:
```json
{
  "id": 3,
  "result": {
    "frameId": "FRAME_1"
  }
}
```
- The page has successfully navigated to `https://example.com`.

### **🚀 If Using `flatten: true`:**
✅ The **same command is sent**, but **via the browser WebSocket** with `sessionId` included:  
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
- **No need for a separate WebSocket!**
- **All interactions remain within the same connection.**

---

## **Comparison Summary**
| Step | Without `flatten: true` | With `flatten: true` |
|------|--------------------|----------------|
| **1. Get Browser WebSocket** | `GET /json/version` | Same |
| **2. Connect to Browser** | Open WebSocket to `/devtools/browser/...` | Same |
| **3. Create Context** | `Target.createBrowserContext` | Same |
| **4. Create Page** | `Target.createTarget` | Same |
| **5. Get Page WebSocket** | `GET /json` to find `/devtools/page/...` | ❌ **Not needed** |
| **6. Connect to Page WebSocket** | Open WebSocket to `/devtools/page/...` | ❌ **Not needed** |
| **7. Navigate Page** | Send `Page.navigate` via the page WebSocket | ✅ **Send `Page.navigate` via the browser WebSocket with `sessionId`** |

---

### **🚀 Key Benefits of Using `flatten: true`**
✅ **Fewer WebSocket connections** (only one instead of one per page).  
✅ **No need to fetch a WebSocket URL for each page.**  
✅ **All commands go through a single connection, simplifying session management.**  