import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";

// continuous-bug-hunt, 2026-09-18 (file-manager path-truth round):
// confineToRoots() (server/utils/browseRoots.js) is the one shared,
// audited "is this path inside an allowed root" check behind
// serverFiles.js's GET /browse-files and GET /image-preview, and
// chunks.js's own save browser. It used path.resolve() -- pure string
// normalization, never touches the filesystem -- so it had no way to
// notice a path component was a symlink. A symlink placed anywhere inside
// an allowed root (workshop mod content, anything writable by a
// serverfiles.manage-only operator) that points OUTSIDE every allowed root
// passed this check by NAME, while the actual fs.readdir/fs.createReadStream
// that followed used the real, unresolved target. GET /image-preview in
// particular streams raw bytes back over HTTP keyed only on the symlink's
// OWN extension, making this an arbitrary-file-read primitive for anything
// under 5MB.
//
// Two proofs: a deterministic one (mocks fs.realpathSync to simulate a
// symlink without needing OS symlink privileges, which this dev box does
// not have -- see the EPERM this repo's own real-symlink tests skip around
// on Windows) that runs everywhere and pins the actual mechanism (the
// containment decision must be made against the REALPATH, not the lexical
// path); and a real end-to-end one with an actual symlink, skipped on
// Windows the same way this repo's other symlink tests already are
// (linuxBackupSymlinkSkipVisibility.test.js).

const { confineToRoots } = await import("../utils/browseRoots.js");

describe("confineToRoots: a symlink inside an allowed root cannot point outside it (mocked realpath, runs on every platform)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("refuses a path whose real target (per fs.realpathSync) resolves outside every allowed root", () => {
    const root = path.resolve(path.join(path.sep, "Servers", "MyServer"));
    const outsideSecret = path.resolve(
      path.join(path.sep, "Windows", "System32", "config.sam"),
    );
    const lexicalTarget = path.join(root, "media", "maps", "escape", "config.sam");

    vi.spyOn(fs, "realpathSync").mockImplementation((p) => {
      // Only the symlinked leaf resolves elsewhere; the root and every
      // other candidate realpath to themselves, same as a real filesystem
      // with no symlinks anywhere except the one planted leaf.
      if (String(p) === lexicalTarget) return outsideSecret;
      return String(p);
    });

    expect(confineToRoots(lexicalTarget, [root])).toBeNull();
  });

  it("still allows the identical path once it genuinely resolves inside the root (no false refusal from the realpath check itself)", () => {
    const root = path.resolve(path.join(path.sep, "Servers", "MyServer"));
    const lexicalTarget = path.join(root, "media", "maps", "RealMap", "map.bin");

    vi.spyOn(fs, "realpathSync").mockImplementation((p) => String(p));

    expect(confineToRoots(lexicalTarget, [root])).toBe(path.resolve(lexicalTarget));
  });

  it("falls back to lexical containment when realpath fails (e.g. the target does not exist yet) -- unchanged pre-fix behavior for that case", () => {
    const root = path.resolve(path.join(path.sep, "Servers", "MyServer"));
    const notYetCreated = path.join(root, "brand-new-file.png");

    vi.spyOn(fs, "realpathSync").mockImplementation(() => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    expect(confineToRoots(notYetCreated, [root])).toBe(path.resolve(notYetCreated));
  });

  it("still refuses a plain lexical escape with no symlink involved at all (sanity: the fix does not weaken the existing check)", () => {
    const root = path.resolve(path.join(path.sep, "Servers", "MyServer"));
    const escape = path.join(root, "..", "..", "Windows", "System32");

    vi.spyOn(fs, "realpathSync").mockImplementation((p) => String(p));

    expect(confineToRoots(escape, [root])).toBeNull();
  });
});

describe("confineToRoots: real symlink end-to-end (POSIX only -- Windows needs elevated/dev-mode privilege this box does not have)", () => {
  let root;

  afterEach(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it.skipIf(process.platform === "win32")(
    "a real symlink inside the root pointing outside it is refused, not silently followed",
    () => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "confine-roots-symlink-"));
      const allowedRoot = path.join(root, "allowed");
      const outside = path.join(root, "outside");
      fs.mkdirSync(allowedRoot, { recursive: true });
      fs.mkdirSync(outside, { recursive: true });
      fs.writeFileSync(path.join(outside, "secret.png"), "not actually a png");

      const linkPath = path.join(allowedRoot, "escape");
      fs.symlinkSync(outside, linkPath, "dir");

      const targetViaSymlink = path.join(linkPath, "secret.png");
      expect(confineToRoots(targetViaSymlink, [allowedRoot])).toBeNull();

      // A real file with no symlink involved, inside the same root, is
      // still allowed -- the fix only closes the symlink escape, it
      // doesn't break ordinary browsing.
      fs.writeFileSync(path.join(allowedRoot, "real.png"), "also not a png");
      expect(
        confineToRoots(path.join(allowedRoot, "real.png"), [allowedRoot]),
      ).toBe(path.resolve(path.join(allowedRoot, "real.png")));
    },
  );
});
