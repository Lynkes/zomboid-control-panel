import { describe, expect, it } from "vitest";

const { modifySandboxValue, applySandboxChanges, parseSandboxVars, findUnpersistedSandboxKeys } =
  await import("../routes/serverFiles.js");

// continuous-bug-hunt, 2026-09-18 (settings-truth round): modifySandboxValue's
// nested-block regex matched its key with a lazy `[^\n]*?` prefix and no
// boundary check on the left side -- so requesting "Speed" in a block that
// also has a longer key ENDING in "Speed" earlier in the same block (e.g.
// "WalkSpeed") matched the key as a bare substring of that longer identifier
// and rewrote ITS value instead. The requested key ("Speed") never changed at
// all. PUT /sandbox-option (and panelBridge's live in-game option
// persistence via writeSandboxValues) have no read-back at all and would
// report success unconditionally in this exact shape -- the textbook "save
// says success, the value you asked for was never actually written" defect.
// Confirmed via a standalone regex repro before touching the fix.
describe("modifySandboxValue: nested-block key matching does not clobber a longer identifier", () => {
  const content = [
    "SandboxVars = {",
    "    VERSION = 4,",
    "    ZombieLore = {",
    "        WalkSpeed = 1,",
    "        Speed = 2,",
    "    },",
    "}",
  ].join("\n");

  it("updates the exact requested key and leaves a longer key ending in the same substring untouched", () => {
    const written = modifySandboxValue(content, "Speed", 9, "ZombieLore");
    const persisted = parseSandboxVars(written);

    expect(persisted.ZombieLore.Speed).toBe(9);
    expect(persisted.ZombieLore.WalkSpeed).toBe(1);
  });

  it("leaves content byte-for-byte unchanged when the requested key truly has no line (no false match to fall back on)", () => {
    const written = modifySandboxValue(content, "NotARealKey", 9, "ZombieLore");
    expect(written).toBe(content);
  });

  // Same collision through applySandboxChanges (PUT /sandbox's bulk path) --
  // its own read-back (findUnpersistedSandboxKeys) already caught the
  // requested key never changing in this shape (a value mismatch, whichever
  // key actually moved), but never reported the OTHER key it silently
  // clobbered as a side effect. Verifies the fix removes the clobber itself,
  // not just its detection.
  it("also protects the bulk /sandbox path (applySandboxChanges) from the same collision", () => {
    const changes = { ZombieLore: { Speed: 9 } };
    const written = applySandboxChanges(content, changes);
    const persisted = parseSandboxVars(written);

    expect(findUnpersistedSandboxKeys(changes, persisted)).toEqual([]);
    expect(persisted.ZombieLore.Speed).toBe(9);
    expect(persisted.ZombieLore.WalkSpeed).toBe(1);
  });
});
