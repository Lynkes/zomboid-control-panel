FROM node:22-bookworm-slim AS client-build

WORKDIR /src
COPY package.json ./
COPY client/package.json client/package-lock.json* ./client/
RUN cd client && npm install --no-audit --prefer-offline --include=optional
COPY client/ ./client/
# Same reasoning as the root Dockerfile: the frontend and the backend must be given the SAME
# build sha, or the build-compatibility gate compares "unknown" against a real sha and blocks
# the UI. No .git and no git binary exists in either stage.
ARG PANEL_BUILD_SHA=""
ENV PANEL_BUILD_SHA=${PANEL_BUILD_SHA}
RUN cd client && npm run build

FROM cm2network/steamcmd:root

ARG PANEL_BUILD_SHA=""
ENV PANEL_BUILD_SHA=${PANEL_BUILD_SHA}

USER root
ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates gnupg lib32gcc-s1 lib32stdc++6 procps \
    && curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --prefer-offline --omit=dev

COPY server/ ./server/
COPY --from=client-build /src/client/dist ./client/dist
COPY pz-mod/ ./pz-mod/
COPY browser-extension/ ./browser-extension/
COPY docker/all-in-one/entrypoint.sh /entrypoint.sh

RUN chmod +x /entrypoint.sh \
    && mkdir -p /pz-server /pz-servers /zomboid /app/data /app/logs

# PANEL_ALL_IN_ONE tells the panel it runs in this image. The two PZ_*
# values below are what an older compose file (no pz-servers volume, only
# 16261-16262 published) gives it; the current docker-compose.yml overrides
# PZ_PUBLISHED_GAME_PORTS with its own range. The panel suggests
# PZ_EXTRA_SERVERS_PATH only when it is really a mounted volume.
ENV NODE_ENV=production \
    PANEL_ALL_IN_ONE=true \
    PZ_SERVER_PATH=/pz-server \
    PZ_SAVE_PATH=/zomboid \
    PZ_EXTRA_SERVERS_PATH=/pz-servers \
    PZ_PUBLISHED_GAME_PORTS=16261-16262 \
    PZ_SERVER_BAT=start-server.sh \
    RCON_HOST=127.0.0.1 \
    RCON_PORT=27015

EXPOSE 3001 16261-16270/udp

HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD node -e "import('http').then(h => h.get('http://localhost:3001/api/health', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1)))"

ENTRYPOINT ["/entrypoint.sh"]
