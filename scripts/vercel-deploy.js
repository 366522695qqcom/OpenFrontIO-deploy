// Deploys the built static/ directory to a Vercel project via the REST API.
//
// Flow: walk static/ → sha1 each file → upload new files to /v2/files → POST
// /v13/deployments (target=production) → poll until READY.
//
// Env: VERCE_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID, optional VERCEL_PROJECT_NAME
// Usage: node scripts/vercel-deploy.js

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const staticDir = path.join(__dirname, "..", "static");

const TOKEN = process.env.VERCE_TOKEN;
const TEAM_ID = process.env.VERCEL_TEAM_ID;
const PROJECT_ID = process.env.VERCEL_PROJECT_ID;
const PROJECT_NAME = process.env.VERCEL_PROJECT_NAME ?? "openfront";

if (!TOKEN || !TEAM_ID || !PROJECT_ID) {
  console.error(
    "Missing required env: VERCE_TOKEN, VERCEL_TEAM_ID, VERCEL_PROJECT_ID",
  );
  process.exit(1);
}

// Local record of file shas we've already uploaded to this team's blob store.
// Vercel keeps uploaded blobs across deployments, so a later deploy only needs
// to upload files whose content (sha) changed — the manifest can reference
// previously-uploaded shas. Re-uploading the whole tree every time quickly
// exhausts the Hobby "api-upload-free" daily cap (~5000 uploads), so skipping
// unchanged shas keeps redeploys cheap and stays within quota.
const uploadLogPath = path.join(__dirname, ".vercel-uploaded.json");
let knownShas = new Set();
try {
  const existing = JSON.parse(fs.readFileSync(uploadLogPath, "utf8"));
  knownShas = new Set(existing);
  console.log(`Loaded ${knownShas.size} previously-uploaded file shas.`);
} catch {
  // No cache yet — first run uploads everything.
}

function persistUploadLog() {
  try {
    fs.writeFileSync(
      uploadLogPath,
      JSON.stringify([...knownShas].sort(), null, 0),
      "utf8",
    );
  } catch (err) {
    console.warn(`Failed to persist upload log: ${err.message}`);
  }
}

const API = "https://api.vercel.com";

async function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...(await walk(full)));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

async function uploadFile(filePath, sha, rel) {
  const content = fs.readFileSync(filePath);
  const res = await fetch(`${API}/v2/files?teamId=${TEAM_ID}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "x-vercel-digest": sha,
    },
    body: content,
  });
  if (!res.ok && res.status !== 200) {
    const text = await res.text();
    // 200/201 indicate success. Retryable-ish errors bubble up.
    throw new Error(
      `Upload failed for ${rel}: ${res.status} ${text.slice(0, 200)}`,
    );
  }
}

// The pre-generated map binaries under _assets/maps/ total ~568MB, which far
// exceeds Vercel's Hobby static-upload limit (100MB). They are loaded on-demand
// at runtime (not on initial page load) and in the production architecture are
// served from the CDN/R2, not the app bundle. Exclude them so the deployment
// fits within the limit; everything else (shell, JS/CSS, flags, images,
// fonts, manifest) is included.
function isMapBinary(rel) {
  return rel.startsWith("_assets/maps/");
}

const allFiles = (await walk(staticDir)).filter(
  (f) => !path.basename(f).startsWith("."),
);
const files = [];
const excluded = [];
let excludedBytes = 0;
for (const f of allFiles) {
  const rel = path.relative(staticDir, f).split(path.sep).join("/");
  if (isMapBinary(rel)) {
    excluded.push(rel);
    excludedBytes += fs.statSync(f).size;
  } else {
    files.push(f);
  }
}
console.log(
  `Deploying ${files.length} files; excluded ${excluded.length} map binaries (~${(excludedBytes / 1048576).toFixed(1)} MB) to stay within Vercel's 100MB static limit.`,
);

const manifest = [];
let uploaded = 0;
let skipped = 0;

// Upload with a small concurrency limit to avoid hammering the API.
const CONCURRENCY = 10;
const queue = [...files];
let inFlight = 0;

await new Promise((resolve, reject) => {
  const next = () => {
    while (inFlight < CONCURRENCY && queue.length > 0) {
      const filePath = queue.shift();
      inFlight++;
      (async () => {
        const rel = path
          .relative(staticDir, filePath)
          .split(path.sep)
          .join("/");
        const sha = crypto
          .createHash("sha1")
          .update(fs.readFileSync(filePath))
          .digest("hex");
        manifest.push({ file: rel, sha });
        // Skip files whose content we've already uploaded to this team's blob
        // store — Vercel keeps blobs across deployments, so re-sending an
        // unchanged sha only burns the daily upload quota for no benefit.
        if (knownShas.has(sha)) {
          skipped++;
          inFlight--;
          next();
          return;
        }
        try {
          await uploadFile(filePath, sha, rel);
          knownShas.add(sha);
          uploaded++;
        } catch (err) {
          if (/already|exists/i.test(err.message)) {
            knownShas.add(sha);
            skipped++;
          } else {
            reject(err);
            return;
          }
        }
        inFlight--;
        next();
      })().catch(reject);
    }
    if (inFlight === 0 && queue.length === 0) resolve();
  };
  next();
});

// Record which blobs now exist on the server so the next deploy can skip them.
persistUploadLog();

console.log(`Uploaded ${uploaded} files (${skipped} skipped/existing)`);

const deploymentBody = {
  name: PROJECT_NAME,
  project: PROJECT_ID,
  target: "production",
  files: manifest,
  projectSettings: {
    framework: null,
    buildCommand: null,
    outputDirectory: null,
  },
};

console.log("Creating deployment...");
const depRes = await fetch(`${API}/v13/deployments?teamId=${TEAM_ID}`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(deploymentBody),
});
const depData = await depRes.json();
if (!depRes.ok) {
  console.error(
    "Deployment creation failed:",
    JSON.stringify(depData, null, 2),
  );
  process.exit(1);
}

const deploymentId = depData.id ?? depData.uid;
console.log(`Deployment created: ${deploymentId} (url: ${depData.url})`);

// Poll until READY / ERROR / CANCELED.
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 3000));
  const statusRes = await fetch(
    `${API}/v13/deployments/${deploymentId}?teamId=${TEAM_ID}`,
    { headers: { Authorization: `Bearer ${TOKEN}` } },
  );
  const status = await statusRes.json();
  const state = status.status ?? status.readyState;
  console.log(`  ...${state}`);
  if (state === "READY") {
    const url = status.url ?? depData.url;
    console.log(`Deployment READY: https://${url}`);
    console.log(`Alias: https://${depData.alias?.[0] ?? ""}`);
    process.exit(0);
  }
  if (state === "ERROR" || state === "CANCELED" || state === "ERRORED") {
    console.error("Deployment failed:", JSON.stringify(status, null, 2));
    process.exit(1);
  }
}
console.error("Timed out waiting for deployment to become ready.");
process.exit(1);
