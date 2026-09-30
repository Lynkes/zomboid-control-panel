import express from "express";
import { getActiveServer, getPlayerLogs } from "../database/init.js";
import bridge from "../services/panelBridge.js";
import { requirePermission } from "../services/permissions.js";
import {
  CHARACTER_SECTIONS,
  DEFAULT_CHARACTER_SECTIONS,
  fetchCharacterSheet,
  refreshIntervalsFor,
} from "../services/characterSheet.js";
import { CHARACTER_HINT_THRESHOLDS, computeCharacterHints, estimateRealHours } from "../services/characterHints.js";
import { readCharacterRecord, recordCharacterSheet } from "../services/characterStore.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { createLogger } from "../utils/logger.js";
import { BRIDGE_USERNAME_REGEX } from "./panelBridge.js";

const log = createLogger("API:PlayerCharacter");

// Character sheet API (/api/player-character) for the Players page's
// Character tab. Read-only: it asks the bridge for a sheet, keeps the last
// one per player (services/characterStore.js) so an offline player still
// shows something, and adds the "Worth a look" hints. A 200 always carries
// the full response shape; the availability field says how live it is.

const router = express.Router();

// Identical requests in flight (or answered within this window) share one
// bridge round-trip, so two tabs polling the same player cost one read.
const COALESCE_MS = 2000;
// fresh=1 bypasses the bridge's own short cache; honoured once per player
// per this window, otherwise the request is served as a normal one.
const FRESH_MIN_INTERVAL_MS = 5000;
// The bridge caches the leaderboard for 10 s; so does this.
const LEADERBOARD_CACHE_MS = 10000;
const MAX_TRACKED_KEYS = 500;
const PLAYER_LOG_LIMIT = 200;

const inFlight = new Map(); // key -> { promise, settledAt }
const lastFreshAt = new Map(); // serverId|lower(username) -> ms
let leaderboardCache = null; // { serverId, at, players }

// Exposed for tests only.
export function resetPlayerCharacterRouteState() {
  inFlight.clear();
  lastFreshAt.clear();
  leaderboardCache = null;
}

function sweepMaps(now) {
  for (const [key, entry] of inFlight) {
    if (entry.settledAt !== null && now - entry.settledAt > COALESCE_MS) inFlight.delete(key);
  }
  for (const [key, at] of lastFreshAt) {
    if (now - at > FRESH_MIN_INTERVAL_MS) lastFreshAt.delete(key);
  }
  if (lastFreshAt.size > MAX_TRACKED_KEYS) lastFreshAt.clear();
}

function parseSections(raw) {
  if (raw === undefined) return [...DEFAULT_CHARACTER_SECTIONS];
  if (typeof raw !== "string") return null;
  const requested = raw.split(",").map((s) => s.trim());
  if (requested.length === 0 || requested.some((s) => !CHARACTER_SECTIONS.includes(s))) return null;
  // Canonical order, so "skills,summary" and "summary,skills" coalesce.
  return CHARACTER_SECTIONS.filter((s) => requested.includes(s));
}

function parseMaxItems(raw) {
  if (typeof raw !== "string" || !/^\d{1,5}$/.test(raw)) return undefined;
  return Math.min(1000, Math.max(50, Number(raw)));
}

function pickRecord(players, username) {
  const lower = username.toLowerCase();
  const found = (Array.isArray(players) ? players : []).find(
    (p) => typeof p?.username === "string" && p.username.toLowerCase() === lower,
  );
  if (!found) return null;
  const numberOrNull = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
  return {
    allTimeKills: numberOrNull(found.allTimeKills),
    deaths: numberOrNull(found.deaths),
    bestDays: numberOrNull(found.bestDays),
    currentKills: numberOrNull(found.currentKills),
    currentDays: numberOrNull(found.currentDays),
    favoriteWeapon: typeof found.favoriteWeapon === "string" ? found.favoriteWeapon.slice(0, 128) : null,
  };
}

async function leaderboardRecord(serverId, username, now) {
  if (!bridge.isRunning || !bridge.isModConnected()) return null;
  try {
    if (!leaderboardCache || leaderboardCache.serverId !== serverId || now - leaderboardCache.at > LEADERBOARD_CACHE_MS) {
      const result = await bridge.getLeaderboard();
      leaderboardCache = { serverId, at: now, players: result?.data?.players ?? [] };
    }
    return pickRecord(leaderboardCache.players, username);
  } catch (error) {
    log.debug(`Leaderboard read for the character sheet failed: ${String(error?.message ?? "").slice(0, 200)}`);
    return null;
  }
}

// Earliest known start of this life: the oldest snapshot of it, minus the
// play time it had already recorded then. Widens the window panel "Give
// item" logs are matched in when the server spent time stopped.
function lifeStartedAtOf(record) {
  const first = record?.snapshots?.[0];
  if (!first || typeof first.at !== "number") return undefined;
  const hours = estimateRealHours({ hoursSurvived: first.hoursSurvived, minutesPerDay: record.lastSheet?.summary?.minutesPerDay });
  return hours === undefined ? first.at : first.at - hours * 60 * 60 * 1000;
}

