import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  estimateArchiveBytes,
  formatBytes,
  insufficientSpaceError,
  nearestExistingPath,
  onSameVolume,
} from "../services/backupDiskSpace.js";
import { measureFolder } from "../services/backupFolderWalk.js";

describe("formatBytes", () => {
  it("writes sizes the way the panel's other disk messages do", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(300 * 1024 * 1024)).toBe("300 MB");
    expect(formatBytes(12.34 * 1024 ** 3)).toBe("12.3 GB");
    expect(formatBytes(2.5 * 1024 ** 4)).toBe("2.5 TB");
  });

  it("does not invent a number for a missing one", () => {
    expect(formatBytes(null)).toBe("?");
    expect(formatBytes(Number.NaN)).toBe("?");
    expect(formatBytes(-1)).toBe("?");
  });
});

describe("estimateArchiveBytes", () => {
  it("has no estimate for a world of unknown or zero size", () => {
    expect(estimateArchiveBytes(null)).toBeNull();
    expect(estimateArchiveBytes(0)).toBeNull();
    expect(estimateArchiveBytes(Number.NaN, 100)).toBeNull();
  });

  it("takes about half the files' size for a first backup, plus a margin", () => {
    expect(estimateArchiveBytes(1000)).toBe(550);
  });

  it("follows the previous archive, never below a quarter of the files", () => {
    expect(estimateArchiveBytes(1000, 400)).toBe(440);
    // A tiny early archive does not stand in for a world that has grown.
    expect(estimateArchiveBytes(1000, 10)).toBe(275);
  });

  it("ignores a previous size that is not a usable number", () => {
    expect(estimateArchiveBytes(1000, null)).toBe(550);
    expect(estimateArchiveBytes(1000, -5)).toBe(550);
  });
});

describe("insufficientSpaceError", () => {
  it("carries the code and the formatted sizes for the translated message", () => {
    const error = insufficientSpaceError(3 * 1024 ** 3, 512 * 1024 ** 2);

    expect(error.errorCode).toBe("BACKUP_INSUFFICIENT_DISK_SPACE");
    expect(error.errorParams).toEqual({ needed: "3.0 GB", free: "512 MB" });
    expect(error.message).toContain("3.0 GB");
    expect(error.message).toContain("512 MB");
  });
});

describe("folders and volumes", () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "pz-diskspace-"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("asks about the nearest folder that exists", () => {
    const missing = path.join(root, "Saves", "Multiplayer");

    expect(nearestExistingPath(missing)).toBe(root);
    expect(nearestExistingPath(root)).toBe(root);
  });

  it("treats two folders on one volume as one", () => {
    fs.mkdirSync(path.join(root, "a"));

    expect(onSameVolume(path.join(root, "a"), path.join(root, "b", "c"))).toBe(true);
  });

  it("measures a folder: files, their bytes, symbolic links counted but not sized", () => {
    fs.mkdirSync(path.join(root, "map", "deep"), { recursive: true });
    fs.writeFileSync(path.join(root, "map_meta.bin"), Buffer.alloc(100));
    fs.writeFileSync(path.join(root, "map", "0_0.bin"), Buffer.alloc(2000));
    fs.writeFileSync(path.join(root, "map", "deep", "x.bin"), Buffer.alloc(30));
    const outside = path.join(root, "outside.bin");
    fs.writeFileSync(outside, Buffer.alloc(99999));
    let linked = false;
    try {
      fs.symlinkSync(outside, path.join(root, "map", "link.bin"), "file");
      linked = true;
    } catch {
      // creating a symlink can need a privilege on Windows
    }

    return measureFolder(path.join(root, "map")).then((measured) => {
      expect(measured.bytes).toBe(2030);
      expect(measured.files).toBe(linked ? 3 : 2);
    });
  });

  it("measures many files without waiting for them one by one", async () => {
    for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(root, `f${i}.bin`), Buffer.alloc(10));

    const measured = await measureFolder(root);

    expect(measured).toEqual({ files: 300, bytes: 3000 });
  });

  it("rejects when the folder itself cannot be read, so the caller falls back", async () => {
    await expect(measureFolder(path.join(root, "missing"))).rejects.toBeTruthy();
  });
});
