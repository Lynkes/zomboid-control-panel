#!/bin/bash
# Regression harness for the Linux service installer trusting files the panel's
# service account can rewrite (security sweep DOCKER-1). Driven by
# server/tests/linuxServiceInstallerTrust.test.js; also runnable by hand:
#
#   sudo bash server/tests/fixtures/linuxServiceInstallerTrust.sh "$PWD"
#
# Needs root on Linux with unshare, setpriv and stat. It re-executes itself in
# a private mount namespace where /opt, /usr/local/lib, /etc/systemd/system,
# /etc/passwd and /etc/group are throwaway overlays: the host is not changed.
# Prints one PASS/FAIL line per check and exits non-zero on any FAIL.
set -eu

REPO=$(cd "${1:?usage: linuxServiceInstallerTrust.sh <repo root>}" && pwd)
if [ -z "${ZCP_INSTALLER_TRUST_NS:-}" ]; then
  exec env ZCP_INSTALLER_TRUST_NS=1 unshare --mount --propagation private \
    bash "$(cd "$(dirname "$0")" && pwd)/$(basename "$0")" "$REPO"
fi

P=/opt/zomboid-panel          # the panel folder, owned by the service account
T=/usr/local/lib/zomboid-panel # the root-owned installer folder (docs Phase 6)
U=/etc/systemd/system/zomboid-panel.service
NS=/opt/.ns
PZ_UID=4242

mount -t tmpfs -o mode=755 tmpfs /opt
mount -t tmpfs -o mode=755 tmpfs /usr/local/lib
mount -t tmpfs -o mode=755 tmpfs /etc/systemd/system
mkdir -p "$NS/bin"
cp /etc/passwd "$NS/passwd"
cp /etc/group "$NS/group"
getent passwd pzuser >/dev/null ||
  echo "pzuser:x:$PZ_UID:$PZ_UID::/nonexistent:/usr/sbin/nologin" >>"$NS/passwd"
getent group pzuser >/dev/null || echo "pzuser:x:$PZ_UID:" >>"$NS/group"
mount --bind "$NS/passwd" /etc/passwd
mount --bind "$NS/group" /etc/group
printf '#!/bin/sh\necho "systemctl $*" >> %s/systemctl.log\n' "$NS" >"$NS/bin/systemctl"
chmod 755 "$NS/bin/systemctl"
export PATH="$NS/bin:$PATH"