async function safePlayerLogs(username, serverId) {
  try {
    return await getPlayerLogs(username, PLAYER_LOG_LIMIT, serverId ?? undefined);
  } catch {
    return [];
  }
}

async function buildCharacterView({ username, serverId, sections, fresh, maxItems }) {
  const now = Date.now();
  const intervals = refreshIntervalsFor(bridge);
  const [result, record] = await Promise.all([
    fetchCharacterSheet(bridge, username, { sections, fresh, maxItems }),
    leaderboardRecord(serverId, username, now),
  ]);
  const { availability } = result;
  const sheet = result.sheet ?? null;
  const canonicalName = sheet?.username ?? username;

  let stored = null;
  let skillDelta = null;
  if (availability === "live" && sheet && serverId) {
    try {
      const saved = await recordCharacterSheet(serverId, username, sheet, { source: "view", sections, now });
      if (saved) {
        stored = saved.record;
        skillDelta = saved.skillDelta;
      }
    } catch (error) {
      log.debug(`Character record not saved: ${error.message}`);
    }
  } else if (serverId) {
    try {
      stored = await readCharacterRecord(serverId, username);
    } catch {
      stored = null;
    }
  }

  const cached =
    availability !== "live" && stored?.lastSheet
      ? {
          at: new Date(stored.lastSheetAt).toISOString(),
          inventoryAt: stored.lastInventoryAt ? new Date(stored.lastInventoryAt).toISOString() : null,
          sheet: stored.lastSheet,
        }
      : null;

  // Live hints read the merged record (this read's sections plus the last
  // inventory the panel loaded), so the header badge counts item hints even
  // before anyone opens the inventory.
  let hintSheet = null;
  let hintSource = null;
  if (availability === "live" && sheet) {
    hintSheet = stored?.lastSheet ?? sheet;
    hintSource = "live";
  } else if (cached) {
    hintSheet = cached.sheet;
    hintSource = "cached";
  } else if (availability === "partial" && sheet) {
    hintSheet = sheet;
    hintSource = "live";
  }
  let hints = [];
  if (hintSheet) {
    const playerLogs = await safePlayerLogs(hintSheet.username ?? canonicalName, serverId);
    hints = computeCharacterHints(hintSheet, {
      thresholds: CHARACTER_HINT_THRESHOLDS,
      skillDelta,
      playerLogs,
      now,
      source: hintSource,
      lifeStartedAt: lifeStartedAtOf(stored),
    });
  }

  const response = {
    username: sheet?.username ?? cached?.sheet?.username ?? username,
    serverId,
    availability,
    transport: intervals.transport,
    refreshAfterMs: intervals.refreshAfterMs,
    inventoryRefreshAfterMs: intervals.inventoryRefreshAfterMs,
    fetchedAt: new Date(now).toISOString(),
    sheet,
    cached,
    record,
    skillDelta,
    hints,
    hintSource,
    hintThresholds: CHARACTER_HINT_THRESHOLDS,
  };
  if (sheet?.cost && typeof sheet.cost.ms === "number") {
    response.cost = { ms: sheet.cost.ms, walked: sheet.cost.walked ?? 0 };
  }
  return response;
}

router.get("/:username", requirePermission("players.view"), async (req, res) => {
  const { username } = req.params;
  if (typeof username !== "string" || !BRIDGE_USERNAME_REGEX.test(username)) {
    return res.status(400).json({
      error: "Invalid username format",
      code: ErrorCode.BRIDGE_INVALID_USERNAME_FORMAT,
    });
  }
  const sections = parseSections(req.query.sections);
  if (!sections) {
    return res
      .status(400)
      .json({ error: "Unknown character section requested.", code: ErrorCode.CHARACTER_INVALID_SECTIONS });
  }
  const maxItems = parseMaxItems(req.query.maxItems);

  try {
    const now = Date.now();
    sweepMaps(now);
    const server = await getActiveServer();
    const serverId = server?.id != null ? String(server.id) : null;
    const playerKey = `${serverId}|${username.toLowerCase()}`;
    let fresh = req.query.fresh === "1" || req.query.fresh === "true";
    if (fresh) {
      const last = lastFreshAt.get(playerKey);
      if (last !== undefined && now - last < FRESH_MIN_INTERVAL_MS) fresh = false;
      else lastFreshAt.set(playerKey, now);
    }
    const key = `${playerKey}|${sections.join(",")}|${maxItems ?? ""}|${fresh ? 1 : 0}`;
    let entry = inFlight.get(key);
    if (!entry || (entry.settledAt !== null && now - entry.settledAt > COALESCE_MS)) {
      entry = { promise: null, settledAt: null };
      entry.promise = buildCharacterView({ username, serverId, sections, fresh, maxItems }).finally(() => {
        entry.settledAt = Date.now();
      });
      inFlight.set(key, entry);
    }
    const payload = await entry.promise;
    return res.json(payload);
  } catch (error) {
    log.warn(`Character sheet request failed: ${String(error?.message ?? "").slice(0, 200)}`);
    return res.status(500).json({ error: "Couldn't read this character.", code: ErrorCode.CHARACTER_SHEET_FAILED });
  }
});

export default router;
