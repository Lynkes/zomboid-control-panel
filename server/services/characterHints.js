// "Worth a look" hints for the Players page's Character tab. Pure: no I/O, no
// clock (the caller passes `now`), no bridge. Each hint is a nudge with the
// numbers behind it, never a verdict, and the copy for every id lives in the
// client's players.json (character.hints.items.<id>).
//
// Thresholds, and why they sit where they do:
// - advancedLevelFloor 3: levels up to 3 in any skill come from ordinary play
//   in the first hours, so they never count toward "ahead of time".
// - advancedLevelsPerHour 3 / advancedLevelsGrace 6: a busy player gains a few
//   levels per real hour across all skills; 3 per hour of this life, times the
//   server's XP multiplier, plus 6 levels of slack, is generous on purpose.
//   Past twice that allowance the hint is strong.
// - bookMultiplierWeight 0.5: levels earned under a skill-book multiplier
//   count half, since books legitimately speed a skill up several times.
// - maxedSkillsCount 3 within maxedSkillsWithinHours 40 (XP-scaled real
//   hours): three skills at 10 that the character didn't start at 10 is rare
//   that early. maxedSkillsStrongCount 6 makes it strong, and so does having
//   maxedSkillsShareAlways (80%) of all non-passive skills at 10, whenever.
// - jumpLevelsOnePerk 3 ending at jumpMinTargetLevel 6+, jumpLevelsPassive 2
//   (Fitness/Strength), or jumpTotalLevels 6 across skills (levels above
//   advancedLevelFloor only), all within jumpWindowMinutes 60 of live data:
//   faster than training normally goes at 1x.
// - jumpRawXpFloor 3000: a server XP multiplier or an active skill book hands
//   out those levels faster (XP.AddXP multiplies every gain by both). Under
//   one, a one-skill jump stands out only when its XP divided by them is
//   still this much: about what the cheapest one-skill jump costs at 1x (3 to
//   6 is 500 + 1000 + 2000 XP on 42.21). Levels toward the total count
//   divided by the multipliers.
// - unusualQuantity 500: units of one item type carried at once.
// - overCapacityFactor 2: carrying more than twice the weight limit. Always
//   mild: the main inventory holds 50 against a base limit of 8, so hauling
//   loot or a generator gets there in ordinary play (Heavy Load tops out at
//   1.75x on 42.21).
//
// Staff (role.adminPower) are expected to use powers and spawn things, so
// powersOnRegularAccount is suppressed for them and every other hint drops to
// mild. A role that can spawn items (role.canSpawnItems) drops the item hints
// to mild. Panel actions logged in player_logs explain the matching hint:
// add_xp a skill's jump, add_item up to the quantity it gave, and import (the
// Players page's Import character, a restore) the skill and item hints of
// this life. Items spawned through the World Map aren't logged, so they can't
// be explained here. The game's user.txt deaths are in player_logs too
// (action "death"): a life began after the newest one.

export const CHARACTER_HINT_THRESHOLDS = Object.freeze({
  advancedLevelFloor: 3,
  advancedLevelsPerHour: 3,
  advancedLevelsGrace: 6,
  bookMultiplierWeight: 0.5,
  maxedSkillsCount: 3,
  maxedSkillsStrongCount: 6,
  maxedSkillsWithinHours: 40,
  maxedSkillsShareAlways: 0.8,
  jumpLevelsOnePerk: 3,
  jumpMinTargetLevel: 6,
  jumpLevelsPassive: 2,
  jumpTotalLevels: 6,
  jumpWindowMinutes: 60,
  jumpRawXpFloor: 3000,
  unusualQuantity: 500,
  overCapacityFactor: 2,
});

// Debug/test items that exist in the vanilla scripts for developers. None of
// them drops in normal play.
export const DEBUG_ITEM_TYPES = Object.freeze([
  "Base.YardstickDEBUG",
  "Base.BucketWaterDebug",
  "Base.DebugFluid",
  "Base.Hat_SantaHatDebug",
  "Base.TestDebugWater",
  "Base.TestHotDrink",
  "Base.TestMug",
  "Base.TestWaterMug",
]);

