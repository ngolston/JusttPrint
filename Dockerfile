# JusttPrint server image: plain Node, no Electron.
# The server is src/server/index.js. Thumbnails render in headless Chromium (Puppeteer).

# --- Dependencies: production packages only, with better-sqlite3 built for Node ---
FROM node:22-trixie-slim AS deps

RUN apt-get update \
    && apt-get install -y --no-install-recommends g++ make python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# .npmrc sets legacy-peer-deps, which the lock file was written with.
COPY package.json package-lock.json .npmrc ./

# Electron and the build tooling are dev dependencies, so --omit=dev leaves them out.
# Puppeteer uses the system Chromium installed below instead of downloading its own.
ENV PUPPETEER_SKIP_DOWNLOAD=1
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm rebuild better-sqlite3 \
    && node -e "new (require('better-sqlite3'))(':memory:').close()" \
    && npm cache clean --force

# --- Runtime ---
FROM node:22-trixie-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Everything else; .dockerignore keeps tests, desktop build files and local data out.
COPY . .

COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    JUSTTPRINT_CHROMIUM=/usr/bin/chromium \
    NODE_ENV=production

EXPOSE 5000
# Healthy once /api/health answers on the port the server actually listens on (see src/server/healthcheck.js).
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 CMD ["node", "/app/src/server/healthcheck.js"]

ENTRYPOINT ["docker-entrypoint.sh"]
