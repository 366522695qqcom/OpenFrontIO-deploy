#!/bin/bash
# vercel-build.sh - Build command for Vercel static deployment.
#
# The repo's own build produces a static/ directory intended to be served by
# the Express/RenderHtml backend (which injects EJS locals at request time).
# On Vercel there is no Express server, so we:
#   1. Build the production bundle with Vite (outputs to static/).
#   2. Prerender static/index.html, baking the EJS locals (jwtAudience and
#      serverHost -> openfront.io) into the file via scripts/prerender-static.js.
#   3. Drop the on-demand map binaries from the output. They total ~500MB and
#      are loaded lazily at runtime (served from CDN/R2 in production), so
#      removing them keeps the deployment within Vercel's 100MB static limit.
set -euo pipefail

echo "==> [1/3] Building production bundle (vite build) ..."
npx vite build

echo "==> [2/3] Prerendering static/index.html (baking backend config) ..."
node scripts/prerender-static.js

echo "==> [3/3] Removing on-demand map binaries (over Vercel 100MB limit) ..."
rm -rf static/_assets/maps

echo "==> Vercel build complete. Output directory: static"
