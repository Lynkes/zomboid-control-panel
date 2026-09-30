import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { getDataPaths } from "../utils/paths.js";
import {
  CHARACTER_STORE_DIR,
  CHARACTER_STORE_LIMITS,
  characterRecordPath,
  computeSkillDelta,
  pruneCharacterStore,
  readCharacterRecord,
  recordCharacterSheet,
} from "../services/characterStore.js";

const MIN = 60 * 1000;
const T0 = Date.parse("2026-09-29T10:00:00.000Z");
let serverCounter = 0;

// Each test gets its own server folder; the data dir itself is per test file
// (vitest.perFileDataDir.setup.mjs).
function freshServerId() {
  serverCounter += 1;
  return `srv-${serverCounter}`;
}

function sheet({ levels = { Axe: 1 }, hours = 10, kills = 5, inventory, extra = {} } = {}) {
  return {
    username: "Kate",
    summary: { hoursSurvived: hours, zombieKills: kills, minutesPerDay: 60 },
    skills: {
      categories: [],
      perks: Object.entries(levels).map(([id, level]) => ({ id, level, xp: level * 100, passive: false })),
    },
    ...(inventory ? { inventory } : {}),
    ...extra,
  };
}

const BASE = ["summary", "stats", "skills", "traits"];

describe("record location", () => {
  it("hashes the lowercased username, so traversal input can't choose a path", () => {
    const file = characterRecordPath("srv-a", "../../../etc/passwd");
    const root = path.join(getDataPaths().dataDir, CHARACTER_STORE_DIR, "srv-a");
    expect(path.dirname(file)).toBe(root);
    expect(path.basename(file)).toMatch(/^[0-9a-f]{32}\.json$/);
    expect(characterRecordPath("srv-a", "KATE")).toBe(characterRecordPath("srv-a", "kate"));
  });

  it("refuses a server id that isn't a plain folder name", () => {
    for (const bad of ["..", "a/b", "a\\b", "", "x".repeat(65), "C:", null]) {
      expect(characterRecordPath(bad, "Kate"), String(bad)).toBeNull();
    }
    expect(characterRecordPath("8d1c2c1e-4a6b-4d2e-9a61-0c7c1f0e9b11", "Kate")).not.toBeNull();
  });
});

describe("snapshots", () => {
  it("appends one when the last is 5 minutes old or a level changed, not otherwise", async () => {
    const id = freshServerId();
    await recordCharacterSheet(id, "Kate", sheet(), { sections: BASE, now: T0 });
    await recordCharacterSheet(id, "Kate", sheet(), { sections: BASE, now: T0 + 4 * MIN });
    let record = await readCharacterRecord(id, "Kate");
    expect(record.snapshots).toHaveLength(1);
    await recordCharacterSheet(id, "Kate", sheet(), { sections: BASE, now: T0 + 5 * MIN });
    record = await readCharacterRecord(id, "Kate");
    expect(record.snapshots).toHaveLength(2);
    await recordCharacterSheet(id, "Kate", sheet({ levels: { Axe: 2 } }), { sections: BASE, now: T0 + 6 * MIN });
    record = await readCharacterRecord(id, "Kate");
    expect(record.snapshots).toHaveLength(3);
    expect(record.snapshots.at(-1)).toMatchObject({ source: "view", levels: { Axe: 2 }, xp: { Axe: 200 }, hoursSurvived: 10, zombieKills: 5 });
  });

  it("keeps at most 96", async () => {
    const id = freshServerId();
    for (let i = 0; i < 100; i++) {
      await recordCharacterSheet(id, "Kate", sheet({ hours: 10 + i }), { sections: BASE, now: T0 + i * 5 * MIN });
    }
    const record = await readCharacterRecord(id, "Kate");
    expect(record.snapshots).toHaveLength(CHARACTER_STORE_LIMITS.maxSnapshots);
    expect(record.snapshots[0].hoursSurvived).toBe(14);
  });

  it("a fetch without skills adds no snapshot", async () => {
    const id = freshServerId();
    await recordCharacterSheet(id, "Kate", { username: "Kate", inventory: { worn: [] } }, { sections: ["inventory"], now: T0 });
    expect((await readCharacterRecord(id, "Kate")).snapshots).toEqual([]);
  });

  it("clears the history when a new life starts (fewer hours or kills)", async () => {
    const id = freshServerId();
    await recordCharacterSheet(id, "Kate", sheet({ hours: 100, kills: 50, inventory: { worn: [] } }), {
      sections: [...BASE, "inventory"],
      now: T0,
    });
    const result = await recordCharacterSheet(id, "Kate", sheet({ hours: 2, kills: 50 }), { sections: BASE, now: T0 + 10 * MIN });
    expect(result.newLife).toBe(true);
    const record = await readCharacterRecord(id, "Kate");
    expect(record.snapshots).toHaveLength(1);
    expect(record.snapshots[0].hoursSurvived).toBe(2);
    // The old life's inventory isn't this character's.
    expect(record.lastSheet.inventory).toBeUndefined();
    const fewerKills = await recordCharacterSheet(id, "Kate", sheet({ hours: 3, kills: 1 }), { sections: BASE, now: T0 + 20 * MIN });
    expect(fewerKills.newLife).toBe(true);
  });
});

