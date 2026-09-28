# Publishing the PanelBridge Workshop Item

For maintainers. This covers publishing PanelBridge as the Steam Workshop
item `ZomboidControlPanelBridge`, the live test that has to pass before a
panel release carries its ID, and how to record that test. Operators don't
need any of it: the install guides and the README cover choosing a delivery
method. This folder isn't shipped in release archives (only `docs/install/`
is).

How the panel uses the item is described in
[ARCHITECTURE.md](../../ARCHITECTURE.md#panelbridge).

---

## What lives where

| Path | What it is |
| --- | --- |
| `pz-mod/PanelBridge/` | The bridge source: `media/lua/server/PanelBridge.lua`, `media/lua/client/PanelBridgeClient.lua`, `mod.info`. The panel-installed copy and the Workshop item are built from these same files. |
| `pz-mod/workshop/published.json` | The item's ID, visibility, last published version and date, and the live-test record (`liveVerified`). Every panel release embeds it; the panel never fetches the ID. |
| `pz-mod/workshop/workshop.txt` | The Workshop page template (title, description, tags). No `id=` line: the build adds it. |
| `pz-mod/workshop/{preview,poster,icon}.png`, `art/bridge.svg` | The item's images and their source. `npm run workshop:art` re-renders the PNGs. |
| `pz-mod/bridge-version.lock.json` | The released bridge version and the hash of its normalized code. |
| `scripts/workshop/build-item.mjs` (`npm run workshop:build`) | Builds the item into `dist-workshop/ZomboidControlPanelBridge/`, or into `--out <dir>`. `--check` runs every check and writes nothing. |
| `scripts/workshop/publish.mjs` (`npm run workshop:publish`) | Publishes with steamcmd, or records an item uploaded in-game (`record`). |
| `scripts/check-bridge-version.mjs` (`npm run check:bridge-version`) | Checks the version lock. `--next` prints the version the next release should use. |

CI runs `node scripts/check-bridge-version.mjs` and
`node scripts/workshop/build-item.mjs --check` on every pull request and
every push to `main`, and tag builds run
`node scripts/check-bridge-version.mjs --release`.

---

## Publishing policy

- **Publish rarely.** Every publish makes new joins fail on every server
  that uses Workshop delivery until that server restarts. Batch Lua changes
  and aim for at most two publishes a month.
- **Never change the mod ID** (`ZomboidControlPanelBridge`). Every
  Workshop server's `Mods=` line, the panel's delivery detection and the
  build all key on it.
- **Never hide or delete the item.** A server whose `WorkshopItems=` lists
  an item Steam won't deliver stops at startup.
- **Publish only from the project's dedicated Steam account.** It owns
  Project Zomboid, uses the Steam Guard mobile authenticator, and has
  accepted the Steam Workshop Legal Agreement; until that agreement is
  accepted, the item stays hidden. Workshop items can't be transferred to
  another account later. Write down who holds the account in the
  maintainer's private notes, not in this repository.
- **The tools never take a Steam password.** steamcmd asks for the
  password and the Steam Guard code itself. `publish.mjs` refuses any
  password option and refuses to run while `STEAM_PASSWORD`,
  `STEAMCMD_PASSWORD` or `STEAM_GUARD_CODE` is set. steamcmd keeps its own
  login session: log out of it on a shared machine.
- **`release.ps1` never publishes.** It decides the bridge version,
  rewrites it, writes the lock and runs `build-item.mjs --check`. When the
  Workshop item lags the released bridge, it ends with an open item saying
  so.

### Each release

- **Bridge code unchanged:** release as usual. `release.ps1` prints
  `PanelBridge unchanged, keeping <version>`. Don't publish.
- **Bridge code changed:** `release.ps1` bumps the bridge version (by
  default the version `node scripts/check-bridge-version.mjs --next`
  prints, usually the lock's next patch; `-PanelBridgeVersion` sets it
  within the same rules), rewrites the Lua header, `VERSION` and
  `mod.info`, and writes the new lock. Publish
  once, from the tagged tree (Path A below), then commit
  `pz-mod/workshop/published.json` with its new `publishedVersion`.

Describe unreleased bridge changes in a `vNEXT Changes:` block at the top of
the Lua header. `release.ps1` renames it to `v<version> Changes:`, and the
steamcmd change note defaults to the header's change blocks newer than the
last published version.

---

## Building and checking

```sh
npm run workshop:build                       # dist-workshop/ZomboidControlPanelBridge/
node scripts/workshop/build-item.mjs --check # CI: every check, nothing written
node scripts/check-bridge-version.mjs        # version lock, PR mode
```

The item has this layout. `dist-workshop/` is gitignored and never goes
under `release/`, which `release.ps1` zips as it is.

```
ZomboidControlPanelBridge/
  workshop.txt  preview.png
  Contents/mods/ZomboidControlPanelBridge/
    42/mod.info  42/poster.png  42/icon.png
    common/media/lua/server/PanelBridge.lua
    common/media/lua/client/PanelBridgeClient.lua
```

The build fails when:

- `pz-mod/PanelBridge/` holds anything other than the three source files,
  or one of them is missing;
- `mod.info` has an unknown key, a line with `=` inside its value, an empty
  value, or `require=`, `pack=`, `pzversion=` or `authors=`;
- the mod ID in `mod.info`, `published.json` and the Lua `MOD_ID` differ;
- `mod.info`'s `modversion`, the Lua `VERSION` and the header's `Version:`
  differ;
- the first executable statement of either Lua file isn't its load guard
  (`isServer()` for the server file, `isClient()` for the client file);
- the item has anything under `Contents/` other than `mods/`, any Lua path
  other than the two above, a `shared/` folder, or a file type the
  uploader refuses (`.exe`, `.dll`, `.bat`, `.app`, `.dylib`, `.sh`, `.so`,
  `.zip`);
- an image has the wrong size, or the preview is over 1,024,000 bytes;
- the tags aren't exactly `Build 42;Multiplayer;Framework`;
- `published.json` doesn't validate;
- `--out` points at a staged item whose `workshop.txt` has a different
  `id=` than `published.json`.

---

## Path B: the first publish, with the in-game uploader

Use the in-game uploader for the item's first publish: it validates the
preview image and sets the tags. Publish from the tagged tree of the
release that bumped the bridge, so the uploaded code is the released code.

1. Build the item into the game's staging folder:
   ```sh
   npm run workshop:build -- --out ~/Zomboid/Workshop
   ```
2. Start Project Zomboid in windowed mode (Steam's upload confirmation can
   be hidden in fullscreen or borderless mode). From the main menu, open
   **Workshop**, pick `ZomboidControlPanelBridge`, choose **This is a new
   workshop item**, check that visibility is **Unlisted**, and click
   **Upload to Steam Workshop now!**. Confirm Steam's upload prompt.
3. Record the new ID. The game writes `id=` back into the staged
   `workshop.txt`, and `record` reads it from there:
   ```sh
   node scripts/workshop/publish.mjs record --from-staged ~/Zomboid/Workshop/ZomboidControlPanelBridge --visibility unlisted
   ```
   If that file has no `id=` line, find the ID on the account's Steam
   profile under Workshop Items and run
   `node scripts/workshop/publish.mjs record --id <id> --visibility unlisted`
   instead. Either way `published.json` gets `workshopId`, `visibility`,
   `publishedVersion` and `publishedAt`.
4. **Move `~/Zomboid/Workshop/ZomboidControlPanelBridge` out of
   `~/Zomboid/Workshop`** before you test anything on this machine. With
   Steam on, the game loads staged items ahead of Workshop downloads. While
   the staged copy is there, the game and any Steam-mode server that uses
   this Zomboid folder run it instead of the downloaded item. The live test
   would then check the wrong files (the bridge reports delivery `mod`,
   never `workshop`), and after a later publish that machine would keep
   running the old code. To upload in-game again later, recreate the staged
   copy with its ID: `npm run workshop:build -- --out ~/Zomboid/Workshop`.
5. **Don't commit `published.json` to `main` until the live test has
   passed.** A push to `main` that touches `pz-mod/` rebuilds and
   republishes the all-in-one Docker image, and every release embeds the
   file, so the ID would reach operators at once. Keep it on a branch.
6. Run the [live test](#live-test) from that branch.

---

## Path A: updates, with steamcmd

```sh
node scripts/workshop/publish.mjs --steam-user <account> [--visibility unlisted|public]
  [--changenote-file <file>] [--steamcmd <path>] [--dry-run] [--allow-unreleased] [--force]
```

The tool refuses to publish when:

- `build-item.mjs --check` fails;
- the bridge code differs from `pz-mod/bridge-version.lock.json`, that is,
  from the released code. `--allow-unreleased` overrides this for live-test
  iterations only;
- `published.json` already records this `VERSION` as published. `--force`
  overrides it; every publish costs each Workshop server a restart;
- the recorded mod ID changed, or the new ID would replace a different one
  already pinned in `published.json`.

`--dry-run` prints the `dist-workshop/item.vdf` it would write and the
steamcmd command it would run, and runs nothing. A real run writes the VDF,
prints which account it publishes as, and runs
`steamcmd +login <account> +workshop_build_item <vdf> +quit` attached to the
terminal, where steamcmd asks for the password and Steam Guard code. On
exit code 0 it records `publishedVersion`, `publishedAt` and `visibility` in
`published.json` (and `workshopId` when the item had none).

After a publish:

- Exit code 0 doesn't prove the upload worked. Check that the change note
  shows on `https://steamcommunity.com/sharedfiles/filedetails/changelog/<id>`.
  If it doesn't, keep the recorded ID and publish again with `--force`.
- If the tags are missing on the Steam page, set them once with the in-game
  uploader (`npm run workshop:build -- --out ~/Zomboid/Workshop`, then
  upload as an existing item), and move the staged copy out again
  afterwards (Path B, step 4).
- After an `--allow-unreleased` publish, `published.json` still records the
  item as `VERSION`, so `release.ps1` compares versions only and may not
  ask for a publish. Publish from the next tagged release even if the
  change is reverted (with `--force` if that release keeps the same
  version).
- Commit `pz-mod/workshop/published.json`. For an item that hasn't passed
  the live test yet, keep it off `main` (Path B, step 5).

The first publish can also go through steamcmd (`publishedfileid` 0 in the
VDF). The tool reads the new ID back from the VDF. If steamcmd didn't write
it there, the tool says so and tells you not to publish again, which would
create a second item: find the ID on the account's Steam profile and run
`record --id`. Path B is still preferred for the first publish.

---

## Live test

Until this test is recorded, the panel marks Steam Workshop delivery
**Preview**, and it asks for an extra acknowledgement before turning the
Lua integrity check on for any server that isn't known to run on Windows.

Run the panel **from source** (`npm run dev`), from the branch that holds
the recorded `published.json`; it reads the file from disk. For the Linux
server, run the panel from source on the Linux host too, or use an
all-in-one image built from that branch (the image copies `pz-mod/` when
it is built). Don't use
`PANEL_BRIDGE_WORKSHOP_ID` for these runs: it marks the item as a test
override, so the panel wouldn't show what operators will see. The panel
reads `published.json` once per process, so restart it after changing the
file or the variable.

### Prerequisites

- The dedicated publishing account (above).
- Two Build 42 dedicated servers on the current game build: one on
  **Windows** (native, panel-managed) and one on **Linux** (the Docker
  all-in-one counts).
- A **plain player account**: access level none, not admin or moderator.
  It is the only account whose result counts. Admin accounts skip the Lua
  integrity check, so an admin account is a control only.
- A Windows game client.
- The item published **unlisted** with Path B and recorded with
  `publish.mjs record`, and the staged copy moved out.

### A. Windows server

1. With panel-installed delivery, Settings → PanelBridge (or
   `GET /api/panel-bridge/delivery`) shows state `local-ok`, and the
   heartbeat's delivery is `loose`.
2. Click **Switch to Steam Workshop**. The preview must list exactly: two
   `.ini` additions (`Mods=`, `WorkshopItems=`), moving `PanelBridge.lua`
   out (plus any client companion or `mod.info` an older panel left), and
   "Stop copying PanelBridge into this game folder". Click **Switch and
   restart now**.
3. After the restart:
   - the state is `workshop-confirmed` (*"Loaded from the Steam Workshop:
     v…"*);
   - `status.json` has `delivery.method` `workshop`, the right
     `workshopId`, and `modActive: true`;
   - the server console has `[PanelBridge] Loaded from: workshop <id>`;
   - **record** the `Workshop: <id> installed to <folder>` line from
     `server-console.txt` (the folder is what this step settles);
   - Settings → PanelBridge and Debug & Logs → Checks & Fixes (*"PanelBridge
     Workshop item present"*) agree on the version.
4. With `DoLuaChecksum=false`, the **plain player** joins. The game asks for
   one install click for the item, then the player gets in. Teleport the
   player from the World Map and check the bridge debug log for a
   `teleportAck`: the client companion now runs on the player's game.
5. Turn the check on through the panel (**Turn on the Lua integrity
   check…**, ticking every box it asks for), then restart. The **plain
   player** must join. Then the admin joins, as a control.
6. Negative controls, with `DoLuaChecksum=true`:
   1. Copy a loose `PanelBridge.lua` back into `media/lua/server/` in the
      install folder and restart **outside the panel** (run the start
      script directly). The plain player must be **refused**. Then restart
      **from the panel**: the launch moves the file out, and the player
      joins.
   2. Edit one Lua file on the player's machine. The player is refused.
7. Single player with the mod enabled: no `Zomboid/Lua/panelbridge/` files
   are created, `console.txt` has no PanelBridge errors, and the log has no
   `[PanelBridge] Initializing`.

### B. Linux server with a Windows client

1. Repeat A2–A6 on the Linux server.
2. **Record** whether the plain player can join with the check on.
3. If not, record `nonAdminJoinWithChecksumOn: false` for `linuxServer`
   below. The panel then keeps asking for the Linux acknowledgement, and
   the docs keep the Linux caveat.

### C. Updates

1. Change the Lua (a line under `vNEXT Changes:` is enough) and publish
   again while the server runs:
   `node scripts/workshop/publish.mjs --steam-user <account> --allow-unreleased --force`.
2. A new plain-player join fails with *"Workshop item version is different
   than the server's"*. **Record** what players who were already connected
   experience.
3. The Mods page and the mod update check flag the update. With
   **Auto-restart server when mods update** on, the server restarts and
   joins work again. With it off, Settings → PanelBridge shows *"After each
   PanelBridge update, new players can't join until you restart."*
4. If you published with steamcmd, **record** whether the multi-line
   description shows correctly on the Steam page.

### D. Failure

1. Stop the panel. Set `PANEL_BRIDGE_WORKSHOP_ID=1` (an item that doesn't
   exist) in the shell or in `.env` at the repository root, and start the
   panel. When it starts, and again before each start from the panel, it
   replaces the server's `WorkshopItems=` entry with `1`.
2. Start the server. Startup stops, and Settings → PanelBridge shows **The
   server didn't start** with the `Workshop: … itemID=1 …` line.
3. Click **Switch to panel-installed and start**. The server comes up with
   `DoLuaChecksum=false` and the loose file in place, and the plain player
   joins.
4. Unset the variable, restart the panel, and switch to Steam Workshop
   again.

### E. Rollback

From a confirmed Workshop server, switch to panel-installed and check:

- the entries are gone from every `.ini` of the servers sharing that game
  folder;
- `DoLuaChecksum=false`;
- the loose file is present and current;
- after the restart, the state is `local-ok` and the heartbeat's delivery
  is `loose`.

### F. Anonymous download

Dedicated servers log on to Steam anonymously. The **unlisted** item must
download on both servers. If it doesn't, make it public (see below) and
repeat A2–A3.

### G. `-nosteam`

- A profile with **Launch without Steam** on shows the Steam Workshop option
  disabled, with the reason.
- On a Workshop profile, turning on **Launch without Steam** in the edit
  dialog is refused with the localized error.

### H. Hosted or remote server (optional)

Follow the guided steps on a hosted or SFTP server
([hosted.md](../install/hosted.md), Phase 3, Option A). The heartbeat
confirms the switch (`workshop-confirmed`), and the checksum dialog asks
you to confirm that the uploaded files were deleted.

---

## Recording the result and releasing

1. Fill in `liveVerified` in `pz-mod/workshop/published.json` by hand, one
   entry per server OS. `gameVersion` is the build as `42.20` or `42.20.4`,
   without the revision the heartbeat appends:
   ```json
   "liveVerified": {
     "windowsServer": { "gameVersion": "42.20", "date": "YYYY-MM-DD", "nonAdminJoinWithChecksumOn": true },
     "linuxServer": { "gameVersion": "42.20", "date": "YYYY-MM-DD", "nonAdminJoinWithChecksumOn": true }
   }
   ```
   `node scripts/workshop/build-item.mjs --check` validates the shape. The
   Preview badge goes away once both entries are filled. The extra
   acknowledgement for servers that aren't on Windows goes away only when
   `linuxServer` records `nonAdminJoinWithChecksumOn: true`.
2. Put the released code back on the item. The item still holds the C.1
   test edit, with its *"Unreleased changes:"* Steam change note, and
   making it public would ship both. Revert the C.1 Lua edit on the test
   branch, so the bridge code matches the released code (the version
   lock) again, and republish from there:
   `node scripts/workshop/publish.mjs --steam-user <account> --force`
   (`--force` because `published.json` already records this version).
   Check that the new change note shows on Steam, as after any publish
   (Path A).
3. Make the item public on its Steam page, and set `"visibility": "public"`
   in `published.json`.
   `node scripts/workshop/publish.mjs --steam-user <account> --visibility public --force`
   also works, but it is a publish, with the restart cost that comes with
   it.
4. If a recorded result differs from what the docs say — the item folder
   in `docs/install/docker.md`, or the update and Linux entries in
   `docs/install/troubleshooting.md` — correct those docs in the same
   change.
5. Commit `published.json` to `main` and release. That release embeds the
   ID, and the panel's Steam Workshop option turns on.
6. Reply on issue #168 with the release link. Use the same wording as the
   panel: it turns the Lua integrity check back on, so players whose Lua,
   script or animation files differ from the server's are refused; it
   doesn't stop modified game clients, and admin accounts skip this check.
   If anything is still unverified, say that the option stays marked
   Preview until it is.

Making Workshop delivery the default for new Steam-mode servers is a
separate, later decision.

---

## If the item or the account is lost

The item ID is effectively permanent. If the account or the item is lost, a
new item gets a new ID. `publish.mjs` refuses to replace a pinned ID, so
put the new ID into `published.json` by hand and release. At its next
launch from the panel, each Workshop server with automatic access swaps its
old `WorkshopItems=` entry for the new ID, and players download the new
item when they join. Hosted and remote servers have to change the entry by
hand.
