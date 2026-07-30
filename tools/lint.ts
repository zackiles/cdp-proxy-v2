/**
 * @module lint
 * @description The lint plugin that makes §4.1 survivable: a `page` function is
 * serialized with `Function.prototype.toString()`, so it closes over nothing.
 * Every identifier it uses has to be its own `config` parameter, something it
 * declared, a page-side {@link GLOBALS global}, or one of the three helpers the
 * runtime prepends.
 *
 * The failure this catches is silent. A captured `cfg`, an imported constant, or
 * a `ctx` reference is `undefined` in the page with no error — the patch does
 * half its job and the surface reports success. The compiler cannot see it,
 * because in the module the reference resolves perfectly well.
 *
 * ```sh
 * deno task lint
 * ```
 *
 * Adding a global is a deliberate edit to {@link GLOBALS}, for the same reason
 * the page-side helper set is closed (§4.1): the alternative is an allowance
 * broad enough to admit exactly the captured module constant the rule exists to
 * reject.
 */

// deno-lint-ignore no-explicit-any
type Node = any

/** Identifiers a page function may reach for without declaring them. */
const GLOBALS = new Set([
  // the three the runtime prepends (§4.1)
  'native',
  'define',
  'noise',

  'globalThis',
  'undefined',
  'NaN',
  'Infinity',
  'arguments',
  'Object',
  'Function',
  'Array',
  'Number',
  'String',
  'Boolean',
  'Symbol',
  'BigInt',
  'Math',
  'JSON',
  'Date',
  'RegExp',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'WeakRef',
  'Promise',
  'Proxy',
  'Reflect',
  'Intl',
  'ArrayBuffer',
  'DataView',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int8Array',
  'Uint16Array',
  'Int16Array',
  'Uint32Array',
  'Int32Array',
  'Float32Array',
  'Float64Array',
  'WebAssembly',
  'parseInt',
  'parseFloat',
  'isNaN',
  'isFinite',
  'encodeURI',
  'decodeURI',
  'encodeURIComponent',
  'decodeURIComponent',
  'eval',
  'atob',
  'btoa',
  'structuredClone',
  'queueMicrotask',

  'window',
  'self',
  'document',
  'navigator',
  'screen',
  'location',
  'history',
  'console',
  'performance',
  'crypto',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'fetch',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'getComputedStyle',
  'matchMedia',
  'Headers',
  'Request',
  'Response',
  'URL',
  'URLSearchParams',
  'Blob',
  'File',
  'FileReader',
  'FormData',
  'TextEncoder',
  'TextDecoder',
  'AbortController',
  'AbortSignal',
  'Event',
  'CustomEvent',
  'EventTarget',
  'MessageChannel',
  'MessagePort',
  'MutationObserver',
  'IntersectionObserver',
  'ResizeObserver',
  'PerformanceObserver',
  'Worker',
  'SharedWorker',
  'WebSocket',
  'XMLHttpRequest',
  'Notification',
  'Image',
  'Audio',
  'OffscreenCanvas',
  'ImageData',
  'ImageBitmap',
  'Path2D',
  'DOMMatrix',
  'DOMPoint',
  'DOMRect',
  'DOMException',
  'DOMParser',
  'Node',
  'NodeFilter',
  'Text',
  'Comment',
  'Range',
  'Selection',
  'DocumentFragment',
  'ShadowRoot',
  'Element',
  'HTMLElement',
  'SVGElement',
  'HTMLCanvasElement',
  'HTMLIFrameElement',
  'HTMLScriptElement',
  'HTMLDivElement',
  'HTMLMediaElement',
  'HTMLVideoElement',
  'HTMLAudioElement',
  'CanvasRenderingContext2D',
  'OffscreenCanvasRenderingContext2D',
  'WebGLRenderingContext',
  'WebGL2RenderingContext',
  'WebGLShaderPrecisionFormat',
  'TextMetrics',
  'Navigator',
  'Screen',
  'Window',
  'Document',
  'Storage',
  'Plugin',
  'PluginArray',
  'MimeType',
  'MimeTypeArray',
  'Permissions',
  'PermissionStatus',
  'MediaDevices',
  'RTCPeerConnection',
  'AudioContext',
  'OfflineAudioContext',
  'AnalyserNode',
  'FontFace',
  'FontFaceSet',
  'CSS',
  'CSSStyleDeclaration',
  'MediaQueryList',
  'Clipboard',
  'Keyboard',
])

/** Skipped when walking: back-references and spans, neither of which are children. */
const SKIP = new Set(['constructor', 'parent', 'range', 'length', 'comments'])

const shapes = new WeakMap<object, string[]>()

