import { createServoWorkerRuntime } from './worker-adapter.mjs';

const MAX_SESSIONS = 3;
const MAX_DURATION = 15_000;
const MAX_HTML_BYTES = 1_000_000;
const MAX_SCRIPT_BYTES = 64 * 1024;
const sessions = new Map();
const queues = new Map();
let wasmModule;
let wasmPromise;

const capabilitiesFallback = {
  supported: ['navigation', 'mouse-keyboard-input', 'html-dom', 'javascript', 'cssom', 'computed-style', 'layout-measurements', 'timers', 'microtasks', 'fetch', 'canvas-2d', 'image-decoding', 'font-registration', 'cpu-screenshots', 'local-session-storage', 'request-animation-frame', 'websocket-transport', 'indexeddb', 'cache-storage-lifecycle'],
  unsupported: ['service-workers', 'dedicated-shared-workers', 'webgl', 'webgpu', 'credentialed-preflight-cors', 'streaming-request-bodies'],
};

function assertPublicUrl(value, protocols = ['http:', 'https:']) {
  const url = new URL(value);
  if (!protocols.includes(url.protocol) || url.username || url.password) throw new TypeError('Only public HTTP(S) URLs without embedded credentials are supported.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || host === '::1' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:')) {
    throw new TypeError('Local and private network addresses are not allowed.');
  }
  const parts = host.split('.').map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n) && n >= 0 && n <= 255)) {
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)) {
      throw new TypeError('Local and private network addresses are not allowed.');
    }
  }
  return url.href;
}

async function compileWasm() {
  if (wasmModule) return wasmModule;
  if (!wasmPromise) wasmPromise = (async () => {
    const response = await fetch(new URL('./servo_js_wasm.wasm.gz', self.location.href));
    if (!response.ok) throw new Error(`Could not load the embedded Servo WASM (${response.status}).`);
    if (!('DecompressionStream' in self)) throw new Error('This browser does not support gzip decompression required by the embedded Servo module.');
    const bytes = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    wasmModule = await WebAssembly.compile(bytes);
    return wasmModule;
  })();
  return wasmPromise;
}

async function pump(runtime, ms = 10_000) {
  const bounded = Math.max(100, Math.min(MAX_DURATION, ms));
  const result = await runtime.pumpUntilSettled({ maxDurationMs: bounded, maxTurns: 2_000, networkIdleMs: 250 });
  if (!result.settled) throw new Error(`Servo did not settle within ${bounded} ms.`);
}

function parsePageResult(runtime) {
  const value = runtime.pageResult();
  if (value && typeof value === 'object' && 'Ok' in value) {
    const string = value.Ok?.String;
    if (typeof string === 'string') { try { return JSON.parse(string); } catch { return string; } }
  }
  return value;
}

async function pageSummary(runtime) {
  if (!runtime.evaluatePage(`JSON.stringify({url:location.href,title:document.title,text:(document.body?.innerText||'').slice(0,20000)})`)) throw new Error('Servo rejected page inspection.');
  await pump(runtime, 10_000);
  const page = parsePageResult(runtime);
  if (!page || typeof page !== 'object' || typeof page.url !== 'string') throw new Error('Servo returned an invalid page summary.');
  return page;
}

