# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.17] - 2026-07-31

### Fixed

- **Standalone auto-updates left the web UI behind**: the updater downloaded only the executable, while the dashboard is served from the adjacent `client/dist` directory. It now verifies the matching platform archive and refreshes that directory too, without touching `data/`.

## [1.1.16] - 2026-07-31

### Added

- **Dashboard LAN Address picker**: Settings > Panel Settings now lists each non-internal IPv4 interface, so hosts running Tailscale, ZeroTier and a physical LAN can choose the address shown on the dashboard.

### Fixed

- **Dashboard React crash**: the LAN-address change accidentally returned an unresolved Promise as `{}` from panel-info. The dashboard now receives a real IP address.
- **Removed mods remained tracked**: tracking added IDs from `WorkshopItems=` but never removed old records. Opening Mod Manager now reconciles the list with the active server INI and prunes IDs no longer configured there.

## [1.1.15] - 2026-07-31

### Fixed

- **Mod settings did not survive a restart**: changing a setting on the Mod Settings tab only set the value on the running server. Nothing ever wrote `<server>_SandboxVars.lua`, which is the file the server reads at boot, so every mod option silently reverted on the next restart. Each edit is now written to that file as well.
- **Mod settings often had no effect at all**: PanelBridge set the value on the Java option but left the `SandboxVars` table stale, and that table is what mod code actually reads. The bridge now refreshes it (PanelBridge 1.7.15).
- **Numeric mod settings rejecting valid input**: options whose minimum was a fraction, such as `0.001`, refused whole numbers, because browsers count valid values up from the minimum in step increments. Only genuine integer options are constrained now.
- **Add XP was missing nine B42 skills**: Blacksmithing, Carving, Glassmaking, Knapping, Masonry, Pottery, Animal Care, Butchering and Tracking could not be selected at all.
- **Add XP silently doing nothing**: the perk name was quoted, which the server tokenises as two arguments and then rejects without an error.
- **God mode and invisibility**: these commands have no form that targets another player, so over RCON they were always a no-op. They now go through PanelBridge, which sets the flag on the player.
- **World Map tiles failing to load ("signal.lost / tiles offline")**: an earlier merge's map fallback and geometry-resolution logic had been committed but never actually deployed to the live server, so the client called a resolve endpoint the running backend didn't have. Redeployed; tiles load again.

### Added

- **Settings > Network: Dashboard LAN Address**: pick which detected network interface's IPv4 the dashboard displays, for hosts running more than one network (e.g. Tailscale and ZeroTier at once).

### Changed

- **Add XP perk list**: perks are now grouped by category and labelled the way the in-game skills screen labels them, rather than by internal id. Twelve differ, including Carpentry, Foraging, Welding and First Aid.

## [1.1.14] - 2026-07-30

### Fixed

- **World Map tiles**: the fallback that switches to a fully-rendered older B42 map build when the newest one isn't rendered upstream yet was deployed live in v1.1.12/v1.1.13 but never actually committed — this release includes it for real. If tiles were still failing to load on 1.1.13, this fixes it.
- **Public IP**: the address shown on the dashboard now expires its cache after 6 hours instead of indefinitely, so a residential ISP rotating your WAN IP no longer leaves a stale, no-longer-yours address displayed forever.

## [1.1.13] - 2026-07-30

### Fixed

- **World Map vehicle layer stuck at "0 loaded"**: `vehicles:get(i)` was called with no safety check, unlike the `.size` lookup right above it. On this game version that call threw "Object tried to call nil in pcall" for every vehicle every ~5s, flooding the server console. Now guarded the same way, along with a third call site that had the identical issue. PanelBridge bumped to 1.7.13, which also folds in the fork's parallel 1.7.11/1.7.12 work.

## [1.1.12] - 2026-07-30

### Fixed

- **"Remove from server" leaving mods active**: the action could report success and ignore-list a mod while silently leaving it in `Mods=`/`WorkshopItems=`. Ignore-list writes are now gated on the INI edit actually running, and `delete-disk-mod` got the same fix.

