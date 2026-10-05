import { describe, expect, it } from "vitest";
import fs from "fs";

// Security sweep 2026-10-05, H5: without an up-to-date PanelBridge the
// panel's death notices come from the game's user log, which a co-op
// player's name can forge (services/playerDeathEvents.js,
// bridgeReportedDeathsCoopForgery.test.js). The troubleshooting guide tells
// operators so, and what to do about it.

// Line endings normalized: a Windows checkout may have CRLF.
const readRepoFile = (relativePath) =>
  fs.readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

describe("troubleshooting guide: forged death notices", () => {
  const guide = readRepoFile("docs/install/troubleshooting.md");
  const section = guide.match(/\n### Death notices for a player who didn't die\n([\s\S]*?)\n---\n/)?.[1];

  it("has a section for death notices", () => {
    expect(section).toBeTruthy();
  });

  it("says the fallback is the game's user log, which a co-op name can forge", () => {
    expect(section).toContain("`Logs/*_user.txt`");
    expect(section).toMatch(/co-op\s+\(split-screen\) player's name/);
    expect(section).toMatch(/forged/);
  });

  it("recommends updating PanelBridge, or AllowCoop=false", () => {
    expect(section).toMatch(/Update PanelBridge/);
    expect(section).toContain("`AllowCoop=false`");
  });
});