describe("skill delta", () => {
  const snap = (minutesAgo, levels, source = "view") => ({ at: T0 - minutesAgo * MIN, source, levels, xp: {} });

  it("compares against the newest snapshot 2 to 60 minutes old", () => {
    const snaps = [snap(90, { Axe: 1 }), snap(50, { Axe: 2 }), snap(20, { Axe: 3 }), snap(1, { Axe: 4 })];
    const delta = computeSkillDelta(snaps, sheet({ levels: { Axe: 6 } }), T0);
    expect(delta).toEqual({
      since: new Date(T0 - 20 * MIN).toISOString(),
      source: "view",
      perks: [{ id: "Axe", fromLevel: 3, toLevel: 6, toXp: 600 }],
    });
  });

  it("falls back to the login snapshot, then to nothing", () => {
    const login = [snap(300, { Axe: 1 }, "login"), snap(1, { Axe: 2 })];
    expect(computeSkillDelta(login, sheet({ levels: { Axe: 5 } }), T0)).toMatchObject({
      source: "login",
      perks: [{ id: "Axe", fromLevel: 1, toLevel: 5 }],
    });
    expect(computeSkillDelta([snap(300, { Axe: 1 }, "sampler")], sheet(), T0)).toBeNull();
    expect(computeSkillDelta([], sheet(), T0)).toBeNull();
  });

  it("is returned by recordCharacterSheet against the history before this read", async () => {
    const id = freshServerId();
    await recordCharacterSheet(id, "Kate", sheet({ levels: { Axe: 2 } }), { source: "login", sections: BASE, now: T0 });
    const { skillDelta } = await recordCharacterSheet(id, "Kate", sheet({ levels: { Axe: 5 } }), { sections: BASE, now: T0 + 30 * MIN });
    expect(skillDelta).toMatchObject({ source: "login", perks: [{ id: "Axe", fromLevel: 2, toLevel: 5 }] });
  });
});

