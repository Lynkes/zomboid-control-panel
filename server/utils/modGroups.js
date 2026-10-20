// Mod groups: a named, ordered list of mod IDs. The list order IS the load
// order those mods must keep relative to each other in the server ini's
// `Mods=` line (e.g. a vehicle pack: library, core mods, add-ons, fixes).
//
// Everything here is pure (no I/O) so the route, the tests and a future
// scheduler can share it:
//   - applyModGroups()  makes a mod order satisfy every group,
//   - groupsInOrder()   reports, per group, whether the order already does,
//   - the clean*/validate* helpers hold the limits for stored and imported
//     groups.

export const MOD_GROUP_LIMITS = Object.freeze({
  maxGroups: 100,
  nameMax: 60,
  descriptionMax: 300,
  modIdsMax: 500,
  modIdMax: 200,
});

export const MOD_GROUP_DOCUMENT_KIND = "zcp-mod-group";
export const MOD_GROUP_DOCUMENT_SCHEMA = 1;

// How many times the whole list of groups is re-applied before giving up on
// groups that keep undoing each other.
const MAX_PASSES = 10;

// ───── Enforcement ─────────────────────────────────────────────────────────

function groupMembers(group) {
  // Unique string IDs in the group's own order.
  const seen = new Set();
  const members = [];
  for (const id of Array.isArray(group?.modIds) ? group.modIds : []) {
    if (typeof id !== "string" || seen.has(id)) continue;
    seen.add(id);
    members.push(id);
  }
  return members;
}

function firstPositions(order) {
  const positions = new Map();
  for (let i = 0; i < order.length; i++) {
    if (!positions.has(order[i])) positions.set(order[i], i);
  }
  return positions;
}

function isGroupInOrder(members, positions) {
  let previous = -1;
  for (const id of members) {
    const at = positions.get(id);
    if (at === undefined) continue;
    if (at < previous) return false;
    previous = at;
  }
  return true;
}

/**
 * Per group: is its order respected by `modIds`?
 * `present` counts the group's members that are in `modIds`, `missing` lists
 * those that are not (in the group's order). A group with fewer than two
 * present members cannot be out of order.
 */
export function groupsInOrder(modIds, groups) {
  const positions = firstPositions(Array.isArray(modIds) ? modIds : []);
  return (Array.isArray(groups) ? groups : []).map((group) => {
    const members = groupMembers(group);
    const missing = members.filter((id) => !positions.has(id));
    return {
      id: group?.id,
      inOrder: isGroupInOrder(members, positions),
      present: members.length - missing.length,
      total: members.length,
      missing,
    };
  });
}

/**
 * Makes `modIds` satisfy every group without disturbing anything else.
 *
 * For each group (in stored order) the members that are in the list take the
 * slots the members occupy right now, in the group's order: the slots stay
 * where they are, only which member sits in which slot changes. Mods that are
 * in no group never move, and the members of a group need not end up next to
 * each other. All groups are applied one after the other and the whole pass is
 * repeated until nothing changes (at most 10 passes), because a mod shared by
 * two groups can be shifted by the second after the first was satisfied.
 *
 * Groups that contradict each other (a shared pair of mods in opposite orders)
 * can never both hold; their ids come back in `conflicts` and `order` is the
 * result of the last pass.
 *
 * Returns { order, moved, conflicts }: `moved` are the mod IDs whose index
 * differs from the one in `modIds`, in their new order.
 */
export function applyModGroups(modIds, groups) {
  const input = Array.isArray(modIds) ? modIds : [];
  const list = Array.isArray(groups) ? groups : [];
  const order = [...input];

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let changed = false;
    for (const group of list) {
      const members = groupMembers(group);
      if (members.length < 2) continue;
      const positions = firstPositions(order);
      const present = members.filter((id) => positions.has(id));
      if (present.length < 2) continue;
      const slots = present.map((id) => positions.get(id)).sort((a, b) => a - b);
      for (let k = 0; k < present.length; k++) {
        if (order[slots[k]] !== present[k]) {
          order[slots[k]] = present[k];
          changed = true;
        }
      }
    }
    if (!changed) break;
  }

  const moved = [];
  const movedSeen = new Set();
  for (let i = 0; i < order.length; i++) {
    if (order[i] !== input[i] && !movedSeen.has(order[i])) {
      movedSeen.add(order[i]);
      moved.push(order[i]);
    }
  }

  const conflicts = groupsInOrder(order, list)
    .filter((status) => !status.inOrder)
    .map((status) => status.id);

  return { order, moved, conflicts };
}

