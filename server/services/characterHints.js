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
//   (Fitness/Strength), or jumpTotalLevels 6 across skills, all within
//   jumpWindowMinutes 60 of live data: faster than training normally goes.
// - unusualQuantity 500: units of one item type carried at once.
// - overCapacityFactor 2: carrying more than twice the weight limit. Always
//   mild: the main inventory holds 50 against a base limit of 8, so hauling
//   loot or a generator gets there in ordinary play (Heavy Load tops out at
//   1.75x on 42.21).
//
// Staff (role.adminPower) are expected to use powers and spawn things, so
// powersOnRegularAccount is suppressed for them and every other hint drops to
// mild. A role that can spawn items (role.canSpawnItems) drops the item hints
// to mild. Panel actions logged in player_logs (add_xp, add_item) explain the
// matching hint; items spawned through the World Map aren't logged, so they
// can't be explained here.

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
const HOUR_MS = 60 * MINUTE_MS;

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

function startLevel(perk) {
  return Math.min(isNumber(perk.boost) ? perk.boost : 0, 10);
}

function parseTime(value) {
  const ms = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : undefined;
}

// add_xp details are "<perk>=<amount>", add_item details "<item> x<count>"
// (routes/players.js).
function parsePanelLogs(playerLogs, fromMs, toMs) {
  const xp = [];
  const items = [];
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
    }
  }
  return { xp, items };
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
  for (const perk of perks) {
    const start = startLevel(perk);
    const above = Math.max(0, perk.level - Math.max(t.advancedLevelFloor, start));
    if (above <= 0) continue;
    const weight = isNumber(perk.multiplier) && perk.multiplier > 1 ? t.bookMultiplierWeight : 1;
    advanced += weight * above;
    contributions.push({ perk, start, above: weight * above });
  }
  const allowed = t.advancedLevelsPerHour * hours * scale + t.advancedLevelsGrace;
  if (!(advanced > allowed)) return null;
  contributions.sort((a, b) => b.above - a.above);
  return makeHint(
    "skillsAheadOfTime",
    advanced > 2 * allowed ? "strong" : "mild",
    { advanced: round1(advanced), allowed: round1(allowed), hours: round1(hours), xpScale: scale },
    contributions.slice(0, MAX_PERK_EVIDENCE).map(({ perk, start }) => ({
      kind: "perk",
      ref: perk.id,
      detail: { level: perk.level, start },
    })),
  );
}

function manyMaxedSkills(sheet, t) {
  const perks = (sheet.skills?.perks ?? []).filter((p) => p.passive === false && isNumber(p.level));
  if (perks.length === 0) return null;
  const maxed = perks.filter((p) => p.level >= 10 && startLevel(p) < 10);
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
    maxed.slice(0, MAX_PERK_EVIDENCE).map((p) => ({ kind: "perk", ref: p.id, detail: { level: p.level, start: startLevel(p) } })),
  );
}

function jumpVerdict(gains, t) {
  const single = gains.filter((g) =>
    g.passive === true
      ? g.gain >= t.jumpLevelsPassive
      : g.gain >= t.jumpLevelsOnePerk && g.toLevel >= t.jumpMinTargetLevel,
  );
  if (single.length > 0) return { weight: "strong", perks: single };
  const total = gains.reduce((sum, g) => sum + g.gain, 0);
  if (total >= t.jumpTotalLevels) return { weight: "mild", perks: gains };
  return null;
}

function skillJump(sheet, t, { skillDelta, logs, now, source }) {
  if (source !== "live" || !skillDelta || !Array.isArray(skillDelta.perks)) return null;
  const since = parseTime(skillDelta.since);
  if (since === undefined || now - since > t.jumpWindowMinutes * MINUTE_MS || since > now) return null;
  const passiveById = new Map((sheet.skills?.perks ?? []).map((p) => [p.id, p.passive]));
  const gains = [];
  for (const change of skillDelta.perks) {
    if (!isNumber(change?.fromLevel) || !isNumber(change?.toLevel)) continue;
    const gain = change.toLevel - change.fromLevel;
    if (gain <= 0) continue;
    gains.push({ id: change.id, gain, fromLevel: change.fromLevel, toLevel: change.toLevel, passive: passiveById.get(change.id) });
  }
  if (gains.length === 0) return null;
  const xpLogs = logs.xp.filter((log) => log.at >= since && log.at <= now);
  const explainedIds = new Set(xpLogs.map((log) => log.perk));
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
    explainedBy: xpLogs.filter((log) => perkIds.has(log.perk)).map(explanationOf),
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
 *   now?: number, source?: 'live'|'cached', lifeStartedAt?: number }} [opts]
 *   lifeStartedAt: optional earliest known start of this life (ms), widening
 *   the window panel "Give item" logs are matched in.
 * @returns {object[]} CharacterHint[], strong first, then mild, then explained
 */
export function computeCharacterHints(sheet, opts = {}) {
  if (!sheet || typeof sheet !== "object") return [];
  const t = { ...CHARACTER_HINT_THRESHOLDS, ...(opts.thresholds ?? {}) };
  const now = isNumber(opts.now) ? opts.now : 0;
  const source = opts.source === "cached" ? "cached" : "live";
  const staff = sheet.role?.adminPower === true;
  const canSpawnItems = sheet.role?.canSpawnItems === true;

  const hours = estimateRealHours(sheet.summary);
  let lifeStart = hours === undefined ? undefined : now - hours * HOUR_MS;
  if (isNumber(opts.lifeStartedAt)) {
    lifeStart = lifeStart === undefined ? opts.lifeStartedAt : Math.min(lifeStart, opts.lifeStartedAt);
  }
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
