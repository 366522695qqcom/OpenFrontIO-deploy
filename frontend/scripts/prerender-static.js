// Prerenders static/index.html for a static host (e.g. Vercel) where the
// Express server (RenderHtml.ts) is not running.
//
// It reproduces the same EJS locals RenderHtml.ts would inject, but with
// static-deploy defaults (no CDN_BASE, no real env). Reads the built HTML and
// asset-manifest.json from static/ and writes the resolved HTML back in place.
//
// Usage: node scripts/prerender-static.js

import ejs from "ejs";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const staticDir = path.join(__dirname, "..", "static");

const htmlPath = path.join(staticDir, "index.html");
const manifestPath = path.join(staticDir, "asset-manifest.json");

if (!fs.existsSync(htmlPath)) {
  console.error(
    `Missing built index.html at ${htmlPath}. Run the build first.`,
  );
  process.exit(1);
}

const htmlContent = fs.readFileSync(htmlPath, "utf-8");
let assetManifest = {};
if (fs.existsSync(manifestPath)) {
  try {
    assetManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (err) {
    console.warn(`Failed to parse asset-manifest.json: ${err.message}`);
  }
}

// Same shape as RenderHtml.ts locals, but with static-deploy defaults. cdnBase
// is empty so asset URLs resolve to the hashed values in the manifest (which
// are deployed alongside in static/_assets).
//
// Backend targeting: point the static frontend at the self-hosted backend
// (Railway by default, override with BACKEND_HOST). jwtAudience=<host> makes
// the client resolve the API base to https://api.<host> (and the JWKS issuer
// likewise); serverHost=<host> makes the game WebSocket target
// wss://<host>/w0. apiBase=<host> is also baked to the backend host: when set,
// account/config endpoints target https://<apiBase> directly instead of the
// fabricated https://api.<host> sub-subdomain (which has no valid TLS cert on
// self-hosted hosts) and are expected to fail open on a self-hosted backend
// (client short-circuits to bundled fallbacks, no console noise). Game HTTP
// API + maps use same-origin paths proxied to the backend by the Vercel
// project's external rewrites, so they carry no CORS. They do not block
// creating/joining/playing games. gameEnv and numWorkers must match the
// backend's GAME_ENV/NUM_WORKERS for creation rate limits and lobby routing.
const backendHost =
  process.env.BACKEND_HOST ?? "openfrontio-deploy-production.up.railway.app";
const locals = {
  gitCommit: JSON.stringify("static"),
  assetManifest: JSON.stringify(assetManifest),
  cdnBase: JSON.stringify(""),
  cdnBaseRaw: "",
  gameEnv: JSON.stringify(process.env.GAME_ENV ?? "dev"),
  numWorkers: JSON.stringify(parseInt(process.env.NUM_WORKERS ?? "2", 10)),
  turnstileSiteKey: JSON.stringify("1x00000000000000000000AA"),
  jwtAudience: JSON.stringify(backendHost),
  serverHost: JSON.stringify(backendHost),
  apiBase: JSON.stringify(backendHost),
  instanceId: JSON.stringify("static"),
  multiplayerEnabled: JSON.stringify(false),
  manifestHref: assetManifest["manifest.json"] ?? "/manifest.json",
  faviconHref: assetManifest["images/Favicon.svg"] ?? "/images/Favicon.svg",
  gameplayScreenshotUrl:
    assetManifest["images/GameplayScreenshot.png"] ??
    "/images/GameplayScreenshot.png",
  backgroundImageUrl:
    assetManifest["images/background.webp"] ?? "/images/background.webp",
  desktopLogoImageUrl:
    assetManifest["images/OpenFront.png"] ?? "/images/OpenFront.png",
  mobileLogoImageUrl: assetManifest["images/OF.png"] ?? "/images/OF.png",
};

const rendered = ejs.render(htmlContent, locals);

// Verify no unresolved EJS placeholders remain (a broken static deploy would
// silently serve raw "<%- ... %>" tokens to users).
const leftover = rendered.match(/<%-[^>]+%>/g);
if (leftover) {
  console.error(
    "Unresolved EJS placeholders remain in rendered HTML:",
    leftover,
  );
  process.exit(1);
}

fs.writeFileSync(htmlPath, rendered, "utf8");
console.log(
  `Prerendered ${htmlPath} (${(Buffer.byteLength(rendered) / 1024).toFixed(1)} KB).`,
);
