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

1. `public/browser.html` provides navigation, rendered-page input, scrolling, fullscreen, inspection, and session controls.
2. The digest-named `public/engine-worker.<sha256>.js` creates isolated Servo sessions in a Web Worker and registers their native WebMCP tools.
3. The digest-named `public/worker-adapter.<sha256>.mjs` supplies the Worker interfaces expected by Servo WASM, including fetch, redirects, cookies, WebSockets, and browser input.
4. `app/api/servo-fetch/route.ts` performs bounded server-side fetches for the WASM engine. It filters ambient credentials, restricts targets to public HTTP(S), limits request rates and body sizes, and carries normalized response metadata in a length-prefixed body envelope. Response metadata is capped at 256 KiB to bound header-stuffing abuse.

The upstream User-Agent identifies the product as `ServoBrowser` and includes a contact URL. The Site is a public browser service: page requests are proxied from the Site, and pages must not be able to access local or private network addresses.

## WebMCP tools

The page registers tools for creating, checking, and closing sessions; navigating, reloading, and traversing history; inspecting and evaluating pages; clicking, typing, pressing keys, and scrolling; taking screenshots; and reading runtime capabilities or registering fonts. Session and request limits are enforced by the Worker harness.

## Source and deployment

- `.openai/hosting.json` identifies the Sites project.
- Push source changes to the configured `main` branch before saving a Sites version. Production deployments are made from a saved version built from that pushed source.
- Do not commit `dist/`, `node_modules/`, or the WASM bundle. The deployment package includes the local digest-named `public/servo_js_wasm.<module-sha256>.wasm.gz` asset even though Git ignores it.

Each browser session may make up to 10,000 host subrequests. The adapter runs at most six fetches concurrently and bounds queued fetch commands to 4,096 and 8 MiB. The proxy keeps a bounded in-memory per-visitor token bucket in each active Worker isolate, with a 2,400-request burst and a refill rate of 2,400 requests per minute. These limits support asset-heavy pages while bounding memory and request bursts.

The Site-specific app code is covered by [`public/LICENSE.SITE`](public/LICENSE.SITE). Servo, Servo MCP, and bundled fonts keep their own notices in `public/LICENSE.SERVO`, `public/LICENSE.SERVO-MCP`, and `public/LICENSE.NOTOFONTS`.
