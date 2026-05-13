# ============================================================
# Hillsborough Probate Worker — Railway Dockerfile
# Node 20 + Playwright Chromium for headless browser automation
# ============================================================

FROM node:20-bookworm-slim

# Install system dependencies required by Playwright Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-driver \
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
    && rm -rf /var/lib/apt/lists/*

# Tell Playwright to use system Chromium
ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
ENV CHROMIUM_PATH=/usr/bin/chromium

WORKDIR /app

# Copy package files
COPY package.json package-lock.json* ./

# Install dependencies
# (use npm install instead of npm ci because lockfile may not exist)
RUN npm install --omit=dev

# Copy TypeScript source and config
COPY tsconfig.json ./
COPY src/ ./src/

# Install temporary build dependencies
RUN npm install --save-dev typescript @types/node @types/express ts-node

# Build TypeScript
RUN npm run build

# Remove dev dependencies after build
RUN npm prune --omit=dev

# Railway injects PORT automatically
EXPOSE 3001

CMD ["node", "dist/index.js"]