## [1.1.11] - 2026-07-29

### Docker

- **Compose installer**: documented `docker-compose.install.yml` for starting the published panel image with persistent Docker volumes.
- **Release package**: made the included Compose installer and its exact command visible in the generated release README.

### Fixed

- **Stale Steam operations**: install and update locks now track the SteamCMD process and clear automatically when that process has exited, preventing a dead operation from permanently blocking its install path.

## [1.1.10] - 2026-07-29

### Fixed

- **Linux first-time server installation**: the setup wizard now offers the safe systemd service path, `/opt/zomboid-panel/data/pzserver`, and explains that the paired `_Data` folder is created automatically for settings and save data.
- **Folder picker errors**: Linux directory browsing now reports the actual filesystem error code and the required service-account permissions instead of a generic “Access denied”.
- **Release documentation**: the packaged Linux README and the main setup guide include a copy-paste command for creating the safe install folder. They also explain how to use a custom `/opt` path safely through `ReadWritePaths`.
- **Clean dependency installs**: regenerated both lockfiles so `npm ci` no longer fails on a fresh checkout.

## [1.1.9] - 2026-07-29

### Fixed

- **PanelBridge on Build 42 build 24449161** — the Project Zomboid update released on 2026-07-29 restricted `getFileWriter` to an extension whitelist. Writing a `.json` file now returns `nil`, so the Lua mod silently failed on every file it owns and the heartbeat, queue state, and command results stopped reaching the panel. The server appeared permanently unresponsive.
- **Bridge file naming** — PanelBridge `1.7.8` appends `.txt` to every file it writes (`status.json.txt`, `outbox/res-<seq>.json.txt`, and so on). The folder layout is unchanged. Files the panel writes — `commands.json` and `inbox/cmd-*.json` — keep their plain names, because the panel is not affected by the restriction.
- **Backwards compatibility** — the panel prefers the new `.txt` files and falls back to the legacy names, so a server still running an older mod or an older game build keeps working without manual migration.
- **PanelBridge 1.7.4 regression** — reverted the `.init` sentinel shortcut added in 1.1.7. It skipped the sentinel write whenever the file already existed, which was never the real cause of the Build 42 failures.

## [1.1.8] - 2026-07-29

### Fixed

- **First-time reverse-proxy setup**: CORS block messages now explain how to set `CORS_ORIGINS` before an administrator account exists, without relaxing the origin policy.
- **Docker path permissions**: install and data-path validation now identifies missing writable bind mounts and container UID/GID ownership. The shipped Compose example correctly marks the PZ install mount writable for panel-managed install, update, and start workflows.

## [1.1.7] - 2026-07-29

### Fixed

- **PanelBridge on Build 42**: startup now accepts its existing `.init` sentinel instead of failing when Build 42 refuses to reopen it with `getFileWriter`. This restores PanelBridge initialization and its `status.json` heartbeat after a server restart.
- **PanelBridge version reporting**: the Lua runtime now reports `1.7.4`, matching the existing mod metadata so version-based deployment can recognize the fixed mod.

## [1.1.6] - 2026-07-29

### Fixed

- **Docker SteamCMD support**: the standard amd64 Docker image now uses a glibc-based runtime with Bash and the required 32-bit SteamCMD libraries, so Linux Docker installations can use the panel's SteamCMD setup and update workflows. The image remains multi-architecture for arm64 remote-server administration. Thanks to @Lynkes for identifying the Docker compatibility issue in [#16](https://github.com/fpsacha/zomboid-control-panel/pull/16).
- **Clean Docker builds**: the image no longer requires an untracked generated browser-extension ZIP that is excluded from the Docker build context. The extension download endpoint continues to report clearly when a bundle is unavailable.

## [1.1.5] - 2026-07-29

### Fixed

- **Unstable-to-Stable server upgrades**: fixes a SteamCMD bug where a dedicated-server install previously mounted to the Unstable branch could not update to Public (Stable), failing with an opaque access-denied exit code. The panel now backs up and clears only the stale app manifest before rebuilding Stable branch metadata. Save data, Workshop downloads, and game files remain in place.

