#!/bin/sh
set -eu

REPOSITORY="fpsacha/zomboid-control-panel"
REGISTRY="ghcr.io/fpsacha"
VERSION="${1:-}"

for required_command in docker curl tar; do
  if ! command -v "$required_command" >/dev/null 2>&1; then
    echo "Required command not found: $required_command" >&2
    exit 1
  fi
done
if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but its daemon is not available to this user." >&2
  exit 1
fi
case "$(docker info --format '{{.Architecture}}')" in
  amd64 | x86_64) ;;
  *) echo "The all-in-one image requires an amd64 Docker host." >&2; exit 1 ;;
esac

if [ -z "$VERSION" ]; then
  VERSION="$(curl --fail --location --silent --show-error \
    "https://api.github.com/repos/$REPOSITORY/releases/latest" \
    | sed -n 's/.*"tag_name": "v\([^"]*\)".*/\1/p' | head -n 1)"
fi
case "$VERSION" in
  ''|*[!0-9.]*) echo "Could not determine a valid release version. Pass it explicitly, for example: ./bootstrap.sh 1.1.4" >&2; exit 1 ;;
esac

PANEL_HOME="${PANEL_HOME:-${XDG_STATE_HOME:-$HOME/.local/state}/zomboid-panel}"
BUILD_ROOT="${BUILD_ROOT:-$PANEL_HOME/build}"
CONTEXT_DIR="$BUILD_ROOT/ctx"
SOURCE_DIR="$BUILD_ROOT/source"
LOCAL_PANEL_IMAGE="zomboid-panel-allinone:latest"
LOCAL_UPDATER_IMAGE="zomboid-panel-updater:latest"
PUBLISHED_PANEL_IMAGE="${PANEL_IMAGE_SOURCE:-$REGISTRY/zomboid-panel:aio-$VERSION}"
PUBLISHED_UPDATER_IMAGE="${UPDATER_IMAGE_SOURCE:-$REGISTRY/zomboid-panel:updater-$VERSION}"

mkdir -p "$CONTEXT_DIR"

detected_lan_ip="${PANEL_LAN_IP:-}"
if [ -z "$detected_lan_ip" ] && command -v ip >/dev/null 2>&1; then
  detected_lan_ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i == "src") { print $(i + 1); exit } }')"
fi
default_origins="http://localhost:3001"
if [ -n "$detected_lan_ip" ]; then
  default_origins="$default_origins,http://$detected_lan_ip:3001"
fi

if [ ! -f "$CONTEXT_DIR/.env" ]; then
  TOKEN="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
  cat > "$CONTEXT_DIR/.env" <<EOF
CORS_ORIGINS=${CORS_ORIGINS:-$default_origins}
TRUST_PROXY=${TRUST_PROXY:-false}
PANEL_BIND_ADDRESS=${PANEL_BIND_ADDRESS:-}
PANEL_DOCKER_UPDATER_TOKEN=$TOKEN
PANEL_BUILD_DIR=$BUILD_ROOT
PANEL_LAN_IP=$detected_lan_ip
PANEL_WAN_IP=${PANEL_WAN_IP:-}
PZ_GAME_PORTS=${PZ_GAME_PORTS:-16261-16270}
EOF
  chmod 600 "$CONTEXT_DIR/.env"
  echo "Created $CONTEXT_DIR/.env."
else
  # A hand-edited .env may not end with a newline, and each append below
  # would then join its line onto the last one.
  if [ -s "$CONTEXT_DIR/.env" ] && [ -n "$(tail -c 1 "$CONTEXT_DIR/.env")" ]; then
    printf '\n' >> "$CONTEXT_DIR/.env"
  fi
  if ! grep -q '^PANEL_BUILD_DIR=' "$CONTEXT_DIR/.env"; then
    printf '\nPANEL_BUILD_DIR=%s\n' "$BUILD_ROOT" >> "$CONTEXT_DIR/.env"
  fi
  if ! grep -q '^TRUST_PROXY=' "$CONTEXT_DIR/.env"; then
    printf 'TRUST_PROXY=false\n' >> "$CONTEXT_DIR/.env"
  fi
  # The compose file is copied over again below on every run, so a hand
  # edit to its port line is lost; the bind address lives here instead.
  # Blank publishes port 3001 on every host address, as before.
  if ! grep -q '^PANEL_BIND_ADDRESS=' "$CONTEXT_DIR/.env"; then
    printf 'PANEL_BIND_ADDRESS=%s\n' "${PANEL_BIND_ADDRESS:-}" >> "$CONTEXT_DIR/.env"
  fi
  if ! grep -q '^PANEL_LAN_IP=' "$CONTEXT_DIR/.env"; then
    printf 'PANEL_LAN_IP=%s\n' "$detected_lan_ip" >> "$CONTEXT_DIR/.env"
  fi
  # Installs from before multi-server support published only 16261-16262.
  if ! grep -q '^PZ_GAME_PORTS=' "$CONTEXT_DIR/.env"; then
    printf 'PZ_GAME_PORTS=%s\n' "${PZ_GAME_PORTS:-16261-16270}" >> "$CONTEXT_DIR/.env"
  fi