function b64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function createSession(options = {}) {
  if (sessions.size >= MAX_SESSIONS) throw new Error(`This browser tab can hold at most ${MAX_SESSIONS} live Servo sessions at once.`);
  if (options.url && options.html !== undefined) throw new TypeError('Provide a URL or inline HTML, not both.');
  if (options.url) assertPublicUrl(options.url);
  if (options.html !== undefined && new TextEncoder().encode(options.html).byteLength > MAX_HTML_BYTES) throw new RangeError('Inline HTML exceeds 1 MiB.');
  const width = Math.max(320, Math.min(1920, Math.trunc(options.width ?? 1280)));
  const height = Math.max(240, Math.min(1600, Math.trunc(options.height ?? 720)));
  let sessionFetches = 0;
  const runtime = await createServoWorkerRuntime(await compileWasm(), {
    width, height, maxResponseBytes: 8 * 1024 * 1024, maxSubrequests: 50,
    fetchImpl: async (input, init = {}) => {
      const url = assertPublicUrl(input instanceof Request ? input.url : String(input));
      if (++sessionFetches > 50) throw new Error('This page has reached the 50-request browser-session limit.');
      const source = input instanceof Request ? input : null;
      const method = String(init.method ?? source?.method ?? 'GET').toUpperCase();
      const requestHeaders = new Headers(init.headers ?? source?.headers);
      let body = init.body;
      if (body === undefined && source && method !== 'GET' && method !== 'HEAD') {
        body = new Uint8Array(await source.clone().arrayBuffer());
      }
      if (body !== undefined && body !== null && !(body instanceof Uint8Array)) {
        body = new Uint8Array(await new Response(body).arrayBuffer());
      }
      let binary = '';
      if (body) {
        for (let offset = 0; offset < body.length; offset += 0x8000) {
          binary += String.fromCharCode(...body.subarray(offset, offset + 0x8000));
        }
      }
      const response = await fetch(new URL('/api/servo-fetch', self.location.origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          url,
          method,
          headers: [...requestHeaders],
          ...(body ? { bodyBase64: btoa(binary) } : {}),
        }),
        credentials: 'omit',
        mode: 'same-origin',
        redirect: 'manual',
        signal: init.signal ?? source?.signal,
      });
      if (!response.ok) {
        let message = `Servo network proxy returned ${response.status}.`;
        try { message = (await response.json()).error || message; } catch { /* Keep the status message. */ }
        throw new Error(message);
      }
      const encodedMetadata = response.headers.get('x-servo-upstream');
      if (!encodedMetadata) throw new Error('Servo network proxy returned no response metadata.');
      const metadataBinary = atob(encodedMetadata);
      const metadataBytes = Uint8Array.from(metadataBinary, (char) => char.charCodeAt(0));
      const metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
      const headers = new Headers(metadata.headers);
      const responseBody = [204, 205, 304].includes(metadata.status) ? null : response.body;
      if (responseBody === null) await response.body?.cancel();
      const upstream = new Response(responseBody, {
        status: metadata.status,
        statusText: metadata.statusText,
        headers,
      });
      Object.defineProperty(upstream.headers, 'getSetCookie', {
        value: () => Array.isArray(metadata.setCookies) ? metadata.setCookies : [],
      });
      Object.defineProperty(upstream, 'url', { value: metadata.url || url });
      return upstream;
    },
    log: (message) => postMessage({ type: 'log', text: String(message).slice(0, 1000) }),
  });
  const sessionId = crypto.randomUUID();
  try {
    if (options.html !== undefined) {
      if (!runtime.loadHtml(options.html)) throw new Error('Servo rejected the supplied HTML document.');
    } else if (options.url && !runtime.loadPage(options.url)) throw new Error('Servo rejected the requested URL.');
    if (options.url || options.html !== undefined) await pump(runtime, options.maxDurationMs ?? 10_000);
    const page = await pageSummary(runtime);
    sessions.set(sessionId, runtime);
    queues.set(sessionId, Promise.resolve());
    return { sessionId, page, capabilities: runtime.capabilities(), runtime: 'servo-wasm', storage: 'this page only' };
  } catch (error) {
    // A WASM trap can leave Rust's browser RefCell borrowed. Preserve the
    // original page failure instead of calling exports on a poisoned runtime.
    if (!runtime.trapped) runtime.reset();
    throw error;
  }
}

let creationQueue = Promise.resolve();
function createSessionSerialized(options) {
  const task = creationQueue.then(() => createSession(options));
  creationQueue = task.then(() => undefined, () => undefined);
  return task;
}

function withSession(id, operation) {
  const runtime = sessions.get(id);
  if (!runtime) return Promise.reject(new Error(`Unknown or closed session: ${id}`));
  const previous = queues.get(id) ?? Promise.resolve();
  const result = previous.then(() => operation(runtime));
  queues.set(id, result.then(() => undefined, () => undefined));
  return result;
}

async function each(sessionsInput, operation) {
  if (!Array.isArray(sessionsInput) || !sessionsInput.length || sessionsInput.length > 20) throw new TypeError('sessions must contain 1 to 20 entries.');
  const ids = sessionsInput.map((s) => s?.sessionId);
  if (new Set(ids).size !== ids.length) throw new TypeError('Each sessionId may appear only once in a tool call.');
  return { results: await Promise.all(sessionsInput.map(async (entry) => {
    try { return { sessionId: entry.sessionId, ok: true, result: await withSession(entry.sessionId, (runtime) => operation(runtime, entry)) }; }
    catch (error) { return { sessionId: entry.sessionId, ok: false, error: String(error?.message ?? error).slice(0, 2048) }; }
  })) };
}