## [1.1.4] - 2026-07-29

### Changed

- **Portable all-in-one Docker setup**: the public installer now resolves the latest release, stores its build state in a normal per-user directory by default, and uses Docker named volumes for panel data, logs, the PZ installation, and world saves. It no longer assumes an Unraid filesystem layout or a `zomboid.tower` hostname.
- **Portable network configuration**: new installs default to `http://localhost:3001`; remote-access, LAN address, and WAN address values are explicit optional configuration rather than values copied from a specific deployment.

## [1.1.3] - 2026-07-29

### Fixed

- **Docker update controller startup**: the updater image now clears the Docker CLI base image entrypoint before starting Node, preventing `node server.js` from being interpreted as a Docker subcommand and allowing the panel update controller to become healthy.

## [1.1.2] - 2026-07-29

### Added

- **Docker in-panel updates**: all-in-one deployments can now update from Settings. The token-protected updater saves and stops Project Zomboid through RCON, downloads the chosen GitHub release, rebuilds and health-checks the container, and restores the prior source and image if the rollout fails.

### Fixed

- **All-in-one Docker paths**: Workshop scanning and B42 log discovery now use the configured `PZ_SERVER_PATH` and `PZ_SAVE_PATH` when no panel server record exists yet.
- **All-in-one server status**: the Docker image includes `procps`, so the panel can use `pgrep` and `ps` to detect the running Java server accurately.

### Changed

- **Docker network addresses**: all-in-one deployments can set the LAN and WAN addresses in `.env`, preserving correct join and panel links after an in-panel update.

## [1.1.1] - 2026-07-28

### Added

- **Dependency-aware load order auto-sort**: the Load Order tab can now propose an order that places every mod declaring `require=` in its `mod.info` after the mods it depends on. Mods without a declared dependency keep their existing position, so the arrangement you built by hand is preserved rather than replaced by an alphabetical list.
- **Reviewable sort proposal**: auto-sort never writes on its own. It presents the mods that would move with their before and after positions, and the order is only staged when you apply it and saved when you confirm with Save Order.
- **Sort diagnostics**: circular `require=` chains are reported by name and keep their current order instead of being reordered arbitrarily, and requirements that point at mods which are not enabled are counted and surfaced rather than silently discarded.

### Changed

- **Focused move reporting**: the proposal lists only the mods whose position genuinely had to change, instead of every mod whose index shifted because an entry above it moved.

## [1.1.0] - 2026-07-28

### Added

- **Collection-first Steam Workshop management**: the Collection tab now identifies whether each item is tracked, in the Steam collection, and configured on the active server. Add collection items directly to the server, or remove server mods individually or in bulk after changing the Steam collection.
- **Complete server-enable action**: adding a mod from Collection updates `WorkshopItems=`, discovers and writes its internal mod ID to `Mods=`, includes map folders when available, and begins tracking the mod for update checks.
- **Safer collection synchronization**: optional collection-only mods are now a first-class neutral state instead of a false mismatch. Sync adds tracked mods that are missing from Steam without silently deleting optional collection items.
- **Operational dashboard signals**: added host disk headroom, next scheduled maintenance action, and current console error count to the dashboard.
- **Clearer collection actions**: bulk actions are disabled when they cannot apply to the current selection, and every mod row states whether it is on the server.

### Fixed

- **Mod removal semantics**: Collection-tab untracking no longer creates an ignore rule or changes Steam membership. Server removal consistently removes the mod from the server INI and tracking state, then mirrors to Steam only when collection auto-sync is enabled.
- **Workshop title resolution**: tracked and deactivated mods now resolve their real Steam titles automatically when local workshop files are unavailable; generic `Workshop Mod <id>` labels are repaired and persisted without manual intervention.
- **Steam collection rate limiting**: collection mutations use a dedicated limiter so normal collection management no longer collides with sensitive-operation limits.
- **Collection title accuracy**: placeholder tracked names no longer block Steam title lookups in the collection view.
- **Mod configuration reliability**: server mod removal handles Workshop IDs, internal mod IDs, and map-folder cleanup together; collection-driven server actions follow the same safe path.
- **Settings reliability**: browser-extension downloads are packaged in Docker images and clipboard copy falls back for browsers running on non-HTTPS local panel URLs.
- **Dashboard polish**: telemetry rows retain fixed geometry, the removed trace mode no longer leaves stale controls, and duplicated oversized error verdicts were replaced by a compact errors work item.

