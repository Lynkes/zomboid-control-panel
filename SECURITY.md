# Security Policy

## Supported Versions

Security fixes are applied to the latest release and the `main` branch.

## Reporting A Vulnerability

Please do not report a vulnerability in a public issue or pull request.
Report it privately on GitHub instead: open the repository's **Security**
tab and choose **Report a vulnerability**
(<https://github.com/fpsacha/zomboid-control-panel/security/advisories/new>).
Only the maintainer sees the report, and the fix can be prepared before
anything is published.

Include the affected version, a concise reproduction, impact, and any safe
mitigation. Please do not include live RCON passwords, JWT secrets, Steam
credentials, Discord tokens, or support bundles containing them.

## PanelBridge Steam Workshop Item

A server can get PanelBridge from the Steam Workshop item "Zomboid Control
Panel Bridge" (mod ID `ZCPB`) instead of having the panel copy it into the
game folder. Operators opt in per server; panel-installed stays the default.

- **One publishing account.** The item is published from a single
  dedicated Steam account. Whoever controls that account can publish Lua
  that every server using Workshop delivery runs after its next restart,
  and that every player who joins one of those servers downloads and runs.
  The publishing tool never takes a Steam password; steamcmd asks for it
  itself. Report a suspected compromise of the item or the account through
  the private flow above. An operator can switch a server back to
  panel-installed at any time in Settings → PanelBridge, which removes the
  item from its settings file.
- **The item id ships with each panel release.** It lives in
  `pz-mod/workshop/published.json`, is embedded in the executable builds,
  and is never fetched from the network, so a panel only points servers at
  the item its own release carries. The one override is the
  `PANEL_BRIDGE_WORKSHOP_ID` environment variable, for the maintainer's
  tests; it always marks the item as a preview in the panel.
- **What the Lua integrity check covers.** Workshop delivery lets an
  operator set `DoLuaChecksum=true` again. That turns the Lua integrity
  check back on: players whose Lua, script or animation files differ from
  the server's are refused. It doesn't stop modified game clients, and
  admin accounts skip this check.

## Server Files

The Server Files page is a file manager for each server's game install and
Zomboid folders, on this computer, through Docker mounts, and on the active
remote server over its PanelBridge SFTP login.

- **Treat "Manage server files" like the admin password.** It can change
  the game's own Java and Lua files, launch scripts and mods, which run under
  the server's account at its next start, and it can read and change world
  saves and the player database. Only the admin role has it by default. It
  is refused outright while panel logins are turned off, because every
  request would then be an anonymous admin.
- **What stays out of reach.** The panel's own data folder (database,
  secrets, certificates), its logs and its program folder are sealed, and
  so are the panel's secret files wherever a hard link or alias puts them
  (matched by inode) and `.ssh`, `.gnupg` and `.steam` folders. The World
  Backups folder can be listed but not read or changed (that stays behind
  the backup permissions), and so can the launch scripts the panel
  generates, which carry the in-game admin password. These hold whichever
  server folder reaches them, such as a Zomboid folder inside the game
  folder. PanelBridge's command folder and its own files are read-only, so
  the file manager can't forge bridge commands. Roots are refused when they
  are a drive root, a home folder or one of its parents, a system folder,
  or inside the panel's own folders.
