const MAX_PROXY_REQUEST_BYTES = 1024 * 1024;
const MAX_UPSTREAM_BODY_BYTES = 512 * 1024 * 1024;
const MAX_REQUEST_HEADER_BYTES = 8 * 1024;
const MAX_UPSTREAM_METADATA_BYTES = 256 * 1024;
const UPSTREAM_HEADERS_TIMEOUT_MS = 15_000;
const UPSTREAM_IDLE_TIMEOUT_MS = 30_000;
const UPSTREAM_MAX_DURATION_MS = 15 * 60_000;
const RATE_BURST_CAPACITY = 2_400;
const RATE_REFILL_PER_MS = 2_400 / 60_000;
const MAX_TRACKED_RATE_KEYS = 4_096;
const SERVO_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 ServoBrowser/0.1 (+https://servo-browser.defcron.chatgpt.site)";
const rates = new Map<string, { tokens: number; updatedAt: number }>();

type ProxyRequest = {
  url?: unknown;
  method?: unknown;
  headers?: unknown;
  bodyBase64?: unknown;
};

function blockedAddress(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    host === "localhost" || host.endsWith(".localhost") ||
    host.endsWith(".local") || host.endsWith(".internal") ||
    host.endsWith(".test") || host === "metadata.google.internal"
  ) return true;

  const octets = host.split(".").map(Number);
  if (octets.length === 4 && octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b] = octets;
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19));
  }

  if (host.includes(":")) {
    return host === "::" || host === "::1" || host.startsWith("fc") ||
      host.startsWith("fd") || host.startsWith("fe8") ||
      host.startsWith("fe9") || host.startsWith("fea") ||
      host.startsWith("feb") || host.startsWith("ff") ||
      host.startsWith("::ffff:");
  }
  return false;
}

function parseTarget(value: unknown): URL {
  if (typeof value !== "string" || value.length > 8192) {
    throw new TypeError("A valid public HTTP(S) URL is required.");
  }
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username || url.password || blockedAddress(url)) {
    throw new TypeError("Only public HTTP(S) destinations are available through Servo.");
  }
  return url;
}

function takeRateLimit(request: Request): boolean {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const now = Date.now();
  const previous = rates.get(ip) ?? { tokens: RATE_BURST_CAPACITY, updatedAt: now };
  const elapsed = Math.max(0, now - previous.updatedAt);
  const available = Math.min(
    RATE_BURST_CAPACITY,
    previous.tokens + elapsed * RATE_REFILL_PER_MS,
  );
  if (available < 1) return false;
  rates.set(ip, { tokens: available - 1, updatedAt: now });
  if (rates.size > MAX_TRACKED_RATE_KEYS) {
    for (const [key, state] of rates) {
      if (now - state.updatedAt >= 60_000) rates.delete(key);
    }
  }
  if (rates.size > MAX_TRACKED_RATE_KEYS) {
    const oldest = rates.keys().next().value;
    if (oldest !== undefined) rates.delete(oldest);
  }
  return true;
}