### Changed

- **Steam collection workflow**: the Collection tab is now the practical place to reconcile Steam membership with server configuration. With auto-sync enabled, removing a mod from the server also removes it from Steam; with auto-sync disabled, Steam membership stays unchanged and the UI says so.
- **Advanced mod actions**: `Remove from server INI` and `Remove from server` now have distinct names, shared destructive iconography, and hover explanations that make their tracking behavior explicit.

## [1.0.77] - 2026-07-22

### Added

- **SteamCMD discovery**: the server update dialog now detects and saves an installed SteamCMD path automatically, including the `/home/steam/steamcmd` location used by the all-in-one Docker image.
- **Branch details**: the server update dialog now explains the selected Steam channel and displays its Steam build number and last-updated time when available.

## [1.0.76] - 2026-07-22

### Fixed

- **All-in-one Docker update controller**: update and rollback Compose commands now load the deployment `.env` file, preserving required CORS and controller-token settings when the panel container is recreated.

## [1.0.75] - 2026-07-22

### Added

- **All-in-one Docker updater**: an opt-in, token-protected controller can download a tagged GitHub release, rebuild the all-in-one image, recreate the panel container, verify its health, and roll back the source and image if the rollout fails.
- **Docker update workflow**: Settings now offers an explicit Docker update confirmation that saves and stops Project Zomboid through RCON before recreating the container.
- **Host-independent bootstrap**: the all-in-one setup script runs Docker Compose inside the updater image, so Unraid hosts do not need a local Docker Compose installation.

## [1.0.72] - 2026-07-22

### Fixed

- **Configurable Steam Workshop update frequency**: the Mod Update Settings interval now accepts whole-minute values from 1 to 120 and applies a saved change immediately, without restarting the panel.
- **One-minute polling regression**: Settings stored values in minutes but startup treated them as milliseconds and clamped them to one minute. Existing millisecond values are migrated safely, and invalid values are rejected.
- **Mod-check timer edge cases**: rescheduling clears stale delayed startup checks without interrupting a pending player-aware restart; unexpected scheduled-check failures are caught and logged.

## [1.0.70] - 2026-07-17

### Added

- **Sandbox diagnostics + auto-repair**: detects a corrupted `SandboxVars.lua` (mismatched braces) and surfaces it as a critical Debug finding, with a one-click automated repair action (backs up the original file first, refuses to write unless the repair is verified syntactically balanced).

### Fixed

- **SandboxVars.lua values containing commas inside quotes could get corrupted when edited through the Sandbox editor**: settings like `WorldItemRemovalList` and `LootItemRemovalList` were truncated at the first comma inside the quotes, corrupting the file and preventing the dedicated server from booting. Quoted string values are now treated as atomic when parsing/writing.

## [1.0.68] - 2026-07-16

### Fixed

- **PanelBridge mod (v1.7.4): server freeze on Restore/Shut Off Utilities**: restoring or shutting off power/water scanned tens of thousands of grid squares synchronously on the game tick, freezing the whole server for every player. The scan now runs as a background job chunked across ticks when triggered from the panel.
- **PanelBridge mod (v1.7.4): character import drained real skill points**: restoring a saved character's perk levels called the skill-point-consuming `LevelPerk` variant, silently spending the live player's own unspent skill points on every restore. Now uses the no-cost restore path.

## [1.0.65] - 2026-07-13

### Fixed