- **Secrets in `.ini` files** (and in the panel's backups of them) are
  masked in the editor, in downloads and in zips, the same way the raw
  config editor masks them, and put back when a masked copy is saved or
  uploaded over the live file. An archived copy (`servertest.ini.gz`,
  `.ini.zip`) downloads as it is: masking can't reach compressed bytes, so
  the file manager won't rename an `.ini` to such a name.
- **Links.** A symlink or junction that leads outside a server folder is
  never followed. Reads are made through a descriptor opened without
  following links and checked against the file that was resolved.
- **Known limit (check-then-use).** Between resolving a path and acting on
  it, someone who can already write to the server's folders on the host
  could swap a parent folder for a link. The file manager narrows that
  window (per-component checks, descriptor checks, `link(2)` landing) but
  can't close it without OS support Node doesn't offer. Anyone able to do
  that already controls the folder the game runs from.
- **SFTP host-key pinning (trust on first use).** Every outbound SFTP
  connection (file manager, bridge sync, config mirror, remote log tail)
  checks the remote host's key against the key the panel pinned for it. The
  first connection to a host trusts and pins its key (logged with its
  `SHA256:` fingerprint); a later connection presenting a different key is
  refused as a possible man-in-the-middle, before any password is sent, and
  Settings › PanelBridge shows the saved and the presented fingerprints. If
  the host really changed its key (a rebuilt or reinstalled server), compare
  the presented fingerprint with the one your host reports (or with
  `ssh-keygen -lf` on the server's `/etc/ssh/ssh_host_*_key.pub` files),
  then choose **Trust new host key**: the panel pins exactly that key and
  keeps refusing any other.
- **Audit.** Every change, download and refusal is recorded (who, from
  where, which files, never their content) in the panel database and in the
  panel's log folder, which the file manager itself can't touch.
- **Known limit (backup restore expansion).** A holder of `backups.manage`
  can upload an archive that expands to more data than it compresses to;
  restore extraction is bounded by free disk space only. Keep the backup
  store and that capability trusted.

## Panel update (all-in-one Docker)

The `updater` container applies panel updates by downloading the release
source archive from GitHub, rebuilding the panel image and recreating the
container. It holds the Docker socket (root-equivalent on the host).

- Set `PANEL_DOCKER_UPDATE_SHA256` in `<PANEL_BUILD_DIR>/ctx/.env` to the
  SHA-256 of a release source archive
  (`https://github.com/<repo>/archive/refs/tags/v<version>.tar.gz`) and the
  updater refuses any archive that doesn't match. Without it, the updater
  logs a warning and the only integrity guarantee is GitHub TLS plus
  repository integrity.

  **It needs the updater from the release that added it.** An update from
  the Settings page rebuilds only the panel container; the updater and the
  Compose file come from `bootstrap.sh`. On an install set up before that
  release, run `bootstrap.sh` once (it keeps `.env` and your volumes),
  otherwise the variable has no effect.

  **This pins exactly one release.** The hash belongs to one version's
  archive, so while it is set the updater refuses *every* other version,
  including newer ones. The panel can't tell: the Settings page first saves
  and stops the active game server, then only reports that the Docker
  update started. The refusal is in the updater's log
  (`docker logs zomboid-panel-updater`), the panel keeps its current
  version, and the game server stays stopped until you start it again. To
  move to a new release:

  1. Download that release's archive and compute its hash
     (`curl -sL <archive url> | sha256sum`), ideally on a different machine
     or network than the panel host, and compare with a hash published by
     the maintainer if one exists.
  2. Put the new hash in `PANEL_DOCKER_UPDATE_SHA256` in
     `<PANEL_BUILD_DIR>/ctx/.env`.
  3. Recreate the updater so it reads the new value: run
     `bootstrap.sh <current version>` again (it keeps `.env` and your
     volumes), or run `docker compose --env-file .env up -d updater` inside
     `<PANEL_BUILD_DIR>/ctx` if the host has the Compose plugin. Then run
     the update from the Settings page.

  Leave it empty if you prefer one-click updates over a pinned release.
- The updater token (`PANEL_DOCKER_UPDATER_TOKEN`) lives in the panel
  container's environment. Anyone with code execution in the panel can use
  it (and the socket) to run their own images as root on the host — treat
  panel RCE as host compromise.

## Role trust levels

Some capabilities are code-execution equivalents on the panel host by
design: `server.install` (install/setup commands), `files.manage` (file
manager, including launch scripts) and `servers.manage` (custom launcher or
start command). The default `technician` role holds `server.install` and
`servers.manage`; `files.manage` is admin-only by default. Grant them only
to people you would trust with a shell on the host.
