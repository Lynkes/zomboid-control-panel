#!/bin/sh
set -eu

INSTALL_DIR=/opt/zomboid-panel
UNIT_TARGET=/etc/systemd/system/zomboid-panel.service
SERVICE_USER=pzuser
ENABLE_SERVICE=0
# Where docs/install/linux.md has root keep this script and its unit file.
TRUSTED_DIR=/usr/local/lib/zomboid-panel

usage() {
  printf '%s\n' \
    "Usage: sudo $TRUSTED_DIR/install-linux-service.sh [--enable]" \
    "" \
    "Installs the systemd unit stored next to this script for $INSTALL_DIR." \
    "Both files must sit in a folder only root can change (docs/install/linux.md)." \
    "The script never invokes sudo itself and never updates the panel binary."
}

for argument in "$@"; do
  case "$argument" in
    --enable) ENABLE_SERVICE=1 ;;
    --help|-h) usage; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$argument" >&2; usage >&2; exit 2 ;;
  esac
done

if [ "$(id -u)" -ne 0 ]; then
  printf '%s\n' "ERROR: Run this installer explicitly as root (for example with sudo)." >&2
  exit 1
fi

# Root runs this script and copies the unit file next to it into /etc, so
# both must come from a place no other account can change. The panel folder
# never qualifies: it belongs to the service account, and anything running as
# that account (the panel, its updater, a game server it launched) could edit
# either file, or swap it for a symlink, before root uses it.
refuse_untrusted() {
  printf 'ERROR: Refusing to run: %s\n' "$1" >&2
  printf '%s\n' \
    "Root must only run this installer, and install the unit file next to it," \
    "from a folder that no other account can change. Copy both files from the" \
    "release archive you downloaded (not from $INSTALL_DIR) into a root-owned" \
    "folder and run the copy. As root, in the folder you extracted the archive to:" \
    "  install -d -o root -g root -m 0755 $TRUSTED_DIR" \
    "  install -o root -g root -m 0755 install-linux-service.sh $TRUSTED_DIR/" \
    "  install -o root -g root -m 0644 zomboid-panel.service $TRUSTED_DIR/" \
    "  $TRUSTED_DIR/install-linux-service.sh --enable" \
    "See docs/install/linux.md, Phase 6." >&2
  exit 1
}

# $1 must be owned by root, writable by nobody else, and not a symlink; $2 is
# "file" or "dir". stat without -L reports the link itself, never its target.
require_root_only() {
  if [ -L "$1" ]; then
    refuse_untrusted "$1 is a symbolic link."
  fi
  if [ "$2" = file ] && [ ! -f "$1" ]; then
    refuse_untrusted "$1 is missing or not a regular file."
  fi
  if [ "$2" = dir ] && [ ! -d "$1" ]; then
    refuse_untrusted "$1 is not a directory."
  fi
  info=$(stat -c '%u %a' -- "$1") || refuse_untrusted "could not inspect $1."
  owner=${info%% *}
  mode=${info#* }
  if [ "$owner" != 0 ]; then
    refuse_untrusted "$1 is owned by uid $owner, not by root."
  fi
  if [ $(( 0$mode & 022 )) -ne 0 ]; then
    refuse_untrusted "$1 can be modified by users other than root (mode $mode)."
  fi
}

case "$0" in
  */*) SCRIPT_PATH=$0 ;;
  *) SCRIPT_PATH=./$0 ;;
esac
SCRIPT_PARENT=${SCRIPT_PATH%/*}
[ -n "$SCRIPT_PARENT" ] || SCRIPT_PARENT=/
SCRIPT_DIR=$(cd -P -- "$SCRIPT_PARENT" && pwd -P) ||
  refuse_untrusted "could not resolve the folder holding this installer."
UNIT_SOURCE=$SCRIPT_DIR/zomboid-panel.service

# Every folder from / down to this script's own: a writable ancestor lets its
# owner rename the folder below it away and put another in its place.
dir=$SCRIPT_DIR
while :; do
  require_root_only "$dir" dir
  [ "$dir" = / ] && break
  dir=${dir%/*}
  [ -n "$dir" ] || dir=/
done
require_root_only "$SCRIPT_DIR/${SCRIPT_PATH##*/}" file
require_root_only "$UNIT_SOURCE" file

# Read-only checks of the panel folder. Root never changes files in it:
# chmod, cp and install all follow a symlink the service account planted.
if [ ! -x "$INSTALL_DIR/ZomboidControlPanel" ]; then
  printf 'ERROR: %s/ZomboidControlPanel is missing or not executable.\n' "$INSTALL_DIR" >&2
  exit 1
fi
if [ ! -x "$INSTALL_DIR/start.sh" ]; then
  printf 'ERROR: %s/start.sh is missing or not executable. As the service account, run: chmod 0755 %s/start.sh\n' "$INSTALL_DIR" "$INSTALL_DIR" >&2
  exit 1
fi
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  printf 'ERROR: service user %s does not exist. Create it before installing the unit.\n' "$SERVICE_USER" >&2
  exit 1
fi

if [ -f "$UNIT_TARGET" ]; then
  if cmp -s "$UNIT_SOURCE" "$UNIT_TARGET"; then
    printf '%s\n' "The installed systemd unit is already current."
  else
    BACKUP="$UNIT_TARGET.backup-$(date +%Y%m%d-%H%M%S)"
    cp -p "$UNIT_TARGET" "$BACKUP"
    printf 'Backed up the existing unit to %s.\n' "$BACKUP"
    install -m 0644 "$UNIT_SOURCE" "$UNIT_TARGET"
  fi
else
  install -m 0644 "$UNIT_SOURCE" "$UNIT_TARGET"
fi

systemctl daemon-reload
if [ "$ENABLE_SERVICE" -eq 1 ]; then
  systemctl enable --now zomboid-panel.service
  printf '%s\n' "Installed, enabled, and started zomboid-panel.service."
else
  printf '%s\n' "Installed zomboid-panel.service without enabling or restarting it."
  printf '%s\n' "Run: systemctl enable --now zomboid-panel.service"
fi
