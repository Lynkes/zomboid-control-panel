import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { execFileSync } from "child_process";
import { IS_WIN, canSymlinkFiles, makeServerTree, makeTempDir, removeDir } from "./helpers/fileManagerFixtures.js";

// Check-then-use guards (spec §A4.4): a file swapped after resolve() -- for
// a link to outside the root, for another file, or for a FIFO -- is caught
// on the opened descriptor (O_NOFOLLOW where the OS has it, then the
// (dev, ino) the resolve saw) and becomes FM_CONFLICT. Not one byte of the
// swapped-in target is returned or written.

const { localBackend } = await import("../services/fileManagerLocalBackend.js");
const { FmError } = await import("../services/fileManagerContract.js");
const { hashEtag } = await import("../services/fileManagerTextCodec.js");

let base;
let tree;
let root;

async function codeOf(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    if (!(err instanceof FmError)) throw err;
    return err.code;
  }
}

function hasMkfifo() {
  if (IS_WIN) return false;
  try {
    execFileSync("which", ["mkfifo"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  base = makeTempDir();
  tree = makeServerTree(base);
  root = await localBackend.describeRoot({ id: "data", path: tree.data });
});

afterEach(() => {
  removeDir(base);
});

describe("a file swapped after resolve()", () => {
  it.skipIf(IS_WIN || !canSymlinkFiles())("for a link to outside: reads refuse and nothing leaks", async () => {
    const target = path.join(tree.data, "Logs", "server.txt");
    const r = await localBackend.resolve(root, ["Logs", "server.txt"], "read");
    fs.unlinkSync(target);
    fs.symlinkSync(path.join(tree.outside, "canary.txt"), target);
    expect(await codeOf(localBackend.readBytes(r, { maxBytes: 1024 }))).toBe("FM_CONFLICT");
    expect(await codeOf(localBackend.openReadStream(r))).toBe("FM_CONFLICT");
  });

  it.skipIf(IS_WIN || !canSymlinkFiles())("for a link to outside: a save refuses and the target is untouched", async () => {
    const target = path.join(tree.data, "Logs", "server.txt");
    const original = fs.readFileSync(target);
    const r = await localBackend.resolve(root, ["Logs", "server.txt"], "write");
    fs.unlinkSync(target);
    fs.symlinkSync(path.join(tree.outside, "canary.txt"), target);
    const code = await codeOf(
      localBackend.writeBytesCas(r, Buffer.from("overwrite"), { expectedHash: hashEtag(original), trashMeta: {} }),
    );
    expect(code).toBe("FM_CONFLICT");
    expect(fs.readFileSync(path.join(tree.outside, "canary.txt"), "utf8")).toBe("CANARY-OUTSIDE-ROOT");
  });

  it("for another file: the inode check refuses it", async () => {
    const target = path.join(tree.data, "Logs", "server.txt");
    const r = await localBackend.resolve(root, ["Logs", "server.txt"], "read");
    fs.renameSync(target, `${target}.old`);
    fs.writeFileSync(target, "SWAPPED-IN-CONTENT");
    expect(await codeOf(localBackend.readBytes(r, { maxBytes: 1024 }))).toBe("FM_CONFLICT");
    expect(await codeOf(localBackend.openReadStream(r))).toBe("FM_CONFLICT");
  });

  it.skipIf(!hasMkfifo())("for a FIFO: refused without blocking", async () => {
    const target = path.join(tree.data, "Logs", "server.txt");
    const r = await localBackend.resolve(root, ["Logs", "server.txt"], "read");
    fs.unlinkSync(target);
    execFileSync("mkfifo", [target]);
    expect(await codeOf(localBackend.readBytes(r, { maxBytes: 1024 }))).toBe("FM_CONFLICT");
  });
});

describe("a parent folder swapped for a link after resolve()", () => {
  it("is caught before reading when the swap changes the inode", async () => {
    const dir = path.join(tree.data, "Logs");
    const r = await localBackend.resolve(root, ["Logs", "server.txt"], "read");
    fs.renameSync(dir, path.join(tree.data, "Logs-moved"));
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "server.txt"), "REPLACEMENT");
    expect(await codeOf(localBackend.readBytes(r, { maxBytes: 1024 }))).toBe("FM_CONFLICT");
  });
});
