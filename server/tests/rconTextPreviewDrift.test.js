import { describe, expect, it } from "vitest";
import { RconService, LATIN_TRANSLITERATION_MAP as serverMap } from "../services/rcon.js";
import {
  previewBanReason,
  LATIN_TRANSLITERATION_MAP as clientMap,
} from "../../client/src/lib/rconTextPreview.ts";

// continuous-bug-hunt round 16b (2026-09-18): round 16 added
// client/src/lib/rconTextPreview.ts as a hand copy of this file's
// foldToRconAscii() + sanitizeForBanReason() (used by kickPlayer()/
// banPlayer() to fold curly quotes/accents, strip anything outside a narrow
// whitelist, and truncate to 100 chars) so the Kick/Ban dialogs can preview
// exactly what the server will actually send, before the operator submits.
// A hand copy has one structural risk a unit test on either side alone
// cannot catch: someone edits ONE copy (e.g. widening the whitelist, adding
// a transliteration entry, changing the length cap) and forgets the other,
// and both sides' own tests keep passing because each still agrees with
// itself. This file runs the REAL server function (via a live RconService
// instance, the same way server/tests/rcon.test.js already does) and the
// client mirror over the identical corpus and fails the moment they
// disagree -- plus a direct equality check on the two transliteration
// tables, so a missing/extra/changed entry is caught even for a character
// the corpus below doesn't happen to exercise.
//
// Runs under the ROOT vitest config (vitest.config.js), not client's own --
// `npm test`/`npm run test:server` invoke `vitest run server/tests`, which
// picks this file up by its path. previewBanReason()'s module has zero
// imports of its own (no React, no client path aliases), so it transpiles
// and runs under plain Node/vitest with no special config needed.

describe("client/src/lib/rconTextPreview.ts vs server/services/rcon.js: drift gate", () => {
  it("the two LATIN_TRANSLITERATION_MAP tables are identical", () => {
    expect(clientMap).toEqual(serverMap);
  });

  it("every character in the server's transliteration map folds identically on both sides", () => {
    const liveRcon = new RconService();
    for (const ch of Object.keys(serverMap)) {
      expect(previewBanReason(ch)).toBe(liveRcon.sanitizeForBanReason(ch));
    }
  });

  it("a shared corpus (accents, curly punctuation, emoji, CJK, Arabic, >100 chars) sanitizes identically on both sides", () => {
    const liveRcon = new RconService();
    const corpus = [
      "Griefing the base",
      "griefing \"the base\" \\ 100% <script>",
      "Comportement toxique répété, insultes à d’autres joueurs",
      "rule 3 – no griefing — final warning…",
      "‘quoted’ and “double quoted” text",
      "nice job \u{1F600}\u{1F44D} keep it up",
      "封禁原因：作弊", // Chinese: "Ban reason: cheating"
      "禁止理由：チート", // Japanese: "Prohibited reason: cheat"
      "سبب الحظر: الغش في اللعب", // Arabic: "Ban reason: cheating"
      "a".repeat(150),
      "Cheaté (used mods) – ‘reported’ by 张三 مرحبا \u{1F600}".repeat(3),
      "",
      "   leading and trailing spaces   ",
      "multiple    internal    spaces",
    ];

    for (const text of corpus) {
      expect(previewBanReason(text)).toBe(liveRcon.sanitizeForBanReason(text));
    }
  });
});
