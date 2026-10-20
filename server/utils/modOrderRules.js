// Order rules: "load <before> before <after>", pinned by an admin (by hand,
// by resolving a conflict, or by a health fix). Stored panel-wide in the panel
// database like mod groups (database/init.js mod_order_rules) and read by the
// load-order planner as hard constraints right after require=. A rule naming
// a mod that is not enabled is kept and ignored.
//
// Pure: validation, the API shape, and the cycle check a new rule must pass
// against the stored rules plus the require= links the game enforces.

export const MOD_ORDER_RULE_LIMITS = Object.freeze({
  maxRules: 2000,
  noteMax: 300,
  modIdMax: 200,
});

export const MOD_ORDER_RULE_SOURCES = Object.freeze(["manual", "conflictResolve", "healthFix"]);

function hasControlCharacters(text) {
  for (const char of text) {
    const code = char.codePointAt(0);
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

/**
 * A mod id as Mods= holds it (the same rules as a mod group's ids): string,
 * backslashes removed (the game drops them), trimmed, 1-200 characters,
 * none of CR, LF, ";", "=" or another control character. null when invalid.
 */
export function cleanRuleModId(value) {
  if (typeof value !== "string") return null;
  const id = value.replace(/\\/g, "").trim();
  if (!id || id.length > MOD_ORDER_RULE_LIMITS.modIdMax) return null;
  if (/[\r\n;=]/.test(id) || hasControlCharacters(id)) return null;
  return id;
}

/**
 * Validates POST /order-rules: { before, after, note?, source? }. Returns
 * { ok: true, value: { before, after, note, source } } or { ok: false, field }
 * with field "before", "after", "self" (both the same mod), "note" or
 * "source".
 */
export function validateOrderRuleInput(input) {
  const body = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const before = cleanRuleModId(body.before);
  if (before === null) return { ok: false, field: "before" };
  const after = cleanRuleModId(body.after);
  if (after === null) return { ok: false, field: "after" };
  if (before === after) return { ok: false, field: "self" };
  let note = "";
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== "string") return { ok: false, field: "note" };
    note = body.note.trim();
    if (note.length > MOD_ORDER_RULE_LIMITS.noteMax || hasControlCharacters(note)) return { ok: false, field: "note" };
  }
  let source = "manual";
  if (body.source !== undefined) {
    if (!MOD_ORDER_RULE_SOURCES.includes(body.source)) return { ok: false, field: "source" };
    source = body.source;
  }
  return { ok: true, value: { before, after, note, source } };
}

/** A stored rule as the API answers it (every field present). */
export function normalizeOrderRule(rule) {
  return {
    id: String(rule?.id ?? ""),
    before: String(rule?.before ?? ""),
    after: String(rule?.after ?? ""),
    note: typeof rule?.note === "string" ? rule.note : "",
    source: MOD_ORDER_RULE_SOURCES.includes(rule?.source) ? rule.source : "manual",
    createdBy: typeof rule?.createdBy === "string" ? rule.createdBy : null,
    createdAt: typeof rule?.createdAt === "string" ? rule.createdAt : null,
  };
}

/** Stored rules that are usable (both ids valid and different). */
export function usableOrderRules(rules) {
  const out = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    const before = cleanRuleModId(rule?.before);
    const after = cleanRuleModId(rule?.after);
    if (before === null || after === null || before === after) continue;
    out.push({ ...normalizeOrderRule(rule), before, after });
  }
  return out;
}

/**
 * Would `candidate` ({ before, after }) close a loop with the stored rules and
 * the require= links (`requireEdges`: [{ before: dependency, after: mod }])?
 * Rules whose id is in `ignoreRuleIds` are left out (one being replaced).
 * Returns null, or { cycle, edges }: `cycle` the mod ids around the loop,
 * starting and ending with candidate.before, `edges` each step with its
 * reason ("rule" with ruleId, "require", or "new" for the candidate).
 */
export function findOrderRuleCycle({ rules = [], requireEdges = [], candidate, ignoreRuleIds = [] }) {
  if (!candidate || candidate.before === candidate.after) return null;
  const ignored = new Set(ignoreRuleIds);
  const out = new Map();
  const link = (before, after, edge) => {
    if (!before || !after || before === after) return;
    if (!out.has(before)) out.set(before, []);
    out.get(before).push({ to: after, edge });
  };
  for (const rule of usableOrderRules(rules)) {
    if (ignored.has(rule.id)) continue;
    link(rule.before, rule.after, { before: rule.before, after: rule.after, reason: "rule", ruleId: rule.id });
  }
  for (const edge of Array.isArray(requireEdges) ? requireEdges : []) {
    if (typeof edge?.before !== "string" || typeof edge?.after !== "string") continue;
    link(edge.before, edge.after, { before: edge.before, after: edge.after, reason: "require" });
  }
  // A path after -> ... -> before closes the loop.
  const parent = new Map([[candidate.after, null]]);
  const queue = [candidate.after];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === candidate.before) break;
    for (const { to, edge } of out.get(node) || []) {
      if (parent.has(to)) continue;
      parent.set(to, edge);
      queue.push(to);
    }
  }
  if (!parent.has(candidate.before)) return null;
  const steps = [];
  for (let node = candidate.before; node !== candidate.after; ) {
    const edge = parent.get(node);
    steps.unshift(edge);
    node = edge.before;
  }
  const edges = [{ before: candidate.before, after: candidate.after, reason: "new" }, ...steps];
  const cycle = [candidate.before, ...edges.map((edge) => edge.after)];
  return { cycle, edges };
}