function decodeBody(encoded: unknown): Uint8Array | undefined {
  if (encoded === undefined || encoded === null || encoded === "") return undefined;
  if (typeof encoded !== "string" || encoded.length > 350_000) {
    throw new RangeError("Request body exceeds 256 KiB.");
  }
  const binary = atob(encoded);
  if (binary.length > 256 * 1024) throw new RangeError("Request body exceeds 256 KiB.");
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function frameMetadata(metadata: Uint8Array): Uint8Array {
  const framed = new Uint8Array(4 + metadata.byteLength);
  new DataView(framed.buffer).setUint32(0, metadata.byteLength, false);
  framed.set(metadata, 4);
  return framed;
}

function streamFramedResponse(
  metadata: Uint8Array,
  upstreamBody: ReadableStream<Uint8Array> | null,
  upstreamController: AbortController,
  requestSignal: AbortSignal,
): ReadableStream<Uint8Array> {
  const prefix = frameMetadata(metadata);
  const reader = upstreamBody?.getReader() ?? null;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let durationTimer: ReturnType<typeof setTimeout> | undefined;
  let received = 0;
  let cleanedUp = false;
  let canceled = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
    if (idleTimer) clearTimeout(idleTimer);
    if (durationTimer) clearTimeout(durationTimer);
    requestSignal.removeEventListener("abort", abortForClient);
    upstreamController.signal.removeEventListener("abort", cancelUpstreamReader);
    try { reader?.releaseLock(); } catch { /* A canceled reader may already be released. */ }
  };
  const abortUpstream = (reason: unknown) => {
    if (!upstreamController.signal.aborted) upstreamController.abort(reason);
  };
  const abortForClient = () => abortUpstream(requestSignal.reason ?? new Error("The client disconnected."));
  const cancelUpstreamReader = () => {
    if (reader) void reader.cancel(upstreamController.signal.reason).catch(() => {});
  };
  const abortError = () => {
    const reason = upstreamController.signal.reason;
    return reason instanceof Error ? reason : new Error(String(reason ?? "The upstream request was aborted."));
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(prefix);
      if (!reader) {
        controller.close();
        cleanup();
        return;
      }
      requestSignal.addEventListener("abort", abortForClient, { once: true });
      upstreamController.signal.addEventListener("abort", cancelUpstreamReader, { once: true });
      if (requestSignal.aborted) {
        abortForClient();
        controller.error(abortError());
        cleanup();
        return;
      }
      durationTimer = setTimeout(() => {
        abortUpstream(new Error("The remote response exceeded the 15-minute transfer limit."));
      }, UPSTREAM_MAX_DURATION_MS);
    },
    async pull(controller) {
      if (!reader || canceled) return;
      idleTimer = setTimeout(() => {
        abortUpstream(new Error("The remote response was idle for more than 30 seconds."));
      }, UPSTREAM_IDLE_TIMEOUT_MS);
      try {
        const { done, value } = await reader.read();
        if (canceled) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = undefined;
        if (upstreamController.signal.aborted) throw abortError();
        if (done) {
          controller.close();
          cleanup();
          return;
        }
        received += value.byteLength;
        if (received > MAX_UPSTREAM_BODY_BYTES) {
          throw new RangeError("The remote response exceeds 512 MiB.");
        }
        controller.enqueue(value);
      } catch (error) {
        if (canceled) return;
        abortUpstream(error);
        cleanup();
        controller.error(error);
      }
    },
    async cancel(reason) {
      canceled = true;
      abortUpstream(reason ?? new Error("The client canceled the response."));
      try { await reader?.cancel(reason); } catch { /* The stream is already canceled. */ }
      cleanup();
    },
  });
}

