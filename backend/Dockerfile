# OpenFront backend image (self-contained: builds the frontend, serves static + game).
#
# Adapted for Render's Metal builder:
#   - No BuildKit `--mount=type=cache` (unsupported there).
#   - Backend-only repo layout: the frontend lives in a separate branch, so the
#     build stage clones it, builds the static bundle, and drops it into ./static.
#   - The server runs directly via tsx (the master process reverse-proxies
#     /w{id} and /api/create_game to the in-container workers), so nginx and
#     supervisor are not needed.

FROM node:24-slim AS build

ENV HUSKY=0
WORKDIR /app

# git + ca-certificates are required to fetch the frontend branch below
# (without ca-certificates, git cannot verify GitHub's TLS certificate in the
# slim base image).
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Backend dependencies (installs devDeps too, which include tsx for the runtime).
COPY package*.json ./
RUN npm ci --ignore-scripts

# Build the frontend from the public `frontend` branch into ./static.
RUN git clone --depth 1 -b frontend https://github.com/366522695qqcom/OpenFrontIO-deploy.git _fe \
    && cd _fe \
    && npm ci --ignore-scripts \
    && npm run build-prod \
    && cd /app \
    && rm -rf static \
    && cp -r _fe/static ./static \
    && rm -rf _fe

# Backend source and resources (resources/maps are served at /maps by the master).
COPY tsconfig.json ./
COPY src ./src
COPY resources ./resources

# Runtime stage
FROM node:24-slim
ENV HUSKY=0
ENV NODE_ENV=production
ENV PORT=10000
ENV GAME_ENV=dev
ENV NUM_WORKERS=2
# Cloudflare's public test site key; required for the server to start but not a secret.
ENV TURNSTILE_SITE_KEY=1x00000000000000000000AA
ENV DOMAIN=openfront-backend.onrender.com
ENV GIT_COMMIT=RENDER

# ca-certificates so the server's outbound HTTPS (JWKS, privilege refresh) works.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/static ./static
COPY --from=build /app/src ./src
COPY --from=build /app/resources ./resources

EXPOSE 10000
CMD ["npx", "tsx", "src/server/Server.ts"]
