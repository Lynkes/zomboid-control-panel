# Hosted / Rented Server Install Guide

For a Project Zomboid server you rent from a hosting provider — you have a
web control panel and no shell, no Docker, no systemd. **Indifferent
Broccoli** is used as the worked example throughout because its terminology
(RCON details, file manager, SFTP credentials) is representative of most PZ
hosts; the concepts and panel steps are the same anywhere else.

Read the three facts below before you touch anything. Each one is a wrong
expectation that otherwise costs an hour of confused troubleshooting.

## Three things to know before you start

**1. The panel does not take ownership of your rented server.** Starting,
stopping, restarting, and installing game updates all stay in your
provider's dashboard, exactly as they do today. This panel adds
administration on top — RCON commands, the world map, player management,
weather, PanelBridge features — it does not replace your provider's own
start/stop controls, and it cannot install a game update for a server it
doesn't own the process of.

**2. PanelBridge needs SFTP. Plain FTP will not work — at all, silently
or otherwise.** That holds whichever way PanelBridge gets onto the server
(Phase 3): the panel talks to it through files it syncs over SFTP. The
panel's file-sync code only speaks SFTP (SSH File
Transfer Protocol); there is no FTP or FTPS client anywhere in it. If your
provider's file manager or credentials page offers a choice, pick **SFTP**
(usually port 22), not FTP or FTPS. If you paste FTP credentials into an
SFTP field, every connection attempt fails and the panel has no way to tell
you "you used the wrong protocol" — it just reports a connection or
authentication error indistinguishable from a wrong password.

**3. The panel itself does not run on your rented server — it can't; you
have no shell there.** It runs on a computer you do control: your own
Windows PC, a Linux machine, or a small VPS you rent separately. Install it
there first using the sibling guide for that machine:

- Windows PC: [`docs/install/windows.md`](windows.md)
- Linux machine or VPS: [`docs/install/linux.md`](linux.md)

Everything below assumes the panel is already running somewhere you
control, and you're now pointing it at the rented game server.

---

## Phase 1 — What you need from your provider

1. Your provider's web control panel login.
2. The PZ server's **RCON port and password**. Most providers show these
   under a "Server settings", "Startup parameters", or "RCON" section of
   their dashboard. If no RCON password is set yet, set one now — the panel
   cannot connect without one.
3. Access to the provider's **web file manager** (sometimes called "File
   Manager", "FTP/SFTP access", or similar) — this is how you'll edit the
   server's `.ini` or upload PanelBridge.lua in Phase 3.
4. Separately, your provider's **SFTP credentials** — host, port (usually
   22), username, and password. These are not always the same account or
   password as your provider dashboard login; look for an "FTP/SFTP access"
   or "File access" page.

**You know it worked when:** you have four values written down — RCON
port, RCON password, SFTP host/port/username/password — before opening the
panel.

---

## Phase 2 — Add the server as remote

5. In the panel's left sidebar, click **My Servers**.
6. Click **Add Existing Server**, then choose **Remote Server**.
7. Fill in:
   - **Server machine (RCON host)** — the address of the machine running
     PZ. This is your provider's server address (for example
     `192.168.1.100` or `server.example.com`), **never** `127.0.0.1` — that
     would mean the computer the panel itself is running on.
   - **RCON Port** and **RCON Password** — from Phase 1, step 2.
8. Save, then set it as the active server.

