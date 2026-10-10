import fs from "fs";

// Helpers shared by the Mods routes and the workshop readers for reading a
// server .ini / mod.info. Moved out of routes/mods.js (behaviour-preserving).

// Strip UTF-8 BOM (byte-order mark) that some text editors prepend to files.
// If present, the BOM breaks regex patterns anchored with ^ on the first line.
export function stripBom(str) {
  return str.charCodeAt(0) === 0xfeff ? str.slice(1) : str;
}

// Read a text file as UTF-8 with BOM stripping and CRLF normalisation
export function readTextFile(filePath) {
  // codeql[js/path-injection] workshopId is validated as /^\d{1,15}$/ at the mods route's POST /inspect-workshop-item handler before reaching getWorkshopPaths/getModDetailsFromWorkshop/findMapFoldersFromWorkshop -- CodeQL's only tracked source for this sink is that numeric-validated field.
  return stripBom(fs.readFileSync(filePath, "utf-8")).replace(/\r\n/g, "\n");
}
