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

// Round 2 (verifier, info): a path straight after ':' was never redacted --
// the guard meant for "https://" also skipped "key:/path" and the second
// folder of a PATH-style list, which the old /home|/opt|... pattern did
// redact -- and an apostrophe in a quoted Windows path ended the match
// there. API routes and Steam Web API methods are not host folders.
describe("sanitizeError: round 2 of the generic patterns", () => {
  it("redacts a path straight after ':' but not a URL's", () => {
    expect(sanitizeError("config:/data/pz/server.ini")).toBe("config:[path]");
    expect(sanitizeError("home:/home/steam/Zomboid")).toBe("home:[path]");
    expect(sanitizeError("LD_LIBRARY_PATH=/data/pz/linux64:/data/pz/natives")).toBe(
      "LD_LIBRARY_PATH=[path]:[path]",
    );
    expect(sanitizeError("Cannot find module imported from file:///app/server/index.js")).toBe(
      "Cannot find module imported from file://[path]",
    );
    for (const text of [
      "See https://steamcommunity.com/sharedfiles/filedetails/?id=2392709985 for details",
      "Docs at https://example.com/home/docs/backups",
      "Proxy at http://127.0.0.1:8080/data/pz/x",
      "Restart at 12:30:45/12:31:00",
    ]) {
      expect(sanitizeError(text)).toBe(text);
    }
  });

  it("redacts a whole Windows path with an apostrophe in a folder name", () => {
    const home = win("G:", "Users", "O'Brien", "Zomboid", "Server", "servertest.ini");
    expect(sanitizeError(`EACCES: permission denied, open '${home}'`)).toBe(
      "EACCES: permission denied, open '[path]'",
    );
    expect(sanitizeError(`Missing ${home} after restore`)).toBe("Missing [path] after restore");
    expect(sanitizeError("rename '/home/o'neil/Zomboid/a.bin' -> 'b'")).toBe("rename '[path]' -> 'b'");
    // Two quoted paths still end at their own closing quotes.
    expect(sanitizeError(`copy '${win("C:", "a")}' to '${win("D:", "b")}'`)).toBe("copy '[path]' to '[path]'");
  });

  it("leaves API routes and Steam Web API methods as written", () => {
    for (const text of [
      "Request to /api/servers/1/status failed: 500",
      "Steam API returned 500 for /ISteamRemoteStorage/GetPublishedFileDetails/v1",
      "POST /IPublishedFileService/QueryFiles/v1 timed out",
    ]) {
      expect(sanitizeError(text)).toBe(text);
    }
    expect(sanitizeError("open /apidata/pz/x.ini")).toBe("open [path]");
  });
});

// Round 3 (verifier, info): the first path of a ';'-separated Windows list
// ran on into the next drive letter ("system32;D") and left the rest of the
// second path (":\Users\otheruser\...") as written; the pattern before this
// batch redacted the whole list. And "FILE:///" was not a file URL.
describe("sanitizeError: round 3 of the generic patterns", () => {
  it("redacts every path of a ';' or ',' separated Windows list", () => {
    const system = win("C:", "Windows", "system32");
    const other = win("D:", "Users", "otheruser", "AppData", "Local", "bin");
    expect(sanitizeError(`PATH=${system};${other}`)).toBe("PATH=[path];[path]");
    expect(sanitizeError(`PATH=${other};${system};${other}`)).toBe("PATH=[path];[path];[path]");
    expect(sanitizeError(`files: ${win("C:", "a", "b.txt")},${win("E:", "c", "d.txt")}`)).toBe(
      "files: [path],[path]",
    );
    // A UNC path after it reads as more of the same path: still all redacted.
    expect(sanitizeError(`PATH=${system};${BS}${BS}nas${BS}share${BS}otheruser`)).toBe("PATH=[path]");
    expect(sanitizeError("PATH=C:/Windows/system32;D:/Users/otheruser/bin")).toBe("PATH=[path];[path]");
    // A ';' that no drive follows stays part of the name.
    expect(sanitizeError(`open ${win("C:", "pz", "a;b.txt")}`)).toBe("open [path]");
  });

  it("redacts the path of an upper-case FILE:/// URL", () => {
    expect(sanitizeError("Cannot load FILE:///app/server/index.js")).toBe("Cannot load FILE://[path]");
    expect(sanitizeError("Cannot load File:///Users/bob/Zomboid/x.lua")).toBe("Cannot load File://[path]");
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
