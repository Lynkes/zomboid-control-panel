import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import { SFTP_SERVER_REQUIRED, sftpServerSkipReason, startOpensshSftpServer } from "./helpers/opensshSftpServer.js";

// #197 on a remote server, against a REAL OpenSSH sftp-server
// (helpers/opensshSftpServer.js). The world save's map_sand.bin, which the
// game applies over SandboxVars.lua on every start, sits next to the remote
// Server/ folder (<cachedir>/Saves/Multiplayer/<server>/). A PanelBridge
// older than #197 wrote it on every live edit; the current one doesn't
// refresh it, so on such a world live edits now revert at the next restart.
// Server Config only ever looked for it on local servers.

const {
  beginRemoteConfigSession,
  pullRemoteConfigFiles,
  remoteWorldSandboxSnapshotPath,
  resetRemoteConfigSession,
  retireRemoteWorldSandboxSnapshot,
} = await import("../services/remoteConfigFiles.js");

const suite = sftpServerSkipReason ? describe.skip : describe;
if (sftpServerSkipReason) {
  (SFTP_SERVER_REQUIRED ? describe : describe.skip)(`map_sand.bin over real OpenSSH (${sftpServerSkipReason})`, () => {
    it("needs an sftp-server binary", () => {
      throw new Error(sftpServerSkipReason);
    });
  });
}

const SNAPSHOT_REL = "Zomboid/Saves/Multiplayer/servertest/map_sand.bin";
const SNAPSHOT = Buffer.from("SAND fake snapshot: Cognition=1 DoorOpeningPercentage=5");
const SANDBOX = "SandboxVars = {\n    VERSION = 6,\n}\n";

let srv;

const transport = (configRel = "Zomboid/Server") => ({
  host: "127.0.0.1",
  port: srv.port,
  username: "pz",
  password: "pw",
  configPath: srv.remote(configRel),
});

async function startHost(opts) {
  srv = await startOpensshSftpServer(opts);
  srv.fs.writeFile("Zomboid/Server/servertest_SandboxVars.lua", SANDBOX);
  srv.fs.writeFile(SNAPSHOT_REL, SNAPSHOT);
  const mtime = new Date("2026-10-05T06:58:03.000Z");
  fs.utimesSync(srv.local(SNAPSHOT_REL), mtime, mtime);
}

beforeEach(() => {
  resetRemoteConfigSession();
});

afterEach(async () => {
  resetRemoteConfigSession();
  await srv?.close();
  srv = null;
});

suite("a remote world's map_sand.bin over real OpenSSH (#197)", () => {
  it("is found next to the remote Server folder when the config is pulled", async () => {
    await startHost();

    const session = await pullRemoteConfigFiles(transport(), "servertest");

    expect(session.worldSandboxSnapshot).toEqual({
      path: srv.remote(SNAPSHOT_REL),
      mtime: "2026-10-05T06:58:03.000Z",
    });
    expect(session.manifest["servertest_SandboxVars.lua"]).toBeTruthy();
  });

  it("is reported as none when the world has no map_sand.bin, or a folder by that name", async () => {
    await startHost();
    fs.rmSync(srv.local(SNAPSHOT_REL));

    expect((await pullRemoteConfigFiles(transport(), "servertest")).worldSandboxSnapshot).toBeNull();

    srv.fs.mkdir(SNAPSHOT_REL);
    expect((await pullRemoteConfigFiles(transport(), "servertest")).worldSandboxSnapshot).toBeNull();
  });

  it("is looked for only when the config folder is a Server folder", async () => {
    await startHost();
    srv.fs.writeFile("elsewhere/servertest_SandboxVars.lua", SANDBOX);
    srv.fs.writeFile("Saves/Multiplayer/servertest/map_sand.bin", SNAPSHOT);

    expect(remoteWorldSandboxSnapshotPath(transport("elsewhere"), "servertest")).toBeNull();
    expect((await pullRemoteConfigFiles(transport("elsewhere"), "servertest")).worldSandboxSnapshot).toBeNull();
    expect(await retireRemoteWorldSandboxSnapshot(transport("elsewhere"), "servertest")).toEqual({
      available: false,
      retired: false,
    });
    expect(srv.fs.readFile("Saves/Multiplayer/servertest/map_sand.bin")).toEqual(SNAPSHOT);
  });

  it("is moved, intact, into the backups folder of the remote Server folder", async () => {
    await startHost();

    const result = await retireRemoteWorldSandboxSnapshot(transport(), "servertest");

    expect(result).toMatchObject({ available: true, retired: true });
    expect(result.movedTo.startsWith(`${srv.remote("Zomboid/Server/backups")}/servertest_map_sand.bin.`)).toBe(true);
    expect(result.movedTo).toMatch(/\.retired$/);
    expect(srv.fs.exists(SNAPSHOT_REL)).toBe(false);
    expect(srv.fs.readFile(`Zomboid/Server/backups/${result.movedTo.split("/").pop()}`)).toEqual(SNAPSHOT);
    expect((await pullRemoteConfigFiles(transport(), "servertest")).worldSandboxSnapshot).toBeNull();
  });

  it("keeps both copies when retired twice in a row", async () => {
    await startHost();

    const first = (await retireRemoteWorldSandboxSnapshot(transport(), "servertest")).movedTo;
    srv.fs.writeFile(SNAPSHOT_REL, "second");
    const second = (await retireRemoteWorldSandboxSnapshot(transport(), "servertest")).movedTo;

    expect(second).not.toBe(first);
    expect(srv.fs.readFile(`Zomboid/Server/backups/${first.split("/").pop()}`)).toEqual(SNAPSHOT);
    expect(srv.fs.readFile(`Zomboid/Server/backups/${second.split("/").pop()}`).toString()).toBe("second");
  });

  it("is copied, then removed, when the host refuses the rename (Saves/ on another mount)", async () => {
    await startHost({ denyRequests: ["rename", "posix-rename"] });

    const result = await retireRemoteWorldSandboxSnapshot(transport(), "servertest");

    expect(result.retired).toBe(true);
    expect(srv.fs.exists(SNAPSHOT_REL)).toBe(false);
    expect(srv.fs.readFile(`Zomboid/Server/backups/${result.movedTo.split("/").pop()}`)).toEqual(SNAPSHOT);
  });

  it("does nothing for a world without map_sand.bin", async () => {
    await startHost();
    fs.rmSync(srv.local(SNAPSHOT_REL));

    expect(await retireRemoteWorldSandboxSnapshot(transport(), "servertest")).toEqual({
      available: true,
      retired: false,
    });
    expect(srv.fs.exists("Zomboid/Server/backups")).toBe(false);
  });

  it("drops the cached mirror session that still names it", async () => {
    await startHost();
    const before = await beginRemoteConfigSession(transport(), "servertest", { fresh: false });
    expect(before.worldSandboxSnapshot).not.toBeNull();

    await retireRemoteWorldSandboxSnapshot(transport(), "servertest");

    const after = await beginRemoteConfigSession(transport(), "servertest", { fresh: false });
    expect(after).not.toBe(before);
    expect(after.worldSandboxSnapshot).toBeNull();
  });
});