describe("section merge and size guard", () => {
  it("an inventory-only fetch updates only the inventory", async () => {
    const id = freshServerId();
    await recordCharacterSheet(id, "Kate", sheet({ levels: { Axe: 3 } }), { sections: BASE, now: T0 });
    await recordCharacterSheet(
      id,
      "Kate",
      { username: "Kate", summary: { hoursSurvived: 999 }, inventory: { worn: [{ kind: "stack", fullType: "Base.Hat" }] } },
      { sections: ["inventory"], now: T0 + MIN },
    );
    const record = await readCharacterRecord(id, "Kate");
    expect(record.lastSheet.skills.perks[0].level).toBe(3);
    expect(record.lastSheet.summary.hoursSurvived).toBe(10);
    expect(record.lastSheet.inventory.worn[0].fullType).toBe("Base.Hat");
    expect(record.lastInventoryAt).toBe(T0 + MIN);
    expect(record.lastSheetAt).toBe(T0 + MIN);
  });

  it("a section that failed doesn't overwrite what was saved", async () => {
    const id = freshServerId();
    await recordCharacterSheet(id, "Kate", sheet({ levels: { Axe: 3 } }), { sections: BASE, now: T0 });
    await recordCharacterSheet(
      id,
      "Kate",
      { ...sheet({ levels: {} }), sectionErrors: { skills: "PerkFactory unavailable" } },
      { sections: BASE, now: T0 + MIN },
    );
    const record = await readCharacterRecord(id, "Kate");
    expect(record.lastSheet.skills.perks[0].level).toBe(3);
    expect(record.lastSheet.sectionErrors).toBeUndefined();
  });

  it("drops the saved inventory when the record would pass 512 KB", async () => {
    const id = freshServerId();
    const rows = Array.from({ length: 4000 }, (_, i) => ({ kind: "stack", fullType: `Base.Item${i}`, name: "x".repeat(120) }));
    await recordCharacterSheet(
      id,
      "Kate",
      sheet({ inventory: { root: { kind: "container", id: "main", rows } } }),
      { sections: [...BASE, "inventory"], now: T0 },
    );
    const record = await readCharacterRecord(id, "Kate");
    expect(record.lastSheet.inventory).toBeUndefined();
    expect(record.lastInventoryAt).toBeNull();
    expect(record.lastSheet.skills).toBeDefined();
    const file = characterRecordPath(id, "Kate");
    expect(fs.statSync(file).size).toBeLessThanOrEqual(CHARACTER_STORE_LIMITS.maxBytes);
  });
});

describe("concurrency and pruning", () => {
  it("serializes concurrent writes to one record", async () => {
    const id = freshServerId();
    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        recordCharacterSheet(id, "Kate", sheet({ levels: { Axe: i } }), { sections: BASE, now: T0 + i * MIN }),
      ),
    );
    const record = await readCharacterRecord(id, "Kate");
    // Every level differs from the one before, so every write appended.
    expect(record.snapshots).toHaveLength(20);
    expect(record.snapshots.map((s) => s.levels.Axe)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  it("prunes records untouched for 180 days and empty server folders, leaving others", async () => {
    const oldId = freshServerId();
    const keepId = freshServerId();
    await recordCharacterSheet(oldId, "Old", sheet(), { sections: BASE, now: T0 });
    await recordCharacterSheet(keepId, "New", sheet(), { sections: BASE, now: T0 });
    const oldFile = characterRecordPath(oldId, "Old");
    const ancient = new Date(Date.now() - 200 * 24 * 60 * MIN);
    fs.utimesSync(oldFile, ancient, ancient);
    const stray = path.join(path.dirname(oldFile), "notes.txt");
    fs.writeFileSync(stray, "not ours");

    const { removed } = await pruneCharacterStore({ maxAgeDays: 180 });
    expect(removed).toBe(1);
    expect(fs.existsSync(oldFile)).toBe(false);
    expect(fs.existsSync(stray)).toBe(true);
    expect(fs.existsSync(characterRecordPath(keepId, "New"))).toBe(true);

    fs.unlinkSync(stray);
    await pruneCharacterStore({ maxAgeDays: 180 });
    expect(fs.existsSync(path.dirname(oldFile))).toBe(false);
  });

  it("prune never throws when the store doesn't exist", async () => {
    await expect(pruneCharacterStore({ maxAgeDays: 180, now: 0 })).resolves.toEqual(expect.any(Object));
  });
});
