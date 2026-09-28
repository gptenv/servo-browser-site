# Servo Browser Site

Servo Browser Site runs the Servo browser engine as a WebAssembly module inside a dedicated browser Worker. It exposes browser controls in the page and registers Servo session tools through native WebMCP.

Live Site: <https://servo-browser.defcron.chatgpt.site>

## Requirements

- Node.js 22.13 or newer
- npm
- The compressed Servo WebAssembly module in `public/`, named `servo_js_wasm.<module-sha256>.wasm.gz`

The WASM module is a large generated build artifact and is intentionally excluded from Git. Its filename includes the module's SHA-256 digest so a deployment cannot accidentally keep serving an older module from the same URL. The browser Worker fetches the matching digest-named file and decompresses it before compiling the module. Obtain the module from the Servo WASM build used for this Site and name it with its SHA-256 digest before running or building locally. Both root-level and `public/` WASM bundles are ignored by Git.

## Run locally

```sh
npm ci
npm run dev
```

Open <http://localhost:5173/browser.html>, then load the embedded sample or enter a public HTTP(S) URL. The browser harness and fetch proxy reject local and private-network destinations.

Create and run the production build locally with:

```sh
npm run build
npm start
```

The build writes generated output to `dist/`, which is ignored by Git. `npm start` serves that build with Wrangler in local mode.

## How it works

1. `public/browser.html` provides navigation, rendered-page input, scrolling, fullscreen, inspection, and session controls. It replaces the displayed frame as Servo reports page activity, so visitors see content appear during navigation.
2. `scripts/engine-worker.mjs` creates isolated Servo sessions in a Web Worker, pumps them in short turns so network activity does not lock out input, and registers their native WebMCP tools. The build writes a digest-named asset in `public/`.
3. `scripts/worker-adapter.mjs` supplies the Site Worker interfaces expected by Servo WASM, including fetch, redirects, cookies, WebSockets, browser input, and activity callbacks. Screenshots capture the current frame without waiting for every page request. The build writes a digest-named asset in `public/`.
4. `app/api/servo-fetch/route.ts` performs server-side fetches for the WASM engine. It forwards Servo's request headers, restricts targets to public HTTP(S), and carries normalized response metadata in a length-prefixed body envelope. Servo applies credential and CORS rules before requests reach the proxy; Site visitor cookies are never forwarded. The application imposes no response-size, transfer-duration, idle-time, header-size, or request-rate cap. The framing format uses a 32-bit metadata length; hosting-provider quotas and available runtime memory also apply.
5. `scripts/servo-media-engine.mjs` uses Mediabunny to demux progressive media and the browser's WebCodecs APIs to decode supported audio/video codecs. Video frames return to Servo's paint path. Ordinary audio is played through an audio device in the embedding page. Host fetch and decoder activity schedule short serialized Servo pump slices while navigation and page scripts are still running. The generated Mediabunny bundle is covered by its MPL-2.0 notice in `public/LICENSE.MEDIABUNNY`; Servo does not bundle FFmpeg or a separate codec implementation.

Media playback depends on codec support in the visitor's browser and uses the primary audio/video tracks. Active players and total streamed media have no application-level count or byte cap; stream backpressure controls in-flight buffering. MSE, HLS/DASH, DRM, reliable random-access seeking, and Servo's general Web Audio API graph are not implemented.

The upstream User-Agent matches Chrome 154 on Linux so sites receive the Chrome-compatible identity requested by the project. The Site is a public browser service: page requests are proxied from the Site, and pages must not be able to access local or private network addresses.

## WebMCP tools

The page registers tools for creating, checking, and closing sessions; navigating, reloading, and traversing history; inspecting and evaluating pages; clicking, typing, pressing keys, and scrolling; taking screenshots; and reading runtime capabilities or registering fonts. Session, fetch, response-size, and default wait budgets are unlimited at the application level; a host can supply explicit finite budgets when creating the adapter runtime.

## Source and deployment

- `.openai/hosting.json` identifies the Sites project.
- Push source changes to the configured `main` branch before saving a Sites version. Production deployments are made from a saved version built from that pushed source.
- Do not commit `dist/`, `node_modules/`, or the WASM bundle. The deployment package includes the local digest-named `public/servo_js_wasm.<module-sha256>.wasm.gz` asset even though Git ignores it.

The adapter has no application-level session, subrequest, response-size, or transfer-time limits. Fetch responses stream to Servo in fixed-size transport chunks with backpressure; chunk size does not cap the total transfer. The Site proxy rejects private and local network destinations to protect the public service. Cloudflare and WebAssembly still impose their own execution, memory, and request quotas.

The Site-specific app code is covered by [`public/LICENSE.SITE`](public/LICENSE.SITE). Servo, Servo MCP, and bundled fonts keep their own notices in `public/LICENSE.SERVO`, `public/LICENSE.SERVO-MCP`, and `public/LICENSE.NOTOFONTS`.
