import { splitIniList, splitModIdList } from "../utils/modIni.js";
import { sanitizeIniList } from "../utils/sanitize.js";
import { sanitizeModIdListWithDiskBypass } from "./workshopModInfo.js";

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
 *   were already on the line stay as they are; an added all-digit id (which
 *   normally means a workshop id landed in Mods=) is kept only when a mod.info
 *   on disk confirms it. `addedModIds` is what was really written.
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

  const modsBefore = splitModIdList(text.match(MODS_RE)?.[1]);
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
      text = setIniLine(text, MODS_LINE_RE, "Mods", newModList);
    }
    modCount = newModList ? newModList.split(";").length : 0;
  }

  const addedMapFolders = [];
  if (mapFolders.length > 0) {
    const mapMatch = text.match(MAP_RE);
    const currentMaps = mapMatch ? splitIniList(mapMatch[1]) : [...DEFAULT_MAPS];
    for (const folder of mapFolders) {
      if (!currentMaps.includes(folder)) {
        currentMaps.unshift(folder);
        addedMapFolders.push(folder);
      }
    }
    if (addedMapFolders.length > 0) {
      text = setIniLine(text, MAP_LINE_RE, "Map", currentMaps.join(";"));
    }
  }

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
