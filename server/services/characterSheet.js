import { createLogger } from "../utils/logger.js";

const log = createLogger("CharacterSheet");

// Reads one player's character sheet through the bridge's read-only
// getCharacterSheet handler and turns whatever came back into the fixed
// shape the Players page's Character tab renders. Nothing here writes to the
// game: an old mod falls back to getPlayerDetails, and every failure maps to
// an availability state instead of an exception.

export const CHARACTER_SECTIONS = Object.freeze(["summary", "stats", "skills", "traits", "inventory"]);
export const DEFAULT_CHARACTER_SECTIONS = Object.freeze(["summary", "stats", "skills", "traits"]);

export const CHARACTER_SHEET_LIMITS = Object.freeze({
  nameMax: 128,
  idMax: 96,
  // The main inventory is depth 1; a row nested deeper than this is dropped
  // and its container marked truncatedDepth.
  rowDepthMax: 4,
  // Across the whole inventory (tree, worn, attached, equipped).
  rowsMax: 2000,
});

const STAT_NAMES = Object.freeze([
  "hunger",
  "thirst",
  "fatigue",
  "endurance",
  "stress",
  "boredom",
  "unhappiness",
  "panic",
  "pain",
  "sickness",
  "zombieInfection",
  "wetness",
  "intoxication",
]);

const FLAG_NAMES = Object.freeze([
  "godMode",
  "invisible",
  "noClip",
  "ghostMode",
  "unlimitedCarry",
  "unlimitedEndurance",
  "knowAllRecipes",
  "invincible",
]);

// Local transport polls fast; SFTP round-trips are slower and every poll costs
// two remote file writes, so it backs off.
export function refreshIntervalsFor(bridge) {
  const remote = Boolean(bridge?.sftpTransport);
  return {
    refreshAfterMs: remote ? 30000 : 10000,
    inventoryRefreshAfterMs: remote ? 60000 : 30000,
    transport: bridge?.isRunning ? (remote ? "sftp" : "local") : null,
  };
}

// ---------------------------------------------------------------------------
// Normalization. The Lua encoder writes an empty table as [], leaves out any
// value it couldn't read, and a sparse Lua list can arrive as an object with
// "1", "2", ... keys. Everything below picks known fields only, so nothing
// the bridge didn't mean to send (a path, a stack trace) can reach a client.
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asObject(value) {
  return isPlainObject(value) ? value : {};
}

