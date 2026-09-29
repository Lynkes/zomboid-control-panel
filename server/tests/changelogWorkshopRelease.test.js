import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..", "..");

// release.ps1 turns the newest "## [x.y.z]" section of CHANGELOG.md into the
// GitHub Release body, and the same release embeds pz-mod/workshop/published.json
// (build.js, PANEL_BRIDGE_WORKSHOP_JSON). 1.4.0's notes were written before the
// item was recorded and kept saying it was unpublished and that the option read
// "Not available yet", while the build shipped its id and the option was live.
// Only the sections a release can still pick up are checked: [Unreleased] and
// the newest numbered one.
function releasableChangelogText() {
  const text = fs.readFileSync(path.join(repoRoot, "CHANGELOG.md"), "utf8");
  const numbered = [...text.matchAll(/^## \[\d+\.\d+\.\d+\]/gm)];
  const end = numbered.length > 1 ? numbered[1].index : text.length;
  return text.slice(0, end);
}

describe("CHANGELOG agrees with the PanelBridge Workshop release this build ships", () => {
  const published = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "pz-mod", "workshop", "published.json"), "utf8"),
  );

  it.runIf(Boolean(published.workshopId))(
    "does not call the Workshop item unpublished once published.json carries its id",
    () => {
      const stale = [
        /\b(?:is not|isn't|has not been|hasn't been) (?:yet )?published\b/i,
        /\bnot published yet\b/i,
        /shows "Not available yet"/i,
      ];
      // Only sentences about the item itself: "published" is an ordinary
      // word elsewhere (a Docker tag that "isn't published yet").
      const offending = releasableChangelogText()
        .split(/(?<=[.;])\s+/)
        .filter((sentence) => /Workshop|PanelBridge/i.test(sentence))
        .filter((sentence) => stale.some((re) => re.test(sentence)));
      expect(offending).toEqual([]);
    },
  );
});
