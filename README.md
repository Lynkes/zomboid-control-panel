<div align="center">

# 🧟 Zomboid Control Panel

### The complete admin cockpit for Project Zomboid dedicated servers

[![Latest Release](https://img.shields.io/github/v/release/fpsacha/zomboid-control-panel?style=for-the-badge&logo=github&color=8a9a5b)](https://github.com/fpsacha/zomboid-control-panel/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/fpsacha/zomboid-control-panel/total?style=for-the-badge&logo=github&color=8a9a5b)](https://github.com/fpsacha/zomboid-control-panel/releases)
[![Discord](https://img.shields.io/badge/discord-join-5865F2?style=for-the-badge&logo=discord&logoColor=white)](https://discord.gg/jHsWJDNmSg)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg?style=for-the-badge)](LICENSE)

Manage your Project Zomboid dedicated server from one place: server controls, RCON, a live world map, Workshop mods, scheduled restarts, backups, and Discord integration.

[**🚀 Download**](https://github.com/fpsacha/zomboid-control-panel/releases/latest) ·
[**👁️ Live demo**](https://fpsacha.github.io/zomboid-control-panel/) ·
[**💬 Discord**](https://discord.gg/jHsWJDNmSg) ·
[**📖 Setup**](#quick-start)

</div>

<br />

![Dashboard](Screenshots/screenshot-dashboard-v2.png)

> **At a glance** — server status, RCON & PanelBridge connection state, live player activity, host telemetry, disk headroom, the next scheduled maintenance action, console error count, backup readiness, and quick actions. One screen covers 80% of routine admin work.

## ✨ Feature tour

<table>
<tr>
<td width="50%" valign="top">

### 🌧️ Events & Weather
Force-trigger blizzards, tropical storms, or rain at any intensity. Fine-grained climate sliders for fog, wind, temperature, clouds, humidity. Spawn helicopter events or lightning strikes on demand. The closest thing to PZ admin god-mode.

<img src="Screenshots/screenshot-events-v2.png" alt="Events & Weather" />

</td>
<td width="50%" valign="top">

### 🗺️ Live World Map
Real-time player positions on Knox County. Multi-floor support, layer toggles, zoom & pan. Right-click any player for instant teleport, heal, kick, or message — straight from the map.

<img src="Screenshots/screenshot-worldmap-v2.png" alt="World Map" />

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 👥 Player Management
Roster with online / offline / banned tabs. Per-player dossier with moderation, spawn loadout, powers (heal, teleport, god mode), notes & history. Voice ban, SteamID ban, manual targeting.

<img src="Screenshots/screenshot-players-v2.png" alt="Players" />

</td>
<td width="50%" valign="top">

### 🧩 Mod Manager
Tracks every Workshop mod on your server and flags updates through the Steam API. Import a Steam collection and drive server membership from it — adding a mod writes `WorkshopItems=`, resolves its internal mod ID into `Mods=`, and picks up map folders on its own.

<img src="Screenshots/screenshot-mods-v2.png" alt="Mod Manager" />

</td>
</tr>
<tr>
<td width="50%" valign="top">

### ⚠️ Mod Conflicts & Load Order
Scans your mod list for known incompatibilities, missing dependencies, and load-order issues. Severity-tinted findings so you see real problems before you boot the server. Load order can auto-sort from each mod's declared `require=`, with a preview of every move before anything is written.

<img src="Screenshots/screenshot-mods-conflicts.png" alt="Mod Conflicts" />

</td>
<td width="50%" valign="top">

### ⚙️ Server Configuration
Full in-browser INI editor for sandbox options, spawn regions, mod settings, and server flags. Searchable, structured view + raw view for power users. No more notepad-and-restart.

<img src="Screenshots/screenshot-config-v2.png" alt="Server Configuration" />

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🆕 Server Setup Wizard
Spin up a fresh PZ server in minutes. SteamCMD install, port config, RCON setup, admin account — all stepped through with sensible defaults.

<img src="Screenshots/screenshot-server-setup.png" alt="Server Setup" />

</td>
<td width="50%" valign="top">

### 🤖 Discord Bot Setup
Guided wizard for creating the Discord app, getting tokens, configuring intents and inviting the bot. Slash commands + two-way chat relay + event notifications ship turnkey.

<img src="Screenshots/screenshot-discord-setup.png" alt="Discord Setup" />

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 📊 Performance Telemetry
Host RAM and CPU graphs, PZ process memory, player count history. Time-range selectable, exportable. Catch slow leaks and load spikes before players notice.

<img src="Screenshots/screenshot-debug-performance.png" alt="Performance" />

</td>
<td width="50%" valign="top">

### 🐛 Crash Logs & Diagnostics
Java crash dumps, error logs, support bundles. One-click `.zip` export for when you need to share state with someone smarter than you. Health, environment, and activity tabs included.

<img src="Screenshots/screenshot-debug-crashes.png" alt="Crash Logs" />

</td>
</tr>
</table>

---

## Contents

- [What It Does](#what-it-does)
- [Requirements](#requirements)
- [Quick Start](#quick-start)
- [Setup](#setup)
- [PanelBridge](#panelbridge-optional)
- [Remote Access](#remote-access)
- [Security](#security)
- [Development](#development)
- [Community](#community)

---

## What It Does

### Operate
- **Server control** — Start, stop, restart, save. Live status and uptime.
- **Console** — Live log viewer and RCON terminal with command history.
- **Scheduling** — Recurring restarts, saves, broadcasts with countdown warnings.
- **Backups** — Create, restore, and manage world backups.

### Observe
- **Players** — Online list, activity history, kick/ban/unban, access levels, notes and tags.
- **World map** — Live player positions on Knox County with right-click actions.
- **Mod manager** — Track Workshop mods and detect updates, decide server membership from your Steam collection, auto-sort load order by declared dependencies, and scan for conflicts. Collection sync adds what's missing without deleting the optional mods you keep on the side.
- **Server config** — Full INI editor with structured and raw views. Sandbox, spawn points, mod settings — searchable and editable in-browser.

### Extend
- **Events & weather** — Rain, storms, blizzards, climate control, time control, sound triggers, zombie management.
- **PanelBridge** — Server-side Lua mod for actions RCON can't reach: teleport, heal, god mode, character export/import, inventory.
- **Discord bot** — Slash commands and two-way chat relay.
- **Multi-server** — Manage multiple PZ servers from one panel.
- **Chunk cleaner** — Visual map selector for cleaning unused chunks.
- **Auto-update** — Checks for new releases, downloads and applies them.

---

## Requirements

- **Project Zomboid dedicated server** — Build 41 or Build 42. Tested through B42.18.
- **RCON enabled** in your server `.ini` (`RCONPort=27015` and `RCONPassword=...`).
- **Network access** between the panel and the PZ server (same machine, same LAN, or reachable IP).
- For PanelBridge features: `DoLuaChecksum=false` in the server `.ini`.

The packaged binary includes its own runtime — no Node.js, Python, or Java install needed on the panel host.

---

## Quick Start

Download from [Releases](https://github.com/fpsacha/zomboid-control-panel/releases/latest). Self-contained binary — no dependencies.

### Windows
1. Extract `ZomboidControlPanel-windows.zip`
2. Run `Start.bat`
3. Open `http://localhost:3001`

### Linux
```bash
tar xzf ZomboidControlPanel-linux.tar.gz
./start.sh
```
Works on Ubuntu 20.04+, Debian 10+, CentOS Stream 8+, Rocky 8+, or anything with glibc 2.28+.

### Docker

Download [docker-compose.install.yml](docker-compose.install.yml), then run:

```bash
docker compose -f docker-compose.install.yml up -d
```

Open `http://localhost:3001`. This starts the panel with persistent Docker
volumes. For a panel that manages a PZ server on the same host, use the fully
documented [docker-compose.yml](docker-compose.yml) and configure its bind mounts.
The Compose files use named volumes for panel state, so do not replace them with
host `./panel-data` or `./data` mounts unless those directories are owned by
UID/GID `1000:1000`.

#### Shared PZ folders: Docker permissions

When the panel bind-mounts Project Zomboid folders, set `PUID` and `PGID` in
`.env` to the numeric Linux user and group that own those folders:

```env
PUID=1000
PGID=1000
```

Find the values with `id -u` and `id -g`, then restart the panel:

```bash
docker compose up -d
```

`PUID` and `PGID` apply when the container starts as root, which is the default
for Docker and Docker Compose. If the runtime already pins a non-root user — for
example a Kubernetes pod with `runAsUser`, `runAsGroup`, and `runAsNonRoot: true`
— the entrypoint skips the ownership fix and the privilege drop and runs the
panel as the given user. In that case `PUID` and `PGID` are ignored, and the
`/app/data` and `/app/logs` volumes must already be writable by that UID/GID.

This works with the published image; rebuilding is not required. The panel
changes ownership only of its own `/app/data` and `/app/logs` directories,
never of PZ game or save mounts.

#### Separate PZ and panel containers

The panel can manage a PZ server in another container. Put both containers on
the same Docker network and set `RCON_HOST` to the PZ service name, not
`127.0.0.1`. For PanelBridge features, choose one of these file-access methods:

- Bind-mount the same PZ save directory into the panel and give both containers
  compatible numeric UID/GID access.
- In **Settings → PanelBridge**, enable **Remote server via SFTP**, enter the
  PZ host credentials and the absolute bridge folder, for example
  `/home/pz/Zomboid/Lua/panelbridge/MyServer`, then select **Test SFTP** and
  **Start SFTP bridge**.

Shared folders and SFTP enable configuration edits and PanelBridge actions.
They do not let the panel start or stop a separate Docker container. Keep PZ
lifecycle management in your container manager, unless you deliberately grant
the panel Docker socket access.

#### Unraid and Indifferent Broccoli

Use the panel-only image alongside an existing Indifferent Broccoli Project
Zomboid container. The two applications have separate persistent state: the
panel's own database and logs are **not** Project Zomboid's data or logs.

| Unraid host path | Panel container path | Purpose |
| --- | --- | --- |
| `/mnt/user/appdata/zomboid-panel/data` | `/app/data` | Panel database, sessions, and backups |
| `/mnt/user/appdata/zomboid-panel/logs` | `/app/logs` | Panel logs |
| `/mnt/cache/appdata/projectzomboid/data` | `/pz-server` | PZ install; use the actual path from the PZ container's template |
| `/mnt/user/appdata/projectzomboid/config` | `/zomboid` | PZ server config, saves, logs, and PanelBridge files |

Do **not** use `/panel-data` or `/panel-logs`: the image never reads those
paths. The panel paths are exactly `/app/data` and `/app/logs`.

In Unraid's Docker page, add the four mappings above, set `PUID=99` and
`PGID=100` (or the owner shown by the PZ container), and use bridge networking.
Set `RCON_HOST` to the PZ container's name only when both containers share a
user-defined Docker network. Otherwise use the PZ container's fixed LAN IP or
host address and its exposed RCON port. Do not use `127.0.0.1`: inside the
panel it means the panel container itself.

After starting the panel, configure the container paths in the wizard or
Settings as `/pz-server` and `/zomboid`, never the `/mnt/...` host paths. For
PanelBridge, the shared `/zomboid` mount is enough. If your PZ container does
not expose that directory to the panel, use **Settings → PanelBridge → Remote
server via SFTP** instead.

The panel can monitor and administer the game through RCON, but it cannot
start, stop, or automatically update an independently managed Broccoli
container. Leave lifecycle and game updates with Unraid/Indifferent Broccoli;
the automatic server-update setting is for a PZ process managed by the panel.

A ready-to-import Unraid template is available at
[`docker/unraid/zomboid-panel.xml`](docker/unraid/zomboid-panel.xml). Edit the
two PZ host paths and RCON values before importing it.

### Linux: installing a new PZ server through the panel

If you installed the panel as the bundled `zomboid-panel.service`, use this install folder in the setup wizard:

```text
/opt/zomboid-panel/data/pzserver
```

Create it once before opening the wizard:

```bash
sudo -u pzuser mkdir -p /opt/zomboid-panel/data/pzserver
```

The panel also creates `/opt/zomboid-panel/data/pzserver_Data` for server settings and save data. Leave **Custom config location** blank unless you have a specific reason to store it elsewhere.

Do not use `/opt/pzserver` with the bundled service unless you add both `/opt/pzserver` and `/opt/pzserver_Data` to `ReadWritePaths` in `zomboid-panel.service`, then run `sudo systemctl daemon-reload` and `sudo systemctl restart zomboid-panel`.

### Docker

The image runs **the panel only** — Project Zomboid itself still has to run somewhere (on the host, in another container, or on a separate machine). The panel reaches it via RCON and via shared filesystem (for PanelBridge).

Pull the prebuilt image:
```bash
mkdir -p ~/zomboid-panel && cd ~/zomboid-panel
curl -O https://raw.githubusercontent.com/fpsacha/zomboid-control-panel/main/docker-compose.yml
curl -O https://raw.githubusercontent.com/fpsacha/zomboid-control-panel/main/.env.example
mv .env.example .env
docker compose up -d
```
Then open `http://localhost:3001`.

Before bringing it up for real, edit [`docker-compose.yml`](docker-compose.yml) and uncomment the volume mounts that point at your PZ install and `~/Zomboid` folder — the file has two annotated topology examples (PZ on the host vs. PZ on a remote machine). All env vars are documented in [`.env.example`](.env.example).

Prebuilt images are published to GHCR: `ghcr.io/fpsacha/zomboid-panel:latest` and `:vX.Y.Z`. Prefer to build from source? Comment out `image:` in the compose file and uncomment the `build:` block.

---

## Setup

1. Open the panel and create your admin account.
2. In **Settings**, set your server install path and Zomboid data path.
3. Configure RCON (host, port `27015`, password from your server `.ini`).
4. Optionally install PanelBridge for advanced features.

### PanelBridge (Optional)

PanelBridge is a server-side Lua drop-in that enables features RCON can't reach — teleport, heal, weather control, character export/import, inventory editing, sound triggers.

There is no client-side component. Players don't install anything. The panel copies `PanelBridge.lua` into your server's `Install/media/lua/server/` folder, then you set `DoLuaChecksum=false` in the server INI, restart the PZ server, and enable it in **Settings → PanelBridge**.

For a remote server without a shared filesystem, use the **Remote server via
SFTP** option in the same panel. It syncs the bridge command and result files
through a local cache; it does not expose the server's full filesystem to the
panel.

---

## Remote Access

If you're running the panel on the same machine as your browser, skip this section.

To access the panel from another machine, allow the origin before first launch:

```bash
CORS_ORIGINS=http://YOUR-IP:3001 ./start.sh
```

After login, save it permanently in **Settings → Remote Access** so the env var isn't required next time.

For VPS or public-internet deployment, put the panel behind a reverse proxy (nginx or Caddy) with HTTPS, and set `HTTPS=true` so the panel emits HSTS headers. Don't expose port 3001 directly to the internet.

---

## Security

- JWT authentication on all API routes.
- Rate limiting on login, RCON, and destructive operations.
- RCON parameter sanitization to prevent command injection.
- CORS configurable per deployment (LAN auto-allows private IPs, VPS requires explicit origins).
- Password reset via secure token file or `--reset-password` CLI flag.

---

## Development

```bash
npm run install:all
npm run dev
```
Frontend at `http://localhost:5173`, backend at `http://localhost:3001`.

```bash
node build.js --all        # Build Windows + Linux binaries
npm test                   # Run tests
```

---

## Community

- **Discord** — [discord.gg/jHsWJDNmSg](https://discord.gg/jHsWJDNmSg) for questions, support, and feature ideas.
- **Issues** — [Report bugs or request features](https://github.com/fpsacha/zomboid-control-panel/issues) on GitHub.
- **Changelog** — See the [latest release notes](https://github.com/fpsacha/zomboid-control-panel/releases/latest) for what's new.

---

## License

MIT
