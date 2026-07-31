# Zomboid Control Panel — Steam Sync Extension

Tiny browser extension that reads your Steam Workshop session cookies and sends them to your **Zomboid Control Panel** so it can mirror a Steam Workshop collection (add/remove items in your collection right from the panel).

## Why this exists

Workshop collection write operations on Steam require your login cookies (`sessionid` + `steamLoginSecure`). The panel needs them to add or remove items from your collection. Pasting them by hand from DevTools is annoying and they expire — this extension makes the refresh one click.

## Privacy

The extension talks to **two places only**:
- `steamcommunity.com` — to read your two session cookies (locally, no network call).
- The panel URL you configure — to log in (with the panel's own username/password) and POST the two cookies.

It does **not** phone home, ship telemetry, or talk to any other origin. Your panel credentials are stored in this browser's local extension storage and never leave your machine except to the panel URL you typed in.

## Install — Firefox

1. Type `about:debugging#/runtime/this-firefox` in the address bar.
2. Click **Load Temporary Add-on…**.
3. Pick `manifest.json` from this folder.

Or, for permanent install, use the signed `.xpi` from the panel's GitHub release.

## Install — Chrome / Edge / Brave

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked**.
4. Pick this folder.

## Use

1. Open the extension popup.
2. Fill in:
   - **Panel URL** — e.g. `http://garage:3001`
   - **Username** — your panel admin username
   - **Password** — your panel admin password
3. Click **Test login** once. If it says "Login OK", you're done with setup.
4. Sign in at <https://steamcommunity.com> in this browser if you aren't already.
5. Click **Send Steam cookies to panel**. Done.

You only need to repeat step 5 when Steam invalidates your session (usually weeks/months apart).

## Re-pairing on a different machine

Install on whichever browser/machine you're logged into Steam on — it doesn't have to be the same machine the panel runs on. As long as the extension can reach the panel URL over the network, it works.
