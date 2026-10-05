import { afterAll, beforeAll, describe, expect, it } from "vitest";
import os from "os";
import path from "path";

// Security sweep 2026-10-05, H1: backup:progress, restore:progress and
// restore:finished reach the "backups" room -- backups.download and
// backups.restore included, neither of which may see host folders -- with
// their message run through sanitizeError(). Its patterns cut a Windows path
// at the first space and only knew ten POSIX top-level folders, so
// "C:\Program Files (x86)\Steam\...\Project Zomboid Dedicated Server\..."
// kept everything after "C:\Program", and /data, /app, /zomboid, /pz-server
// and /Users paths went out whole. The fix redacts the folders the panel is
// configured with by exact text first, then broadens the generic patterns
// without touching URLs, times or ratios.

const init = await import("../database/init.js");
const { sanitizeError, registerHostFolderSource } = await import("../utils/sanitize.js");
const { BackupService, BACKUP_PROGRESS_ROOM } = await import("../services/backupService.js");

const BS = String.fromCharCode(92);
const win = (...parts) => parts.join(BS);

describe("sanitizeError: generic path patterns", () => {
  it("redacts a whole Windows path whose folders hold spaces", () => {
    const install = win(
      "C:",
      "Program Files (x86)",
      "Steam",
      "steamapps",
      "common",
      "Project Zomboid Dedicated Server",
    );
    expect(sanitizeError(`Saves folder not found: ${install}${BS}Zomboid${BS}Saves`)).toBe(
      "Saves folder not found: [path]",
    );
    expect(
      sanitizeError(`ENOENT: no such file or directory, open '${install}${BS}java${BS}my mod${BS}x.jar'`),
    ).toBe("ENOENT: no such file or directory, open '[path]'");
    expect(sanitizeError(`Missing ${win("C:", "Users", "John Smith", "Zomboid", "Saves")} after restore`)).toBe(
      "Missing [path] after restore",
    );
  });

  it("redacts POSIX paths outside home/opt/usr/var/tmp/srv/root/etc/mnt/media", () => {
    for (const hostPath of [
      "/data/pz/Saves/Multiplayer/world/map_1_1.bin",
      "/app/data/db.json",
      "/zomboid/Server/servertest.ini",
      "/pz-server/start-server.sh",
      "/Users/bob/Zomboid/backups/servertest.zip",
    ]) {
      expect(sanitizeError(`Backup failed: EACCES: permission denied, open ${hostPath}`)).toBe(
        "Backup failed: EACCES: permission denied, open [path]",
      );
      expect(sanitizeError(`rename '${hostPath}' -> '${hostPath}.tmp'`)).toBe("rename '[path]' -> '[path]'");
    }
  });

  it("leaves URLs, times, ratios, versions and chat commands as written", () => {
    for (const text of [
      "See https://steamcommunity.com/sharedfiles/filedetails/?id=2392709985 for details",
      "Docs at https://example.com/home/docs/backups",
      "Archiving files... (50/1200)",
      "Restart at 12:30:45, 3/4 players online, 50%/60% disk",
      "Panel v1.4.6/2, km/h, TCP/IP and/or N/A",
      "Unknown command '/help' -- try /kick",
      "Restored from servertest_2026-10-05T12-00-00.zip",
    ]) {
      expect(sanitizeError(text)).toBe(text);
    }
  });
});

describe("sanitizeError: the folders the panel is configured with", () => {
  const unregister = [];

  afterAll(() => {
    for (const remove of unregister) remove();
  });

  it("redacts a registered folder by exact text, even where the generic patterns stop", () => {
    unregister.push(
      registerHostFolderSource(() => ["/srv/pz world", "/zomboid", win("D:", "PZ Server", "My Data")]),
    );
    // A space in the last name, and a single-name root.
    expect(sanitizeError("Backup failed: /srv/pz world is read-only")).toBe("Backup failed: [path] is read-only");
    expect(sanitizeError("/zomboid is full")).toBe("[path] is full");
    expect(sanitizeError("/zomboid/Saves/Multiplayer/x.bin is locked")).toBe("[path] is locked");
    // Folder names below a registered folder may hold spaces.
    expect(sanitizeError("/zomboid/My Saves/world one/map.bin is locked")).toBe("[path] is locked");
    expect(sanitizeError("/zomboid/a/b and 3/4 done")).toBe("[path] and 3/4 done");
    // Windows folders: any case, either slash style, with the path below them.
    expect(sanitizeError(`${win("D:", "PZ Server", "My Data")} is full`)).toBe("[path] is full");
    expect(sanitizeError("d:/pz server/MY DATA/Saves/x is locked")).toBe("[path] is locked");
    // Not the start of a longer name.
    expect(sanitizeError("/zomboidx/notes")).toBe("[path]");
    expect(sanitizeError("about /zomboidx")).toBe("about /zomboidx");
  });

  it("redacts the OS temp folder", () => {
    expect(sanitizeError(`Could not write ${os.tmpdir()} at all`)).toBe("Could not write [path] at all");
  });

  it("redacts every server's folders and folder settings straight from the database", async () => {
    await init.initDatabase();
    await init.createServer({
      name: "Host paths",
      serverName: "hostpaths",
      installPath: "/opt/pz/My Launchers/start server.sh",
      zomboidDataPath: "/zomboid data/Zomboid",
    });
    await init.setSetting("steamcmdPath", "/steam cmd");

    // Neither starts like a path the generic patterns know: a space ends
    // their first name.
    expect(sanitizeError("Saves folder not found: /zomboid data/Zomboid/Saves/Multiplayer/hostpaths")).toBe(
      "Saves folder not found: [path]",
    );
    expect(sanitizeError("SteamCMD missing at /steam cmd/steamcmd.sh")).toBe("SteamCMD missing at [path]");
    // A launcher file adds its folder.
    expect(sanitizeError("Could not run /opt/pz/My Launchers/start server.sh")).toBe("Could not run [path]");
    expect(sanitizeError("Log at /opt/pz/My Launchers/logs/out.txt")).toBe("Log at [path]");
  });
});

describe("backup:progress", () => {
  let zomboidDataPath;

  beforeAll(async () => {
    await init.initDatabase();
    // A save folder that doesn't exist, below folder names with spaces.
    zomboidDataPath = path.join(os.tmpdir(), `zcp h1 ${process.pid}`, "pz data");
    const servers = await init.getServers();
    for (const server of servers) await init.deleteServer(server.id);
    const created = await init.createServer({
      name: "Backup paths",
      serverName: "servertest",
      zomboidDataPath,
    });
    await init.setActiveServer(created.id);
  });

  it("carries no part of the save folder to the backups room", async () => {
    const sent = [];
    const io = {
      emit: () => {
        throw new Error("backup progress must never go to every socket");
      },
      to: (room) => ({ emit: (event, payload) => sent.push({ room, event, payload }) }),
    };
    const result = await new BackupService().createBackup({ io });
    expect(result.success).toBe(false);

    const errors = sent.filter((s) => s.event === "backup:progress" && s.payload.phase === "error");
    expect(errors.length).toBeGreaterThan(0);
    for (const { room, payload } of errors) {
      expect(room).toBe(BACKUP_PROGRESS_ROOM);
      expect(payload.message).toContain("Saves folder not found: [path]");
      for (const leaked of ["zcp h1", "pz data", "Saves" + BS, "Saves/", "Multiplayer", "servertest"]) {
        expect(payload.message).not.toContain(leaked);
      }
    }
    expect(result.message).toBe("Saves folder not found: [path]");
  });
});
