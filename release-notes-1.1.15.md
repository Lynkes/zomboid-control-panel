## v1.1.15

Mod settings and the Add XP tool both had bugs that made them look like they worked when they did not. Everything below was diagnosed against a live 42.20.0 server rather than inferred.

### Fixed

- **Mod settings did not survive a restart.** Changing a setting on the Mod Settings tab only set the value on the running server. Nothing ever wrote `<server>_SandboxVars.lua`, and that is the file the server reads at boot, so every mod option silently reverted on the next restart. Each edit is now written to that file as well. If a key is not already present in the file the panel says so plainly instead of showing a success message, because the game regenerates those entries from the mod's own defaults.
- **Mod settings often had no effect at all.** PanelBridge set the value on the Java option but left the global `SandboxVars` table stale, and that table is what mod code actually reads. The bridge now refreshes it. Requires PanelBridge 1.7.15.
- **Numeric mod settings rejecting valid input.** An option with a fractional minimum such as `0.001` refused whole numbers: browsers count valid values up from the minimum in step increments, so `0.001` and `1.001` were accepted but `1` was not. Only genuine integer options are constrained now.
- **Add XP was missing nine B42 skills.** Blacksmithing, Carving, Glassmaking, Knapping, Masonry, Pottery, Animal Care, Butchering and Tracking could not be selected at all.
- **Add XP silently doing nothing.** The perk name was quoted, which the server tokenises as two arguments and then rejects by printing usage rather than reporting an error.
- **God mode and invisibility never applied.** Neither command has a form that targets another player, so issued over RCON — which has no player of its own — they were always a no-op. They now go through PanelBridge, which sets the flag on the player directly.
- **World Map tiles failing to load ("signal.lost / tiles offline").** The map fallback and geometry-resolution logic from an earlier merge had been committed but never actually deployed to the live server, so the client kept calling a resolve endpoint the running backend didn't have. Redeployed; tiles load again.

### Added

- **Settings > Network: Dashboard LAN Address.** Pick which detected network interface's IPv4 the dashboard displays, for hosts running more than one (e.g. Tailscale and ZeroTier at once). Previously the panel just took whichever interface the OS listed first, with no way to change it short of an undocumented environment variable.

### Changed

- **Add XP perk list.** Perks are grouped by category and labelled the way the in-game skills screen labels them instead of by internal id. Twelve differ, including Carpentry, Foraging, Welding and First Aid.

### Upgrading

PanelBridge must reach 1.7.15 for the mod settings fix. The panel updates the server's copy automatically on restart.
