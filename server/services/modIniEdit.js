import { splitIniList, splitModIdTokens } from "../utils/modIni.js";
import { sanitizeIniList, sanitizeIniValue } from "../utils/sanitize.js";
import { isWritableMapFolderName, sanitizeModIdListWithDiskBypass } from "./workshopModInfo.js";

// Pure edits of a server .ini's text for "add this workshop item": no file
// access, no locking, no backup -- the caller owns those. POST /add-to-ini,
// POST /add-mod-advanced and the bulk POST /add-to-ini-bulk all go through
// addWorkshopItemToIni(), so adding one item and adding sixty differ only in
// how many times the file is written.

// Each key has one pattern to read it (value captured) and one to replace the
// whole line; both tolerate whitespace around "=" like every other reader.
const WORKSHOP_ITEMS_RE = /^[ \t]*WorkshopItems[ \t]*=[ \t]*(.*)$/m;
const WORKSHOP_ITEMS_LINE_RE = /^[ \t]*WorkshopItems[ \t]*=.*/m;
const MODS_RE = /^[ \t]*Mods[ \t]*=[ \t]*(.*)$/m;
const MODS_LINE_RE = /^[ \t]*Mods[ \t]*=.*/m;
const MAP_RE = /^[ \t]*Map[ \t]*=[ \t]*(.*)$/m;
const MAP_LINE_RE = /^[ \t]*Map[ \t]*=.*/m;
const DEFAULT_MAPS = ["Muldraugh, KY"];

// Replace the first `Key=` line, or append one when there is none. The
// replacement is a function so a dollar-ampersand or dollar-quote sequence in
// the value is inserted literally.
function setIniLine(content, lineRe, key, value) {
  const line = `${key}=${value}`;
  return lineRe.test(content)
    ? content.replace(lineRe, () => line)
    : `${content}\n${line}`;
}

/**
 * Add one workshop item to the ini text.
 *
 * - WorkshopItems=: the id is appended unless it is already listed.
 * - Mods=: each of `modIds` not already on the line is appended. Entries that
 *   were already on the line stay as they were written (a "\" prefix, which
 *   the game ignores, included; only the padding around them goes) and count
 *   as there with or without it. An added all-digit id (which normally means
 *   a workshop id landed in Mods=) is kept only when a mod.info on disk
 *   confirms it. `addedModIds` is what was really written.
 * - Map=: each of `mapFolders` not already listed is put in front (a missing
 *   Map= line starts from the vanilla map).
 *
 * A line is only rewritten when this call changes it. Returns the new text and
 * what changed; `content` is the input unchanged when nothing did.
 */
export function addWorkshopItemToIni(
  content,
  { workshopId, modIds = [], mapFolders = [], serverPath = null },
) {
  const wsId = String(workshopId);
  let text = content;

  const workshopIds = splitIniList(text.match(WORKSHOP_ITEMS_RE)?.[1]);
  const workshopAlreadyExisted = workshopIds.includes(wsId);
  if (!workshopAlreadyExisted) {
    workshopIds.push(wsId);
    text = setIniLine(text, WORKSHOP_ITEMS_LINE_RE, "WorkshopItems", sanitizeIniList(workshopIds));
  }

  const modTokens = splitModIdTokens(text.match(MODS_RE)?.[1]);
  const modsBefore = modTokens.map((entry) => entry.id);
  const modsAfter = [...modsBefore];
  let addedModIds = [];
  for (const modId of modIds) {
    if (!modsAfter.includes(modId)) {
      modsAfter.push(modId);
      addedModIds.push(modId);
    }
  }
  let modCount = modsBefore.length;
  if (addedModIds.length > 0) {
    const newModList = sanitizeModIdListWithDiskBypass(
      modsAfter,
      workshopIds,
      serverPath,
      modsBefore,
    );
    // Report only what was really written (a refused id is not "added").
    const written = new Set(newModList.split(";"));
    addedModIds = addedModIds.filter((id) => written.has(id));
    if (addedModIds.length > 0) {
      // The entries that were already there keep the text they were written
      // with (a "\" prefix and all): the game ignores the backslashes, but the
      // file is the operator's. The sanitizer's list says what is new.
      const addedSet = new Set(addedModIds);
      const kept = modTokens.map((entry) => sanitizeIniValue(entry.raw)).filter(Boolean);
      const newEntries = newModList.split(";").filter((id) => addedSet.has(id));
      const mods = [...kept, ...newEntries];
      text = setIniLine(text, MODS_LINE_RE, "Mods", mods.join(";"));
      modCount = mods.length;
    } else {
      modCount = newModList ? newModList.split(";").length : 0;
    }
  }

  const maps = addMapFoldersToIni(text, mapFolders);
  text = maps.content;
  const addedMapFolders = maps.addedMapFolders;

  return {
    content: text,
    changed: text !== content,
    workshopAlreadyExisted,
    addedModIds,
    addedMapFolders,
    workshopCount: workshopIds.length,
    modCount,
  };
}

/**
 * Map=: each of `folders` not already listed goes in front (the map the
 * server loads first wins its cells; a missing Map= line starts from the
 * vanilla map), the rule every add-mod flow follows. Returns { content,
 * addedMapFolders }.
 */
