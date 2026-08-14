#!/bin/bash
# sync-static.sh - Build the frontend and sync its static output into the backend
# This script:
# 1. Builds the frontend (tsc --noEmit + vite build) which outputs to frontend/static/
# 2. Copies frontend/static/ into backend/static/ so the backend can self-host the frontend
#
# Maps are intentionally NOT part of this build: the split repo keeps maps only
# under backend/resources/maps, and the master serves them at /maps/<map>/...
# (the client falls back to unhashed URLs when the asset manifest omits maps).

set -euo pipefail

# Resolve the backend directory root (parent of scripts/)
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FRONTEND_DIR="$ROOT/../frontend"

echo "======================================================"
echo "🚀 Building frontend (npm run build-prod)"
echo "======================================================"
cd "$FRONTEND_DIR"
npm run build-prod

echo "======================================================"
echo "🚀 Syncing frontend/static -> backend/static"
echo "======================================================"
rm -rf "$ROOT/static"
mkdir -p "$ROOT/static"
cp -r "$FRONTEND_DIR/static/." "$ROOT/static/"

echo "======================================================"
echo "✅ Frontend static files synced to backend/static"
echo "======================================================"
