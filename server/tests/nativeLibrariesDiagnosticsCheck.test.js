import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { buildNativeLibrariesCheck } from "../routes/debug.js";

// GET /api/debug/diagnostics' server.nativeLibs check (2026-10-01, 42.21
// UnsatisfiedLinkError incident): a leftover natives/ folder from an older
// build, whose libraries differ from linux64/'s, is a warning with the way
// out (safe to remove or rename); otherwise the check says where the game's
// libraries load from. Locale entries for both are enforced by
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

afterEach(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
  roots = [];
});

describe("buildNativeLibrariesCheck()", () => {
  it("warns about the incident layout, with the libraries and the safe way out", async () => {
    const installPath = makeInstall({
      "linux64/libPZPopMan64.so": Buffer.alloc(900, 2),
      "natives/libPZPopMan64.so": Buffer.alloc(590, 9),
      "ProjectZomboid64.json": JSON.stringify({ vmArgs: ["-Djava.library.path=linux64/"] }),
    });

    const check = await buildNativeLibrariesCheck({ installPath }, { platform: "linux" });

    expect(check).toMatchObject({
      id: "server.nativeLibs",
      status: "warn",
      severity: "warning",
      category: "server",
      variant: "leftoverNatives",
      params: { libraries: "libPZPopMan64.so" },
    });
    expect(check.message).toContain("libPZPopMan64.so");
    expect(check.hint).toMatch(/safe to remove or rename the natives\/ folder/);
    expect(check.hint).toMatch(/never deletes it/);
  });

  it("is ok, naming linux64/, for a clean install", async () => {
    const installPath = makeInstall({
      "linux64/libPZPopMan64.so": "current",
      "ProjectZomboid64.json": JSON.stringify({ vmArgs: ["-Djava.library.path=linux64/"] }),
    });

    const check = await buildNativeLibrariesCheck({ installPath }, { platform: "linux" });

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

    const check = await buildNativeLibrariesCheck({ installPath }, { platform: "linux" });

    expect(check.status).toBe("ok");
  });

  it("checks the folder a custom launcher sits in", async () => {
    const installPath = makeInstall({
      "linux64/libPZPopMan64.so": Buffer.alloc(900, 2),
      "natives/libPZPopMan64.so": Buffer.alloc(590, 9),
      "custom.sh": "#!/bin/bash\n",
    });

    const check = await buildNativeLibrariesCheck(
      { serverPath: path.join(installPath, "custom.sh") },
      { platform: "linux" },
    );

    expect(check.status).toBe("warn");
  });

  it("reports nothing on Windows, without game libraries, or without a path", async () => {
    const withLeftover = makeInstall({
      "linux64/libPZPopMan64.so": Buffer.alloc(900, 2),
      "natives/libPZPopMan64.so": Buffer.alloc(590, 9),
    });
    const empty = makeInstall({ "readme.txt": "not a PZ install" });

    expect(await buildNativeLibrariesCheck({ installPath: withLeftover }, { platform: "win32" })).toBeNull();
    expect(await buildNativeLibrariesCheck({ installPath: empty }, { platform: "linux" })).toBeNull();
    expect(await buildNativeLibrariesCheck({}, { platform: "linux" })).toBeNull();
  });
});
