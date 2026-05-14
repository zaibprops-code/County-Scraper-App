# ============================================================
# Hillsborough Probate Worker — Railway Dockerfile
# Node 20 LTS + Chromium (system) + ws for WebSocket support
# ============================================================

FROM node:20-bookworm-slim

# ── System Chromium + dependencies ──────────────────────────
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

# ── Playwright: use system Chromium, skip bundled download ──
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROMIUM_PATH=/usr/bin/chromium

# ── Verify Chromium binary exists at build time ─────────────
RUN test -f /usr/bin/chromium && echo "✓ /usr/bin/chromium present" \
    || (echo "✗ /usr/bin/chromium NOT found" && exit 1)

WORKDIR /app

# ── Copy package manifest ───────────────────────────────────
COPY package.json ./

# Cache-bust argument — change value to force fresh npm install.
# On Railway: set a Build Argument CACHE_BUST with today's date.
ARG CACHE_BUST=1
RUN echo "[Docker] Cache bust value: ${CACHE_BUST}"

# ── Install ALL dependencies (including ws + devDeps for tsc) ─
RUN npm install

# ── Copy source ─────────────────────────────────────────────
COPY tsconfig.json ./
COPY src/ ./src/

# ── Verify ws package is present before compile ─────────────
RUN node -e "require('ws'); console.log('✓ ws package OK')"

# ── Compile TypeScript ───────────────────────────────────────
RUN npx tsc

# ── Prune dev dependencies ───────────────────────────────────
RUN npm prune --omit=dev

# ── Verify compiled output ───────────────────────────────────
RUN ls -la dist/ && echo "✓ dist/ contents verified"
RUN test -f dist/index.js && echo "✓ dist/index.js present" \
    || (echo "✗ dist/index.js MISSING — tsc failed" && exit 1)

# ── Runtime: ws must still be present after prune ───────────
RUN node -e "require('ws'); console.log('✓ ws available at runtime')"

# Railway injects PORT automatically; default 3001 for local dev
EXPOSE 3001

CMD ["node", "dist/index.js"]
