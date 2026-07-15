# syntax=docker/dockerfile:1
# Multi-stage build for WebAZ (robust-heart on Railway).
#
# Why this exists: the Nixpacks builder injects EVERY Railway service variable
# into the build as an ARG/ENV, which trips BuildKit's SecretsUsedInArgOrEnv
# warning (ADMIN_KEY / RESEND_API_KEY / VAPID_PRIVATE_KEY / ...) plus the
# UndefinedVar $NIXPACKS_PATH noise. The build itself needs NO secret, so a
# plain Dockerfile that declares no secret ARG removes the warnings and keeps
# secrets out of the image layers. Railway still injects variables at RUNTIME
# regardless of builder type.

# ---- builder: full toolchain + dev deps + native compile + tsc build -------
FROM node:22-bookworm AS builder
WORKDIR /app

# better-sqlite3 is the ONLY native dependency; node-gyp needs these to compile.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

# Install with lifecycle scripts OFF: `prepare` (= npm run build) must not run
# during install (source isn't copied yet), and better-sqlite3's install script
# is skipped here then forced via `npm rebuild` against THIS image's Node ABI.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

# Compile the native module against Node 22 in this image.
RUN npm rebuild better-sqlite3

# Build the app: build:whitepaper (tsx) -> tsc -> copy static public assets.
COPY . .
RUN npm run build

# ---- runtime: slim glibc image, prod deps only, same Node major ------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# os.homedir() drives DATA_DIR (= $HOME/.webaz); the Railway volume mounts at
# /root/.webaz, so HOME MUST stay /root or the SQLite path drifts (data "loss").
ENV HOME=/root

# node_modules carries the compiled better-sqlite3 .node binary. builder and
# runtime share glibc + Node 22 (bookworm / bookworm-slim), so it is ABI-safe.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
# Runtime reads repo-root docs/ at /app/docs (public-utils.ts resolves
# ../../../docs from dist/pwa/routes -> /app/docs). /docs/REMOTE-MCP.md is
# advertised by OAuth discovery metadata, so it MUST ship in the image.
COPY --from=builder /app/docs ./docs

# Drop dev dependencies now the build is done. better-sqlite3 is a prod dep, so
# its compiled binary is kept; prune runs no install/lifecycle scripts.
RUN npm prune --omit=dev

CMD ["node", "dist/pwa/server.js"]