/**
 * The child properties of a node.
 *
 * DANGER: `Object.keys` on a lint AST node returns nothing. The nodes are views
 * over a native buffer, so every field is a getter on the prototype and none of
 * them is an own property — a walk written the obvious way visits nothing at all
 * and the rule silently passes everything.
 */
function keys(node: Node): string[] {
  const proto = Object.getPrototypeOf(node)
  let known = shapes.get(proto)
  if (!known) {
    known = Object.getOwnPropertyNames(proto).filter((k) => !SKIP.has(k))
    shapes.set(proto, known)
  }
  return known
}

/** Walk every child node, ignoring the `parent` back-reference. */
function walk(node: Node, visit: (child: Node) => void): void {
  for (const key of keys(node)) {
    const value = node[key]
    for (const child of Array.isArray(value) ? value : [value]) {
      if (child && typeof child === 'object' && typeof child.type === 'string') {
        visit(child)
        walk(child, visit)
      }
    }
  }
}

/** Every name a binding pattern introduces: `{ a, b: [c] = d }` binds a, b, c. */
function bound(pattern: Node, into: Set<string>): void {
  if (!pattern) return
  if (pattern.type === 'Identifier') into.add(pattern.name)
  else walk(pattern, (child) => {
    if (child.type === 'Identifier') into.add(child.name)
  })
}

/**
 * Is this `Identifier` naming something, rather than reading it? `o.x`, `{ x: 1 }`
 * and `class X { x() {} }` all contain an `Identifier` that resolves against an
 * object rather than the scope.
 */
function reference(node: Node): boolean {
  const parent = node.parent
  if (!parent) return true
  if (parent.type.startsWith('TS')) return false
  if (
    (parent.type === 'MemberExpression' && parent.property === node &&
      !parent.computed) ||
    (parent.type === 'Property' && parent.key === node && !parent.computed) ||
    (parent.type === 'MethodDefinition' && parent.key === node) ||
    (parent.type === 'PropertyDefinition' && parent.key === node) ||
    parent.type === 'LabeledStatement' ||
    parent.type === 'BreakStatement' ||
    parent.type === 'ContinueStatement'
  ) {
    return false
  }
  return true
}

/**
 * Is this object literal the hooks a `surface` returns?
 *
 * Scoped by walking up to the enclosing `definePlugin({ kind: 'surface' })`
 * rather than by file path, so a `page` property that is merely called `page` —
 * the harness has one — is not held to a rule about a function it never
 * serializes.
 */
function surface(node: Node): boolean {
  for (let at = node.parent; at; at = at.parent) {
    if (at.type !== 'CallExpression') continue
    const callee = at.callee?.type === 'CallExpression'
      ? at.callee.callee
      : at.callee
    const name = callee?.type === 'Identifier' ? callee.name : undefined
    if (name !== 'definePlugin') continue
    return at.arguments?.some((arg: Node) =>
      arg.type === 'ObjectExpression' &&
      arg.properties?.some((p: Node) =>
        p.key?.name === 'kind' && p.value?.value === 'surface'
      )
    ) ?? false
  }
  return false
}

export default {
  name: 'page-function',
  rules: {
    'no-capture': {
      create(ctx: Deno.lint.RuleContext): Deno.lint.LintVisitor {
        return {
          'Property[key.name="page"]'(node: Node) {
            const fn = node.value
            if (
              node.kind === 'get' || node.kind === 'set' ||
              (fn?.type !== 'FunctionExpression' &&
                fn?.type !== 'ArrowFunctionExpression') ||
              !surface(node)
            ) {
              return
            }

            const declared = new Set<string>()
            for (const param of fn.params ?? []) bound(param, declared)
            const reads: Node[] = []

            walk(fn, (child) => {
              switch (child.type) {
                case 'VariableDeclarator':
                  return bound(child.id, declared)
                case 'FunctionDeclaration':
                case 'ClassDeclaration':
                case 'FunctionExpression':
                case 'ArrowFunctionExpression':
                  if (child.id) declared.add(child.id.name)
                  for (const p of child.params ?? []) bound(p, declared)
                  return
                case 'CatchClause':
                  return bound(child.param, declared)
                case 'ImportDefaultSpecifier':
                case 'ImportSpecifier':
                  return bound(child.local, declared)
                case 'Identifier':
                  if (reference(child)) reads.push(child)
              }
            })

            for (const read of reads) {
              if (declared.has(read.name) || GLOBALS.has(read.name)) continue
              ctx.report({
                node: read,
                message:
                  `page functions are serialized, so \`${read.name}\` is undefined in the page`,
                hint:
                  'pass it through `config`, which the runtime sends as JSON, ' +
                  'or add it to GLOBALS in tools/lint.ts if the page really does have it',
              })
            }
          },
        }
      },
    },
  },
} satisfies Deno.lint.Plugin