export function addMapFoldersToIni(content, folders = []) {
  let text = content;
  const addedMapFolders = [];
  if (folders.length > 0) {
    const mapMatch = text.match(MAP_RE);
    const currentMaps = mapMatch ? splitIniList(mapMatch[1]) : [...DEFAULT_MAPS];
    for (const folder of folders) {
      // SECURITY (2026-10-20): a folder name is Workshop content; one with a
      // line break, ";" or "=" would add ini lines or entries, and the
      // sanitizer below would write it as another name.
      if (!isWritableMapFolderName(folder)) continue;
      if (!currentMaps.includes(folder)) {
        currentMaps.unshift(folder);
        addedMapFolders.push(folder);
      }
    }
    if (addedMapFolders.length > 0) {
      text = setIniLine(text, MAP_LINE_RE, "Map", sanitizeIniList(currentMaps));
    }
  }
  return { content: text, addedMapFolders };
}

// A mod id the fixes below may write: what Mods= can hold as one entry.
function writableModId(id) {
  return typeof id === "string" && id.trim() === id && id !== "" && id.length <= 200 && !/[\u0000-\u001f\u007f-\u009f;=\\]/.test(id);
}

/**
 * Applies one mod-list fix of the health check (utils/modHealth.js) to the
 * ini text. Entries that stay keep the text they were written with. `order`
 * is the planned Mods= order for applyPlan. Returns { content, changed }.
 *
 *   removeMods          { modIds }                    leave Mods=
 *   addMods             { modIds, before? }           into Mods=, before
 *                                                     `before` (else at the end)
 *   addWorkshopItems    { workshopIds, modIds?, before? }  WorkshopItems=, and
 *                                                     those mods as addMods
 *   removeWorkshopItems { workshopIds }               leave WorkshopItems=
 *   addMapFolders       { folders }                   in front of Map=
 *   removeMapFolders    { folders }                   leave Map= (the vanilla
 *                                                     map stays when nothing else is left)
 *   applyPlan           {} with `order`               Mods= in that order
 */
export function applyModListFix(content, { action, params = {} }, { order = null } = {}) {
  let text = content;
  const modTokens = () => splitModIdTokens(text.match(MODS_RE)?.[1]);
  const writeMods = (tokens) => {
    text = setIniLine(text, MODS_LINE_RE, "Mods", tokens.map((t) => sanitizeIniValue(t.raw)).filter(Boolean).join(";"));
  };
  const addMods = (ids, before) => {
    const tokens = modTokens();
    const present = new Set(tokens.map((t) => t.id));
    const adding = [];
    for (const id of ids || []) {
      if (writableModId(id) && !present.has(id) && !adding.includes(id)) adding.push(id);
    }
    if (adding.length === 0) return;
    const at = before ? tokens.findIndex((t) => t.id === before) : -1;
    const entries = adding.map((id) => ({ raw: id, id }));
    if (at === -1) tokens.push(...entries);
    else tokens.splice(at, 0, ...entries);
    writeMods(tokens);
  };
  switch (action) {
    case "removeMods": {
      const off = new Set(params.modIds || []);
      const tokens = modTokens();
      const kept = tokens.filter((t) => !off.has(t.id));
      if (kept.length !== tokens.length) writeMods(kept);
      break;
    }
    case "addMods":
      addMods(params.modIds, params.before);
      break;
    case "addWorkshopItems": {
      const items = splitIniList(text.match(WORKSHOP_ITEMS_RE)?.[1]);
      const adding = (params.workshopIds || []).filter((id) => /^\d{1,15}$/.test(id) && !items.includes(id));
      if (adding.length > 0) text = setIniLine(text, WORKSHOP_ITEMS_LINE_RE, "WorkshopItems", sanitizeIniList([...items, ...new Set(adding)]));
      addMods(params.modIds, params.before);
      break;
    }
    case "removeWorkshopItems": {
      const off = new Set(params.workshopIds || []);
      const items = splitIniList(text.match(WORKSHOP_ITEMS_RE)?.[1]);
      const kept = items.filter((id) => !off.has(id));
      if (kept.length !== items.length) text = setIniLine(text, WORKSHOP_ITEMS_LINE_RE, "WorkshopItems", sanitizeIniList(kept));
      break;
    }
    case "addMapFolders":
      text = addMapFoldersToIni(text, params.folders || []).content;
      break;
    case "removeMapFolders": {
      const mapMatch = text.match(MAP_RE);
      if (!mapMatch) break;
      const off = new Set((params.folders || []).map((f) => String(f).toLowerCase()));
      const current = splitIniList(mapMatch[1]);
      let kept = current.filter((f) => !off.has(f.toLowerCase()));
      if (kept.length === current.length) break;
      if (kept.length === 0) kept = [...DEFAULT_MAPS];
      text = setIniLine(text, MAP_LINE_RE, "Map", sanitizeIniList(kept));
      break;
    }
    case "applyPlan": {
      if (!Array.isArray(order)) break;
      const tokens = modTokens();
      const unused = new Map();
      for (const token of tokens) {
        if (!unused.has(token.id)) unused.set(token.id, []);
        unused.get(token.id).push(token);
      }
      const next = [];
      for (const id of order) {
        const token = unused.get(id)?.shift();
        if (token) next.push(token);
      }
      // Anything the plan did not place (it never drops a mod) stays at the end.
      for (const list of unused.values()) next.push(...list);
      if (next.some((t, i) => t !== tokens[i])) writeMods(next);
      break;
    }
    default:
      break;
  }
  return { content: text, changed: text !== content };
}
