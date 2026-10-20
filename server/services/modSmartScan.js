// Suggested winners on a conflict scan's pairs (utils/modConflictSuggestions.js),
// from what the scan already read: the file index gives each mod's files (so
// nothing is read again), the mod.info data its links, the stored order rules
// and the cached Steam knowledge the rest. An aid on top of the scan: a
// failure here never fails the scan.

import { createLogger } from "../utils/logger.js";
import { getModOrderRules } from "../database/init.js";
import { profilesFromFileIndex } from "../utils/modContentProfile.js";
import { classifyMods } from "../utils/modClassification.js";
import { computeOrderingConstraints } from "../utils/modLoadOrder.js";
import { createSuggestionContext, suggestConflictWinners } from "../utils/modConflictSuggestions.js";
import { peekSteamKnowledge } from "./modSteamKnowledge.js";

const log = createLogger("API:Mods");

// Per scan result: what its suggestions were made from, so the cached result
// can answer a rule stored after the scan.
const contexts = new WeakMap();

/**
 * Sets `suggestion` on the pairs of `result` (a scan result). `fileIndex` and
 * `modInfoMap` are buildFileIndex()'s, `effectiveOrder` the order the server
 * loads the mods in.
 */
export async function addConflictSuggestions(result, { fileIndex, modInfoMap, effectiveOrder }) {
  if (!result || !Array.isArray(result.pairs)) return;
  try {
    const mods = [];
    const seen = new Set();
    for (const [workshopId, details] of Object.entries(modInfoMap || {})) {
      for (const mod of details || []) {
        if (!mod?.id || seen.has(mod.id)) continue;
        seen.add(mod.id);
        mods.push({ ...mod, workshopId });
      }
    }
    const { profiles, fileCounts } = profilesFromFileIndex(fileIndex);
    for (const mod of mods) mod.profile = profiles.get(mod.id) || null;
    const steam = peekSteamKnowledge(Object.keys(modInfoMap || {}));
    const steamTags = new Map();
    const modIdOrder = new Map();
    for (const [workshopId, entry] of steam.items) {
      steamTags.set(workshopId, entry.tags || []);
      modIdOrder.set(workshopId, entry.modIdOrder || []);
    }
    const enabled = Array.isArray(effectiveOrder) ? effectiveOrder : [];
    const enabledSet = new Set(enabled);
    const namePatches = computeOrderingConstraints(mods.filter((m) => enabledSet.has(m.id))).filter((e) => e.reason === "patch");
    const classification = classifyMods({ mods, enabled, steamTags, namePatches });
    const base = { mods, classification, fileCounts, modIdOrder, effectiveOrder: enabled };
    contexts.set(result, base);
    result.pairs = suggestConflictWinners(result.pairs, createSuggestionContext({ ...base, rules: await getModOrderRules() }));
  } catch (error) {
    log.warn(`Conflict winner suggestions skipped: ${error.message}`);
  }
}

/** Recomputes the suggestions of a stored scan result with the current rules. */
export async function refreshConflictSuggestions(result) {
  const base = result ? contexts.get(result) : null;
  if (!base) return;
  try {
    result.pairs = suggestConflictWinners(result.pairs, createSuggestionContext({ ...base, rules: await getModOrderRules() }));
  } catch (error) {
    log.warn(`Conflict winner suggestions not refreshed: ${error.message}`);
  }
}