- **Discord bot crash on newer Node versions (full fix)**: the earlier fix only covered slash-command registration. The Discord client's internal REST — used for login, notifications, the "Send Test Message" button, chat relay, and command replies — still crashed on Node 22+/24+ with the `Symbol(sensitiveHeaders)` header error. All Discord API traffic now goes through the safe request path.

### Security

- **Discord mention injection**: player-controlled text (in-game chat relay and player join/leave/death notifications) could ping Discord roles or users via raw mention syntax like `<@&roleId>`. The bot now blocks all outbound mentions, so relayed chat and notifications can no longer ping anyone.

### Changed

- Replaced the deprecated Discord `ephemeral` reply option with the current `MessageFlags.Ephemeral` form.
- Added a request timeout to the Discord token test so a stalled Discord API can no longer hang the check.

## [1.0.64] - 2026-07-07

### Fixed

- **World map and chunk cleaner tile loading**: fixed the Project Zomboid map tile breakage after the B42 CDN migration from b42map.com to map.projectzomboid.com. The panel now proxies tiles through the backend and resolves the current B42 map directory dynamically from upstream metadata, so newer map builds continue to work without manual updates.
- **Discord bot startup crash**: fixed a compatibility issue with newer Node/undici versions that caused the Discord bot to crash during REST requests. Discord API calls now use a safe request path that avoids the header constructor failure.
- **Server names with spaces**: server creation and validation now accept names containing spaces while still rejecting unsafe path characters.

### Changed

- **Release pipeline**: removed the hard dependency on the old garage deployment share so packaging and release steps no longer block on that dead target.

## [1.0.27] - 2026-05-13

### Fixed

- **Mod update restart loop for mods removed from INI**: if a previously subscribed mod was deleted from `WorkshopItems=` but still had a newer version on Steam, the panel kept flagging it as "Update available" and queued a `Restart Pending` cycle that could never resolve (a restart can't apply a mod the server isn't subscribed to). `modChecker.checkForUpdates()` now filters out updates for any workshop ID not present in the active server's INI before they reach the auto-restart pipeline.
- **"Flags out of sync" false positive from phantom updates**: `getStatus().updatesAvailable` was counted directly from the Workshop ACF without consulting the server INI, so even after the filter above the UI still showed `1 mod update reported by Steam — flags out of sync` and prompted a re-check. The status count is now filtered against `WorkshopItems=` as well.
- **Cancelling a pending mod-update restart silently disabled future auto-restarts for those mods**: `cancelPendingRestart()` left the `processedUpdates` dedup map populated, so the next poll cycle treated the same Steam timestamps as "already processed" and skipped them indefinitely. The map is now cleared on cancel, re-arming detection on the next check.

## [1.0.6] - 2026-04-16

### Fixed

- **RCON detection with WinGSM and other wrappers**: the panel failed to detect servers launched through WinGSM because the wrapper's process arguments did not match the old strict regex. `isWindowsDedicatedServerCommandLine` now recognizes WinGSM-wrapped launches, native `ProjectZomboid64.exe` with `-server`/`-servername`, and generic Zomboid command lines.
- **RCON startup port-probe fallback**: when Windows process detection returns a false negative (permissions, wrappers, unusual launchers), the panel now probes the RCON port directly at startup and connects immediately if it is listening, instead of waiting up to 60s for the auto-reconnect loop.
- **Stale RCON credentials after editing active server**: previously, editing the active server's RCON host/port/password kept the running RconService using cached credentials until the panel was restarted. Editing the active server now reloads and reconnects RCON and refreshes ServerManager paths when relevant fields change.
- **Force stop failed on wrapped servers**: the Windows force-kill path used a hardcoded PowerShell pipeline that only matched the raw `zombie.network.gameserver` Java class. WinGSM-wrapped or native-launcher processes were not stopped. Force stop now scans processes via WMI, matches them with the shared wrapper-aware logic, and falls back to generic kill only if detection fails.
- **Log download 401 errors**: "Download combined.log" and "Download error.log" in `/debug` used plain `<a href>` links that skipped the JWT bearer header. Replaced with authenticated `Blob` downloads.

### Added