fi

# Each server uses two UDP ports in a row, so this has to be a range: A-B
# with 1024 <= A < B <= 65535.
game_ports="$(sed -n 's/^PZ_GAME_PORTS=//p' "$CONTEXT_DIR/.env" | tail -n 1)"
game_ports_valid=false
case "$game_ports" in
  *[!0-9-]*|*-*-*) ;;
  [0-9]*-[0-9]*)
    game_ports_start="${game_ports%-*}"
    game_ports_end="${game_ports#*-}"
    if [ "${#game_ports_start}" -le 5 ] && [ "${#game_ports_end}" -le 5 ] \
      && [ "$game_ports_start" -ge 1024 ] \
      && [ "$game_ports_start" -lt "$game_ports_end" ] \
      && [ "$game_ports_end" -le 65535 ]; then
      game_ports_valid=true
    fi
    ;;
esac
if [ "$game_ports_valid" != true ]; then
  echo "PZ_GAME_PORTS in $CONTEXT_DIR/.env must be a range like 16261-16270, from 1024 to 65535 with the lower port first: each server uses two ports in a row (got '$game_ports')." >&2
  exit 1
fi
if [ "$game_ports_start" -gt 16261 ] || [ "$game_ports_end" -lt 16262 ]; then
  echo "Warning: PZ_GAME_PORTS ($game_ports) leaves out 16261-16262, the first server's default game ports. Players can't reach a server whose game port is outside the range." >&2
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

curl --fail --location --silent --show-error \
  "https://github.com/$REPOSITORY/archive/refs/tags/v$VERSION.tar.gz" \
  -o "$WORK_DIR/release.tar.gz"
mkdir -p "$WORK_DIR/extract"
tar -xzf "$WORK_DIR/release.tar.gz" -C "$WORK_DIR/extract"
EXTRACTED_SOURCE="$(find "$WORK_DIR/extract" -mindepth 1 -maxdepth 1 -type d -print -quit)"
test -n "$EXTRACTED_SOURCE"
test -f "$EXTRACTED_SOURCE/docker/all-in-one/Dockerfile"

rm -rf "$SOURCE_DIR"
mv "$EXTRACTED_SOURCE" "$SOURCE_DIR"
cp "$SOURCE_DIR/docker/all-in-one/docker-compose.yml" "$CONTEXT_DIR/docker-compose.yml"

prepare_image() {
  published_image="$1"
  local_image="$2"
  dockerfile="$3"
  label="$4"
  echo "Preparing $label image..."
  if docker pull "$published_image"; then
    docker tag "$published_image" "$local_image"
    return
  fi
  echo "Published $label image is not available yet; building it locally."
  docker build -t "$local_image" -f "$SOURCE_DIR/$dockerfile" "$SOURCE_DIR"
}

prepare_image \
  "$PUBLISHED_PANEL_IMAGE" \
  "$LOCAL_PANEL_IMAGE" \
  "docker/all-in-one/Dockerfile" \
  "panel"
prepare_image \
  "$PUBLISHED_UPDATER_IMAGE" \
  "$LOCAL_UPDATER_IMAGE" \
  "docker/all-in-one/updater/Dockerfile" \
  "updater"

docker run --rm \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$BUILD_ROOT:/build" \
  -w /build/ctx \
  "$LOCAL_UPDATER_IMAGE" \
  docker compose --env-file .env -f docker-compose.yml up -d --no-build

echo "Waiting for the panel to become healthy (the first PZ install can take several minutes)..."
attempt=0
while [ "$attempt" -lt 180 ]; do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' zomboid-panel 2>/dev/null || true)"
  state="$(docker inspect --format '{{.State.Status}}' zomboid-panel 2>/dev/null || true)"
  if [ "$health" = "healthy" ]; then
    break
  fi
  if [ "$state" = "exited" ] || [ "$state" = "dead" ]; then
    echo "The panel container stopped during startup. Recent logs:" >&2
    docker logs --tail 40 zomboid-panel >&2 || true
    exit 1
  fi
  attempt=$((attempt + 1))
  sleep 5
done
if [ "$health" != "healthy" ]; then
  echo "Timed out waiting for the panel health check. Recent logs:" >&2
  docker logs --tail 40 zomboid-panel >&2 || true
  exit 1
fi

echo "All-in-one installation is ready."
bind_address="$(sed -n 's/^PANEL_BIND_ADDRESS=//p' "$CONTEXT_DIR/.env" | tail -n 1)"
case "$bind_address" in
  '' | 0.0.0.0) echo "Panel: http://${detected_lan_ip:-localhost}:3001" ;;
  *) echo "Panel: published on $bind_address:3001 only (PANEL_BIND_ADDRESS); open it through your reverse proxy" ;;
esac
echo "PZ ports: $game_ports/udp (published automatically; each server uses two in a row)"