const summaryAfter = async (runtime, action, maxDurationMs = 10_000) => { await pump(runtime, maxDurationMs); return { action, page: await pageSummary(runtime) }; };
const specs = {
  servo_session_create: { title: 'Create Servo browser sessions', description: 'Start one or more isolated Servo WebAssembly browser tabs in this page. Each session has its own browser runtime.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { url: { type: 'string', format: 'uri' }, html: { type: 'string', maxLength: MAX_HTML_BYTES }, width: { type: 'integer', minimum: 320, maximum: 1920, default: 1280 }, height: { type: 'integer', minimum: 240, maximum: 1600, default: 720 }, maxDurationMs: { type: 'integer', minimum: 100, maximum: MAX_DURATION, default: 10000 } }, additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, execute: async ({ sessions: input }) => { const results = []; for (const entry of input) { try { const result = await createSessionSerialized(entry); results.push({ sessionId: result.sessionId, ok: true, result }); } catch (error) { results.push({ ok: false, error: String(error?.message ?? error).slice(0, 2048) }); } } return { results }; } },
  servo_session_status: { title: 'Check Servo sessions', description: 'Check whether selected in-page browser sessions are active.', inputSchema: { type: 'object', properties: { sessionIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', format: 'uuid' } } }, required: ['sessionIds'], additionalProperties: false }, execute: async ({ sessionIds }) => ({ results: sessionIds.map((sessionId) => ({ sessionId, ok: true, result: { status: sessions.has(sessionId) ? 'active' : 'missing', runtimeAvailable: sessions.has(sessionId), resumable: false, storage: 'this page only' } })) }) },
  servo_session_close: { title: 'Close Servo sessions', description: 'Close selected browser sessions and release their Servo runtime from this page.', inputSchema: { type: 'object', properties: { sessionIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', format: 'uuid' } } }, required: ['sessionIds'], additionalProperties: false }, execute: async ({ sessionIds }) => ({ results: await Promise.all(sessionIds.map(async (sessionId) => { if (!sessions.has(sessionId)) return { sessionId, ok: false, error: 'Unknown or already closed session.' }; try { await withSession(sessionId, (runtime) => runtime.reset()); sessions.delete(sessionId); queues.delete(sessionId); return { sessionId, ok: true, result: { status: 'closed' } }; } catch (error) { return { sessionId, ok: false, error: String(error?.message ?? error) }; } })) }) },
  servo_navigate: { title: 'Navigate Servo tabs', description: 'Navigate selected Servo tabs to public HTTP(S) URLs.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, url: { type: 'string', format: 'uri' }, maxDurationMs: { type: 'integer', minimum: 100, maximum: MAX_DURATION } }, required: ['sessionId', 'url'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, execute: (input) => each(input.sessions, async (runtime, entry) => { const url = assertPublicUrl(entry.url); if (!runtime.loadPage(url)) throw new Error('Servo rejected the requested URL.'); return summaryAfter(runtime, 'navigate', entry.maxDurationMs); }) },
  servo_reload: { title: 'Reload Servo tabs', description: 'Reload the current page in selected Servo tabs.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, maxDurationMs: { type: 'integer', minimum: 100, maximum: MAX_DURATION } }, required: ['sessionId'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, execute: (input) => each(input.sessions, async (runtime, entry) => { if (!runtime.reload()) throw new Error('Servo could not reload the current page.'); return summaryAfter(runtime, 'reload', entry.maxDurationMs); }) },
  servo_history: { title: 'Traverse Servo history', description: 'Move a selected Servo tab backward or forward in page history.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, direction: { type: 'string', enum: ['back', 'forward'] }, maxDurationMs: { type: 'integer', minimum: 100, maximum: MAX_DURATION } }, required: ['sessionId', 'direction'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, execute: (input) => each(input.sessions, async (runtime, entry) => { const moved = entry.direction === 'back' ? runtime.goBack() : runtime.goForward(); if (moved) await pump(runtime, entry.maxDurationMs); return { action: entry.direction, page: await pageSummary(runtime) }; }) },
  servo_inspect: { title: 'Inspect Servo tabs', description: 'Read the current URL, title, and visible body text in selected Servo tabs.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' } }, required: ['sessionId'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: (input) => each(input.sessions, (runtime) => pageSummary(runtime)) },
  servo_wait: { title: 'Wait for Servo tabs', description: 'Pump selected Servo tabs until activity settles or the time budget expires.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, maxDurationMs: { type: 'integer', minimum: 100, maximum: MAX_DURATION, default: 1000 } }, required: ['sessionId'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, execute: (input) => each(input.sessions, async (runtime, entry) => { await pump(runtime, entry.maxDurationMs ?? 1000); return pageSummary(runtime); }) },
  servo_evaluate: { title: 'Evaluate JavaScript in Servo tabs', description: 'Run synchronous JavaScript in each selected Servo page and return its result. Page scripts may change page state or cause side effects.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, script: { type: 'string', maxLength: MAX_SCRIPT_BYTES }, maxDurationMs: { type: 'integer', minimum: 100, maximum: MAX_DURATION } }, required: ['sessionId', 'script'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, annotations: { untrustedContentHint: true }, execute: (input) => each(input.sessions, async (runtime, entry) => { if (new TextEncoder().encode(entry.script).byteLength > MAX_SCRIPT_BYTES) throw new RangeError('Script exceeds 64 KiB.'); if (!runtime.evaluatePage(entry.script)) throw new Error('Servo rejected this page evaluation.'); await pump(runtime, entry.maxDurationMs); return { value: parsePageResult(runtime), page: await pageSummary(runtime) }; }) },
  servo_click: { title: 'Click in Servo tabs', description: 'Send a mouse click at viewport coordinates in selected Servo tabs.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, x: { type: 'number' }, y: { type: 'number' }, button: { type: 'integer', minimum: 0, maximum: 4, default: 0 }, maxDurationMs: { type: 'integer', minimum: 100, maximum: MAX_DURATION } }, required: ['sessionId', 'x', 'y'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, execute: (input) => each(input.sessions, async (runtime, entry) => { runtime.click(entry.x, entry.y, entry.button ?? 0); return summaryAfter(runtime, 'click', entry.maxDurationMs); }) },
  servo_type_text: { title: 'Type into Servo tabs', description: 'Type text into the focused element in selected Servo tabs.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, text: { type: 'string', maxLength: 4096 }, maxDurationMs: { type: 'integer', minimum: 100, maximum: MAX_DURATION } }, required: ['sessionId', 'text'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, execute: (input) => each(input.sessions, async (runtime, entry) => { runtime.typeText(entry.text); return summaryAfter(runtime, 'type', entry.maxDurationMs); }) },
  servo_press_key: { title: 'Press a key in Servo tabs', description: 'Send a keyboard key to selected Servo tabs.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, key: { type: 'string', minLength: 1, maxLength: 64 }, maxDurationMs: { type: 'integer', minimum: 100, maximum: MAX_DURATION } }, required: ['sessionId', 'key'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, execute: (input) => each(input.sessions, async (runtime, entry) => { runtime.pressKey(entry.key); return summaryAfter(runtime, 'key', entry.maxDurationMs); }) },
  servo_scroll: { title: 'Scroll Servo tabs', description: 'Scroll selected Servo tabs by the given pixel offsets.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, deltaX: { type: 'number' }, deltaY: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, maxDurationMs: { type: 'integer', minimum: 100, maximum: MAX_DURATION } }, required: ['sessionId', 'deltaX', 'deltaY'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, execute: (input) => each(input.sessions, async (runtime, entry) => { runtime.scrollBy(entry.deltaX, entry.deltaY, { x: entry.x, y: entry.y }); return summaryAfter(runtime, 'scroll', entry.maxDurationMs); }) },
  servo_screenshot: { title: 'Capture Servo screenshots', description: 'Capture selected Servo tabs as PNG images and return base64 image data with page details.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, fullPage: { type: 'boolean', default: false }, maxDurationMs: { type: 'integer', minimum: 100, maximum: MAX_DURATION, default: 5000 } }, required: ['sessionId'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: (input) => each(input.sessions, async (runtime, entry) => ({ page: await pageSummary(runtime), pngBase64: b64(await runtime.screenshot({ fullPage: entry.fullPage, maxDurationMs: entry.maxDurationMs ?? 5000 })) })) },
  servo_get_capabilities: { title: 'Get Servo capabilities', description: 'Report supported, partial, unsupported, and unverified browser features in the selected Servo tabs.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' } }, required: ['sessionId'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, annotations: { readOnlyHint: true }, execute: (input) => each(input.sessions, (runtime) => runtime.capabilities()) },
  servo_register_font: { title: 'Register a font in Servo tabs', description: 'Register a base64 encoded TTF, OTF, TTC, or OTC font file in selected Servo tabs. Fonts may be up to 32 MiB.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, fontBase64: { type: 'string', minLength: 1, maxLength: 44739244 } }, required: ['sessionId', 'fontBase64'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, execute: (input) => each(input.sessions, (runtime, entry) => { const binary = atob(entry.fontBase64); const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0)); return { faces: runtime.registerFont(bytes) }; }) },
};

async function invoke(name, input) {
  const spec = specs[name];
  if (!spec) throw new Error(`Unknown Servo tool: ${name}`);
  return spec.execute(input ?? {});
}

onmessage = async ({ data }) => {
  if (data?.type !== 'call') return;
  try {
    const result = await invoke(data.name, data.input);
    postMessage({ type: 'result', id: data.id, result });
  } catch (error) {
    postMessage({ type: 'error', id: data.id, error: String(error?.message ?? error).slice(0, 2048) });
  }
};

const toolDefinitions = Object.fromEntries(Object.entries(specs).map(([name, spec]) => [name, {
  name, title: spec.title, description: spec.description, inputSchema: spec.inputSchema,
  ...(spec.annotations ? { annotations: spec.annotations } : {}),
}]));
postMessage({ type: 'ready', tools: Object.keys(specs), toolDefinitions, capabilities: capabilitiesFallback, wasmBytesCompressed: 20_500_000, maxSessions: MAX_SESSIONS });