// ───── Validation ──────────────────────────────────────────────────────────

function hasControlCharacters(text, { allowLineBreaks = false } = {}) {
  for (const char of text) {
    const code = char.codePointAt(0);
    if (allowLineBreaks && (code === 9 || code === 10 || code === 13)) continue;
    if (code < 32 || (code >= 127 && code <= 159)) return true;
  }
  return false;
}

/** A trimmed name of 1-60 characters without control characters, or null. */
export function cleanGroupName(value) {
  if (typeof value !== "string") return null;
  const name = value.trim();
  if (!name || name.length > MOD_GROUP_LIMITS.nameMax) return null;
  if (hasControlCharacters(name)) return null;
  return name;
}

/** A trimmed description of at most 300 characters (null/undefined -> ""), or null when invalid. */
export function cleanGroupDescription(value) {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") return null;
  const description = value.trim();
  if (description.length > MOD_GROUP_LIMITS.descriptionMax) return null;
  if (hasControlCharacters(description, { allowLineBreaks: true })) return null;
  return description;
}

/**
 * The mod IDs of a group: 1-500 strings of 1-200 characters, duplicates
 * dropped (first one wins), or null when invalid.
 *
 * Same character rules as the load-order save route (POST /save-order):
 * character-only, so a mod whose ID is all digits is fine, and an ID may not
 * carry the characters that would break the ini line (CR, LF, ";", "=").
 * Backslashes are removed because the game removes them from Mods= before it
 * reads the IDs, so a stored "\Mod" could never match anything.
 */
export function cleanGroupModIds(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MOD_GROUP_LIMITS.modIdsMax) {
    return null;
  }
  const ids = [];
  const seen = new Set();
  for (const raw of value) {
    if (typeof raw !== "string") return null;
    const id = raw.replace(/\\/g, "").trim();
    if (!id || id.length > MOD_GROUP_LIMITS.modIdMax) return null;
    if (/[\r\n;=]/.test(id) || hasControlCharacters(id)) return null;
    if (seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

/**
 * Validates the fields of a create (every field required, description
 * optional) or an update (`partial`: only the fields that are given).
 * Returns { ok: true, value } with the cleaned fields, or { ok: false, field }
 * naming the first field that is wrong.
 */
export function validateGroupFields(input, { partial = false } = {}) {
  const body = input && typeof input === "object" ? input : {};
  const value = {};

  if (!partial || body.name !== undefined) {
    const name = cleanGroupName(body.name);
    if (name === null) return { ok: false, field: "name" };
    value.name = name;
  }
  if (!partial || body.description !== undefined) {
    const description = cleanGroupDescription(body.description);
    if (description === null) return { ok: false, field: "description" };
    value.description = description;
  }
  if (!partial || body.modIds !== undefined) {
    const modIds = cleanGroupModIds(body.modIds);
    if (modIds === null) return { ok: false, field: "modIds" };
    value.modIds = modIds;
  }
  return { ok: true, value };
}

/**
 * Validates a shared group file: { schema: 1, kind: "zcp-mod-group", name,
 * description?, modIds }. Returns { ok: true, value: { name, description,
 * modIds } } or { ok: false }.
 */
export function validateGroupDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) return { ok: false };
  if (document.kind !== MOD_GROUP_DOCUMENT_KIND) return { ok: false };
  if (document.schema !== MOD_GROUP_DOCUMENT_SCHEMA) return { ok: false };
  const fields = validateGroupFields(document);
  return fields.ok ? { ok: true, value: fields.value } : { ok: false };
}

/**
 * `name` if no existing name matches it (ignoring case), otherwise
 * "name (2)", "name (3)", ... The result stays within the name limit, so a
 * long name is shortened before the suffix is added.
 */
export function uniqueGroupName(name, existingNames) {
  const taken = new Set((existingNames || []).map((n) => String(n).trim().toLowerCase()));
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const base = name.slice(0, MOD_GROUP_LIMITS.nameMax - suffix.length).trimEnd();
    const candidate = `${base}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}
