#!/bin/sh
set -eu

puid="${PUID:-1000}"
pgid="${PGID:-1000}"

case "$puid:$pgid" in
  *[!0-9:]* | :* | *:)
    echo "PUID and PGID must be numeric values" >&2
    exit 64
    ;;
esac

mkdir -p /app/data /app/logs
chown -R "$puid:$pgid" /app/data /app/logs

exec setpriv --reuid="$puid" --regid="$pgid" --clear-groups "$@"
