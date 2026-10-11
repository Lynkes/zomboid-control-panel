import fs from "fs";

// Helpers shared by the Mods routes and the workshop readers for reading a
// server .ini / mod.info. Moved out of routes/mods.js (behaviour-preserving).

// Strip UTF-8 BOM (byte-order mark) that some text editors prepend to files.
// If present, the BOM breaks regex patterns anchored with ^ on the first line.
export function stripBom(str) {
  return str.charCodeAt(0) === 0xfeff ? str.slice(1) : str;
}

// The game reads a semicolon list (WorkshopItems=, Map=, Mods=) token by
// token and trims each one, so "Mods=111; 222;333 " names 111, 222 and 333.
// Splitting with a bare split(";").filter(Boolean) kept the padding, and every
// exact comparison after it (toggle, remove, "already there?") silently missed.
// All the panel's ini readers go through these two instead.
export function splitIniList(value) {
  if (typeof value !== "string") return [];
  return value
    .split(";")
    .map((token) => token.trim())
    .filter(Boolean);
}

// Mods= additionally loses every backslash before it is split (the game
// runs value.replace("\\", "").split(";") over the whole line).
export function splitModIdList(value) {
  if (typeof value !== "string") return [];
  return splitIniList(value.replace(/\\/g, ""));
}

// Read a text file as UTF-8 with BOM stripping and CRLF normalisation
export function readTextFile(filePath) {
  // codeql[js/path-injection] workshopId is validated as /^\d{1,15}$/ at the mods route's POST /inspect-workshop-item handler before reaching getWorkshopPaths/getModDetailsFromWorkshop/findMapFoldersFromWorkshop -- CodeQL's only tracked source for this sink is that numeric-validated field.
  return stripBom(fs.readFileSync(filePath, "utf-8")).replace(/\r\n/g, "\n");
}
