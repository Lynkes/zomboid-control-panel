import { EventEmitter } from "events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getActiveServer = vi.fn();
vi.mock("../database/init.js", () => ({
  getActiveServer: (...args) => getActiveServer(...args),
}));

const { CHARACTER_SAMPLER_TIMING, startCharacterSnapshotSampler, stopCharacterSnapshotSampler } = await import(
  "../services/characterSnapshotSampler.js"
);
const { readCharacterRecord, recordCharacterSheet } = await import("../services/characterStore.js");

let serverCounter = 0;
let serverId;

function sheetFor(username) {
  return {
    success: true,
    data: {
      username,
      summary: { hoursSurvived: 20, zombieKills: 3 },
      skills: { categories: [], perks: [{ id: "Axe", parent: "Combat", passive: false, level: 2, xp: 200 }] },
      traits: [],
    },
  };
}

function makeBridge() {
  const bridge = new EventEmitter();
  bridge.isRunning = true;
  bridge.modStatus = { alive: true, players: [] };
  bridge.isModConnected = () => bridge.modStatus?.alive === true;
  bridge.sendCommand = vi.fn(async (action, args) => sheetFor(args.username));
  bridge.getPlayerDetails = vi.fn();
  return bridge;
}

let bridge;

beforeEach(() => {
  vi.useFakeTimers();
  serverCounter += 1;
  serverId = `sampler-${serverCounter}`;
  getActiveServer.mockReset();
  getActiveServer.mockImplementation(async () => ({ id: serverId }));
  bridge = makeBridge();
  startCharacterSnapshotSampler(bridge);
});

afterEach(() => {
  stopCharacterSnapshotSampler();
  vi.useRealTimers();
});

describe("characterSnapshotSampler: login snapshots", () => {
  it("reads a player 20 s after they connect, without the inventory, and saves a login snapshot", async () => {
    bridge.emit("playerConnect", "Kate");
    await vi.advanceTimersByTimeAsync(CHARACTER_SAMPLER_TIMING.loginDelayMs - 1000);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000 + CHARACTER_SAMPLER_TIMING.processIntervalMs);
    expect(bridge.sendCommand).toHaveBeenCalledTimes(1);
    expect(bridge.sendCommand).toHaveBeenCalledWith("getCharacterSheet", {
      username: "Kate",
      sections: ["summary", "skills", "traits"],
    });
    const record = await readCharacterRecord(serverId, "Kate");
    expect(record.snapshots).toEqual([expect.objectContaining({ source: "login", levels: { Axe: 2 } })]);
    expect(record.lastSheet.skills.perks[0].id).toBe("Axe");
  });

  it("does nothing while the bridge is disconnected", async () => {
    bridge.modStatus = { alive: false };
    bridge.emit("playerConnect", "Kate");
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
  });

  it("stops listening once stopped", async () => {
    stopCharacterSnapshotSampler();
    bridge.emit("playerConnect", "Kate");
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
    expect(bridge.listenerCount("playerConnect")).toBe(0);
  });
});

describe("characterSnapshotSampler: periodic pass", () => {
  it("every 30 minutes queues online players not read for 25 minutes, one every 2 s", async () => {
    bridge.modStatus.players = ["Ann", "Bob", "Cid"];
    // Cid was read 10 minutes before the pass: skipped.
    await recordCharacterSheet(serverId, "Cid", sheetFor("Cid").data, {
      sections: ["summary", "skills", "traits"],
      now: Date.now() + CHARACTER_SAMPLER_TIMING.sweepIntervalMs - 10 * 60 * 1000,
    });
    await vi.advanceTimersByTimeAsync(CHARACTER_SAMPLER_TIMING.sweepIntervalMs - 1);
    expect(bridge.sendCommand).not.toHaveBeenCalled();
    // The pass and a processing tick land together: the first read is
    // immediate, the next one 2 s later.
    await vi.advanceTimersByTimeAsync(1);
    expect(bridge.sendCommand).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(CHARACTER_SAMPLER_TIMING.processIntervalMs - 1);
    expect(bridge.sendCommand).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1 + CHARACTER_SAMPLER_TIMING.processIntervalMs * 3);
    expect(bridge.sendCommand.mock.calls.map(([, args]) => args.username)).toEqual(["Ann", "Bob"]);
    const record = await readCharacterRecord(serverId, "Bob");
    expect(record.snapshots.at(-1).source).toBe("sampler");
  });

  it("keeps at most one read in flight", async () => {
    bridge.modStatus.players = ["Ann", "Bob"];
    let release;
    bridge.sendCommand.mockImplementationOnce(
      (action, args) => new Promise((resolve) => (release = () => resolve(sheetFor(args.username)))),
    );
    await vi.advanceTimersByTimeAsync(CHARACTER_SAMPLER_TIMING.sweepIntervalMs + CHARACTER_SAMPLER_TIMING.processIntervalMs * 5);
    expect(bridge.sendCommand).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(CHARACTER_SAMPLER_TIMING.processIntervalMs);
    expect(bridge.sendCommand).toHaveBeenCalledTimes(2);
  });

  it("discards a read when the active server changed while it was in flight", async () => {
    bridge.emit("playerConnect", "Kate");
    const original = serverId;
    let calls = 0;
    getActiveServer.mockImplementation(async () => {
      calls += 1;
      return { id: calls === 1 ? original : "someone-else" };
    });
    await vi.advanceTimersByTimeAsync(CHARACTER_SAMPLER_TIMING.loginDelayMs + CHARACTER_SAMPLER_TIMING.processIntervalMs);
    expect(bridge.sendCommand).toHaveBeenCalledTimes(1);
    expect(await readCharacterRecord(original, "Kate")).toBeNull();
    expect(await readCharacterRecord("someone-else", "Kate")).toBeNull();
  });

  it("never throws: a failing read is skipped and the next player still gets read", async () => {
    bridge.modStatus.players = ["Ann", "Bob"];
    bridge.sendCommand.mockRejectedValueOnce(new Error("Player not found: Ann"));
    await vi.advanceTimersByTimeAsync(CHARACTER_SAMPLER_TIMING.sweepIntervalMs + CHARACTER_SAMPLER_TIMING.processIntervalMs * 3);
    expect(bridge.sendCommand).toHaveBeenCalledTimes(2);
    expect(await readCharacterRecord(serverId, "Ann")).toBeNull();
    expect((await readCharacterRecord(serverId, "Bob")).snapshots).toHaveLength(1);
  });

  it("drops the queue when the bridge disconnects", async () => {
    bridge.modStatus.players = ["Ann", "Bob"];
    let release;
    bridge.sendCommand.mockImplementationOnce(
      (action, args) => new Promise((resolve) => (release = () => resolve(sheetFor(args.username)))),
    );
    await vi.advanceTimersByTimeAsync(CHARACTER_SAMPLER_TIMING.sweepIntervalMs);
    expect(bridge.sendCommand).toHaveBeenCalledTimes(1); // Ann, still in flight; Bob waits
    bridge.modStatus = { alive: false, players: ["Ann", "Bob"] };
    release();
    await vi.advanceTimersByTimeAsync(CHARACTER_SAMPLER_TIMING.processIntervalMs * 3);
    bridge.modStatus = { alive: true, players: [] };
    await vi.advanceTimersByTimeAsync(CHARACTER_SAMPLER_TIMING.processIntervalMs * 3);
    expect(bridge.sendCommand).toHaveBeenCalledTimes(1);
  });
});
