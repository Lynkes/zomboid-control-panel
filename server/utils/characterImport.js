// A skill's level in the game runs 0..10.
export const CHARACTER_PERK_LEVEL_MAX = 10;

/**
 * Why the bridge should not be sent this character import (an English
 * sentence; routes/panelBridge.js answers it with 400
 * PANELBRIDGE_CHARACTER_PERK_INVALID), or null.
 *
 * SECURITY (2026-10-20): PanelBridge's importPlayerData levels each perk once
 * per level in the file, so a level of 1e9 froze the game server. The bridge
 * clamps the level itself (PanelBridge.lua); the panel refuses such a file
 * outright so the operator learns it is wrong. `perks` must be an object of
 * perk entries, and each entry's level, when it has one, a whole number from
 * 0 to 10. Exports always look like that.
 *
 * @param {unknown} data - The import's `data` object.
 * @returns {string | null}
 */
export function characterImportRefusal(data) {
  const perks = data?.perks;
  if (perks === undefined || perks === null) return null;
  const refuse = (where) =>
    `Each skill in the character data must have a whole-number level from 0 to ${CHARACTER_PERK_LEVEL_MAX} (${JSON.stringify(String(where).slice(0, 64))}).`;
  if (typeof perks !== "object" || Array.isArray(perks)) return refuse("perks");
  for (const [name, entry] of Object.entries(perks)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return refuse(name);
    const level = entry.level;
    if (level === undefined || level === null) continue;
    if (!Number.isInteger(level) || level < 0 || level > CHARACTER_PERK_LEVEL_MAX) return refuse(name);
  }
  return null;
}
