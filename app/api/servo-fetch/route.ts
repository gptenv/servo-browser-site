const CHROME_USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

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
  if (typeof value !== "string") {
    throw new TypeError("A valid public HTTP(S) URL is required.");
  }
  const url = new URL(value);
  if ((url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username || url.password || blockedAddress(url)) {
    throw new TypeError("Only public HTTP(S) destinations are available through Servo.");
  }
  return url;
}

function decodeBody(encoded: unknown): Uint8Array | undefined {
  if (encoded === undefined || encoded === null || encoded === "") return undefined;
  if (typeof encoded !== "string") throw new TypeError("Invalid Servo request body.");
  const binary = atob(encoded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function frameMetadata(metadata: Uint8Array): Uint8Array {
  if (metadata.byteLength > 0xffff_ffff) {
    throw new RangeError("Response metadata exceeds the proxy framing format.");
  }
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
  let cleanedUp = false;
  let canceled = false;

  const cleanup = () => {
    if (cleanedUp) return;
    cleanedUp = true;
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
    },
    async pull(controller) {
      if (!reader || canceled) return;
      try {
        const { done, value } = await reader.read();
        if (canceled) return;
        if (upstreamController.signal.aborted) throw abortError();
        if (done) {
          controller.close();
          cleanup();
          return;
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

  let input: ProxyRequest;
  try {
    const text = await request.text();
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

  const method = typeof input.method === "string" ? input.method : "";
  const canonicalMethod = method.toUpperCase();
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(method) ||
      ["CONNECT", "TRACE", "TRACK"].includes(canonicalMethod)) {
    return reply(405, "This HTTP method is not supported.");
  }
  if ((canonicalMethod === "GET" || canonicalMethod === "HEAD") && body?.length) {
    return reply(400, "GET and HEAD requests cannot include a body.");
  }

  if (!Array.isArray(input.headers)) {
    return reply(400, "Invalid Servo request headers.");
  }
  const headers = new Headers();
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
      headers.append(name, pair[1]);
    }
  } catch {
    return reply(400, "Invalid Servo request headers.");
  }
  // Keep the requested Chrome-compatible identity consistent even when Servo
  // supplied its own default User-Agent header.
  headers.set("user-agent", CHROME_USER_AGENT);

  // Servo performs CORS checks in the WASM module. Forward the original
  // Origin and preflight headers to the destination so its actual CORS policy
  // decides whether credentialed requests and their preflights are allowed.
  const controller = new AbortController();
  const cancel = () => controller.abort(request.signal.reason);
  request.signal.addEventListener("abort", cancel, { once: true });
  try {
    const upstream = await fetch(target, {
      method,
      headers,
      body: canonicalMethod === "GET" || canonicalMethod === "HEAD" ? undefined : body,
      // Responses can vary by Cookie and Origin. Keep shared Cloudflare caches
      // out of this cross-session browser transport.
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal,
    });
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
    if (canonicalMethod === "HEAD") await upstream.body?.cancel();
    return new Response(streamFramedResponse(
      metadataBytes,
      canonicalMethod === "HEAD" ? null : upstream.body,
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
      ? "The remote request was cancelled."
      : error instanceof RangeError
        ? error.message
        : "The remote site could not be fetched.";
    return reply(controller.signal.aborted ? 504 : 502, message);
  } finally {
    request.signal.removeEventListener("abort", cancel);
  }
}

export async function OPTIONS(request: Request): Promise<Response> {
  return request.headers.get("origin") === new URL(request.url).origin
    ? new Response(null, { status: 204, headers: { allow: "POST, OPTIONS" } })
    : reply(403, "Same-origin Servo requests only.");
}
