## v1.1.17

### Fixed

- **Standalone auto-updates now update the dashboard too.** The updater previously replaced only `ZomboidControlPanel.exe`, leaving the adjacent `client/dist` web interface from the old version. It now downloads and verifies the platform archive, then replaces only `client/dist` alongside the staged executable. Your `data/` directory is never touched.

### Important

If you updated to v1.1.16 with the in-app updater, install this release once from the Windows ZIP or Linux tar.gz archive. That old updater cannot repair its own missing web bundle. Future in-app updates from v1.1.17 will keep the dashboard files in sync.
