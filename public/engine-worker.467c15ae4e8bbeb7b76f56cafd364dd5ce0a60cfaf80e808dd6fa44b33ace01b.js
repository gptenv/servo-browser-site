import { createServoWorkerRuntime } from './worker-adapter.10eec8c619576f8c5d1e052e9d046a40752f022f61c417419a9225ca89c5fedf.mjs';
import { createServoMediaHost } from './servo-media-engine.bundle.mjs';

const SERVO_WASM_ASSET = './servo_js_wasm.ba1c248d9606c39496996cfc0c55a195a745418cae2448d7ead29d145c62ac2c.wasm.gz';
const sessions = new Map();
const mediaHosts = new Map();
const mediaPumpControls = new Map();
const mediaPumpRequests = new Map();
const queues = new Map();
let wasmModule;
let wasmPromise;

const SINGLE_TAB_LINK_FALLBACK = `(() => {
  const marker = '__servoBrowserSingleTabLinkFallback';
  if (window[marker]) return true;
  Object.defineProperty(window, marker, { value: true });
  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.ctrlKey ||
        event.metaKey || event.shiftKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target : event.target?.parentElement;
    const anchor = target?.closest?.('a[href]');
    if (!anchor) return;
    const browsingContext = (anchor.getAttribute('target') || '').trim().toLowerCase();
    if (!browsingContext || browsingContext === '_self' ||
        browsingContext === '_parent' || browsingContext === '_top') return;
    event.preventDefault();
    window.location.assign(anchor.href);
  }, true);
  return true;
})()`;

const capabilitiesFallback = {
  supported: ['navigation', 'mouse-keyboard-input', 'html-dom', 'javascript', 'cssom', 'computed-style', 'layout-measurements', 'timers', 'microtasks', 'fetch', 'canvas-2d', 'image-decoding', 'font-registration', 'cpu-screenshots', 'local-session-storage', 'request-animation-frame', 'websocket-transport', 'indexeddb', 'cache-storage-lifecycle'],
  partial: { mediaElements: 'Progressive audio/video playback uses Mediabunny for demux and browser WebCodecs for decoding. Playback depends on browser codec support; only primary tracks are used. Audio output uses the embedding page audio device, while video uses Servo’s renderer. MSE, HLS/DASH, DRM, random-access seeking, and Servo’s general Web Audio API graph are not provided.' },
  unsupported: ['service-workers', 'dedicated-shared-workers', 'webgl', 'webgpu', 'web-audio', 'streaming-request-bodies'],
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
    const response = await fetch(new URL(SERVO_WASM_ASSET, self.location.href));
    if (!response.ok) throw new Error(`Could not load the embedded Servo WASM (${response.status}).`);
    if (!('DecompressionStream' in self)) throw new Error('This browser does not support gzip decompression required by the embedded Servo module.');
    const bytes = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    wasmModule = await WebAssembly.compile(bytes);
    return wasmModule;
  })();
  return wasmPromise;
}

async function pump(runtime, maxDurationMs = Infinity) {
  const result = await runtime.pumpUntilSettled({ maxDurationMs, maxTurns: Infinity, networkIdleMs: 250 });
  if (!result.settled) throw new Error(`Servo did not settle within ${maxDurationMs} ms.`);
}

function parsePageResult(value) {
  if (value && typeof value === 'object' && 'Ok' in value) {
    const string = value.Ok?.String;
    if (typeof string === 'string') { try { return JSON.parse(string); } catch { return string; } }
  }
  return value;
}

async function pumpBriefly(runtime, maxDurationMs = Infinity) {
  return runtime.pumpUntilSettled({
    maxDurationMs,
    maxTurns: Infinity,
    networkIdleMs: 100,
  });
}

