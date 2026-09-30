import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import { CHARACTER_HINT_IDS } from "../services/characterHints.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The "Worth a look" hints are nudges with numbers, never verdicts. This pins
// the wording of every English character string (players.json character.*)
// and every hint id, and that each hint id has its four strings.
describe("wording: nudges, never verdicts", () => {
  const BANNED = /cheat|hack|exploit|suspicious/i;

  function strings(node, out = []) {
    if (typeof node === "string") out.push(node);
    else if (node && typeof node === "object") for (const value of Object.values(node)) strings(value, out);
    return out;
  }

  it("no hint id uses a banned word", () => {
    for (const id of CHARACTER_HINT_IDS) expect(id).not.toMatch(BANNED);
  });

  it("no English character string uses a banned word, and every hint id has its copy", () => {
    const players = JSON.parse(
      fs.readFileSync(path.join(__dirname, "..", "..", "client", "src", "locales", "en", "players.json"), "utf8"),
    );
    const character = players.character;
    expect(character?.hints?.items).toBeDefined();
    for (const text of strings(character)) expect(text).not.toMatch(BANNED);
    for (const id of CHARACTER_HINT_IDS) {
      expect(Object.keys(character.hints.items[id] ?? {}).sort()).toEqual(["detail", "innocent", "rule", "title"]);
    }
  });
});
