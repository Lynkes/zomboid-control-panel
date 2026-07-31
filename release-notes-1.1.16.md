## v1.1.16

### Added

- **Dashboard LAN Address picker.** Settings > Panel Settings now lists every non-internal IPv4 address detected on the host, including separate Tailscale, ZeroTier and physical LAN adapters. Pick the address you want the dashboard to display, or retain Auto-detect. The selection persists and falls back safely to auto-detect if that adapter disappears.

### Fixed

- **Dashboard crash after the LAN picker change.** The panel-info endpoint returned an unresolved Promise as `{}`, which React cannot render. The Dashboard now receives a real IP address again.
- **Removed mods still appeared as tracked.** The tracker previously added IDs from `WorkshopItems=` but never removed old database records. The server INI is now the source of truth: the next Mod Manager refresh prunes any tracked workshop ID no longer present there.

### Upgrading

After installing, open Mod Manager once. It reconciles the tracked-mod list against the active server's `WorkshopItems=` line and removes obsolete entries automatically.
