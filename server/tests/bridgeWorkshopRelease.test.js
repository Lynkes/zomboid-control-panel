import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import {
  _resetWorkshopReleaseCacheForTests,
  getWorkshopRelease,
  isValidWorkshopId,
} from "../services/bridgeWorkshopRelease.js";

// Where the Workshop item id comes from decides which Lua every Workshop
// server downloads, so the precedence (embedded define > published.json on
// disk > nothing; env override only for testing) and the validation are
// pinned here rather than trusted.

const BASE = {
  schema: 1,
  modId: "ZCPB",
  workshopId: null,
  visibility: null,
  publishedVersion: null,
  publishedAt: null,
  liveVerified: { windowsServer: null, linuxServer: null },
};
const VERIFIED = { gameVersion: "42.20", date: "2026-10-01", nonAdminJoinWithChecksumOn: true };

let tmpDir;

function writeDiskDoc(doc) {
  const dir = path.join(tmpDir, "pz-mod", "workshop");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "published.json"), typeof doc === "string" ? doc : JSON.stringify(doc));
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bridge-release-"));
  vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", "");
  _resetWorkshopReleaseCacheForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  _resetWorkshopReleaseCacheForTests();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("getWorkshopRelease", () => {
  it("reads published.json from disk and reports not-published while the id is null", () => {
    writeDiskDoc(BASE);
    const release = getWorkshopRelease();
    expect(release).toMatchObject({ status: "not-published", source: "file", workshopId: null, preview: true });
  });

  it("prefers the embedded define over the file on disk", () => {
    writeDiskDoc({ ...BASE, workshopId: "111" });
    vi.stubGlobal("PANEL_BRIDGE_WORKSHOP_JSON", JSON.stringify({ ...BASE, workshopId: "222" }));
    expect(getWorkshopRelease()).toMatchObject({ status: "published", source: "embedded", workshopId: "222" });
  });

  it("reports source none when no document exists anywhere", () => {
    const realExists = fs.existsSync;
    vi.spyOn(fs, "existsSync").mockImplementation((p) =>
      String(p).endsWith("published.json") ? false : realExists(p),
    );
    expect(getWorkshopRelease()).toMatchObject({ status: "not-published", source: "none", workshopId: null });
  });

  it("the env override replaces the id, marks the source env and always forces preview", () => {
    writeDiskDoc({ ...BASE, workshopId: "111", liveVerified: { windowsServer: VERIFIED, linuxServer: VERIFIED } });
    vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", "987654321");
    expect(getWorkshopRelease()).toMatchObject({
      status: "published",
      source: "env",
      workshopId: "987654321",
      preview: true,
    });
  });

  it("ignores a malformed env override", () => {
    writeDiskDoc({ ...BASE, workshopId: "111" });
    vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", "12ab");
    expect(getWorkshopRelease()).toMatchObject({ source: "file", workshopId: "111" });
  });

  it.each([
    ["invalid JSON", "{ not json"],
    ["a wrong schema", { ...BASE, schema: 2 }],
    ["a foreign modId", { ...BASE, modId: "PanelBridge" }],
    ["a non-numeric id", { ...BASE, workshopId: "abc" }],
    ["an id above the Steam id range", { ...BASE, workshopId: "18446744073709551616" }],
  ])("reports invalid (and no id) for %s", (_label, doc) => {
    writeDiskDoc(doc);
    expect(getWorkshopRelease()).toMatchObject({ status: "invalid", workshopId: null });
  });

  it("stays invalid even with the env override set: a broken document is a broken install", () => {
    writeDiskDoc({ ...BASE, modId: "Other" });
    vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", "987654321");
    expect(getWorkshopRelease()).toMatchObject({ status: "invalid", workshopId: null });
  });

  it("drops the preview flag only once BOTH server OSes are live-verified", () => {
    writeDiskDoc({ ...BASE, workshopId: "111", liveVerified: { windowsServer: VERIFIED, linuxServer: null } });
    expect(getWorkshopRelease().preview).toBe(true);
    _resetWorkshopReleaseCacheForTests();
    writeDiskDoc({ ...BASE, workshopId: "111", liveVerified: { windowsServer: VERIFIED, linuxServer: VERIFIED } });
    expect(getWorkshopRelease().preview).toBe(false);
  });

  it("linuxChecksumVerified follows the recorded non-admin join on the Linux server only", () => {
    writeDiskDoc({
      ...BASE,
      workshopId: "111",
      liveVerified: { windowsServer: VERIFIED, linuxServer: { ...VERIFIED, nonAdminJoinWithChecksumOn: false } },
    });
    expect(getWorkshopRelease().linuxChecksumVerified).toBe(false);
    _resetWorkshopReleaseCacheForTests();
    writeDiskDoc({ ...BASE, workshopId: "111", liveVerified: { windowsServer: null, linuxServer: VERIFIED } });
    expect(getWorkshopRelease().linuxChecksumVerified).toBe(true);
  });

  it("caches the result for the process until reset", () => {
    writeDiskDoc({ ...BASE, workshopId: "111" });
    const first = getWorkshopRelease();
    writeDiskDoc({ ...BASE, workshopId: "222" });
    expect(getWorkshopRelease()).toBe(first);
  });
});

describe("isValidWorkshopId", () => {
  it("accepts the full unsigned 64-bit range and nothing else", () => {
    expect(isValidWorkshopId("18446744073709551615")).toBe(true);
    expect(isValidWorkshopId("18446744073709551616")).toBe(false);
    expect(isValidWorkshopId("")).toBe(false);
    expect(isValidWorkshopId(123)).toBe(false);
  });

  // 0 would reach WorkshopItems=0 and abort a Workshop server's startup; a
  // leading zero never equals the plain id the heartbeat reports, so the
  // server could never be confirmed.
  it.each(["0", "000", "03712345678", "+3712345678"])("rejects %j", (value) => {
    expect(isValidWorkshopId(value)).toBe(false);
  });

  it("ignores a PANEL_BRIDGE_WORKSHOP_ID that isn't a plain non-zero id", () => {
    writeDiskDoc({ ...BASE, workshopId: "111" });
    vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", "0");
    _resetWorkshopReleaseCacheForTests();
    expect(getWorkshopRelease()).toMatchObject({ source: "file", workshopId: "111" });
    vi.stubEnv("PANEL_BRIDGE_WORKSHOP_ID", "03712345678");
    _resetWorkshopReleaseCacheForTests();
    expect(getWorkshopRelease()).toMatchObject({ source: "file", workshopId: "111" });
  });

  it("marks a published.json with a leading-zero id invalid", () => {
    writeDiskDoc({ ...BASE, workshopId: "03712345678" });
    _resetWorkshopReleaseCacheForTests();
    expect(getWorkshopRelease()).toMatchObject({ status: "invalid", workshopId: null });
  });
});