- **Support Bundle ZIP**: new "Download Support Bundle (.zip)" button on `/debug` aggregates panel logs (`combined.log`, `error.log`), Zomboid install logs (`connection_log`, `workshop_log`, `content_log`, etc.), server runtime logs (`server-console.txt`, chat/debug logs), and any matching crash dumps (`hs_err_pid*`) into a single zip stream for bug reports.

### Changed

- **Safer Windows force stop**: `-server` / `startserver` in a command line alone no longer counts as a PZ server match. The native launcher or an explicit Zomboid path is now required, so unrelated Java processes on the same machine (for example a Minecraft server started with `java -server`) can never be falsely identified or killed by the panel.

## [1.0.1] - 2025-04-12

### Added

- **World Map — Vehicle overlay**: see every vehicle on the map, color-coded by fuel level. Right-click for quick actions (repair, fill fuel, charge battery, remove).
- **World Map — Safehouse overlay**: safehouses rendered as isometric diamonds with owner labels. Active safehouses glow brighter when a player is connected.
- **World Map — Toggle buttons**: Car and Home icons in the toolbar to show/hide vehicles and safehouses independently.
- **Chunk Cleaner — Vehicle overlay**: vehicles shown as colored dots on the chunk map with fuel-level coloring.
- **Chunk Cleaner — Safehouse overlay**: safehouses shown as dashed-border rectangles with owner labels.
- **Chunk Cleaner — Vehicle removal on delete**: checkbox in the delete dialog to remove vehicles in the selected area before chunk deletion, preventing orphaned entries in vehicles.db.
- **Chunk Cleaner — Safehouse warning**: delete dialog warns when safehouses overlap the selected chunks, listing affected owners.
- **PanelBridge `removeVehicle` handler**: permanently remove a single vehicle by ID.
- **PanelBridge `removeVehiclesInArea` handler**: remove all vehicles within a coordinate bounding box.

### Fixed

- "Ekron" label on both World Map and Chunk Cleaner corrected to "Fallas Lake".
- Vehicle overlay coordinate validation in Lua now checks `nil` instead of `== 0` (0,0 is a valid PZ coordinate).
- Safehouse label deduplication — owner name no longer shown twice when it matches the safehouse title.
- Stale overlay data cleared when switching saves in Chunk Cleaner.
- Delete dialog "Remove vehicles" checkbox resets on each open (no stale state from cancelled dialogs).

### Changed

- Vehicle fuel-level colors pre-resolved to canvas color refs instead of calling `getComputedStyle()` per frame per vehicle.
- Safehouse owner list in delete dialog truncated to 5 entries with "+N more" overflow.

## [1.0.0] - 2025-04-10

### Added

- Full-featured web admin panel for Project Zomboid dedicated servers.
- Dashboard with real-time server status, player list, and quick actions.
- Interactive World Map with DZI tile rendering, player position tracking, airdrops, and landmark labels.
- RCON console with command history and autocomplete.
- Player management: kick, ban, teleport, heal, godmode, inventory, character export/import.
- Weather and climate control via PanelBridge (storms, temperature, fog, wind, snow).
- Mod tracker with Steam Workshop update detection.
- Scheduler for automated tasks (restarts, backups, messages) via cron.
- Backup and restore with zip archives.
- Chunk Cleaner for resetting map areas with visual chunk selection.
- Server config INI editor with validation.
- Multi-server support with server finder auto-detection.
- Discord bot integration for server status and player notifications.
- PanelBridge Lua mod for advanced in-game operations (B41 + B42 compatible).
- JWT authentication with rate limiting and CORS configuration.
- Standalone Windows .exe and Linux binary builds via pkg.
- Docker support with docker-compose.
- 6 color themes (Dark, Midnight, Crimson, Forest, Hacker, Vapor).
- Responsive design with mobile support.

[1.0.6]: https://github.com/fpsacha/zomboid-control-panel/compare/v1.0.1...v1.0.6
[1.0.1]: https://github.com/fpsacha/zomboid-control-panel/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/fpsacha/zomboid-control-panel/releases/tag/v1.0.0