function reply(status: number, message: string): Response {
  return Response.json({ error: message }, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

export async function POST(request: Request): Promise<Response> {
  const origin = request.headers.get("origin");
  if (origin !== new URL(request.url).origin) return reply(403, "Same-origin Servo requests only.");
  if (!takeRateLimit(request)) return reply(429, "Servo network request rate limit reached; retry shortly.");
  const declaredSize = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_PROXY_REQUEST_BYTES) {
    return reply(413, "Servo proxy request is too large.");
  }

  let input: ProxyRequest;
  try {
    const text = await request.text();
    if (new TextEncoder().encode(text).byteLength > MAX_PROXY_REQUEST_BYTES) {
      return reply(413, "Servo proxy request is too large.");
    }
    input = JSON.parse(text) as ProxyRequest;
  } catch {
    return reply(400, "Invalid Servo proxy request.");
  }

  let target: URL;
  let body: Uint8Array | undefined;
  try {
    target = parseTarget(input.url);
    body = decodeBody(input.bodyBase64);
  } catch (error) {
    return reply(400, error instanceof Error ? error.message : "Invalid Servo proxy request.");
  }

  const method = typeof input.method === "string" ? input.method.toUpperCase() : "";
  if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(method)) {
    return reply(405, "This HTTP method is not supported.");
  }
  if ((method === "GET" || method === "HEAD") && body?.length) {
    return reply(400, "GET and HEAD requests cannot include a body.");
  }

  if (!Array.isArray(input.headers) || input.headers.length > 128) {
    return reply(400, "Invalid Servo request headers.");
  }
  const headers = new Headers();
  let headerBytes = 0;
  // These are headers supplied by the Servo runtime. Cookie and Authorization
  // are forwarded only when Servo's request credentials policy adds them; the
  // Site's own incoming browser cookies are never copied upstream.
  const denied = new Set([
    "connection", "content-length", "host", "keep-alive", "proxy-authorization",
    "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
  ]);
  try {
    for (const pair of input.headers) {
      if (!Array.isArray(pair) || pair.length !== 2 ||
          typeof pair[0] !== "string" || typeof pair[1] !== "string") {
        return reply(400, "Invalid Servo request headers.");
      }
      const name = pair[0].toLowerCase();
      if (denied.has(name) || name.startsWith("cf-") ||
          name.startsWith("x-forwarded-")) continue;
      headerBytes += pair[0].length + pair[1].length;
      if (headerBytes > MAX_REQUEST_HEADER_BYTES) return reply(400, "Servo request headers exceed 8 KiB.");
      headers.append(name, pair[1]);
    }
  } catch {
    return reply(400, "Invalid Servo request headers.");
  }
  if (!headers.has("user-agent")) headers.set("user-agent", SERVO_USER_AGENT);

  // Servo performs CORS checks in the WASM module. Forward the original
  // Origin and preflight headers to the destination so its actual CORS policy
  // decides whether credentialed requests and their preflights are allowed.
  const controller = new AbortController();
  let headersTimeout: ReturnType<typeof setTimeout> | undefined = setTimeout(
    () => controller.abort("Servo upstream response headers timed out"),
    UPSTREAM_HEADERS_TIMEOUT_MS,
  );
  const cancel = () => controller.abort(request.signal.reason);
  request.signal.addEventListener("abort", cancel, { once: true });
  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
      // Responses can vary by Cookie and Origin. Keep shared Cloudflare caches
      // out of this cross-session browser transport.
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
    if (headersTimeout) clearTimeout(headersTimeout);
    headersTimeout = undefined;
    const declaredLength = Number(upstream.headers.get("content-length"));
    if (method !== "HEAD" && Number.isFinite(declaredLength) && declaredLength > MAX_UPSTREAM_BODY_BYTES) {
      await upstream.body?.cancel();
      return reply(502, "The remote response exceeds 512 MiB.");
    }
    const setCookies = upstream.headers.getSetCookie?.() ?? [];
    const safeHeaders = [...upstream.headers.entries()].filter(([name]) =>
      !["content-length", "content-encoding", "set-cookie"].includes(name.toLowerCase()));
    const metadataBytes = new TextEncoder().encode(JSON.stringify({
      status: upstream.status,
      statusText: upstream.statusText,
      url: upstream.url || target.href,
      headers: safeHeaders,
      setCookies,
    }));
    if (metadataBytes.byteLength > MAX_UPSTREAM_METADATA_BYTES) {
      await upstream.body?.cancel();
      return reply(502, "The remote response metadata exceeds 256 KiB.");
    }
    if (method === "HEAD") await upstream.body?.cancel();
    return new Response(streamFramedResponse(
      metadataBytes,
      method === "HEAD" ? null : upstream.body,
      controller,
      request.signal,
    ), {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/octet-stream",
        "x-servo-metadata-format": "1",
      },
    });
  } catch (error) {
    const message = controller.signal.aborted
      ? "The remote request timed out or was cancelled."
      : error instanceof RangeError
        ? error.message
        : "The remote site could not be fetched.";
    return reply(controller.signal.aborted ? 504 : 502, message);
  } finally {
    if (headersTimeout) clearTimeout(headersTimeout);
    request.signal.removeEventListener("abort", cancel);
  }
}

export async function OPTIONS(request: Request): Promise<Response> {
  return request.headers.get("origin") === new URL(request.url).origin
    ? new Response(null, { status: 204, headers: { allow: "POST, OPTIONS" } })
    : reply(403, "Same-origin Servo requests only.");
}