// Rule order, which is also the tie-break order within a weight group.
export const CHARACTER_HINT_IDS = Object.freeze([
  "powersOnRegularAccount",
  "debugItems",
  "skillJump",
  "skillsAheadOfTime",
  "manyMaxedSkills",
  "overCapacity",
  "unusualQuantity",
  "hiddenItems",
  "obsoleteItems",
]);

const ITEM_HINTS_SOFTENED_BY_SPAWN_ROLE = new Set(["debugItems", "hiddenItems", "unusualQuantity"]);
// What a restore (Import character) can account for: the skills and items it
// brought back. skillJump checks its own window.
const HINTS_EXPLAINED_BY_IMPORT = new Set([
  "debugItems",
  "skillsAheadOfTime",
  "manyMaxedSkills",
  "unusualQuantity",
  "hiddenItems",
  "obsoleteItems",
]);
const POWER_FLAGS = Object.freeze([
  "godMode",
  "invisible",
  "noClip",
  "ghostMode",
  "unlimitedCarry",
  "unlimitedEndurance",
  "knowAllRecipes",
  "invincible",
]);
const MAX_PERK_EVIDENCE = 8;
const MINUTE_MS = 60 * 1000;

function round1(value) {
  return Math.round(value * 10) / 10;
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** Real hours this life has lasted, estimated from in-game time. */
export function estimateRealHours(summary) {
  if (!summary || !isNumber(summary.hoursSurvived)) return undefined;
  const minutesPerDay = isNumber(summary.minutesPerDay) && summary.minutesPerDay > 0 ? summary.minutesPerDay : 60;
  return (summary.hoursSurvived * minutesPerDay) / 1440;
}

/** The server's XP multiplier, never below 1. */
export function xpScaleOf(sheet) {
  const sandbox = sheet?.summary?.xpSandbox;
  if (sandbox?.globalToggle === true && isNumber(sandbox.global)) return Math.max(1, sandbox.global);
  let highest;
  for (const perk of sheet?.skills?.perks ?? []) {
    if (isNumber(perk.sandboxMultiplier) && (highest === undefined || perk.sandboxMultiplier > highest)) {
      highest = perk.sandboxMultiplier;
    }
  }
  return Math.max(1, highest ?? 1);
}

// The server's XP multiplier for one skill (the global one while it's on,
// else the skill's own option) times an active skill book's: what XP.AddXP
// multiplies that skill's gains by. Never below 1.
function perkXpFactor(sheet, perk) {
  const sandbox = sheet?.summary?.xpSandbox;
  let scale = 1;
  if (sandbox?.globalToggle === true && isNumber(sandbox.global)) scale = sandbox.global;
  else if (isNumber(perk?.sandboxMultiplier)) scale = perk.sandboxMultiplier;
  const book = isNumber(perk?.multiplier) && perk.multiplier > 1 ? perk.multiplier : 1;
  return Math.max(1, scale) * book;
}

function parseTime(value) {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * One player's rows out of player_logs (newest first), matching the name
 * without case: the game's own commands find a player that way, so a Give
 * item sent to "bob" was Bob's.
 */
export function playerLogsFor(allLogs, username, limit) {
  const lower = typeof username === "string" ? username.toLowerCase() : "";
  const out = [];
  for (const entry of Array.isArray(allLogs) ? allLogs : []) {
    if (typeof entry?.player_name === "string" && entry.player_name.toLowerCase() === lower) {
      out.push(entry);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** When the game last logged this player's death (user.txt), in ms, or undefined. */
export function latestDeathAt(playerLogs, now) {
  let latest;
  for (const entry of Array.isArray(playerLogs) ? playerLogs : []) {
    if (entry?.action !== "death") continue;
    const at = parseTime(entry.logged_at);
    if (at === undefined || (isNumber(now) && at > now)) continue;
    if (latest === undefined || at > latest) latest = at;
  }
  return latest;
}

// add_xp details are "<perk>=<amount>", add_item details "<item> x<count>"
// (routes/players.js); an import row's details are a summary of what it
// restored (routes/panelBridge.js).
function parsePanelLogs(playerLogs, fromMs, toMs) {
  const xp = [];
  const items = [];
  const imports = [];
  for (const entry of Array.isArray(playerLogs) ? playerLogs : []) {
    if (!entry || typeof entry.details !== "string") continue;
    const at = parseTime(entry.logged_at);
    if (at === undefined) continue;
    if (fromMs !== undefined && at < fromMs) continue;
    if (toMs !== undefined && at > toMs) continue;
    if (entry.action === "add_xp") {
      const match = entry.details.match(/^([A-Za-z0-9_]+)=/);
      if (match) xp.push({ perk: match[1], at, entry });
    } else if (entry.action === "add_item") {
      const match = entry.details.match(/^(\S+) x(\d+)$/);
      if (match) items.push({ fullType: match[1], count: Number(match[2]), at, entry });
    } else if (entry.action === "import") {
      imports.push({ at, entry });
    }
  }
  return { xp, items, imports };
}

function explanationOf(log) {
  return { action: log.entry.action, at: new Date(log.at).toISOString(), details: log.entry.details };
}

function flattenRows(row, out) {
  if (!row || typeof row !== "object") return out;
  if (row.kind === "container") {
    out.push(row);
    for (const child of Array.isArray(row.rows) ? row.rows : []) flattenRows(child, out);
  } else {
    out.push(row);
  }
  return out;
}

function makeHint(id, weight, params, evidence, extra = {}) {
  return { id, weight, params, evidence, ...extra };
}

// ---------------------------------------------------------------------------
// Skill rules
// ---------------------------------------------------------------------------

function skillsAheadOfTime(sheet, t) {
  const perks = (sheet.skills?.perks ?? []).filter((p) => p.passive === false && isNumber(p.level));
  const hours = estimateRealHours(sheet.summary);
  if (perks.length === 0 || hours === undefined) return null;
  const scale = xpScaleOf(sheet);
  const contributions = [];
  let advanced = 0;
  // The bridge's perk.boost is the 0-3 XP-rate tier (XPBoostMap stores
  // min(3, starting level)), not where the skill started, so it can't lift
  // the floor.
  for (const perk of perks) {
    const above = Math.max(0, perk.level - t.advancedLevelFloor);
    if (above <= 0) continue;
    const weight = isNumber(perk.multiplier) && perk.multiplier > 1 ? t.bookMultiplierWeight : 1;
    advanced += weight * above;
    contributions.push({ perk, above: weight * above });
  }
  const allowed = t.advancedLevelsPerHour * hours * scale + t.advancedLevelsGrace;
  if (!(advanced > allowed)) return null;
  contributions.sort((a, b) => b.above - a.above);
  return makeHint(
    "skillsAheadOfTime",
    advanced > 2 * allowed ? "strong" : "mild",
    { advanced: round1(advanced), allowed: round1(allowed), hours: round1(hours), xpScale: scale },
    contributions.slice(0, MAX_PERK_EVIDENCE).map(({ perk }) => ({
      kind: "perk",
      ref: perk.id,
      detail: { level: perk.level },
    })),
  );
}

function manyMaxedSkills(sheet, t) {
  const perks = (sheet.skills?.perks ?? []).filter((p) => p.passive === false && isNumber(p.level));
  if (perks.length === 0) return null;
  const maxed = perks.filter((p) => p.level >= 10);
  const hours = estimateRealHours(sheet.summary);
  const scaledHours = hours === undefined ? undefined : hours * xpScaleOf(sheet);
  const early = maxed.length >= t.maxedSkillsCount && scaledHours !== undefined && scaledHours < t.maxedSkillsWithinHours;
  const shareNeeded = Math.max(1, Math.ceil(t.maxedSkillsShareAlways * perks.length));
  const mostOfThem = maxed.length >= shareNeeded;
  if (!early && !mostOfThem) return null;
  return makeHint(
    "manyMaxedSkills",
    mostOfThem || maxed.length >= t.maxedSkillsStrongCount ? "strong" : "mild",
    {
      maxed: maxed.length,
      nonPassive: perks.length,
      hours: hours === undefined ? undefined : round1(hours),
    },
    maxed.slice(0, MAX_PERK_EVIDENCE).map((p) => ({ kind: "perk", ref: p.id, detail: { level: p.level } })),
  );
}

// Levels of a gain that count toward the total: those above the floor,
// divided by the XP multipliers behind them.
function countedLevels(g, t) {
  return Math.max(0, g.toLevel - Math.max(g.fromLevel, t.advancedLevelFloor)) / g.factor;
}

function jumpVerdict(gains, t) {
  const single = gains.filter((g) => {
    const levels =
      g.passive === true
        ? g.gain >= t.jumpLevelsPassive
        : g.gain >= t.jumpLevelsOnePerk && g.toLevel >= t.jumpMinTargetLevel;
    if (!levels) return false;
    if (g.factor <= 1) return true;
    // Boosted: only when the XP behind it, taken back to 1x, would still
    // stand out. Without the XP there's no telling it from the boost.
    return isNumber(g.xp) && g.xp / g.factor >= t.jumpRawXpFloor;
  });
  if (single.length > 0) return { weight: "strong", perks: single };
  const counted = gains.filter((g) => countedLevels(g, t) > 0);
  const total = counted.reduce((sum, g) => sum + countedLevels(g, t), 0);
  if (total >= t.jumpTotalLevels) return { weight: "mild", perks: counted };
  return null;
}

function skillJump(sheet, t, { skillDelta, logs, now, source }) {
  if (source !== "live" || !skillDelta || !Array.isArray(skillDelta.perks)) return null;
  const since = parseTime(skillDelta.since);
  if (since === undefined || now - since > t.jumpWindowMinutes * MINUTE_MS || since > now) return null;
  const perkById = new Map((sheet.skills?.perks ?? []).map((p) => [p.id, p]));
  const gains = [];
  for (const change of skillDelta.perks) {
    if (!isNumber(change?.fromLevel) || !isNumber(change?.toLevel)) continue;
    const gain = change.toLevel - change.fromLevel;
    if (gain <= 0) continue;
    const perk = perkById.get(change.id);
    gains.push({
      id: change.id,
      gain,
      fromLevel: change.fromLevel,
      toLevel: change.toLevel,
      passive: perk?.passive,
      factor: perkXpFactor(sheet, perk),
      xp: isNumber(change.fromXp) && isNumber(change.toXp) ? change.toXp - change.fromXp : undefined,
    });
  }
  if (gains.length === 0) return null;
  const xpLogs = logs.xp.filter((log) => log.at >= since && log.at <= now);
  // A restore inside the window can account for every skill it set.
  const importLogs = logs.imports.filter((log) => log.at >= since && log.at <= now);
  const explainedIds = new Set(xpLogs.map((log) => log.perk));
  if (importLogs.length > 0) for (const g of gains) explainedIds.add(g.id);
  const params = {
    since: skillDelta.since,
    minutes: Math.max(0, Math.round((now - since) / MINUTE_MS)),
    total: gains.reduce((sum, g) => sum + g.gain, 0),
    source: skillDelta.source,
  };
  const toEvidence = (list) =>
    list.map((g) => ({ kind: "perk", ref: g.id, detail: { from: g.fromLevel, to: g.toLevel } }));
  const unexplained = jumpVerdict(gains.filter((g) => !explainedIds.has(g.id)), t);
  if (unexplained) return makeHint("skillJump", unexplained.weight, params, toEvidence(unexplained.perks));
  const any = jumpVerdict(gains, t);
  if (!any) return null;
  const perkIds = new Set(any.perks.map((g) => g.id));
  return makeHint("skillJump", any.weight, params, toEvidence(any.perks), {
    explainedBy: [...xpLogs.filter((log) => perkIds.has(log.perk)), ...importLogs].map(explanationOf),
  });
}

// ---------------------------------------------------------------------------
// Item rules
// ---------------------------------------------------------------------------

function tallyItems(sheet) {
  const root = sheet.inventory?.root;
  if (!root) return null;
  const byType = new Map();
  for (const row of flattenRows(root, [])) {
    if (!row.fullType || row.id === "main") continue;
    const qty = row.kind === "stack" && isNumber(row.qty) ? row.qty : 1;
    let entry = byType.get(row.fullType);
    if (!entry) {
      entry = { fullType: row.fullType, name: row.name, qty: 0, hiddenQty: 0, obsoleteQty: 0 };
      byType.set(row.fullType, entry);
    }
    entry.qty += qty;
    if (row.hidden === true && row.worn !== true) entry.hiddenQty += qty;
    if (row.obsolete === true) entry.obsoleteQty += qty;
  }
  return byType;
}

function givenByType(itemLogs) {
  const given = new Map();
  for (const log of itemLogs) {
    const entry = given.get(log.fullType) ?? { qty: 0, lastAt: 0, logs: [] };
    entry.qty += log.count;
    entry.lastAt = Math.max(entry.lastAt, log.at);
    entry.logs.push(log);
    given.set(log.fullType, entry);
  }
  return given;
}

// Shared by debugItems / hiddenItems / obsoleteItems: `pick` returns how many
// units of a type count toward the rule. A panel "Give item" covers at most
// the quantity it gave.
function itemRule(hintId, weight, tally, given, pick) {
  const flagged = [];
  const explained = [];
  for (const entry of tally.values()) {
    const qty = pick(entry);
    if (!(qty > 0)) continue;
    const g = given.get(entry.fullType);
    const givenQty = g ? Math.min(g.qty, qty) : 0;
    const detail = { qty, name: entry.name };
    if (g) {
      detail.given = givenQty;
      detail.givenAt = new Date(g.lastAt).toISOString();
    }
    const item = { kind: "item", ref: entry.fullType, detail };
    if (qty - givenQty > 0) flagged.push(item);
    else explained.push({ item, logs: g.logs });
  }
  const params = { types: flagged.length || explained.length };
  if (flagged.length > 0) {
    params.units = flagged.reduce((sum, e) => sum + e.detail.qty, 0);
    return makeHint(hintId, weight, params, flagged);
  }
  if (explained.length > 0) {
    params.units = explained.reduce((sum, e) => sum + e.item.detail.qty, 0);
    return makeHint(
      hintId,
      weight,
      params,
      explained.map((e) => e.item),
      { explainedBy: explained.flatMap((e) => e.logs.map(explanationOf)) },
    );
  }
  return null;
}

function unusualQuantity(tally, given, t) {
  const flagged = [];
  const explained = [];
  for (const entry of tally.values()) {
    if (entry.qty < t.unusualQuantity) continue;
    const g = given.get(entry.fullType);
    const givenQty = g ? Math.min(g.qty, entry.qty) : 0;
    const detail = { qty: entry.qty, name: entry.name };
    if (g) {
      detail.given = givenQty;
      detail.givenAt = new Date(g.lastAt).toISOString();
    }
    const item = { kind: "item", ref: entry.fullType, detail };
    if (entry.qty - givenQty >= t.unusualQuantity) flagged.push(item);
    else explained.push({ item, logs: g.logs });
  }
  if (flagged.length > 0) {
    return makeHint("unusualQuantity", "mild", { threshold: t.unusualQuantity, types: flagged.length }, flagged);
  }
  if (explained.length > 0) {
    return makeHint(
      "unusualQuantity",
      "mild",
      { threshold: t.unusualQuantity, types: explained.length },
      explained.map((e) => e.item),
      { explainedBy: explained.flatMap((e) => e.logs.map(explanationOf)) },
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Other rules
// ---------------------------------------------------------------------------

function overCapacity(sheet, t) {
  const s = sheet.summary;
  if (!s || !isNumber(s.maxWeight) || !isNumber(s.carriedWeight) || !(s.maxWeight > 0)) return null;
  if (!(s.carriedWeight > t.overCapacityFactor * s.maxWeight)) return null;
  return makeHint(
    "overCapacity",
    "mild",
    { carried: round1(s.carriedWeight), max: round1(s.maxWeight), factor: t.overCapacityFactor },
    [],
  );
}

function powersOnRegularAccount(sheet, staff) {
  if (staff) return null;
  const flags = sheet.summary?.flags;
  if (!flags) return null;
  const on = POWER_FLAGS.filter((flag) => flags[flag] === true);
  if (on.length === 0) return null;
  return makeHint(
    "powersOnRegularAccount",
    "strong",
    { count: on.length },
    on.map((flag) => ({ kind: "flag", ref: flag })),
  );
}

function rank(hint) {
  if (hint.explainedBy) return 2;
  return hint.weight === "strong" ? 0 : 1;
}

/**
 * @param {object|null} sheet a normalized CharacterSheet (characterSheet.js)
 * @param {{ thresholds?: object, skillDelta?: object|null, playerLogs?: object[],
 *   now?: number, source?: 'live'|'cached', lifeStartedAfter?: number }} [opts]
 *   lifeStartedAfter: this life began after this time (ms): panel actions
 *   before it were for an earlier life. Unknown, every log counts: play time
 *   says nothing about when a life began (a character played an hour a day
 *   for a month has 30 hours).
 * @returns {object[]} CharacterHint[], strong first, then mild, then explained
 */
export function computeCharacterHints(sheet, opts = {}) {
  if (!sheet || typeof sheet !== "object") return [];
  const t = { ...CHARACTER_HINT_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const now = isNumber(opts.now) ? opts.now : 0;
  const source = opts.source === "cached" ? "cached" : "live";
  const staff = sheet.role?.adminPower === true;
  const canSpawnItems = sheet.role?.canSpawnItems === true;

  const lifeStart = isNumber(opts.lifeStartedAfter) ? opts.lifeStartedAfter : undefined;
  const logs = parsePanelLogs(opts.playerLogs, lifeStart, undefined);

  const hints = [];
  const push = (hint) => {
    if (hint) hints.push(hint);
  };
  push(powersOnRegularAccount(sheet, staff));
  const tally = tallyItems(sheet);
  const given = givenByType(logs.items);
  const debugTypes = new Set(DEBUG_ITEM_TYPES);
  if (tally) {
    push(itemRule("debugItems", "strong", tally, given, (e) => (debugTypes.has(e.fullType) ? e.qty : 0)));
  }
  push(skillJump(sheet, t, { skillDelta: opts.skillDelta, logs, now, source }));
  push(skillsAheadOfTime(sheet, t));
  push(manyMaxedSkills(sheet, t));
  push(overCapacity(sheet, t));
  if (tally) {
    push(unusualQuantity(tally, given, t));
    push(itemRule("hiddenItems", "mild", tally, given, (e) => (debugTypes.has(e.fullType) ? 0 : e.hiddenQty)));
    push(itemRule("obsoleteItems", "mild", tally, given, (e) => (debugTypes.has(e.fullType) ? 0 : e.obsoleteQty)));
  }

  for (const hint of hints) {
    if (logs.imports.length > 0 && !hint.explainedBy && HINTS_EXPLAINED_BY_IMPORT.has(hint.id)) {
      hint.explainedBy = logs.imports.map(explanationOf);
    }
    if (canSpawnItems && ITEM_HINTS_SOFTENED_BY_SPAWN_ROLE.has(hint.id)) {
      hint.weight = "mild";
      hint.params.canSpawnItems = true;
    }
    if (staff) hint.weight = "mild";
    hint.staff = staff;
    hint.source = source;
  }
  const order = new Map(CHARACTER_HINT_IDS.map((hintId, index) => [hintId, index]));
  return hints.sort((a, b) => rank(a) - rank(b) || order.get(a.id) - order.get(b.id));
}
