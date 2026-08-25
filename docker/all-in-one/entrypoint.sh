#!/bin/bash
set -e

STEAM_UID=1000
STEAM_GID=1000
STEAM_HOME=/home/steam
STEAMCMD=/home/steam/steamcmd/steamcmd.sh
PZ_APPID=380870

chown -R ${STEAM_UID}:${STEAM_GID} /pz-server /zomboid /app/data /app/logs "$STEAM_HOME" 2>/dev/null || true

if [ ! -x "$STEAMCMD" ]; then
  echo "[entrypoint] ERROR: steamcmd not found at $STEAMCMD" >&2
  exit 1
fi

if [ ! -f /pz-server/start-server.sh ]; then
  echo "[entrypoint] No PZ install found in /pz-server; installing as steam..."
  su steam -s /bin/bash -c "export HOME='$STEAM_HOME'; exec $STEAMCMD +force_install_dir /pz-server +login anonymous +app_update $PZ_APPID validate +quit"
else
  echo "[entrypoint] Existing PZ install found in /pz-server."
fi

chown -R ${STEAM_UID}:${STEAM_GID} /pz-server
chmod +x /pz-server/start-server.sh 2>/dev/null || true

cd /app
exec su steam -s /bin/bash -c "export HOME='$STEAM_HOME'; cd /app && exec node server/index.js"