# ============================================================
# Hillsborough Probate Worker — Railway Dockerfile
# Node 20 + system Chromium + ws for Node 20 WebSocket support
# ============================================================

FROM node:20-bookworm-slim

# ── System Chromium + all required shared libraries ──────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libdbus-1-3 \
    libexpat1 \
    libxcb1 \
    libxkbcommon0 \
    libx11-6 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libpango-1.0-0 \
    libcairo2 \
    libasound2 \
    libatspi2.0-0 \
    fonts-liberation \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# ── Tell Playwright to use system Chromium ───────────────────
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROMIUM_PATH=/usr/bin/chromium

# ── Verify Chromium exists at build time (fail fast) ────────
RUN test -f /usr/bin/chromium \
    && echo "[Docker] ✓ /usr/bin/chromium confirmed" \
    || (echo "[Docker] ✗ /usr/bin/chromium NOT found — apt install failed" && exit 1)

WORKDIR /app

# ── Copy package manifest ───────────────────────────────────
COPY package.json ./

# Cache-bust: set CACHE_BUST build arg in Railway to today's date
# to force a clean npm install when dependencies change.
# Railway → Service → Settings → Build Arguments → CACHE_BUST=<date>
ARG CACHE_BUST=1
RUN echo "[Docker] Cache bust: ${CACHE_BUST}"

# ── Install ALL dependencies (ws must be in deps, not devDeps) ─
RUN npm install

# ── Verify ws is installed (must exist before compile) ───────
RUN node -e "require('ws'); console.log('[Docker] ✓ ws package installed')"

# ── Copy TypeScript source + config ─────────────────────────
COPY tsconfig.json ./
COPY src/ ./src/

# ── Compile TypeScript → dist/ ───────────────────────────────
RUN npx tsc
RUN test -f dist/index.js \
    && echo "[Docker] ✓ dist/index.js compiled successfully" \
    || (echo "[Docker] ✗ TypeScript compilation failed — dist/index.js missing" && exit 1)

# ── Prune dev dependencies ───────────────────────────────────
RUN npm prune --omit=dev

# ── Verify ws still present after prune (it must be in deps) ─
RUN node -e "require('ws'); console.log('[Docker] ✓ ws available at runtime after prune')"

# ── Verify compiled output looks correct ────────────────────
RUN ls -la dist/ && echo "[Docker] dist/ contents listed above"

# Railway sets PORT automatically; 3001 is the local default
EXPOSE 3001

CMD ["node", "dist/index.js"]
