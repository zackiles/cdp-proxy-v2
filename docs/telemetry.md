# OpenTelemetry Support in CDP Proxy

This document explains how to utilize the OpenTelemetry features integrated into the Chrome DevTools Protocol (CDP) proxy.

## Overview

The CDP proxy has been enhanced with OpenTelemetry support to provide better observability of the proxy's operations. Deno automatically creates spans for HTTP requests and outgoing fetch calls, and we've enhanced these spans with additional metadata specific to CDP operations.

## Spans and Attributes

### HTTP Request Spans

For each incoming HTTP request handled by Deno.serve, a span is automatically created with the following base attributes:

- `http.request.method`: The HTTP method of the request
- `url.full`: The full URL of the request
- `url.scheme`: The scheme of the request URL (http/https)
- `url.path`: The path of the request URL
- `url.query`: The query string of the request URL
- `http.status_code`: The status code of the response (added after completion)

Our custom enhancements add the following attributes:

- `http.route`: The identified route pattern (e.g., "/json/list", "/devtools/browser")
- `cdp.connection_type`: Either "http" or "websocket"
- `cdp.endpoint`: For HTTP requests, the specific CDP endpoint being accessed (e.g., "list", "version")
- `cdp.request.target_url`: The URL where the request is being proxied to
- `cdp.proxy.host`: The host of the proxy
- `cdp.proxy.port`: The port of the proxy
- `cdp.response.status`: The HTTP status code of the response
- `cdp.response.type`: The response type
- `cdp.response.rewritten`: Boolean indicating if the response was rewritten (for WebSocket URLs)

### WebSocket Spans

For WebSocket connections, additional attributes are added:

- `cdp.websocket.path`: The path for the WebSocket connection
- `cdp.websocket.target`: The browser WebSocket URL being proxied to
- `cdp.websocket.client_upgrade`: Status of client WebSocket upgrade
- `cdp.websocket.client_connection`: Status of client connection
- `cdp.websocket.browser_connection`: Status of browser connection
- `cdp.websocket.connection_state`: Overall connection state
- `cdp.websocket.messages_received_from_browser`: Count of messages received from browser
- `cdp.websocket.messages_sent_to_browser`: Count of messages sent to browser
- `cdp.websocket.client_close_code`: WebSocket close code from client (if closed)
- `cdp.websocket.client_close_reason`: Close reason from client (if provided)
- `cdp.websocket.browser_close_code`: WebSocket close code from browser (if closed)
- `cdp.websocket.browser_close_reason`: Close reason from browser (if provided)

### Error Handling

When errors occur, the following attributes are added to the span:

- `error`: Set to true
- `error.type`: The type/name of the error
- `error.message`: The error message

## Enabling OpenTelemetry in Deno

OpenTelemetry in Deno is enabled via environment variables. To enable telemetry with the CDP proxy, use one of the following methods:

### Console Output

To output traces to the console:

```bash
OTEL_TRACES_EXPORTER=console deno run --allow-net --allow-env --allow-read src/main.ts
```

### OTLP (OpenTelemetry Protocol)

To send traces to an OpenTelemetry collector:

```bash
OTEL_TRACES_EXPORTER=otlp OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 deno run --allow-net --allow-env --allow-read src/main.ts
```

### Zipkin

To send traces to a Zipkin server:

```bash
OTEL_TRACES_EXPORTER=zipkin OTEL_EXPORTER_ZIPKIN_ENDPOINT=http://localhost:9411/api/v2/spans deno run --allow-net --allow-env --allow-read src/main.ts
```

## Viewing Traces

You can use various tools to view and analyze the collected traces:

1. **Jaeger**: An open-source, end-to-end distributed tracing system
2. **Zipkin**: A distributed tracing system
3. **OpenTelemetry Collector**: Collect, process, and export telemetry data
4. **Grafana Tempo**: Distributed tracing backend

For a simple local setup, you can use Docker to run a Jaeger all-in-one container:

```bash
docker run -d --name jaeger \
  -e COLLECTOR_ZIPKIN_HOST_PORT=:9411 \
  -e COLLECTOR_OTLP_ENABLED=true \
  -p 6831:6831/udp \
  -p 6832:6832/udp \
  -p 5778:5778 \
  -p 16686:16686 \
  -p 4317:4317 \
  -p 4318:4318 \
  -p 9411:9411 \
  jaegertracing/all-in-one:latest
```

Then run the CDP proxy with OTLP enabled pointing to this collector, and access the Jaeger UI at http://localhost:16686 to view your traces.

## Metrics

In addition to traces, Deno can collect metrics for HTTP servers when properly configured. Common metrics include:

- Request duration
- Active requests
- Request/response body sizes

## Custom Instrumentation

If you need to add custom spans or metrics beyond what's provided automatically, you can use the OpenTelemetry API directly:

```typescript
import { trace } from "npm:@opentelemetry/api@1";

// Create a custom span
const tracer = trace.getTracer("custom-tracer");
const span = tracer.startSpan("custom-operation");

try {
  // Perform operation
  span.setAttribute("custom.attribute", "value");
} finally {
  span.end();
}
```

## Troubleshooting

If you encounter issues with OpenTelemetry in Deno:

1. Ensure you're using a recent version of Deno (1.28 or later for OpenTelemetry support)
2. Check that the environment variables are correctly set
3. Verify that the OpenTelemetry collector or backend service is running and accessible
4. For OTLP exports, ensure that the endpoint URL is correct and includes the protocol (http/https) 
