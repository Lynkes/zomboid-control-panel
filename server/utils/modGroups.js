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

// The colours a group can be tagged with (the client's palette names), or null.
export const MOD_GROUP_COLORS = Object.freeze([
  "slate",
  "red",
  "orange",
  "amber",
  "lime",
  "green",
  "teal",
  "sky",
  "blue",
  "violet",
  "pink",
]);

// Where the load-order planner puts a group (utils/modSmartSort.js): "first"
// as early as its constraints allow, "last" as late; null, the default,
// wherever its mods are.
export const MOD_GROUP_PLACEMENTS = Object.freeze(["first", "last"]);

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

function keepsTogether(group) {
  return group?.keepTogether === true;
}

// In order: the present members appear in the group's order. A group kept
// together must also fill one contiguous run of the list (nothing else, not
// even a repeated entry, between its first and its last member).
function isGroupInOrder(members, positions, together = false) {
  let previous = -1;
  let first = Infinity;
  let present = 0;
  for (const id of members) {
    const at = positions.get(id);
    if (at === undefined) continue;
    if (at < previous) return false;
    previous = at;
    first = Math.min(first, at);
    present++;
  }
  if (together && present > 1 && previous - first + 1 !== present) return false;
  return true;
}

/**
 * Per group: is its order respected by `modIds`?
 * `present` counts the group's members that are in `modIds`, `missing` lists
 * those that are not (in the group's order). A group with fewer than two
 * present members cannot be out of order. A group with `keepTogether` is in
 * order only when its present members also sit next to each other.
 */
export function groupsInOrder(modIds, groups) {
  const positions = firstPositions(Array.isArray(modIds) ? modIds : []);
  return (Array.isArray(groups) ? groups : []).map((group) => {
    const members = groupMembers(group);
    const missing = members.filter((id) => !positions.has(id));
    return {
      id: group?.id,
      inOrder: isGroupInOrder(members, positions, keepsTogether(group)),
      present: members.length - missing.length,
      total: members.length,
      missing,
    };
  });
}

// Today's rule: the present members trade the slots they hold, nothing else
// moves. Returns whether `order` changed.
function permuteMemberSlots(order, members) {
  const positions = firstPositions(order);
  const present = members.filter((id) => positions.has(id));
  if (present.length < 2) return false;
  const slots = present.map((id) => positions.get(id)).sort((a, b) => a - b);
  let changed = false;
  for (let k = 0; k < present.length; k++) {
    if (order[slots[k]] !== present[k]) {
      order[slots[k]] = present[k];
      changed = true;
    }
  }
  return changed;
}

// keepTogether: the present members form one block, in the group's order, at
// the slot of the member that comes first in `order` right now. The entries
// that were between the first and the last member (other mods, and a repeated
// entry of a member) move right after the block, in their relative order.
// Nothing before the first or after the last member moves. Returns whether
// `order` changed.
function gatherMembers(order, members) {
  const positions = firstPositions(order);
  const present = members.filter((id) => positions.has(id));
  if (present.length < 2) return false;
  const memberSlots = new Set(present.map((id) => positions.get(id)));
  const start = Math.min(...memberSlots);
  const end = Math.max(...memberSlots);
  const others = [];
  for (let i = start; i <= end; i++) {
    if (!memberSlots.has(i)) others.push(order[i]);
  }
  const segment = [...present, ...others];
  let changed = false;
  for (let k = 0; k < segment.length; k++) {
    if (order[start + k] !== segment[k]) {
      order[start + k] = segment[k];
      changed = true;
    }
  }
  return changed;
}

/**
 * Makes `modIds` satisfy every group, disturbing as little else as it can.
 *
 * For each group (in stored order) the members that are in the list take the
 * slots the members occupy right now, in the group's order: the slots stay
 * where they are, only which member sits in which slot changes. Unless a group
 * is kept together (below), mods that are in no group never move, and the
 * members of a group need not end up next to each other. All groups are
 * applied one after the other and the whole pass is
 * repeated until nothing changes (at most 10 passes), because a mod shared by
 * two groups can be shifted by the second after the first was satisfied.
 *
 * A group with `keepTogether` also gets its members into one contiguous block:
 * the block starts at the slot of the member that comes first in the list,
 * and the other mods that were between its members move right after the
 * block, keeping their relative order.
 *
 * Groups that contradict each other (a shared pair of mods in opposite orders,
 * or two groups kept together that cannot both be one block) can never both
 * hold; their ids come back in `conflicts` and `order` is the result of the
 * last pass.
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
      const moved = keepsTogether(group) ? gatherMembers(order, members) : permuteMemberSlots(order, members);
      if (moved) changed = true;
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

/** One of MOD_GROUP_COLORS, or null for "no colour". */
export function isGroupColor(value) {
  return value === null || (typeof value === "string" && MOD_GROUP_COLORS.includes(value));
}

/** "first", "last", or null for "wherever its mods are". */
export function isGroupPlacement(value) {
  return value === null || (typeof value === "string" && MOD_GROUP_PLACEMENTS.includes(value));
}

/**
 * Validates the fields of a create (every field required, description
 * optional) or an update (`partial`: only the fields that are given).
 * `color` (one of MOD_GROUP_COLORS or null), `keepTogether` (a boolean) and
 * `placement` ("first", "last" or null) are optional in both and only come
 * back when given; a stored group without them reads as color null,
 * keepTogether false, placement null (normalizeGroup).
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
  if (body.color !== undefined) {
    if (!isGroupColor(body.color)) return { ok: false, field: "color" };
    value.color = body.color;
  }
  if (body.keepTogether !== undefined) {
    if (typeof body.keepTogether !== "boolean") return { ok: false, field: "keepTogether" };
    value.keepTogether = body.keepTogether;
  }
  if (body.placement !== undefined) {
    if (!isGroupPlacement(body.placement)) return { ok: false, field: "placement" };
    value.placement = body.placement;
  }
  return { ok: true, value };
}

/**
 * Validates a shared group file: { schema: 1, kind: "zcp-mod-group", name,
 * description?, modIds, color?, keepTogether?, placement? }. Returns { ok:
 * true, value: { name, description, modIds, color?, keepTogether?,
 * placement? } } or { ok: false }.
 *
 * The options are taken when they are valid and otherwise left
 * out (the group gets the defaults): a file from another panel version with a
 * colour this one does not know still imports.
 */
export function validateGroupDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) return { ok: false };
  if (document.kind !== MOD_GROUP_DOCUMENT_KIND) return { ok: false };
  if (document.schema !== MOD_GROUP_DOCUMENT_SCHEMA) return { ok: false };
  const fields = validateGroupFields({
    name: document.name,
    description: document.description,
    modIds: document.modIds,
    ...(isGroupColor(document.color) ? { color: document.color } : {}),
    ...(typeof document.keepTogether === "boolean" ? { keepTogether: document.keepTogether } : {}),
    ...(isGroupPlacement(document.placement) ? { placement: document.placement } : {}),
  });
  return fields.ok ? { ok: true, value: fields.value } : { ok: false };
}

/**
 * A stored group as the API answers it: every field of the contract, with
 * color null, keepTogether false and placement null for a group saved before
 * they existed (or holding a value this version does not know).
 */
export function normalizeGroup(group) {
  return {
    ...group,
    color: isGroupColor(group?.color) ? group.color : null,
    keepTogether: group?.keepTogether === true,
    placement: isGroupPlacement(group?.placement) ? group.placement : null,
  };
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
