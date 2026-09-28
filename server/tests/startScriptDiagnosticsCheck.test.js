import { afterEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { buildStartScriptCheck } from "../routes/debug.js";
import {
  managedStartupScriptName,
  resolveManagedStartupScript,
} from "../services/serverManager.js";

// GH #167 follow-up: a managed server with a name launches only its own
// generated script (StartServer_<name>.bat / start-server_<name>.sh) from
// `serverPath || installPath`, and a start refuses with
// SERVER_START_SCRIPT_MISSING while it is missing. Debug › Diagnostics
// still took the first of the named and STOCK scripts it found in
// `installPath || serverPath`, so a folder holding only StartServer64.bat
// showed "Start script found -- Using StartServer64.bat." for exactly the
// setup whose every Start fails.
//
// Runs on the host platform: a "found" case stats a real file, and the
// Linux executable-bit check reads real mode bits (a file on Windows never
// has them).
const isWin = process.platform === "win32";
const STOCK = isWin ? "StartServer64.bat" : "start-server.sh";
const NO_ENV = {};

describe("buildStartScriptCheck() (server.startScript)", () => {
  let root;

  afterEach(() => {
    if (root) {
      try {
        fs.chmodSync(root, 0o755);
      } catch {
        // best effort -- only the read-only-folder case changes it
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
    root = null;
  });

  function tempInstall() {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-startscript-"));
    return root;
  }

  function writeScript(dir, name) {
    fs.writeFileSync(path.join(dir, name), "echo start\n", { mode: 0o750 });
  }

  it("does not call the stock script found for a named managed server; the named one isn't written yet", async () => {
    const dir = tempInstall();
    writeScript(dir, STOCK);
    const named = managedStartupScriptName("Fresh", isWin);

    const check = await buildStartScriptCheck(
      { serverName: "Fresh", installPath: dir },
      { env: NO_ENV },
    );

    expect(check.id).toBe("server.startScript");
    expect(check.status).toBe("warn");
    expect(check.variant).toBe("notWrittenYet");
    expect(check.params).toEqual({ script: named });
    expect(check.message).toContain(named);
    expect(check.message).not.toContain(STOCK);
  });

  it("reports the named script the panel launches when it is there", async () => {
    const dir = tempInstall();
    writeScript(dir, STOCK);
    const named = managedStartupScriptName("Ready", isWin);
    writeScript(dir, named);

    const check = await buildStartScriptCheck(
      { serverName: "Ready", installPath: dir },
      { env: NO_ENV },
    );

    expect(check.status).toBe("ok");
    expect(check.params).toEqual({ script: named });
  });

  it("looks in serverPath first, the folder the start writes into and launches from", async () => {
    const installPath = tempInstall();
    const serverPath = path.join(installPath, "launch");
    fs.mkdirSync(serverPath);
    const named = managedStartupScriptName("Split", isWin);
    // Only in installPath: not what a start runs.
    writeScript(installPath, named);

    const missing = await buildStartScriptCheck(
      { serverName: "Split", installPath, serverPath },
      { env: NO_ENV },
    );
    expect(missing.status).not.toBe("ok");
    expect(missing.variant).toBe("notWrittenYet");

    writeScript(serverPath, named);
    const found = await buildStartScriptCheck(
      { serverName: "Split", installPath, serverPath },
      { env: NO_ENV },
    );
    expect(found.status).toBe("ok");
    expect(found.params).toEqual({ script: named });
  });

  it("fails when the named script is missing and its folder can't be written (here: doesn't exist)", async () => {
    const installPath = tempInstall();
    const serverPath = path.join(installPath, "gone");
    writeScript(installPath, STOCK);

    const check = await buildStartScriptCheck(
      { serverName: "Gone", installPath, serverPath },
      { env: NO_ENV },
    );

    expect(check.status).toBe("fail");
    expect(check.variant).toBe("folderNotWritable");
    expect(check.params).toEqual({ script: managedStartupScriptName("Gone", isWin) });
  });

  // fs.access(W_OK) sees mode bits only off Windows, and root ignores them.
  it.skipIf(isWin || process.getuid?.() === 0)(
    "fails for an existing folder the panel can't write",
    async () => {
      const dir = tempInstall();
      writeScript(dir, STOCK);
      fs.chmodSync(dir, 0o555);

      const check = await buildStartScriptCheck(
        { serverName: "ReadOnly", installPath: dir },
        { env: NO_ENV },
      );

      expect(check.status).toBe("fail");
      expect(check.variant).toBe("folderNotWritable");
    },
  );

  describe("keeps the stock candidates where the panel doesn't write the named script", () => {
    it("a server with no name", async () => {
      const dir = tempInstall();
      writeScript(dir, STOCK);

      const check = await buildStartScriptCheck({ installPath: dir }, { env: NO_ENV });

      expect(check.status).toBe("ok");
      expect(check.params).toEqual({ script: STOCK });
    });

    it("a custom start command", async () => {
      const dir = tempInstall();
      writeScript(dir, STOCK);

      const check = await buildStartScriptCheck(
        { serverName: "Custom", installPath: dir, startCommand: "run.sh" },
        { env: NO_ENV },
      );

      expect(check.status).toBe("ok");
      expect(check.params).toEqual({ script: STOCK });
    });

    it("a Docker-mapped container, whose image owns the launch command", async () => {
      const dir = tempInstall();
      writeScript(dir, STOCK);

      const check = await buildStartScriptCheck(
        { serverName: "Boxed", installPath: dir, dockerContainerName: "pz" },
        { env: NO_ENV },
      );

      expect(check.status).toBe("ok");
      expect(check.params).toEqual({ script: STOCK });
    });

    it("an explicit PZ_SERVER_BAT other than the stock name", async () => {
      const dir = tempInstall();
      writeScript(dir, STOCK);

      const check = await buildStartScriptCheck(
        { serverName: "EnvPinned", installPath: dir },
        { env: { PZ_SERVER_BAT: "MyLauncher.bat" } },
      );

      expect(check.status).toBe("ok");
      expect(check.params).toEqual({ script: STOCK });
    });
  });

  it("still asks for the named script when PZ_SERVER_BAT only names the stock script (the all-in-one image)", async () => {
    const dir = tempInstall();
    writeScript(dir, STOCK);

    const check = await buildStartScriptCheck(
      { serverName: "AllInOne", installPath: dir },
      { env: { PZ_SERVER_BAT: STOCK } },
    );

    expect(check.variant).toBe("notWrittenYet");
  });
});

// The one answer loadConfig() launches and the check above looks for.
describe("resolveManagedStartupScript()", () => {
  it("names the server's own script when it has a name", () => {
    expect(resolveManagedStartupScript("S", { windows: true, env: {} })).toBe("StartServer_S.bat");
    expect(resolveManagedStartupScript("S", { windows: false, env: {} })).toBe("start-server_S.sh");
  });

  it("uses the stock script only for a server with no name", () => {
    expect(resolveManagedStartupScript("", { windows: true, env: {} })).toBe("StartServer64.bat");
    expect(resolveManagedStartupScript(undefined, { windows: false, env: {} })).toBe("start-server.sh");
  });

  it("lets an explicit, non-stock PZ_SERVER_BAT win, and ignores one that just names the stock script", () => {
    expect(
      resolveManagedStartupScript("S", { windows: false, env: { PZ_SERVER_BAT: "mine.sh" } }),
    ).toBe("mine.sh");
    expect(
      resolveManagedStartupScript("S", { windows: false, env: { PZ_SERVER_BAT: "start-server.sh" } }),
    ).toBe("start-server_S.sh");
    expect(
      resolveManagedStartupScript("", { windows: false, env: { PZ_SERVER_BAT: "start-server.sh" } }),
    ).toBe("start-server.sh");
  });
});
