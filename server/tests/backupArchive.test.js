import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import unzipper from "unzipper";
import { StreamingBackupArchive } from "../services/backupArchive.js";
import { appendDirectoryToArchive, waitForArchiveEntry } from "../services/backupService.js";

// #259: archiver kept an object per entry in the heap until finalize(), so a
// world of ~870,000 files ran the panel out of memory. This archive writes the
// central directory to disk instead.

describe("StreamingBackupArchive", () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "pz-backup-archive-"));
    fs.mkdirSync(path.join(dir, "world", "sub"), { recursive: true });
    fs.writeFileSync(path.join(dir, "world", "a.txt"), "alpha".repeat(1000));
    fs.writeFileSync(path.join(dir, "world", "sub", "b.bin"), Buffer.from([1, 2, 3, 4]));
    fs.mkdirSync(path.join(dir, "world", "empty"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function zipWorld({ vanish } = {}) {
    const zipPath = path.join(dir, "out.zip.tmp");
    const output = fs.createWriteStream(zipPath);
    const archive = new StreamingBackupArchive(zipPath, output);
    const closed = new Promise((resolve) => output.on("close", resolve));
    const skipped = await appendDirectoryToArchive(archive, path.join(dir, "world"), "world");
    if (vanish) skipped.push(...vanish);
    await waitForArchiveEntry(archive, () => archive.append('{"x":1}', { name: "snapshot.json" }));
    await archive.finalize();
    await closed;
    return { zipPath, archive, skipped };
  }

  it("writes a zip that unzipper reads back, with folders and an appended entry", async () => {
    const { zipPath, archive } = await zipWorld();
    const opened = await unzipper.Open.file(zipPath);
    const names = opened.files.map((f) => f.path).sort();
    expect(names).toEqual(
      ["snapshot.json", "world/a.txt", "world/empty/", "world/sub/", "world/sub/b.bin"].sort(),
    );
    const a = opened.files.find((f) => f.path === "world/a.txt");
    expect((await a.buffer()).toString()).toBe("alpha".repeat(1000));
    const b = opened.files.find((f) => f.path === "world/sub/b.bin");
    expect([...(await b.buffer())]).toEqual([1, 2, 3, 4]);
    expect(archive.pointer()).toBe(fs.statSync(zipPath).size);
  });

  it("leaves no central-directory temp file behind", async () => {
    await zipWorld();
    expect(fs.readdirSync(dir).filter((n) => n.startsWith(".central-"))).toEqual([]);
  });

  it("reports a file that vanished as skipped and still finishes", async () => {
    const zipPath = path.join(dir, "out.zip.tmp");
    const output = fs.createWriteStream(zipPath);
    const archive = new StreamingBackupArchive(zipPath, output);
    const closed = new Promise((resolve) => output.on("close", resolve));
    const result = await waitForArchiveEntry(archive, () =>
      archive.file(path.join(dir, "world", "gone.txt"), { name: "world/gone.txt" }),
    );
    expect(result).toEqual({ skipped: true });
    await waitForArchiveEntry(archive, () =>
      archive.file(path.join(dir, "world", "a.txt"), { name: "world/a.txt" }),
    );
    await archive.finalize();
    await closed;
    const opened = await unzipper.Open.file(zipPath);
    expect(opened.files.map((f) => f.path)).toEqual(["world/a.txt"]);
  });

  it("abort() removes the central-directory temp file and writes nothing more", async () => {
    const zipPath = path.join(dir, "out.zip.tmp");
    const output = fs.createWriteStream(zipPath);
    const archive = new StreamingBackupArchive(zipPath, output);
    await waitForArchiveEntry(archive, () =>
      archive.file(path.join(dir, "world", "a.txt"), { name: "world/a.txt" }),
    );
    archive.destroy(new Error("stop"));
    await new Promise((resolve) => output.once("close", resolve));
    expect(archive.errored.message).toBe("stop");
    await vi.waitFor(() =>
      expect(fs.readdirSync(dir).filter((n) => n.startsWith(".central-"))).toEqual([]),
    );
  });
});
