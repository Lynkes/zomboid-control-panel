import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { buildNativeLibrariesCheck } from "../routes/debug.js";

// GET /api/debug/diagnostics' server.nativeLibs check (2026-10-01, 42.21
// UnsatisfiedLinkError incident): a leftover natives/ folder from an older
// build, whose libraries differ from linux64/'s, is a warning with the way
// out; otherwise, for a server the panel's own start script launches, the
// check says where the game's libraries load from. Each variant's wording
// depends on what the panel actually knows about the launch. Locale entries
// for every (status, variant) are enforced by
// diagnosticsCheckRegistry.test.js.

let roots = [];

function makeInstall(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-native-diag-"));
  roots.push(root);
  for (const [relativePath, content] of Object.entries(files)) {
    const filePath = path.join(root, ...relativePath.split("/"));
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return root;
}

function ageFile(root, relativePath, days) {
  const when = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  fs.utimesSync(path.join(root, ...relativePath.split("/")), when, when);
}

const INCIDENT_FILES = {
  "linux64/libPZPopMan64.so": Buffer.alloc(900, 2),
  "natives/libPZPopMan64.so": Buffer.alloc(590, 9),
  "ProjectZomboid64.json": JSON.stringify({
    mainClass: "zombie/network/GameServer",
    vmArgs: ["-Djava.library.path=linux64/"],
  }),
};

// A managed server with a name: the panel writes and launches its
// start-server_<name>.sh.
function panelLaunched(installPath) {
  return { installPath, serverName: "Tower" };
}

const linux = { platform: "linux", env: {} };

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("buildNativeLibrariesCheck()", () => {
  it("warns about the incident layout, with the libraries and the safe way out", async () => {
    const installPath = makeInstall(INCIDENT_FILES);

    const check = await buildNativeLibrariesCheck(panelLaunched(installPath), linux);

    expect(check).toMatchObject({
      id: "server.nativeLibs",
      status: "warn",
      severity: "warning",
      category: "server",
      variant: "leftoverNatives",
      params: { libraries: "libPZPopMan64.so" },
    });
    expect(check.message).toContain("libPZPopMan64.so");
    expect(check.message).toContain("The panel's start script loads linux64/");
    expect(check.hint).toMatch(/safe to remove or rename the natives\/ folder/);
    expect(check.hint).toMatch(/never deletes it/);
  });

  it("is ok, naming linux64/, for a clean install", async () => {
    const installPath = makeInstall({
      "linux64/libPZPopMan64.so": "current",
      "ProjectZomboid64.json": JSON.stringify({ vmArgs: ["-Djava.library.path=linux64/"] }),
    });

    const check = await buildNativeLibrariesCheck(panelLaunched(installPath), linux);

    expect(check).toMatchObject({
      id: "server.nativeLibs",
      status: "ok",
      category: "server",
      params: { folders: "linux64/" },
    });
    expect(check.variant).toBeUndefined();
  });

  it("is ok for a byte-identical natives/ copy -- nothing would load differently", async () => {
    const installPath = makeInstall({
      "linux64/libPZPopMan64.so": "same bytes",
      "natives/libPZPopMan64.so": "same bytes",
    });

    const check = await buildNativeLibrariesCheck(panelLaunched(installPath), linux);

    expect(check.status).toBe("ok");
    // Only the folders that hold a library, in the order they're searched.
    expect(check.params.folders).toBe("linux64/, natives/");
  });

  it("checks the folder a custom launcher sits in, without vouching for the launcher", async () => {
    const installPath = makeInstall({ ...INCIDENT_FILES, "custom.sh": "#!/bin/bash\n" });

    const check = await buildNativeLibrariesCheck(
      { serverName: "Tower", serverPath: path.join(installPath, "custom.sh") },
      linux,
    );

    expect(check).toMatchObject({ status: "warn", variant: "leftoverNativesOwnLauncher" });
    expect(check.message).not.toContain("The panel's start script loads linux64/");
  });

  // Review finding (2026-10-01): a Docker-run server starts with its image's
  // own command, yet the warning said "The panel's start script loads
  // linux64/" and the ok reading named folders the panel never checked.
  it("doesn't claim the panel's script loads linux64/ for a Docker-run server or a custom start command", async () => {
    const installPath = makeInstall(INCIDENT_FILES);
    for (const server of [
      { ...panelLaunched(installPath), provider: "docker-managed", dockerContainerName: "pz" },
      { ...panelLaunched(installPath), dockerContainerName: "pz" }, // docker-local
      { ...panelLaunched(installPath), startCommand: "/opt/pz/run.sh" },
      { installPath }, // no name: the stock start-server.sh
    ]) {
      const check = await buildNativeLibrariesCheck(server, linux);
      expect(check, JSON.stringify(server)).toMatchObject({
        status: "warn",
        variant: "leftoverNativesOwnLauncher",
      });
      expect(check.message).not.toContain("The panel's start script loads linux64/");
      expect(check.message).toContain("own launcher");
    }

    const clean = makeInstall({ "linux64/libPZPopMan64.so": "current" });
    expect(
      await buildNativeLibrariesCheck(
        { ...panelLaunched(clean), provider: "docker-managed", dockerContainerName: "pz" },
        linux,
      ),
    ).toBeNull();
  });

  // Review finding (2026-10-01): a ProjectZomboid64.json listing natives/
  // first loads its older copies through the panel's own script, and the
  // check reported "ok" for exactly that.
  it("warns when the game's own file loads older natives/ copies first", async () => {
    for (const libraryPath of ["natives/:linux64/", "natives/"]) {
      const installPath = makeInstall({
        ...INCIDENT_FILES,
        "ProjectZomboid64.json": JSON.stringify({ vmArgs: [`-Djava.library.path=${libraryPath}`] }),
      });
      ageFile(installPath, "natives/libPZPopMan64.so", 70);

      const check = await buildNativeLibrariesCheck(panelLaunched(installPath), linux);

      expect(check, libraryPath).toMatchObject({
        status: "warn",
        variant: "nativesFirst",
        params: { libraries: "libPZPopMan64.so" },
      });
      expect(check.message).toContain("ProjectZomboid64.json puts natives/ before linux64/");
    }
  });

  // Review finding (2026-10-01): a library only natives/ holds was listed as
  // a copy that "differs", and removing the folder was called safe.
  it("doesn't call removal safe when natives/ holds libraries linux64/ lacks", async () => {
    const installPath = makeInstall({
      ...INCIDENT_FILES,
      "natives/libZNetJNI64.so": "only here",
    });

    const check = await buildNativeLibrariesCheck(panelLaunched(installPath), linux);

    expect(check).toMatchObject({
      status: "warn",
      variant: "leftoverNativesPartial",
      params: { libraries: "libPZPopMan64.so", onlyInLeftover: "libZNetJNI64.so" },
    });
    expect(check.message).toContain("which linux64/ doesn't have");
    expect(check.hint).not.toMatch(/safe/);
    expect(check.hint).toMatch(/Verify the game files with SteamCMD/);
  });

  it("reports nothing on Windows, without game libraries, or without a path", async () => {
    const withLeftover = makeInstall({
      "linux64/libPZPopMan64.so": Buffer.alloc(900, 2),
      "natives/libPZPopMan64.so": Buffer.alloc(590, 9),
    });
    const empty = makeInstall({ "readme.txt": "not a PZ install" });

    expect(
      await buildNativeLibrariesCheck(panelLaunched(withLeftover), { platform: "win32", env: {} }),
    ).toBeNull();
    expect(await buildNativeLibrariesCheck(panelLaunched(empty), linux)).toBeNull();
    expect(await buildNativeLibrariesCheck({}, linux)).toBeNull();
  });
});