async function pageSummary(runtime, maxDurationMs = Infinity) {
  const result = await runtime.evaluate(`(() => {
    const body = document.body;
    const textParts = [];
    try {
      const walker = body && document.createTreeWalker(body, 4);
      let node;
      while (walker && (node = walker.nextNode())) {
        let parent = node.parentElement;
        let ignored = false;
        while (parent && parent !== body) {
          const tag = parent.tagName;
          if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'SVG') {
            ignored = true;
            break;
          }
          parent = parent.parentElement;
        }
        if (ignored || typeof node.nodeValue !== 'string') continue;
        const text = node.nodeValue.trim();
        if (text) {
          textParts.push(text);
        }
      }
    } catch { /* Keep URL/title inspection available if text traversal is unsupported. */ }
    return JSON.stringify({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      navigationId: performance.timeOrigin,
      text: textParts.join(' '),
    });
  })()`, { maxDurationMs });
  if (result?.Err) throw new Error(`Servo page inspection failed: ${result.Err}`);
  const page = parsePageResult(result);
  if (!page || typeof page !== 'object' || typeof page.url !== 'string') throw new Error('Servo returned an invalid page summary.');
  return page;
}

function b64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

async function readProxyEnvelope(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Servo network proxy returned no response envelope.');
  let buffered = new Uint8Array();
  async function readExactly(length) {
    while (buffered.byteLength < length) {
      const { done, value } = await reader.read();
      if (done) throw new Error('Servo network proxy returned a truncated response envelope.');
      const next = new Uint8Array(buffered.byteLength + value.byteLength);
      next.set(buffered);
      next.set(value, buffered.byteLength);
      buffered = next;
    }
    const result = buffered.subarray(0, length);
    buffered = buffered.subarray(length);
    return result;
  }

  const lengthBytes = await readExactly(4);
  const metadataLength = new DataView(lengthBytes.buffer, lengthBytes.byteOffset, 4).getUint32(0, false);
  if (metadataLength === 0) {
    await reader.cancel();
    throw new RangeError('Servo network proxy response metadata is empty.');
  }
  const metadataBytes = await readExactly(metadataLength);
  const metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
  const body = new ReadableStream({
    start(controller) {
      if (buffered.byteLength) controller.enqueue(buffered);
      buffered = new Uint8Array();
    },
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          reader.releaseLock();
          controller.close();
        } else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return { metadata, body };
}

async function createSession(options = {}) {
  if (options.url && options.html !== undefined) throw new TypeError('Provide a URL or inline HTML, not both.');
  if (options.url) assertPublicUrl(options.url);
  const dimension = (value, fallback) => {
    const result = Math.trunc(value ?? fallback);
    if (!Number.isSafeInteger(result) || result < 1 || result > 0xffff_ffff) {
      throw new RangeError('Viewport dimensions must fit positive 32-bit unsigned values.');
    }
    return result;
  };
  const width = dimension(options.width, 1280);
  const height = dimension(options.height, 720);
  const sessionId = crypto.randomUUID();
  let runtime;
  let mediaPumpTimer = null;
  let mediaPumpPending = false;
  let mediaPumpRunning = false;
  let mediaPumpDisposed = false;
  let framePending = false;
  let lastFrameAt = 0;
  let nextPumpDelayMs = 0;
  const frameRefreshIntervalMs = 100;
  const disposeMediaPump = () => {
    mediaPumpDisposed = true;
    mediaPumpPending = false;
    if (mediaPumpTimer !== null) clearTimeout(mediaPumpTimer);
    mediaPumpTimer = null;
  };
  // Network and decoder callbacks can arrive after a tool call returns. Pump
  // one turn at a time so page input stays responsive while requests stream;
  // coalesce document redraws to a modest presentation cadence.
  const scheduleMediaPump = (render = false, delayMs = 0) => {
    if (mediaPumpDisposed) return;
    mediaPumpPending = true;
    framePending ||= render;
    if (mediaPumpRunning || mediaPumpTimer !== null) return;
    if (!runtime || !sessions.has(sessionId)) return;
    const frameDelay = framePending
      ? Math.max(0, frameRefreshIntervalMs - (performance.now() - lastFrameAt))
      : 0;
    mediaPumpTimer = setTimeout(() => {
      mediaPumpTimer = null;
      if (mediaPumpDisposed || !runtime || !sessions.has(sessionId) || mediaPumpRunning) return;
      mediaPumpRunning = true;
      mediaPumpPending = false;
      const shouldRender = framePending;
      framePending = false;
      void withSession(sessionId, async (activeRuntime) => {
        // Advance one browser turn at a time. A long-running network request
        // must not hold the session lock and block clicks, scrolls, or newer
        // frames until its entire body has arrived.
        const png = shouldRender
          ? await activeRuntime.screenshot({ waitForResources: false })
          : null;
        // Screenshot capture pumps Servo too. Read the status afterward so
        // newly queued timers, fetches, and paint work keep the loop alive.
        const status = activeRuntime.pumpStatus();
        const timerDelayMs = activeRuntime.nextTimerDelayMs();
        const pendingFetches = activeRuntime.pendingFetchCount();
        return { status, timerDelayMs, pendingFetches, png };
      }).then(({ status, timerDelayMs, pendingFetches, png }) => {
        if (png && !mediaPumpDisposed && sessions.has(sessionId)) {
          lastFrameAt = performance.now();
          postMessage({ type: 'frame', sessionId, png }, [png.buffer]);
        }
        if (status.progressed || timerDelayMs !== null || status.fetches > 0 || pendingFetches > 0) {
          mediaPumpPending = true;
          framePending = true;
          nextPumpDelayMs = timerDelayMs === null
            ? (status.fetches > 0 || pendingFetches > 0 ? 100 : 16)
            : Math.max(4, timerDelayMs);
        }
      }).catch((error) => {
        if (!mediaPumpDisposed) {
          const waitingForFirstFrame = String(error?.message ?? error).includes('first rendered frame');
          if (!waitingForFirstFrame) {
            postMessage({ type: 'log', text: `Servo media pump failed: ${String(error?.message ?? error)}` });
          }
          if (runtime?.trapped) disposeMediaPump();
          else if (waitingForFirstFrame) {
            // A navigation can reach this pump before layout has produced its
            // first display list. Retry at a calm cadence instead of leaving
            // the previous page frame on screen indefinitely.
            mediaPumpPending = true;
            framePending = true;
            nextPumpDelayMs = 250;
          }
        }
      }).finally(() => {
        mediaPumpRunning = false;
        if (mediaPumpPending) {
          const delay = nextPumpDelayMs;
          nextPumpDelayMs = 0;
          scheduleMediaPump(framePending, delay);
        }
      });
    }, Math.max(delayMs, frameDelay));
  };
  const mediaHost = createServoMediaHost({
    emit: (message, transfer = []) => {
      if (message.type === 'media-activity' || message.type === 'media-state') scheduleMediaPump(true);
      if (message.type !== 'media-activity') postMessage({ ...message, sessionId }, transfer);
    },
  });
  try {
    runtime = await createServoWorkerRuntime(await compileWasm(), {
      width,
      height,
      mediaHost,
      onActivity: () => scheduleMediaPump(true),
      fetchImpl: async (input, init = {}) => {
        const url = assertPublicUrl(input instanceof Request ? input.url : String(input));
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
        let metadata;
        let proxiedBody = response.body;
        if (response.headers.get('x-servo-metadata-format') === '1') {
          ({ metadata, body: proxiedBody } = await readProxyEnvelope(response));
        } else {
          const encodedMetadata = response.headers.get('x-servo-upstream');
          if (!encodedMetadata) throw new Error('Servo network proxy returned no response metadata.');
          const metadataBinary = atob(encodedMetadata);
          const metadataBytes = Uint8Array.from(metadataBinary, (char) => char.charCodeAt(0));
          metadata = JSON.parse(new TextDecoder().decode(metadataBytes));
        }
        const headers = new Headers(metadata.headers);
        const responseBody = method === 'HEAD' || [204, 205, 304].includes(metadata.status) ? null : proxiedBody;
        if (responseBody === null) await proxiedBody?.cancel();
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
      log: (message) => postMessage({ type: 'log', text: String(message) }),
    });
    if (options.html !== undefined) {
      if (!runtime.loadHtml(options.html)) throw new Error('Servo rejected the supplied HTML document.');
    } else if (options.url && !runtime.loadPage(options.url)) throw new Error('Servo rejected the requested URL.');
    const navigationPending = Boolean(options.url);
    if (options.html !== undefined) {
      await pumpBriefly(runtime);
    }
    const page = options.url
      ? { url: options.url, title: '', text: '', readyState: 'loading' }
      : await pageSummary(runtime);
    sessions.set(sessionId, runtime);
    mediaHosts.set(sessionId, mediaHost);
    mediaPumpControls.set(sessionId, disposeMediaPump);
    mediaPumpRequests.set(sessionId, () => scheduleMediaPump(true));
    queues.set(sessionId, Promise.resolve());
    scheduleMediaPump(true);
    return { sessionId, page, navigationPending, capabilities: runtime.capabilities(), runtime: 'servo-wasm', storage: 'this page only' };
  } catch (error) {
    // A WASM trap can leave Rust's browser RefCell borrowed. Preserve the
    // original page failure instead of calling exports on a poisoned runtime.
    if (!runtime?.trapped) runtime?.reset();
    disposeMediaPump();
    mediaHost.dispose();
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

function requestPageRender(sessionId) {
  mediaPumpRequests.get(sessionId)?.();
}

async function each(sessionsInput, operation, renderAfter = false) {
  if (!Array.isArray(sessionsInput) || !sessionsInput.length) throw new TypeError('sessions must contain at least one entry.');
  const ids = sessionsInput.map((s) => s?.sessionId);
  if (new Set(ids).size !== ids.length) throw new TypeError('Each sessionId may appear only once in a tool call.');
  return { results: await Promise.all(sessionsInput.map(async (entry) => {
    try {
      const result = await withSession(entry.sessionId, (runtime) => operation(runtime, entry));
      if (renderAfter) requestPageRender(entry.sessionId);
      return { sessionId: entry.sessionId, ok: true, result };
    }
    catch (error) { return { sessionId: entry.sessionId, ok: false, error: String(error?.message ?? error) }; }
  })) };
}

const specs = {
  servo_session_create: { title: 'Create Servo browser sessions', description: 'Start one or more isolated Servo WebAssembly browser tabs in this page. Each session has its own browser runtime.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, items: { type: 'object', properties: { url: { type: 'string', format: 'uri' }, html: { type: 'string' }, width: { type: 'integer', minimum: 1, default: 1280 }, height: { type: 'integer', minimum: 1, default: 720 }, maxDurationMs: { type: 'integer', minimum: 0 } }, additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, execute: async ({ sessions: input }) => { const results = []; for (const entry of input) { try { const result = await createSessionSerialized(entry); results.push({ sessionId: result.sessionId, ok: true, result }); } catch (error) { results.push({ ok: false, error: String(error?.message ?? error) }); } } return { results }; } },
  servo_session_status: { title: 'Check Servo sessions', description: 'Check whether selected in-page browser sessions are active.', inputSchema: { type: 'object', properties: { sessionIds: { type: 'array', minItems: 1, items: { type: 'string', format: 'uuid' } } }, required: ['sessionIds'], additionalProperties: false }, execute: async ({ sessionIds }) => ({ results: sessionIds.map((sessionId) => ({ sessionId, ok: true, result: { status: sessions.has(sessionId) ? 'active' : 'missing', runtimeAvailable: sessions.has(sessionId), resumable: false, storage: 'this page only' } })) }) },
  servo_session_close: { title: 'Close Servo sessions', description: 'Close selected browser sessions and release their Servo runtime from this page.', inputSchema: { type: 'object', properties: { sessionIds: { type: 'array', minItems: 1, items: { type: 'string', format: 'uuid' } } }, required: ['sessionIds'], additionalProperties: false }, execute: async ({ sessionIds }) => ({ results: await Promise.all(sessionIds.map(async (sessionId) => { if (!sessions.has(sessionId)) return { sessionId, ok: false, error: 'Unknown or already closed session.' }; try { mediaPumpControls.get(sessionId)?.(); await withSession(sessionId, (runtime) => runtime.reset()); mediaHosts.get(sessionId)?.dispose(); mediaPumpControls.delete(sessionId); mediaPumpRequests.delete(sessionId); mediaHosts.delete(sessionId); sessions.delete(sessionId); queues.delete(sessionId); return { sessionId, ok: true, result: { status: 'closed' } }; } catch (error) { return { sessionId, ok: false, error: String(error?.message ?? error) }; } })) }) },
  servo_navigate: { title: 'Navigate Servo tabs', description: 'Start navigation to a public HTTP(S) URL and return while Servo loads and renders it.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, url: { type: 'string', format: 'uri' }, maxDurationMs: { type: 'integer', minimum: 0 } }, required: ['sessionId', 'url'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, execute: (input) => each(input.sessions, (runtime, entry) => { const url = assertPublicUrl(entry.url); if (!runtime.loadPage(url)) throw new Error('Servo rejected the requested URL.'); return { action: 'navigate', page: { url, title: '', text: '', readyState: 'loading' }, navigationPending: true }; }, true) },
  servo_reload: { title: 'Reload Servo tabs', description: 'Reload the current page and return while Servo loads and renders it.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, maxDurationMs: { type: 'integer', minimum: 0 } }, required: ['sessionId'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, execute: (input) => each(input.sessions, (runtime) => { if (!runtime.reload()) throw new Error('Servo could not reload the current page.'); return { action: 'reload', navigationPending: true }; }, true) },
  servo_history: { title: 'Traverse Servo history', description: 'Move a selected Servo tab backward or forward in page history and return while it loads.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, direction: { type: 'string', enum: ['back', 'forward'] }, maxDurationMs: { type: 'integer', minimum: 0 } }, required: ['sessionId', 'direction'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, execute: (input) => each(input.sessions, (runtime, entry) => ({ action: entry.direction, navigationPending: entry.direction === 'back' ? runtime.goBack() : runtime.goForward() }), true) },
  servo_inspect: { title: 'Inspect Servo tabs', description: 'Read the current URL, title, and visible body text in selected Servo tabs.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' } }, required: ['sessionId'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: (input) => each(input.sessions, (runtime) => pageSummary(runtime)) },
  servo_wait: { title: 'Wait for Servo tabs', description: 'Pump selected Servo tabs until activity settles; an optional duration can be supplied.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, maxDurationMs: { type: 'integer', minimum: 0 } }, required: ['sessionId'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, execute: (input) => each(input.sessions, async (runtime, entry) => { await pump(runtime, entry.maxDurationMs ?? Infinity); return pageSummary(runtime); }, true) },
  servo_evaluate: { title: 'Evaluate JavaScript in Servo tabs', description: 'Run synchronous JavaScript in each selected Servo page and return its result. Page scripts may change page state or cause side effects.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, script: { type: 'string' }, maxDurationMs: { type: 'integer', minimum: 0 } }, required: ['sessionId', 'script'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, annotations: { untrustedContentHint: true }, execute: (input) => each(input.sessions, async (runtime, entry) => { const result = await runtime.evaluate(entry.script, { maxDurationMs: entry.maxDurationMs ?? Infinity }); return { value: parsePageResult(result), page: await pageSummary(runtime) }; }, true) },
  servo_click: { title: 'Click in Servo tabs', description: 'Send a mouse click at viewport coordinates in selected Servo tabs. Links targeting another browsing context open in the current Servo tab.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, x: { type: 'number' }, y: { type: 'number' }, button: { type: 'integer', minimum: 0, maximum: 4, default: 0 }, maxDurationMs: { type: 'integer', minimum: 0 } }, required: ['sessionId', 'x', 'y'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, execute: (input) => each(input.sessions, async (runtime, entry) => { if (entry.button === undefined || entry.button === 0) { const installed = await runtime.evaluate(SINGLE_TAB_LINK_FALLBACK, { maxDurationMs: entry.maxDurationMs ?? Infinity }); if (installed?.Err) throw new Error(`Could not prepare link navigation: ${installed.Err}`); } runtime.click(entry.x, entry.y, entry.button ?? 0); return { action: 'click', navigationPending: true }; }, true) },
  servo_type_text: { title: 'Type into Servo tabs', description: 'Type text into the focused element in selected Servo tabs.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, text: { type: 'string' }, maxDurationMs: { type: 'integer', minimum: 0 } }, required: ['sessionId', 'text'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, execute: (input) => each(input.sessions, (runtime, entry) => { runtime.typeText(entry.text); return { action: 'type', navigationPending: false }; }, true) },
  servo_press_key: { title: 'Press a key in Servo tabs', description: 'Send a keyboard key to selected Servo tabs.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, key: { type: 'string', minLength: 1 }, maxDurationMs: { type: 'integer', minimum: 0 } }, required: ['sessionId', 'key'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, execute: (input) => each(input.sessions, (runtime, entry) => { runtime.pressKey(entry.key); return { action: 'key', navigationPending: false }; }, true) },
  servo_scroll: { title: 'Scroll Servo tabs', description: 'Scroll selected Servo tabs by the given pixel offsets.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, deltaX: { type: 'number' }, deltaY: { type: 'number' }, x: { type: 'number' }, y: { type: 'number' }, maxDurationMs: { type: 'integer', minimum: 0 } }, required: ['sessionId', 'deltaX', 'deltaY'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, execute: (input) => each(input.sessions, (runtime, entry) => { runtime.scrollBy(entry.deltaX, entry.deltaY, { x: entry.x, y: entry.y }); return { action: 'scroll', navigationPending: false }; }, true) },
  servo_screenshot: { title: 'Capture Servo screenshots', description: 'Capture selected Servo tabs as PNG images without waiting for page inspection or network idle.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, fullPage: { type: 'boolean', default: false }, maxDurationMs: { type: 'integer', minimum: 0 } }, required: ['sessionId'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, annotations: { readOnlyHint: true, untrustedContentHint: true }, execute: (input) => each(input.sessions, async (runtime, entry) => ({ pngBase64: b64(await runtime.screenshot({ fullPage: entry.fullPage, maxDurationMs: entry.maxDurationMs ?? Infinity })) })) },
  servo_get_capabilities: { title: 'Get Servo capabilities', description: 'Report supported, partial, unsupported, and unverified browser features in the selected Servo tabs.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' } }, required: ['sessionId'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, annotations: { readOnlyHint: true }, execute: (input) => each(input.sessions, (runtime) => runtime.capabilities()) },
  servo_register_font: { title: 'Register a font in Servo tabs', description: 'Register a base64 encoded TTF, OTF, TTC, or OTC font file in selected Servo tabs.', inputSchema: { type: 'object', properties: { sessions: { type: 'array', minItems: 1, items: { type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' }, fontBase64: { type: 'string', minLength: 1 } }, required: ['sessionId', 'fontBase64'], additionalProperties: false } } }, required: ['sessions'], additionalProperties: false }, execute: (input) => each(input.sessions, (runtime, entry) => { const binary = atob(entry.fontBase64); const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0)); return { faces: runtime.registerFont(bytes) }; }) },
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
    postMessage({ type: 'error', id: data.id, error: String(error?.message ?? error) });
  }
};

const toolDefinitions = Object.fromEntries(Object.entries(specs).map(([name, spec]) => [name, {
  name, title: spec.title, description: spec.description, inputSchema: spec.inputSchema,
  ...(spec.annotations ? { annotations: spec.annotations } : {}),
}]));
postMessage({ type: 'ready', tools: Object.keys(specs), toolDefinitions, capabilities: capabilitiesFallback, wasmBytesCompressed: 15_265_700 });
