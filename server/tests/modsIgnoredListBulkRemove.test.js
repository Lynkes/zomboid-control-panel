import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createRouteRunner } from "./helpers/modsRouteHarness.js";

// Mod Manager, ignored list (issue #232): a list of hundreds of entries could
// only be taken apart one row at a time. POST /api/mods/ignored/remove
// un-ignores a set of workshop ids in one request; ids that are not on the
// list are skipped and another server's entries are never touched.
//
// Real, unmocked database/init.js with the real mods router.
const db = await import("../database/init.js");
const { default: modsRouter } = await import("../routes/mods.js");
const runRoute = createRouteRunner(modsRouter);

let activeServerId;

beforeAll(async () => {
  await db.initDatabase();
  // A fresh database has no server record; the ignored list is scoped to the active one.
  const state = await db.getDb();
  state.data.servers = [{ id: "srv-test", name: "Test", isActive: true }];
  activeServerId = "srv-test";
});

afterAll(async () => {
  const state = await db.getDb();
  state.data.ignored_mods = [];
});

async function reset(entries) {
  const state = await db.getDb();
  state.data.ignored_mods = entries;
}

function entry(workshopId, serverId = activeServerId) {
  return {
    workshop_id: workshopId,
    name: `Mod ${workshopId}`,
    server_id: serverId,
    ignored_at: "2026-10-01T00:00:00.000Z",
  };
}

async function remove(body) {
  return runRoute("/ignored/remove", "post", { body });
}

describe("POST /ignored/remove", () => {
  beforeEach(async () => {
    await reset([entry("111"), entry("222"), entry("333"), entry("444", "some-other-server")]);
  });

  it("takes the listed mods off the list and keeps the rest", async () => {
    const res = await remove({ workshopIds: ["111", "333"] });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody()).toMatchObject({ success: true, removed: 2 });
    expect((await db.getIgnoredMods()).map((m) => m.workshop_id)).toEqual(["222"]);
  });

  it("skips ids that are not on the list and says how many it really removed", async () => {
    const res = await remove({ workshopIds: ["222", "999", 222] });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().removed).toBe(1);
    expect((await db.getIgnoredMods()).map((m) => m.workshop_id)).toEqual(["111", "333"]);
  });

  it("never touches another server's entries", async () => {
    const res = await remove({ workshopIds: ["444"] });
    expect(res.getStatusCode()).toBe(200);
    expect(res.getBody().removed).toBe(0);
    const state = await db.getDb();
    expect(state.data.ignored_mods.some((m) => m.workshop_id === "444")).toBe(true);
  });

  it("clears a long list in one request", async () => {
    const many = Array.from({ length: 300 }, (_, i) => String(1000 + i));
    await reset(many.map((id) => entry(id)));
    const res = await remove({ workshopIds: many });
    expect(res.getBody().removed).toBe(300);
    expect(await db.getIgnoredMods()).toEqual([]);
  });

  it("refuses a body without a workshopIds array", async () => {
    for (const body of [undefined, {}, { workshopIds: "111" }, { workshopIds: [] }]) {
      const res = await remove(body);
      expect(res.getStatusCode()).toBe(400);
      expect(res.getBody().code).toBe("MODS_WORKSHOP_IDS_ARRAY_REQUIRED");
    }
    expect((await db.getIgnoredMods()).length).toBe(3);
  });

  it("refuses ids that are not workshop ids", async () => {
    const res = await remove({ workshopIds: ["../x", "12ab", ""] });
    expect(res.getStatusCode()).toBe(400);
    expect(res.getBody().code).toBe("MODS_NO_VALID_WORKSHOP_IDS");
    expect((await db.getIgnoredMods()).length).toBe(3);
  });
});