FAILS=0
pass() { printf 'PASS %s\n' "$1"; }
fail() { printf 'FAIL %s\n' "$1"; FAILS=$((FAILS + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }
as_pzuser() { setpriv --reuid="$(id -u pzuser)" --regid="$(id -g pzuser)" --clear-groups -- "$@"; }

# Runs an installer as root; its exit status goes to $RC, its output to $OUT.
run_installer() {
  set +e
  OUT=$(sh "$@" 2>&1)
  RC=$?
  set -e
}

# docs/install/linux.md Phase 6: the release copied into /opt and handed to
# pzuser, then the installer and unit copied from the archive into a
# root-owned folder and run from there.
reset_install() {
  rm -rf "$P" "$T" "$NS/pwned" "$NS/secret" "$NS/systemctl.log"
  rm -f /etc/systemd/system/zomboid-panel.service*
  mkdir -p "$P"
  cp "$REPO/install-linux-service.sh" "$REPO/zomboid-panel.service" "$P/"
  printf '#!/bin/sh\nexec ./ZomboidControlPanel\n' >"$P/start.sh"
  printf '#!/bin/sh\n' >"$P/ZomboidControlPanel"
  chmod 755 "$P/install-linux-service.sh" "$P/start.sh" "$P/ZomboidControlPanel"
  chown -R pzuser:pzuser "$P"
  install -d -o root -g root -m 0755 "$T"
  install -o root -g root -m 0755 "$REPO/install-linux-service.sh" "$T/"
  install -o root -g root -m 0644 "$REPO/zomboid-panel.service" "$T/"
}

# --- baseline: the documented install works ---------------------------------
reset_install
run_installer "$T/install-linux-service.sh" --enable
check "documented install succeeds" '[ "$RC" -eq 0 ]'
check "documented install installs the root-owned template" 'cmp -s "$T/zomboid-panel.service" "$U"'
check "documented install enables the service" 'grep -q "enable --now zomboid-panel.service" "$NS/systemctl.log"'

# --- C1: pzuser rewrites the unit template in the panel folder ---------------
as_pzuser sed -i 's/^User=pzuser/User=root/; s/^Group=pzuser/Group=root/; s|^ExecStart=.*|ExecStartPre=/bin/sh -c "id > /root/owned"\nExecStart=/opt/zomboid-panel/start.sh|' "$P/zomboid-panel.service"
check "C1 precondition: pzuser could rewrite the panel-folder unit" 'grep -q "^User=root" "$P/zomboid-panel.service"'
run_installer "$T/install-linux-service.sh" --enable
check "C1 installed unit still runs as pzuser" 'grep -q "^User=pzuser" "$U" && ! grep -q "^User=root" "$U"'
check "C1 installed unit has no injected ExecStartPre" '! grep -q "^ExecStartPre" "$U"'
check "C1 installed unit is the root-owned template" 'cmp -s "$T/zomboid-panel.service" "$U"'

# --- the old habit: running the copy inside the panel folder as root --------
BEFORE=$(sha256sum "$U")
run_installer "$P/install-linux-service.sh" --enable
check "installer refuses to run from the pzuser-owned panel folder" '[ "$RC" -ne 0 ] && printf "%s" "$OUT" | grep -q "Refusing to run"'
check "refused run leaves the installed unit untouched" '[ "$(sha256sum "$U")" = "$BEFORE" ]'

# --- C2: pzuser rewrites the installer in the panel folder -------------------
reset_install
as_pzuser sed -i "2a id > $NS/pwned" "$P/install-linux-service.sh"
check "C2 precondition: pzuser could rewrite the panel-folder installer" 'grep -q "pwned" "$P/install-linux-service.sh"'
run_installer "$T/install-linux-service.sh" --enable
check "C2 root never runs the pzuser-writable installer" '[ ! -e "$NS/pwned" ]'

# --- C3: pzuser swaps panel-folder files for symlinks to a root-only file ----
reset_install
printf 'root:$6$ONLY-ROOT-MAY-READ:19000:0:99999:7:::\n' >"$NS/secret"
chmod 600 "$NS/secret"
as_pzuser ln -sf "$NS/secret" "$P/start.sh"
as_pzuser ln -sf "$NS/secret" "$P/zomboid-panel.service"
run_installer "$T/install-linux-service.sh" --enable
check "C3 root does not chmod through a planted symlink" '[ "$(stat -c "%a %u" "$NS/secret")" = "600 0" ]'
check "C3 the secret is not installed as the unit" '! grep -q "ONLY-ROOT-MAY-READ" "$U" 2>/dev/null'
check "C3 the secret is not echoed back" '! printf "%s" "$OUT" | grep -q "ONLY-ROOT-MAY-READ"'

# --- the trusted folder itself must be root-only ----------------------------
expect_refusal() {
  run_installer "$T/install-linux-service.sh" --enable
  check "$1" '[ "$RC" -ne 0 ] && printf "%s" "$OUT" | grep -q "Refusing to run" && [ ! -e "$U" ]'
}

reset_install
chmod 0775 "$T"
expect_refusal "refuses a group-writable installer folder"

reset_install
chown pzuser:pzuser "$T"
expect_refusal "refuses an installer folder owned by another account"

reset_install
chown pzuser:pzuser "$T/zomboid-panel.service"
expect_refusal "refuses a unit template owned by another account"

reset_install
chmod 0646 "$T/zomboid-panel.service"
expect_refusal "refuses a world-writable unit template"

reset_install
rm "$T/zomboid-panel.service"
ln -s "$P/zomboid-panel.service" "$T/zomboid-panel.service"
expect_refusal "refuses a unit template that is a symlink into the panel folder"

reset_install
chmod 0757 "$T/install-linux-service.sh"
expect_refusal "refuses a world-writable installer script"

reset_install
chown pzuser:pzuser "$T/install-linux-service.sh"
expect_refusal "refuses an installer script owned by another account"

reset_install
chmod 0777 /usr/local/lib
expect_refusal "refuses when a parent folder is writable by others"
chmod 0755 /usr/local/lib

if [ "$FAILS" -ne 0 ]; then
  printf '%s check(s) failed\n' "$FAILS"
  exit 1
fi
printf 'all checks passed\n'
