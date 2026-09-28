# Architecture Decisions

## Stack

The panel uses a Node.js and Express backend, a React, Vite, and TypeScript client, Socket.IO for real-time updates, and a lowdb JSON database. It ships as a Docker image and standalone Windows/Linux executable.

## Server Profiles

Server profiles describe a local or remote Project Zomboid installation. Legacy `isRemote` records resolve to `native` or `remote-sftp`; the server-status model also recognizes `docker-local` and `docker-managed` values so persisted profiles remain accurately labeled. Docker lifecycle control is not integrated: provider labels do not grant Docker socket access or container management.

## PanelBridge

PanelBridge is a file-based bridge between the panel and the in-game Lua mod. The panel owns command files and reads response files; Lua only creates `.txt` files because Build 42 requires that extension. For local mounts, the panel can atomically install and verify the bundled PanelBridge Lua file when a server is activated.

## Mount Discovery

`mountDiscovery.js` probes configured and common local PZ paths for install and save-data signatures. Discovery records are trusted only on the server: the client can request a mount scan, but server creation accepts only an exact server-side discovery. `PZ_SERVER_PATH` and `PZ_SAVE_PATH` provide fallback paths when persisted fields are empty.

## Templates

Templates are sparse JSON overrides for existing `server.ini` and SandboxVars settings. Secret, identity, and networking keys are excluded. Template mutations require an administrator and applying to the active server requires a verified stopped state. Server names are validated before paths are built; writes are serialized, backed up by default, and rolled back if the second file cannot be written. Unknown INI keys are skipped rather than appended.

## Status Model

The active-server status endpoint reports three distinct signals: host/process or container state, RCON connectivity, and PanelBridge state. Healthy signals remain neutral in the client. Remote SFTP hosts are deliberately shown as unknown when the panel cannot verify their process state. A confirmed host answer (a completed native process scan, a managed systemd/OpenRC unit's settled state, or a resolved Docker container) is authoritative; a unit that is still stopping or in a state the panel cannot read counts as unknown, not stopped. When the confirmed answer is stopped, the status watchdog's verdict is stopped and the exited server's last PanelBridge heartbeat is expired at once, because the bridge's own liveness is only the age of the mod's last status-file write, which outlives the process (by up to five minutes on an empty server). The composed status also reports PanelBridge offline beside a stopped host once that write is older than the normal freshness window, but keeps a mod that wrote seconds ago active. The expired write stays expired until the mod writes again, which a restarted server only does once its world has loaded; while the server is observed running before that, the bridge diagnostics say how long the mod has been silent since the start instead of calling the server stopped.

Server uptime is computed in the client from the host signal's `startedAt`, which is present only for a host confirmed running whose start time the panel can state. For a native server that is the tracked process's OS start time (from the same `Win32_Process` row the Windows scan found it in, or from `/proc` on Linux, where a systemd-managed server is tracked by its unit's `MainPID` and an OpenRC-managed one by the child PID supervise-daemon records in `$XDG_RUNTIME_DIR/openrc/options/<service>/child_pid`), otherwise the panel's own launch-time record, which belongs to the first PID seen after that launch; a start time is never carried over to a different PID, and none is reported while no PID is known. For Docker providers it is the container's `State.StartedAt`, which is the container's start rather than the game server's if PZ is relaunched inside a running container. Remote SFTP hosts, processes the panel cannot see, and managed services between a crash and the respawn have no start time and render as unknown, never as zero. Status payloads carry `serverTime` (the host clock when it answered) so the client re-expresses `startedAt` in its own clock before counting; that leaves each response's latency in the value, so the client treats reports less than 2 seconds apart as the same start and keeps the earlier one.

## Storage Health

`diskMonitor.js` checks free space on the save volume every 60 seconds. Warning and critical thresholds are 90% and 95%. The system health endpoint combines disk state with the lowdb write circuit-breaker state; the client renders this only when a fault is present.

## File Writes

Configuration and bridge installation writes use atomic temp-file replacement. `withFileLock()` serializes concurrent writes to the same path. Multi-file operations must either complete or restore earlier files from their original content.

## Authentication

Authentication uses bcrypt password hashing, JWT access tokens, refresh cookies, timing-safe comparisons, recovery codes, and role middleware. Privileged routes use `requireRole("admin")`; the client should hide mutation controls from authenticated non-admin users while the server remains the enforcement boundary.

## Deferred Work

Docker capability discovery, managed-container metrics, and one-container lifecycle actions are disabled unless `PANEL_DOCKER_CONTROL_ENABLED=true` and the Docker socket is mounted. Even then, the panel recognizes only containers carrying `zomboid-panel.managed=true`; image names and provider labels never grant access. Lifecycle actions are administrator-only, strict-rate-limited, and re-check the label through Docker inspection immediately before acting. Resource snapshots are non-streaming and bounded to three concurrent Docker API calls. Do not infer that a Docker provider label or a detected mount permits lifecycle operations.