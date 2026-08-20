## v1.1.48

### Added

- Added manual minimum and maximum RAM inputs to server setup, with allocation controls up to 64 GB and manual maximums up to 128 GB.
- Added Discord bot presence updates showing the current online player count.

### Fixed

- Matched Build 42 map player visibility values: Friends and nearby players is value 3 and Everyone is value 4.
- Persisted Custom Start Command when editing managed servers.
- Fixed Build 42.20 lightning by triggering the server-side ThunderStorm event directly.
- Reduced repeated offline RCON warnings with a five-minute cooldown.
- Prevented failed SteamCMD setup from leaving a stale operation lock.
- Added a SteamCMD inactivity watchdog for stalled update processes.
- Forced dedicated-server SteamCMD updates to use non-interactive anonymous login instead of waiting for an unavailable password or Steam Guard prompt.
- Automatically backs up and resets a Project Zomboid appmanifest stuck in Steam state 0x6 before an update.

### PanelBridge

- Updated PanelBridge to `1.7.35` for the Build 42.20 lightning fix.