function asList(value) {
  if (Array.isArray(value)) return value;
  if (!isPlainObject(value)) return [];
  const keys = Object.keys(value).filter((k) => /^\d+$/.test(k));
  if (keys.length === 0) return [];
  return keys.sort((a, b) => Number(a) - Number(b)).map((k) => value[k]);
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function bool(value) {
  return typeof value === "boolean" ? value : undefined;
}

function text(value, max) {
  if (typeof value === "number" && Number.isFinite(value)) value = String(value);
  if (typeof value !== "string" || value.length === 0) return undefined;
  return value.length > max ? value.slice(0, max) : value;
}

const name = (value) => text(value, CHARACTER_SHEET_LIMITS.nameMax);
const id = (value) => text(value, CHARACTER_SHEET_LIMITS.idMax);

// Drops undefined keys so an unread value stays absent, never a null or 0.
function compact(object) {
  const out = {};
  for (const [key, value] of Object.entries(object)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

function normalizeRole(raw) {
  const role = asObject(raw);
  return compact({
    name: name(role.name),
    adminPower: bool(role.adminPower),
    canSpawnItems: bool(role.canSpawnItems),
  });
}

function normalizeSummary(raw) {
  const s = asObject(raw);
  const flagsRaw = asObject(s.flags);
  const flags = {};
  for (const flag of FLAG_NAMES) {
    const value = bool(flagsRaw[flag]);
    if (value !== undefined) flags[flag] = value;
  }
  const professionRaw = asObject(s.profession);
  const profession = compact({ id: id(professionRaw.id), label: name(professionRaw.label) });
  const sandboxRaw = asObject(s.xpSandbox);
  const xpSandbox = compact({ global: num(sandboxRaw.global), globalToggle: bool(sandboxRaw.globalToggle) });
  return compact({
    isAlive: bool(s.isAlive),
    isAsleep: bool(s.isAsleep),
    isSneaking: bool(s.isSneaking),
    isRunning: bool(s.isRunning),
    x: num(s.x),
    y: num(s.y),
    z: num(s.z),
    hoursSurvived: num(s.hoursSurvived),
    minutesPerDay: num(s.minutesPerDay),
    zombieKills: num(s.zombieKills),
    survivorKills: num(s.survivorKills),
    bodyWeight: num(s.bodyWeight),
    carriedWeight: num(s.carriedWeight),
    maxWeight: num(s.maxWeight),
    flags: Object.keys(flags).length > 0 ? flags : undefined,
    profession: Object.keys(profession).length > 0 ? profession : undefined,
    xpSandbox: Object.keys(xpSandbox).length > 0 ? xpSandbox : undefined,
  });
}

function normalizeStats(raw) {
  const stats = asObject(raw);
  const out = {};
  for (const stat of STAT_NAMES) {
    const entry = stats[stat];
    // A bare number is what the old getPlayerDetails fallback carries.
    const value = isPlainObject(entry)
      ? compact({ value: num(entry.value), min: num(entry.min), max: num(entry.max) })
      : compact({ value: num(entry) });
    if (value.value !== undefined) out[stat] = value;
  }
  return out;
}

function normalizeHealth(raw) {
  const h = asObject(raw);
  const numPartsBleeding = num(h.numPartsBleeding);
  let isBleeding = bool(h.isBleeding);
  if (isBleeding === undefined && numPartsBleeding !== undefined) isBleeding = numPartsBleeding > 0;
  return compact({
    overall: num(h.overall),
    isInfected: bool(h.isInfected),
    numPartsBleeding,
    isBleeding,
    temperature: num(h.temperature),
  });
}

function normalizeSkills(raw) {
  const skills = asObject(raw);
  const categories = [];
  for (const entry of asList(skills.categories)) {
    const c = asObject(entry);
    const categoryId = id(c.id);
    if (!categoryId) continue;
    categories.push(compact({ id: categoryId, name: name(c.name) }));
  }
  const perks = [];
  for (const entry of asList(skills.perks)) {
    const p = asObject(entry);
    const perkId = id(p.id);
    if (!perkId) continue;
    perks.push(
      compact({
        id: perkId,
        parent: id(p.parent),
        name: name(p.name),
        passive: bool(p.passive),
        level: num(p.level),
        xp: num(p.xp),
        levelXp: num(p.levelXp),
        nextLevelXp: num(p.nextLevelXp),
        boost: num(p.boost),
        multiplier: num(p.multiplier),
        sandboxMultiplier: num(p.sandboxMultiplier),
      }),
    );
  }
  return compact({ categories, perks, failed: num(skills.failed) });
}

function normalizeTraits(raw) {
  const traits = [];
  for (const entry of asList(raw)) {
    const t = asObject(entry);
    const traitId = id(t.id);
    if (!traitId) continue;
    traits.push(compact({ id: traitId, label: name(t.label), cost: num(t.cost), profession: bool(t.profession) }));
  }
  return traits;
}

// Shared across one sheet's inventory: every row counts against rowsMax.
function createRowBudget() {
  return { used: 0, overflow: false };
}

function rowPlacement(r) {
  const equipped = r.equipped === "primary" || r.equipped === "secondary" ? r.equipped : undefined;
  return { worn: bool(r.worn), equipped, attached: id(r.attached) };
}

function normalizeRow(raw, depth, budget) {
  if (!isPlainObject(raw)) return null;
  if (budget.used >= CHARACTER_SHEET_LIMITS.rowsMax) {
    budget.overflow = true;
    return null;
  }
  budget.used += 1;
  const r = raw;
  if (r.kind === "container") {
    const rows = [];
    let truncatedDepth = bool(r.truncatedDepth) ?? (num(r.truncatedDepth) !== undefined ? r.truncatedDepth > 0 : undefined);
    const children = asList(r.rows);
    if (depth >= CHARACTER_SHEET_LIMITS.rowDepthMax) {
      if (children.length > 0) truncatedDepth = true;
    } else {
      for (const child of children) {
        const row = normalizeRow(child, depth + 1, budget);
        if (row) rows.push(row);
      }
    }
    return compact({
      kind: "container",
      id: id(r.id),
      itemId: id(r.itemId),
      fullType: id(r.fullType),
      name: name(r.name),
      weight: num(r.weight),
      contentsWeight: num(r.contentsWeight),
      capacity: num(r.capacity),
      itemCount: num(r.itemCount),
      truncatedDepth,
      ...rowPlacement(r),
      rows,
    });
  }
  return compact({
    kind: "stack",
    fullType: id(r.fullType),
    name: name(r.name),
    category: name(r.category),
    qty: num(r.qty),
    weight: num(r.weight),
    condition: num(r.condition),
    conditionMax: num(r.conditionMax),
    ...rowPlacement(r),
    modId: id(r.modId),
    hidden: bool(r.hidden),
    obsolete: bool(r.obsolete),
  });
}

function normalizeInventory(raw) {
  const inv = asObject(raw);
  const budget = createRowBudget();
  const root = isPlainObject(inv.root) ? normalizeRow(inv.root, 1, budget) : null;
  const worn = asList(inv.worn)
    .map((row) => normalizeRow(row, 2, budget))
    .filter(Boolean);
  const attached = asList(inv.attached)
    .map((row) => normalizeRow(row, 2, budget))
    .filter(Boolean);
  const equippedRaw = asObject(inv.equipped);
  const equipped = compact({
    primary: isPlainObject(equippedRaw.primary) ? normalizeRow(equippedRaw.primary, 2, budget) ?? undefined : undefined,
    secondary: isPlainObject(equippedRaw.secondary)
      ? normalizeRow(equippedRaw.secondary, 2, budget) ?? undefined
      : undefined,
  });
  const t = asObject(inv.totals);
  const totals = compact({
    walked: num(t.walked),
    itemCount: num(t.itemCount),
    distinctTypes: num(t.distinctTypes),
    skipped: num(t.skipped),
    truncated: bool(t.truncated),
    truncatedReason: text(t.truncatedReason, 32),
    maxItems: num(t.maxItems),
    maxDepth: num(t.maxDepth),
    budgetMs: num(t.budgetMs),
  });
  if (budget.overflow) {
    totals.truncated = true;
    if (!totals.truncatedReason) totals.truncatedReason = "rowLimit";
  }
  return compact({ root: root ?? undefined, worn, equipped, attached, totals });
}

/**
 * Turn a raw getCharacterSheet result into the panel's CharacterSheet shape.
 * Only sections present in `raw` appear in the result, so a caller can tell
 * "not fetched" from "fetched and empty".
 */
export function normalizeSheet(raw) {
  const r = asObject(raw);
  const sheet = compact({
    schema: num(r.schema),
    generatedAt: num(r.generatedAt),
    username: name(r.username),
    displayName: name(r.displayName),
    forename: name(r.forename),
    surname: name(r.surname),
  });
  if (r.role !== undefined) {
    const role = normalizeRole(r.role);
    if (Object.keys(role).length > 0) sheet.role = role;
  }
  if (r.summary !== undefined) sheet.summary = normalizeSummary(r.summary);
  if (r.stats !== undefined) sheet.stats = normalizeStats(r.stats);
  if (r.health !== undefined) sheet.health = normalizeHealth(r.health);
  if (r.skills !== undefined) sheet.skills = normalizeSkills(r.skills);
  if (r.traits !== undefined) sheet.traits = normalizeTraits(r.traits);
  if (r.inventory !== undefined) sheet.inventory = normalizeInventory(r.inventory);
  if (r.cost !== undefined) {
    const cost = asObject(r.cost);
    sheet.cost = compact({ ms: num(cost.ms), walked: num(cost.walked) });
  }
  const errorsRaw = asObject(r.sectionErrors);
  const sectionErrors = {};
  for (const section of [...CHARACTER_SECTIONS, "health"]) {
    const reason = name(errorsRaw[section]);
    if (reason) sectionErrors[section] = reason;
  }
  if (Object.keys(sectionErrors).length > 0) sheet.sectionErrors = sectionErrors;
  return sheet;
}

// The pre-1.4.1 bridge only has getPlayerDetails: condition and position, no
// ranges, skills, traits or inventory.
export function sheetFromPlayerDetails(raw) {
  const d = asObject(raw);
  const statsRaw = asObject(d.stats);
  const healthRaw = asObject(d.health);
  return normalizeSheet({
    username: d.username,
    displayName: d.displayName,
    role: typeof d.accessLevel === "string" && d.accessLevel ? { name: d.accessLevel } : undefined,
    summary: {
      isAlive: d.isAlive,
      isAsleep: d.isAsleep,
      isSneaking: d.isSneaking,
      isRunning: d.isRunning,
      x: d.x,
      y: d.y,
      z: d.z,
    },
    stats: statsRaw,
    health: {
      overall: healthRaw.overallBodyHealth,
      isInfected: healthRaw.isInfected,
      isBleeding: healthRaw.isBleeding,
      temperature: healthRaw.temperature,
    },
  });
}

// ---------------------------------------------------------------------------
// Fetching.
// ---------------------------------------------------------------------------

const UNKNOWN_COMMAND_RE = /^Unknown command: getCharacterSheet/;
const PLAYER_NOT_FOUND_RE = /^Player not found:/;
const COMMAND_TIMEOUT_RE = /^Command timeout/;

function availabilityForError(message) {
  if (PLAYER_NOT_FOUND_RE.test(message)) return "playerOffline";
  if (COMMAND_TIMEOUT_RE.test(message)) return "timeout";
  // "Online player list unavailable", a stopped bridge, an unhealthy file
  // connection: none of them says anything about this player.
  return "bridgeOffline";
}

async function fetchPartialSheet(bridge, username) {
  try {
    const result = await bridge.getPlayerDetails(username);
    return { availability: "partial", sheet: sheetFromPlayerDetails(result?.data) };
  } catch (error) {
    const message = String(error?.message ?? "");
    log.debug(`getPlayerDetails fallback for a character sheet failed: ${message.slice(0, 200)}`);
    return { availability: availabilityForError(message), sheet: null };
  }
}

/**
 * @param {object} bridge the PanelBridge service (or a test double)
 * @param {string} username
 * @param {{ sections?: string[], fresh?: boolean, maxItems?: number }} [opts]
 * @returns {Promise<{ availability: 'live'|'partial'|'playerOffline'|'bridgeOffline'|'timeout', sheet: object|null }>}
 */
export async function fetchCharacterSheet(bridge, username, opts = {}) {
  if (!bridge || !bridge.isRunning || !bridge.isModConnected()) {
    return { availability: "bridgeOffline", sheet: null };
  }
  const sections = Array.isArray(opts.sections) && opts.sections.length > 0 ? opts.sections : DEFAULT_CHARACTER_SECTIONS;
  const args = { username, sections: [...sections] };
  if (opts.fresh) args.fresh = true;
  if (Number.isInteger(opts.maxItems)) args.maxItems = opts.maxItems;
  try {
    const result = await bridge.sendCommand("getCharacterSheet", args);
    return { availability: "live", sheet: normalizeSheet(result?.data) };
  } catch (error) {
    const message = String(error?.message ?? "");
    if (UNKNOWN_COMMAND_RE.test(message)) return fetchPartialSheet(bridge, username);
    const availability = availabilityForError(message);
    if (availability === "bridgeOffline") {
      log.debug(`getCharacterSheet failed: ${message.slice(0, 200)}`);
    }
    return { availability, sheet: null };
  }
}
