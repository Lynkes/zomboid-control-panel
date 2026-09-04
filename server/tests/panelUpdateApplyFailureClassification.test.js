import { describe, expect, it } from "vitest";

// 2026-09-04, Dwight's live finding + god's follow-up: classifyApplyFailure()
// had never been directly tested before this file. readMostRecentApplyLog()
// prefers supervisor.log (build.js's generateStartBat(), "Supervisor v2")
// whenever it exists, and grepping build.js for every prose phrase the
// classifier matches on turns up zero occurrences of any of them -- so on a
// real current install, none of those branches could ever fire, and every
// real apply failure classified as "unknown" no matter what actually
// happened. Only the [pre-spawn]/"apply helper started" pair genuinely
// matches spawnWindowsApplyHelper()'s wording (dead in production, kept for
// an un-upgraded pre-v1.0.21 install); the rest of the prose predates even
// that -- `git log -S"quarantined by av"` shows it was introduced once, at
// v1.0.14, and never touched since, through two later apply-mechanism
// rewrites. Fixed by matching Supervisor v2's own stamped bracket codes
// (build.js's `:apply_update`/`:rollback_update` labels) as the primary
// signal, ahead of the legacy fallbacks.

const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.js");

describe("classifyApplyFailure() recognises Supervisor v2's real, current wording", () => {
  it("Dwight's exact case: supervisor.log's actual av_quarantine line resolves correctly, not 'unknown'", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-04 10:00:00] Supervisor v2 starting\n" +
      "[2026-09-04 10:00:05] Apply: marker present, beginning swap\n" +
      "[2026-09-04 10:00:05] Apply: staged binary missing or quarantined [av_quarantine]\n";

    expect(checker.classifyApplyFailure(log, false)).toBe("av_quarantine");
  });

  it("binary_swap_failed (a failed `ren` on the live/staged exe) maps to the existing rename_locked bucket", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-04 10:00:00] Supervisor v2 starting\n" +
      "[2026-09-04 10:00:05] Apply: marker present, beginning swap\n" +
      "[2026-09-04 10:00:05] Apply: backing up ZomboidControlPanel.exe to ZomboidControlPanel.exe.bundle-previous\n" +
      "[2026-09-04 10:00:05] Apply: could not back up running executable [binary_swap_failed]\n";

    expect(checker.classifyApplyFailure(log, true)).toBe("rename_locked");
  });

  it("only the LAST bracket tag decides -- an earlier unrelated tag from a prior step must not win", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-04 10:00:00] Supervisor v2 starting\n" +
      "[2026-09-04 09:59:00] Apply: update-bundle.json missing [version_mismatch]\n" +
      "[2026-09-04 10:00:05] Apply: staged binary missing or quarantined [av_quarantine]\n";

    expect(checker.classifyApplyFailure(log, false)).toBe("av_quarantine");
  });

  it("a Supervisor v2 code with no existing client-recognised bucket falls through to 'unknown', unchanged from before this fix -- a named gap, not a regression", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-04 10:00:00] Supervisor v2 starting\n" +
      "[2026-09-04 10:00:05] Apply: rolling back bundle\n" +
      "[2026-09-04 10:00:06] Apply: rollback incomplete; journal retained for recovery [rollback_failed]\n";

    expect(checker.classifyApplyFailure(log, false)).toBe("unknown");
  });

  it("the legacy [pre-spawn]-blocked path (spawnWindowsApplyHelper's format) still works for an un-upgraded pre-v1.0.21 install", () => {
    const checker = new PanelUpdateChecker();
    const log =
      "[2026-09-04T10:00:00.000Z] [PRE-SPAWN] Panel is about to spawn apply helper: C:\\panel\\.panel-helpers\\apply-update-1.cmd\n" +
      "[2026-09-04T10:00:00.000Z] [PRE-SPAWN] If no further lines appear below, the helper was blocked from running (AV / ASR / policy).\n" +
      "[2026-09-04T10:00:00.000Z] [PRE-SPAWN] Recovery: close any running panel, then double-click Start.bat in C:\\panel\n";

    expect(checker.classifyApplyFailure(log, false)).toBe("helper_blocked");
  });

  it("the legacy av_quarantine prose pattern itself still classifies correctly -- pins the matcher even though nothing currently in this repo writes it (git log -S shows it dates to v1.0.14 and was never touched across two later apply-mechanism rewrites)", () => {
    const checker = new PanelUpdateChecker();
    const log = "Staged file quarantined by av before it could be placed.\n";

    expect(checker.classifyApplyFailure(log, false)).toBe("av_quarantine");
  });

  it("no log at all still reports no_helper_log", () => {
    const checker = new PanelUpdateChecker();
    expect(checker.classifyApplyFailure(null, false)).toBe("no_helper_log");
  });

  it("a log matching no known pattern, legacy or current, still reports unknown", () => {
    const checker = new PanelUpdateChecker();
    expect(checker.classifyApplyFailure("some unrelated log content", false)).toBe("unknown");
  });
});