**You know it worked when:** the Servers card shows the server as connected
(not offline), and the panel logs `Cannot connect to server. Is the game
server running with RCON enabled?` (RCON refused the connection — check the
port and that the server is actually running), `Connection timed out.
Server may be unresponsive or firewall is blocking.` (see [When the
provider blocks the RCON port](#when-the-provider-blocks-the-rcon-port-from-outside)
below), or `Authentication failed. Check RCON password in server settings.`
(the password doesn't match) if it doesn't.

RCON alone already unlocks console commands, player kick/ban, and most
Events/Players actions. Everything from here on is for **PanelBridge**
specifically — weather control, teleport, and the other features that need
a file channel into the game, not just RCON.

---

## Phase 3 — Put PanelBridge on the server

PanelBridge can reach a rented server in two ways. Pick one now; you can
switch later under **Settings → PanelBridge → How PanelBridge is
installed**. The panel can't change a rented server's files, so either way
you make the changes yourself, through your provider's file manager or
config editor.

| | Option A: Steam Workshop | Option B: upload the file |
| --- | --- | --- |
| Works on | Build 42 servers running in Steam mode (not started with `-nosteam`) | Any server, including Build 41 and servers that launch without Steam |
| What you change | Two entries in the server's `.ini` | Upload `PanelBridge.lua`, set `DoLuaChecksum=false` |
| Players | Install "Zomboid Control Panel Bridge" with one click when they join | Download nothing |
| Lua integrity check (`DoLuaChecksum`) | Can go back on once the panel confirms the switch | Must stay off, or players can't join |
| After a panel update | Nothing to upload. After each PanelBridge update on the Workshop, new players can't join until the server restarts | Upload the new `PanelBridge.lua` |
| If Steam can't deliver PanelBridge | The server won't start until Steam can, or you switch to Option B | Not affected |

With the check back on, players whose Lua, script or animation files
differ from the server's are refused. It doesn't stop modified game
clients, and admin accounts skip this check.

Option A needs this panel version to know the PanelBridge Workshop item's
ID. If the **Steam Workshop** card under **How PanelBridge is installed**
says *"Not available yet: the PanelBridge Workshop item hasn't been
published, so this panel version doesn't know its ID"*, use Option B for
now. You can switch after a panel update.

Both options use steps 9–12, and Phase 4 continues from either.

### Option A — Steam Workshop

9. In the panel, open **Settings → PanelBridge**. Under **How PanelBridge
   is installed** (it names the active server), click **Switch to Steam
   Workshop**. The dialog (*Switch <server> to Steam Workshop delivery?*)
   lists, under **Make these changes on the server**, the exact values with
   a **Copy** button for each. Keep it open.
10. Open your server's `.ini` file — through the provider's config editor,
    or by downloading and re-uploading it through the file manager — and:
    - add `;ZomboidControlPanelBridge` to the end of the `Mods=` line;
    - add `;` followed by the item ID the dialog shows to the end of the
      `WorkshopItems=` line (add the line if it's missing).

    Always add both. A `Mods=` entry without its `WorkshopItems=` ID stops
    every player from joining. If your provider manages these two lines
    from its own mod list page, add the entries there instead, so the
    provider doesn't write the old lines back.

    Leave `DoLuaChecksum=false` (set it if the line is missing or says
    `true`) until the panel confirms the switch in Phase 4.
11. In the file manager, delete `media/lua/server/PanelBridge.lua` and
    `media/lua/client/PanelBridgeClient.lua` from the server's game folder
    if you uploaded them earlier. Check that the server isn't started with
    `-nosteam` (look at your provider's startup parameters). Then click
    **I've made these changes** in the dialog. The panel saves the choice
    and confirms the switch once PanelBridge reports in, which needs the
    SFTP bridge from Phase 4.
12. Restart the PZ server from your **provider's dashboard** — not from the
    panel, which doesn't own this server's lifecycle (see fact 1 above).
    It downloads PanelBridge from the Steam Workshop as it starts.

**You know it worked when:** the server comes back up and its console
shows `[PanelBridge] Loaded from: workshop` followed by the item ID. The
panel's own confirmation comes after Phase 4: **How PanelBridge is
installed** then reads *"Loaded from the Steam Workshop: v…"*. Only then
turn the Lua integrity check back on. The block offers **Turn on the Lua
integrity check…**, which asks you to set `DoLuaChecksum=true` in the
`.ini` and restart. Test with a normal player account: an admin getting in
proves nothing. If the server doesn't come back up, see [Server won't start
after switching to the
Workshop](troubleshooting.md#server-wont-start-after-switching-to-the-workshop).

### Option B — Upload PanelBridge.lua

9. Find `PanelBridge.lua` inside your own panel install — it shipped
   alongside it, at `pz-mod/PanelBridge/media/lua/server/PanelBridge.lua`
   (Windows and Linux downloads both include a `pz-mod/` folder next to the
   panel executable). Players don't install anything with this option.
10. In your provider's web file manager, upload that file into your PZ
    server's `Install/media/lua/server/` folder (the exact root name varies
    by provider — Indifferent Broccoli calls it the server's file root; look
    for an existing `media/lua/server/` path and drop the file next to
    what's already there).
11. Open your server's `.ini` file — through the provider's config editor,
    or by downloading and re-uploading it through the same file manager —
    and set:
    ```ini
    DoLuaChecksum=false
    ```
    With this option it has to stay off: with it on, players can't join.
12. Restart the PZ server from your **provider's dashboard** — not from the
    panel, which doesn't own this server's lifecycle (see fact 1 above).

**You know it worked when:** the `.ini` file you re-download shows
`DoLuaChecksum=false`, and the server comes back up without a checksum
error in its console.

After each panel update, upload the new `PanelBridge.lua` the same way and
restart. Once the SFTP bridge is running, Settings → PanelBridge shows
**Bridge mod update available** when the server's copy is older than the
panel's.

---

## Phase 4 — Configure the SFTP bridge

13. In the panel, open **Settings → PanelBridge**. You'll see a "Remote
    server setup" section — it's shown automatically because the active
    server is remote.
14. Under **SFTP PanelBridge files**, fill in the same SFTP host, port,
    username, and password from Phase 1, step 4.
15. Set **Remote bridge folder on the VPS** to the path, as your SFTP
    account sees it, to `Lua/panelbridge/<your server name>` under your
    Zomboid data folder — for example
    `/home/pz/Zomboid/Lua/panelbridge/MyServer`. Use the path exactly as
    your SFTP client shows it, not a Windows path and not a path from your
    own computer.

    **If your SFTP account is chrooted** (very common on rented hosts —
    the account's own root looks like `/` even though the real path is
    somewhere under `/home`), a path starting with `/home/...` will be
    rejected. The panel's own error for this is explicit:
    > SFTP account rejected remote bridge path /home/pz/Zomboid/Lua/panelbridge/MyServer; likely chrooted account path. Remove the /home prefix and use the path visible in the SFTP client.

    If you see that, drop the `/home/<user>` portion and enter the path as
    your SFTP client already shows it from its own root — for example
    `/Zomboid/Lua/panelbridge/MyServer`.
16. Click **Verify and prepare SFTP**.
17. Once it succeeds, click **Start SFTP bridge**.

**You know it worked when** step 16 (Verify and prepare SFTP) returns one
of:
- *"The remote bridge is ready. Start the SFTP bridge."* — status.json
  already exists; PanelBridge loaded on a previous start. Move on to
  step 17.
- *"Folders are ready. Start or restart the PZ server with PanelBridge
  installed (see Settings › PanelBridge) to create status.json."* — the
  SFTP connection and folder itself are fine, but the game hasn't written
  its status file yet. Check the Phase 3 option you followed, restart the
  PZ server (Phase 3, step 12) and try again.

If step 16 fails instead, the panel prepends a **Fix:** suggestion to the
raw error — the exact text tells you which of these you're looking at:

| What you see | What it means |
| --- | --- |
| *"...Fix: Verify the SFTP username and password, then confirm the account can log in over port 22."* | Wrong username/password, or the account can't use SFTP at all. |
| *"...Fix: Give the SFTP account read and write permission for the remote bridge folder and its parent directory."* | The SFTP account can log in but can't write there — ask your provider to grant write access, or pick a folder it already owns. |
| *"...Fix: Verify the remote bridge folder is the VPS path to Lua/panelbridge/<server name>. The panel will create its inbox and outbox folders after the parent path is correct."* | The parent folder doesn't exist yet — double check the path from step 15. |
| *"...Fix: Check the SFTP host, port, firewall, and that the hosting provider allows SFTP from this panel computer."* | Couldn't reach the host at all — wrong host/port, or the provider firewalls SFTP to specific IPs. |
| *(chroot message quoted above)* | See the chroot note in step 15. |

After **Start SFTP bridge**, the connection page shows **Waiting for PZ
mod** until the game writes its status file — that's normal for up to one
sync interval (a few seconds) after the server finishes loading
PanelBridge.

If you followed Option A, **How PanelBridge is installed** now confirms
the switch with *"Loaded from the Steam Workshop: v…"*. If it says *"The
server started, but PanelBridge didn't load from the Workshop"* instead,
see [PanelBridge not loaded from the
Workshop](troubleshooting.md#panelbridge-not-loaded-from-the-workshop).

---

## Optional — edit server config files from the browser

If you also want to edit the `.ini` and `SandboxVars.lua` files from the
panel instead of your provider's file manager: in **Settings → PanelBridge
→ Remote server config**, set **Remote Server folder** to the absolute path
of the `Server` folder that directly contains those files (not a parent
folder), then click **Check folder**. A successful check lists the `.ini`
and `.lua` files it found there — an empty list almost always means the
path is one folder off. This unlocks the Server Config page for this
server; the panel mirrors `.ini` and `SandboxVars.lua` over SFTP, edits the
local copy, then writes it back.

---

## When the provider blocks the RCON port from outside

Some hosts firewall the RCON port to their own dashboard and don't expose
it to the wider internet by default — the panel then sees `Connection timed
out. Server may be unresponsive or firewall is blocking.` even with the
right host/port/password. There's no code fix for this on the panel side;
it's a provider-side setting. Two things to check, in order:

1. Look for an "external RCON", "remote access", or "advanced ports" toggle
   in your provider's dashboard — many hosts disable outside RCON access by
   default and require turning it on explicitly.
2. Confirm the port your provider's dashboard shows for RCON is the one you
   entered — some hosts proxy RCON through a different external port than
   the one written in the `.ini` file.

If neither applies, your provider's support is the next step — this is
their firewall, not something the panel can see into or work around.

---

## Optional extras

- **Remote server logs** (Settings → PanelBridge → Remote server logs): the
  panel can list and tail `.txt`/`.log` files in a remote `Logs` folder
  over the same SFTP connection, read-only — nothing is written to the
  remote host and whole files are never mirrored to disk.
- If your PZ server ever moves to a machine you fully control, everything
  above still works unchanged — a "remote" server in the panel just means
  "not on the same machine as the panel," Docker, VPS, or rented host alike.
