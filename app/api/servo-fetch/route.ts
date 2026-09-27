const MAX_PROXY_REQUEST_BYTES = 1024 * 1024;
const MAX_UPSTREAM_BODY_BYTES = 8 * 1024 * 1024;
const MAX_REQUEST_HEADER_BYTES = 8 * 1024;
const MAX_UPSTREAM_METADATA_BYTES = 256 * 1024;
const UPSTREAM_TIMEOUT_MS = 15_000;
const RATE_WINDOW_MS = 60_000;
const MAX_REQUESTS_PER_WINDOW = 240;
const SERVO_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36 ServoBrowser/0.1 (+https://servo-browser.defcron.chatgpt.site)";
const rates = new Map<string, number[]>();

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
  const recent = (rates.get(ip) ?? []).filter((time) => now - time < RATE_WINDOW_MS);
  if (recent.length >= MAX_REQUESTS_PER_WINDOW) return false;
  recent.push(now);
  rates.set(ip, recent);
  if (rates.size > 4096) {
    for (const [key, values] of rates) {
      if (values.every((time) => now - time >= RATE_WINDOW_MS)) rates.delete(key);
    }
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

async function readBounded(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_UPSTREAM_BODY_BYTES) {
    await response.body?.cancel();
    throw new RangeError("The remote response exceeds 8 MiB.");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_UPSTREAM_BODY_BYTES) {
        await reader.cancel();
        throw new RangeError("The remote response exceeds 8 MiB.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function frameResponse(metadata: Uint8Array, body: Uint8Array): Uint8Array {
  const framed = new Uint8Array(4 + metadata.byteLength + body.byteLength);
  new DataView(framed.buffer).setUint32(0, metadata.byteLength, false);
  framed.set(metadata, 4);
  framed.set(body, 4 + metadata.byteLength);
  return framed;
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
  if (!takeRateLimit(request)) return reply(429, "Servo network request limit reached; wait one minute and try again.");
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
  const denied = new Set([
    "connection", "content-length", "host", "keep-alive", "proxy-authorization",
    "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade",
    "origin",
    // The Site proxy is a public, unauthenticated Worker-style transport. Do
    // not forward ambient browser credentials to arbitrary public hosts.
    "cookie",
  ]);
  try {
    for (const pair of input.headers) {
      if (!Array.isArray(pair) || pair.length !== 2 ||
          typeof pair[0] !== "string" || typeof pair[1] !== "string") {
        return reply(400, "Invalid Servo request headers.");
      }
      const name = pair[0].toLowerCase();
      if (denied.has(name) || name === "authorization" || name.startsWith("cf-") ||
          name.startsWith("x-forwarded-")) continue;
      headerBytes += pair[0].length + pair[1].length;
      if (headerBytes > MAX_REQUEST_HEADER_BYTES) return reply(400, "Servo request headers exceed 8 KiB.");
      headers.append(name, pair[1]);
    }
  } catch {
    return reply(400, "Invalid Servo request headers.");
  }
  if (!headers.has("user-agent")) headers.set("user-agent", SERVO_USER_AGENT);

  // A browser preflight is a permissions check for JavaScript running in the
  // page, not a request that needs to reach the destination. This same-origin
  // Worker endpoint authorizes Servo's bounded public requests itself and
  // supplies the corresponding CORS grant to the engine.
  const rawHeaders = input.headers as [string, string][];
  const originalHeader = (name: string): string | undefined =>
    rawHeaders.find((pair) => pair[0].toLowerCase() === name)?.[1];
  const requestedMethod = originalHeader("access-control-request-method")?.toUpperCase();
  if (method === "OPTIONS" && requestedMethod) {
    if (!/^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)$/.test(requestedMethod)) {
      return reply(405, "This HTTP method is not supported.");
    }
    const allowHeaders = originalHeader("access-control-request-headers") || "*";
    const metadataBytes = new TextEncoder().encode(JSON.stringify({
      status: 204,
      statusText: "No Content",
      url: target.href,
      headers: [
        ["access-control-allow-origin", "*"],
        ["access-control-allow-methods", requestedMethod],
        ["access-control-allow-headers", allowHeaders],
        ["access-control-expose-headers", "*"],
      ],
      setCookies: [],
    }));
    return new Response(frameResponse(metadataBytes, new Uint8Array()), {
      headers: {
        "cache-control": "no-store",
        "content-type": "application/octet-stream",
        "x-servo-metadata-format": "1",
      },
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("Servo upstream timed out"), UPSTREAM_TIMEOUT_MS);
  const cancel = () => controller.abort(request.signal.reason);
  request.signal.addEventListener("abort", cancel, { once: true });
  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
      redirect: "manual",
      signal: controller.signal,
    });
    const requestedHeaders = originalHeader("access-control-request-headers");
    const corsHeaders = [
      ["access-control-allow-origin", "*"],
      ["access-control-allow-methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"],
      ["access-control-allow-headers", requestedHeaders || "*"],
      ["access-control-expose-headers", "*"],
    ];
    const setCookies = upstream.headers.getSetCookie?.() ?? [];
    const safeHeaders = [...upstream.headers.entries()].filter(([name]) =>
      !["content-length", "content-encoding", "set-cookie"].includes(name.toLowerCase()) &&
      !name.toLowerCase().startsWith("access-control-"));
    const metadataBytes = new TextEncoder().encode(JSON.stringify({
      status: upstream.status,
      statusText: upstream.statusText,
      url: upstream.url || target.href,
      headers: [...safeHeaders, ...corsHeaders],
      setCookies,
    }));
    if (metadataBytes.byteLength > MAX_UPSTREAM_METADATA_BYTES) {
      await upstream.body?.cancel();
      return reply(502, "The remote response metadata exceeds 256 KiB.");
    }
    const responseBody = method === "HEAD" ? new Uint8Array() : await readBounded(upstream);
    return new Response(frameResponse(metadataBytes, responseBody), {
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
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", cancel);
  }
}

export async function OPTIONS(request: Request): Promise<Response> {
  return request.headers.get("origin") === new URL(request.url).origin
    ? new Response(null, { status: 204, headers: { allow: "POST, OPTIONS" } })
    : reply(403, "Same-origin Servo requests only.");
}
