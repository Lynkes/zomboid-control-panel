import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { regenerateStartupScriptsWithBackup } from "../routes/server.js";

// StartServer_<name>.bat carries -adminpassword. #193 wrote it 0600 at
// install time, but every Start regenerates it here, and without an explicit
// mode writeFileAtomic keeps the existing file's mode: a .bat created before
// #193 stayed world-readable for good. The regenerated script and its backup
// must both be owner-only.
const posix = process.platform !== "win32";

describe("startup scripts are owner-only after every Start", () => {
  let tmpRoot;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  function setup() {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-startmode-"));
    const batPath = path.join(tmpRoot, "StartServer_Test.bat");
    const shPath = path.join(tmpRoot, "start-server_Test.sh");
    // A pre-#193 install: hand-edited (so a backup is taken) and 0644.
    fs.writeFileSync(batPath, "@echo off\r\nREM hand edit -adminpassword secret\r\n");
    fs.writeFileSync(shPath, "#!/bin/bash\n# hand edit -adminpassword secret\n");
    if (posix) {
      fs.chmodSync(batPath, 0o644);
      fs.chmodSync(shPath, 0o644);
    }
    return {
      batPath,
      shPath,
      files: [
        { path: batPath, content: "@echo off\r\nREM -adminpassword secret\r\n" },
        { path: shPath, content: "#!/bin/bash\n# -adminpassword secret\n" },
      ],
    };
  }

  it("writes the .bat with mode 0600 and the .sh with 0750", () => {
    const { files } = setup();
    const writeSpy = vi.spyOn(fs, "writeFileSync");

    regenerateStartupScriptsWithBackup(tmpRoot, files);

    const optionsFor = (suffix) =>
      writeSpy.mock.calls.find(([target]) => String(target).includes(suffix))?.[2];
    expect(optionsFor("StartServer_Test.bat")).toMatchObject({ encoding: "utf8", mode: 0o600 });
    expect(optionsFor("start-server_Test.sh")).toMatchObject({ encoding: "utf8", mode: 0o750 });
  });

  it.skipIf(!posix)("tightens a world-readable .bat and makes its backup owner-only", () => {
    const { batPath, files } = setup();

    const backups = regenerateStartupScriptsWithBackup(tmpRoot, files);

    expect(backups.length).toBeGreaterThan(0);
    expect(fs.statSync(batPath).mode & 0o777).toBe(0o600);
    const backupNames = fs.readdirSync(tmpRoot).filter((name) => name.includes(".bak-"));
    expect(backupNames.length).toBe(2);
    for (const name of backupNames) {
      expect(fs.statSync(path.join(tmpRoot, name)).mode & 0o777).toBe(0o600);
    }
  });
});
