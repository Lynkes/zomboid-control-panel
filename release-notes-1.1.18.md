## v1.1.18

### Fixed

- **Mod-update auto-restart could shut down the server without bringing it back.** The Settings page saved the toggle and restart delay under different keys from the mod checker. On the next panel launch the checker restored auto-restart as disabled, so it detected workshop updates but never scheduled the restart.

Existing Settings values are migrated automatically at startup. Saving the Mod Checker settings now also updates the running checker immediately.
