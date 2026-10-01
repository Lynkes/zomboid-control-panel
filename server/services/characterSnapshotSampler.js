import { getActiveServer, getPlayerLogs } from "../database/init.js";
import { createLogger } from "../utils/logger.js";
import { latestDeathAt, playerLogsFor } from "./characterHints.js";
import { fetchCharacterSheet, isCharacterSheetUnsupported } from "./characterSheet.js";
import { readCharacterRecord, recordCharacterSheet } from "./characterStore.js";

const log = createLogger("CharacterSampler");

// Skill snapshots for the Players page's Character tab, so an offline player
// still shows their skills and a sudden jump can be compared against
// something: one read 20 s after each login, then every 30 minutes a slow
// pass over whoever is online and hasn't been read for 25 minutes. One
// player every 2 s, one read in flight at most, never the inventory, never
// while the bridge is down, and nothing at all while the mod is one without
// getCharacterSheet (a partial sheet has no skills to snapshot). Nothing here
// throws; failures log at debug.

export const CHARACTER_SAMPLER_TIMING = Object.freeze({
  loginDelayMs: 20 * 1000,
  sweepIntervalMs: 30 * 60 * 1000,
  staleAfterMs: 25 * 60 * 1000,
  processIntervalMs: 2 * 1000,
});

const SAMPLED_SECTIONS = Object.freeze(["summary", "skills", "traits"]);
// player_logs keeps 1000 rows across every player (database/init.js).
const PLAYER_LOG_SCAN_LIMIT = 1000;

let state = null;

function bridgeConnected(bridge) {
  try {
    return Boolean(bridge?.isRunning && bridge.isModConnected()) && !isCharacterSheetUnsupported(bridge);
  } catch {
    return false;
  }
}

async function deathAtFor(serverId, username, now) {
  try {
    const logs = await getPlayerLogs(null, PLAYER_LOG_SCAN_LIMIT, serverId);
    return latestDeathAt(playerLogsFor(logs, username, PLAYER_LOG_SCAN_LIMIT), now);
  } catch {
    return undefined;
  }
}

function onlinePlayers(bridge) {
  const players = bridge?.modStatus?.players;
  if (Array.isArray(players)) return players.filter((name) => typeof name === "string" && name.length > 0);
  if (players && typeof players === "object") return Object.keys(players);
  return [];
}

function enqueue(current, username, source, { front = false } = {}) {
  const key = username.toLowerCase();
  const existing = current.queue.findIndex((item) => item.key === key);
  if (existing !== -1) {
    // A login read outranks a periodic one already waiting.
    if (source === "login") current.queue[existing].source = "login";
    return;
  }
  const item = { key, username, source };
  if (front) current.queue.unshift(item);
  else current.queue.push(item);
}

async function activeServerId() {
  const server = await getActiveServer();
  return server?.id != null ? String(server.id) : null;
}

async function sweep(current) {
  if (!bridgeConnected(current.bridge)) return;
  try {
    const serverId = await activeServerId();
    if (!serverId) return;
    const now = Date.now();
    for (const username of onlinePlayers(current.bridge)) {
      const record = await readCharacterRecord(serverId, username);
      const last = record?.snapshots?.at(-1);
      if (!last || now - last.at >= CHARACTER_SAMPLER_TIMING.staleAfterMs) enqueue(current, username, "sampler");
    }
  } catch (error) {
    log.debug(`Character snapshot sweep skipped: ${error.message}`);
  }
}

async function processNext(current) {
  if (current.inFlight || current.queue.length === 0) return;
  if (!bridgeConnected(current.bridge)) {
    current.queue.length = 0;
    return;
  }
  const item = current.queue.shift();
  current.inFlight = true;
  try {
    const serverBefore = await activeServerId();
    if (!serverBefore) return;
    const result = await fetchCharacterSheet(current.bridge, item.username, {
      sections: SAMPLED_SECTIONS,
      fallback: false,
    });
    if (result.availability !== "live" || !result.sheet) {
      if (result.availability === "unsupported") current.queue.length = 0;
      log.debug(`Character snapshot for ${item.username} skipped: ${result.availability}`);
      return;
    }
    // The operator switched servers while this read was in flight: the
    // answer belongs to a server that is no longer active.
    if ((await activeServerId()) !== serverBefore || state !== current) return;
    const now = Date.now();
    await recordCharacterSheet(serverBefore, item.username, result.sheet, {
      source: item.source,
      sections: SAMPLED_SECTIONS,
      now,
      deathAt: await deathAtFor(serverBefore, item.username, now),
    });
  } catch (error) {
    log.debug(`Character snapshot for ${item.username} failed: ${error.message}`);
  } finally {
    current.inFlight = false;
  }
}

export function startCharacterSnapshotSampler(panelBridge) {
  stopCharacterSnapshotSampler();
  if (!panelBridge || typeof panelBridge.on !== "function") return;
  const current = {
    bridge: panelBridge,
    queue: [],
    inFlight: false,
    loginTimers: new Set(),
    onConnect: null,
    sweepTimer: null,
    processTimer: null,
  };
  current.onConnect = (username) => {
    if (typeof username !== "string" || username.length === 0) return;
    const timer = setTimeout(() => {
      current.loginTimers.delete(timer);
      if (state !== current || !bridgeConnected(current.bridge)) return;
      enqueue(current, username, "login", { front: true });
    }, CHARACTER_SAMPLER_TIMING.loginDelayMs);
    timer.unref?.();
    current.loginTimers.add(timer);
  };
  panelBridge.on("playerConnect", current.onConnect);
  current.sweepTimer = setInterval(() => {
    sweep(current).catch(() => {});
  }, CHARACTER_SAMPLER_TIMING.sweepIntervalMs);
  current.sweepTimer.unref?.();
  current.processTimer = setInterval(() => {
    processNext(current).catch(() => {});
  }, CHARACTER_SAMPLER_TIMING.processIntervalMs);
  current.processTimer.unref?.();
  state = current;
}

export function stopCharacterSnapshotSampler() {
  const current = state;
  state = null;
  if (!current) return;
  if (typeof current.bridge.off === "function") current.bridge.off("playerConnect", current.onConnect);
  else current.bridge.removeListener?.("playerConnect", current.onConnect);
  for (const timer of current.loginTimers) clearTimeout(timer);
  current.loginTimers.clear();
  clearInterval(current.sweepTimer);
  clearInterval(current.processTimer);
  current.queue.length = 0;
}
