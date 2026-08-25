#!/usr/bin/env node
// German (de) locale linter for defect classes no gate on this floor can see:
// noun capitalisation, register leaks (Sie-form), imperative-vs-infinitive buttons,
// English-width length blowups, cross-file/glossary vocabulary drift, and
// inconsistent acronym casing.
//
// Report-only. Not wired into vitest or any gate -- see the task brief this was
// written for. Run with: node client/scripts/de-lint.mjs
//
// Usage: node client/scripts/de-lint.mjs [--json] [--check=cap,register,verb,length,glossary,acronym]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCALES_DIR = path.resolve(__dirname, "../src/locales");
const DE_DIR = path.join(LOCALES_DIR, "de");
const EN_DIR = path.join(LOCALES_DIR, "en");
const GLOSSARY_PATH = path.join(LOCALES_DIR, "GLOSSARY.de.md");

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const checkArg = args.find((a) => a.startsWith("--check="));
// "cap" (noun-capitalisation) is OFF by default: manual review of every one
// of its 58 findings on this tree found zero true positives -- all were
// relative pronouns/personal pronouns/adverbs misread as determiners, or
// literal path/filename fragments correctly lowercase. The regex-boundary
// bug that made this worse (Unicode letters truncating matches) is fixed,
// but the remaining false-positive rate is still total. Pass --check=cap
// explicitly to see its output; treat every finding as unverified.
const enabledChecks = checkArg
  ? new Set(checkArg.slice("--check=".length).split(","))
  : new Set(["register", "verb", "length", "glossary", "acronym"]);

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

function flattenLeaves(obj, prefix = "", out = {}) {
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const keyPath = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      flattenLeaves(value, keyPath, out);
    } else {
      out[keyPath] = value;
    }
  }
  return out;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// ---------------------------------------------------------------------------
// Glossary parsing: pipe tables + the "Do not translate" bullet section.
// Deliberately parses the markdown rather than hard-coding terms, so this
// script stays true as terms are added to GLOSSARY.de.md.
// ---------------------------------------------------------------------------

function stripMarkdown(cell) {
  return cell
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/`(.*?)`/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/\([^)]*\)/g, "") // drop parenthetical asides ("(verb)", "(a JSON array entry)", ...)
    .trim();
}

function splitAlternatives(cell) {
  const cleaned = stripMarkdown(cell);
  if (!cleaned) return [];
  const bySlash = cleaned.split(" / ").map((s) => s.trim()).filter(Boolean);
  if (bySlash.length > 1) return bySlash;
  const byDot = cleaned.split(" · ").map((s) => s.trim()).filter(Boolean);
  if (byDot.length > 1) return byDot;
  return [cleaned];
}

function parseGlossaryTables(text) {
  const lines = text.split("\n");
  const terms = []; // { english, deAlternatives: string[] }
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;
    if (/^\|[\s:-]+\|[\s:-]+\|?/.test(trimmed) && /-{2,}/.test(trimmed)) continue; // separator row
    const cells = trimmed.split("|").slice(1, -1).map((c) => c.trim());
    if (cells.length < 2) continue;
    const [rawEnglish, rawDe] = cells;
    if (!rawEnglish || !rawDe) continue;
    if (/^english$/i.test(rawEnglish)) continue; // header row
    if (/see below/i.test(rawDe)) continue; // not a real term, a forward-reference row

    const englishParts = splitAlternatives(rawEnglish);
    const deParts = splitAlternatives(rawDe);
    if (englishParts.length === 0 || deParts.length === 0) continue;

    if (englishParts.length === deParts.length && englishParts.length > 1) {
      // paired synonyms, e.g. "start / stop" -> "starten / stoppen"
      for (let i = 0; i < englishParts.length; i++) {
        if (englishParts[i].length < 3) continue; // skip too-short/noisy tokens
        terms.push({ english: englishParts[i], deAlternatives: [deParts[i]] });
      }
    } else {
      for (const en of englishParts) {
        if (en.length < 3) continue;
        terms.push({ english: en, deAlternatives: deParts });
      }
    }
  }
  return terms;
}

function parseDoNotTranslate(text) {
  const section = text.split(/^## Do not translate$/m)[1]?.split(/^## /m)[0] ?? "";
  const tokens = new Set();
  // backtick or bold tokens, and bare comma-separated proper nouns on bullet lines
  for (const m of section.matchAll(/`([^`]+)`/g)) tokens.add(m[1].trim());
  for (const m of section.matchAll(/\*\*([^*]+)\*\*/g)) tokens.add(m[1].split(",")[0].trim());
  for (const line of section.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("-")) continue;
    const body = t.replace(/^-\s*/, "");
    if (/^\*\*/.test(body)) continue; // already captured above
    for (const part of body.split(",")) {
      const cleaned = stripMarkdown(part).trim();
      if (cleaned && /^[A-Z]/.test(cleaned) && cleaned.length > 1 && !/ and | or /i.test(cleaned)) {
        tokens.add(cleaned.split(/\s+—|\s+\(/)[0].trim());
      }
    }
  }
  return [...tokens].filter((t) => t.length > 1 && t.length < 40);
}

// The same English word legitimately appears in more than one glossary row
// with a different rendering per sense ("save" the noun -> der Spielstand;
// "save" (verb) -> speichern). Checked independently, each row over-fires on
// every occurrence of the OTHER sense. Merge same-english rows into one
// matcher that accepts any of the senses' renderings -- imprecise (it can't
// tell which sense is meant either), but turns a guaranteed false positive
// into a much rarer one (only when NONE of the senses' words appear).
function mergeSameEnglish(terms) {
  const byEnglish = new Map();
  for (const t of terms) {
    const key = `${t.isLiteral ? "L:" : "T:"}${t.english.toLowerCase()}`;
    if (!byEnglish.has(key)) {
      byEnglish.set(key, { english: t.english, deAlternatives: [], isLiteral: t.isLiteral });
    }
    byEnglish.get(key).deAlternatives.push(...t.deAlternatives);
  }
  return [...byEnglish.values()];
}

function loadGlossary() {
  const text = fs.readFileSync(GLOSSARY_PATH, "utf8");
  const tableTerms = parseGlossaryTables(text).map((t) => ({ ...t, isLiteral: false }));
  const literalTerms = parseDoNotTranslate(text)
    .filter((t) => t.length >= 4) // short tokens (GM, ID...) are too collision-prone case-sensitively too
    .map((t) => ({ english: t, deAlternatives: [t], isLiteral: true }));
  return mergeSameEnglish([...tableTerms, ...literalTerms]);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Check 1: noun capitalisation
// Heuristic: article/determiner immediately followed by a lowercase word that
// is NOT itself immediately followed by another capitalised word (which would
// suggest the lowercase word is an attributive adjective modifying a further,
// correctly-capitalised noun -- the overwhelmingly common case in real prose).
// Ranked, not asserted: expect false positives, especially on predicate
// adjectives and function words that happen to look like determiners.
// ---------------------------------------------------------------------------

const ARTICLES = "der|die|das|den|dem|des|ein|eine|einen|einem|einer|eines";
// NOTE: JS's \b only recognises ASCII word characters. Used right after a
// captured word that may end in ü/ö/ä/ß, it creates a spurious boundary at
// the umlaut and truncates the match ("missglücktes" -> "missglü"). The
// trailing boundary is therefore a manual lookahead over the SAME extended
// letter class, not \b, so it matches how far the word actually continues.
const DE_LETTER_CLASS = "a-zäöüßA-ZÄÖÜ";
const CAP_HEURISTIC_RE = new RegExp(
  `\\b(${ARTICLES})\\s+([a-zäöüß][${DE_LETTER_CLASS}-]*)(?![${DE_LETTER_CLASS}])(?!\\s+[A-ZÄÖÜ])`,
  "g",
);

// Common lowercase words that legitimately follow an article/determiner and
// are not the head noun -- pronouns, auxiliaries, adverbs, conjunctions that
// coincide with article spelling, or words mid-adjective-chain. Kept short
// and reviewed by hand rather than exhaustive; the point is cutting the worst
// of the noise, not proving completeness.
const CAP_STOPLIST = new Set(
  `ist sind war waren wird werden wurde wurden kann können konnte muss müssen musste
   soll sollen sollte hat haben hatte sich nicht auch noch schon nur sehr mehr immer
   wieder dann jetzt hier dort so wie was wer wenn aber oder und für mit von zu in
   auf bei nach vor über unter während bereits erst mal denn doch also somit dass
   selbst eigene eigener eigenes eigenen ganze ganzer ganzes ganzen gleiche gleicher
   gleiches gleichen andere anderer anderes anderen letzte letzter letztes letzten
   neue neuer neues neuen aktuelle aktueller aktuelles aktuellen erste erster erstes
   ersten nächste nächster nächstes nächsten gesamte gesamter gesamtes gesamten`
    .split(/\s+/)
    .filter(Boolean),
);

function checkCapitalisation(value) {
  const findings = [];
  for (const m of value.matchAll(CAP_HEURISTIC_RE)) {
    const word = m[2];
    const lower = word.toLowerCase();
    if (CAP_STOPLIST.has(lower)) continue;
    if (word.length < 3) continue;
    // Adjective inflection endings are the dominant source of remaining noise
    // (article + adjective + [correctly-capitalised noun later/elsewhere]).
    // We already excluded "followed immediately by a capitalised word"; an
    // adjective at the END of a clause (e.g. "... ist nicht verfügbar") is
    // the residual noise case, flagged as low-confidence.
    const looksAdjectival = /(e|en|em|er|es)$/i.test(word);
    findings.push({ word, context: m[0], confidence: looksAdjectival ? "low" : "medium" });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check 2: register leak (Sie-form against the du ruling)
// ---------------------------------------------------------------------------

const REGISTER_RE = /\b(Sie|Ihr|Ihre|Ihrer|Ihren|Ihrem|Ihnen)\b/g;
// "Sie"/"Ihr" capitalised at a SENTENCE START is structurally ambiguous with
// "sie"/"ihr" (she/they/their) capitalised only by position -- German gives
// no way to tell them apart from capitalisation or verb form alone (formal
// Sie and plural sie conjugate identically). Sentence start means either the
// very beginning of the string, or the first letter after ./!/?/—/„ and
// whitespace -- not just index 0, which misses every sentence after the
// first inside one JSON value.
const SENTENCE_END_RE = /[.!?—„]\s*$/;

function checkRegisterLeak(value) {
  const findings = [];
  for (const m of value.matchAll(REGISTER_RE)) {
    const before = value.slice(0, m.index);
    const atSentenceStart = m.index === 0 || SENTENCE_END_RE.test(before);
    findings.push({
      word: m[1],
      confidence: atSentenceStart ? "low" : "high",
      note: atSentenceStart
        ? "sentence-initial -- could be 'sie'/'ihr' (she/they/their) capitalised by position, not formal Sie"
        : undefined,
    });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check 3: button-shaped keys that look imperative rather than infinitive
//
// A generic "label"/"action" substring match is the wrong signal on this
// codebase -- most `*Label` keys are STATUS/diagnostic descriptors ("RCON
// getrennt", "Heap-Auslastung hoch"), correctly noun/adjective-shaped, not
// buttons at all; matching them produced a 100% false-positive rate in
// manual review. Real clickable buttons here are named for the action
// itself (cancel, confirm, deleteSelected, startContainer, retry), or end in
// an explicit Button/Btn/Cta suffix -- match THAT instead.
// ---------------------------------------------------------------------------

const BUTTON_KEY_RE = new RegExp(
  "^(cancel|confirm|close|dismiss|retry|apply|submit|save|delete|start|stop|restart|" +
    "install|update|verify|kick|ban|unban|wipe|remove|add|create|download|upload|" +
    "export|import|reset|restore|continue)\\b|(button|btn|cta)$",
  "i",
);
const VERB_NONVERB_STOPLIST = new Set([
  "zurück", "weiter", "fertig", "ja", "nein", "ok", "mehr", "los", "hilfe",
  "einstellungen", "dashboard", "server", "backup", "backups",
]);

function lastWord(value) {
  const cleaned = value.replace(/[.!?…:]+$/g, "").trim();
  const words = cleaned.split(/\s+/);
  return words[words.length - 1]?.replace(/[^a-zA-ZäöüßÄÖÜ]/g, "") ?? "";
}

// English gerund/participle key names ("startingButton", "addedButton") name
// a TRANSIENT STATE shown while/after an action runs, not a command to give
// -- their correct German ("Wird gestartet…", "Hinzugefügt") is deliberately
// not infinitive. These accounted for the majority of remaining false
// positives once the key-detection itself was narrowed to real buttons.
const STATE_KEY_RE = /(ing|ed)(Button|Btn)?$/i;

function checkImperativeButton(keyPath, value) {
  const lastSegment = keyPath.split(".").pop() ?? keyPath;
  if (!BUTTON_KEY_RE.test(lastSegment)) return null;
  if (STATE_KEY_RE.test(lastSegment)) return null;
  if (!value || /\{\{/.test(value)) return null; // skip templated values
  const word = lastWord(value);
  if (!word || word.length < 3) return null;
  const lower = word.toLowerCase();
  if (VERB_NONVERB_STOPLIST.has(lower)) return null;
  const looksInfinitive = /(en|eln|ern)$/i.test(word) || /^(sein|tun)$/i.test(word);
  if (looksInfinitive) return null;
  return { word, keyPath };
}

// ---------------------------------------------------------------------------
// Check 4: length blowup vs. English, for short (layout-constrained) strings
// ---------------------------------------------------------------------------

const LENGTH_RATIO_THRESHOLD = 1.6;
const LENGTH_EN_MAX_CHARS = 25;

function checkLength(enValue, deValue) {
  if (typeof enValue !== "string" || typeof deValue !== "string") return null;
  if (enValue.length === 0 || enValue.length > LENGTH_EN_MAX_CHARS) return null;
  if (/\{\{/.test(enValue)) return null; // placeholders skew raw length, not the point of this check
  const ratio = deValue.length / enValue.length;
  if (ratio <= LENGTH_RATIO_THRESHOLD) return null;
  return { ratio: Math.round(ratio * 100) / 100, enLen: enValue.length, deLen: deValue.length };
}

// ---------------------------------------------------------------------------
// Check 5: glossary term presence -- generalised Mod-Checker/Mod-Prüfung check
//
// Two very different failure modes had to be designed around:
//   - Table terms ("backup" -> "das Backup") must tolerate German inflection
//     (Backup/Backups, aktualisieren/aktualisiert/Aktualisierung) and the
//     glossary's own leading article, or almost every real, correct string
//     "misses" on a technicality. Matched via a stripped-article, truncated
//     stem, case-insensitively.
//   - Do-not-translate literal terms (Local, General, Admin...) collide with
//     ordinary English vocabulary when matched case-insensitively ("local"
//     the generic adjective vs. "Local" the PZ chat-scope proper noun) --
//     these are matched case-SENSITIVELY on both sides instead, since a
//     literal token is supposed to appear byte-identical in German anyway.
// ---------------------------------------------------------------------------

function stripLeadingArticle(s) {
  return s.replace(new RegExp(`^(${ARTICLES})\\s+`, "i"), "").trim();
}

function stemOf(word) {
  const stemLen = Math.max(4, word.length - 3);
  return word.slice(0, stemLen);
}

// For a (possibly multi-word) German rendering, stem its head (last) word --
// German noun phrases put the head noun last ("geplante Aufgabe" -> Aufgabe).
// A few glossary rows are descriptive rather than a clean rendering (e.g.
// "die Festplatte **in prose** · **Disk** in a terse stat label" -- context
// notes mixed into the cell itself, not just the Note column). Naively
// taking the last word picks up "prose"/"label", which no real translation
// will ever contain -- guaranteed false positives on every matching string.
// Skip trailing English filler/meta words and use the last real one instead.
const ENGLISH_FILLER_WORDS = new Set([
  "in", "a", "an", "the", "of", "for", "as", "or", "and", "to",
  "prose", "label", "stat", "terse", "see", "below", "note", "row",
  "matrix", "form", "noun", "verb", "one",
]);

function headStem(alt) {
  const stripped = stripLeadingArticle(alt);
  const words = stripped.split(/\s+/).filter(Boolean);
  let head = stripped;
  for (let i = words.length - 1; i >= 0; i--) {
    if (!ENGLISH_FILLER_WORDS.has(words[i].toLowerCase())) {
      head = words[i];
      break;
    }
  }
  return stemOf(head);
}

function buildGlossaryMatchers(terms) {
  return terms.map((t) => ({
    ...t,
    enRe: new RegExp(`\\b${escapeRegex(t.english)}\\b`, t.isLiteral ? "" : "i"),
    deStems: t.isLiteral ? t.deAlternatives : t.deAlternatives.map(headStem),
  }));
}

function checkGlossaryTerm(enValue, deValue, matchers) {
  if (typeof enValue !== "string" || typeof deValue !== "string") return [];
  // Placeholder NAMES ({{path}}, {{count}}...) are not English prose -- a
  // literal template variable called "path" doesn't mean the sentence talks
  // about a path. Strip them before testing whether the term is even in play.
  const enProse = enValue.replace(/\{\{[^}]+\}\}/g, " ");
  const findings = [];
  const deLower = deValue.toLowerCase();
  for (const term of matchers) {
    if (!term.enRe.test(enProse)) continue;
    const present = term.isLiteral
      ? term.deAlternatives.some((alt) => deValue.includes(alt))
      : term.deStems.some((stem) => deLower.includes(stem.toLowerCase()));
    if (!present) {
      findings.push({ english: term.english, expected: term.deAlternatives, literal: term.isLiteral });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check 6: acronym casing consistency
//
// German capitalises RCON/GM/INI/OIDC wherever they appear as words, even
// where the English source itself is inconsistent (a label spells it "RCON"
// while a terse badge in the same file writes "rcon") -- the English source
// is not authoritative about German orthography here, only about meaning.
// Exception: shell-prompt mimicry, where the lowercase form IS the thing
// being displayed on screen ("rcon $", "/rcon <command>").
// ---------------------------------------------------------------------------

const CANONICAL_ACRONYMS = { rcon: "RCON", gm: "GM", ini: "INI", oidc: "OIDC" };
const SHELL_MIMICRY_RE = /[/`]\s*$|\$\s*$|^\s*[/$>]/; // context right before the match looks like a prompt/path

function checkAcronymCasing(value) {
  const findings = [];
  // ".ini" as a literal file EXTENSION ("server.ini", "{{name}}.ini") is
  // correctly lowercase -- it's a filename convention, not the acronym INI
  // used as a word. This was the dominant false-positive source (21 of 22
  // on the first pass, all "server.ini"/"{{x}}.ini"). Scrub placeholder
  // names for the same reason a bare "{{ini}}" isn't the word "INI" either.
  const scrubbed = value
    .replace(/\{\{[^}]+\}\}/g, " ")
    .replace(/\.ini\b/gi, ".xxx");
  for (const [lower, canonical] of Object.entries(CANONICAL_ACRONYMS)) {
    const re = new RegExp(`\\b${lower}\\b`, "gi");
    for (const m of scrubbed.matchAll(re)) {
      if (m[0] === canonical) continue; // already correct
      const before = scrubbed.slice(Math.max(0, m.index - 3), m.index);
      const after = scrubbed.slice(m.index + m[0].length, m.index + m[0].length + 3);
      if (SHELL_MIMICRY_RE.test(before) || /^\s*\$/.test(after)) continue;
      findings.push({
        found: m[0],
        expected: canonical,
        context: value.slice(Math.max(0, m.index - 15), m.index + m[0].length + 15),
      });
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const glossaryTerms = loadGlossary();
  const glossaryMatchers = buildGlossaryMatchers(glossaryTerms);

  const deFiles = fs
    .readdirSync(DE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();

  const findingsByFile = {};
  const stats = { cap: 0, register: 0, verb: 0, length: 0, glossary: 0, acronym: 0, filesChecked: 0, keysChecked: 0 };

  for (const fileName of deFiles) {
    const enPath = path.join(EN_DIR, fileName);
    if (!fs.existsSync(enPath)) continue; // no English source to compare against
    const dePath = path.join(DE_DIR, fileName);

    let enJson, deJson;
    try {
      enJson = readJson(enPath);
      deJson = readJson(dePath);
    } catch (err) {
      findingsByFile[fileName] = findingsByFile[fileName] || [];
      findingsByFile[fileName].push({ type: "PARSE_ERROR", message: String(err.message) });
      continue;
    }

    stats.filesChecked++;
    const enLeaves = flattenLeaves(enJson);
    const deLeaves = flattenLeaves(deJson);
    const fileFindings = [];

    for (const keyPath of Object.keys(deLeaves)) {
      const deValue = deLeaves[keyPath];
      const enValue = enLeaves[keyPath];
      if (typeof deValue !== "string") continue;
      stats.keysChecked++;

      if (enabledChecks.has("cap")) {
        for (const f of checkCapitalisation(deValue)) {
          stats.cap++;
          fileFindings.push({
            type: "CAPITALISATION",
            keyPath,
            confidence: f.confidence,
            detail: `"${f.word}" in "${f.context}"`,
            value: deValue,
          });
        }
      }

      if (enabledChecks.has("register")) {
        for (const f of checkRegisterLeak(deValue)) {
          stats.register++;
          fileFindings.push({
            type: "REGISTER_LEAK",
            keyPath,
            confidence: f.confidence,
            detail: f.note ? `"${f.word}" (${f.note})` : `"${f.word}"`,
            value: deValue,
          });
        }
      }

      // Search-index/keyword-list fields are matched, not read -- English's
      // own source uses lowercase acronyms there too (case-insensitive
      // matching is the point), so it's not the same "German should
      // normalise regardless of English" case the rule targets.
      const isSearchIndexField = /keywords$/i.test(keyPath);
      if (enabledChecks.has("acronym") && !isSearchIndexField) {
        for (const f of checkAcronymCasing(deValue)) {
          stats.acronym++;
          fileFindings.push({
            type: "ACRONYM_CASING",
            keyPath,
            confidence: "high",
            detail: `"${f.found}" should be "${f.expected}" in "...${f.context}..."`,
            value: deValue,
          });
        }
      }

      if (enabledChecks.has("verb")) {
        const f = checkImperativeButton(keyPath, deValue);
        if (f) {
          stats.verb++;
          fileFindings.push({
            type: "IMPERATIVE_BUTTON",
            keyPath,
            confidence: "medium",
            detail: `last word "${f.word}" does not look infinitive`,
            value: deValue,
          });
        }
      }

      if (enabledChecks.has("length") && enValue !== undefined) {
        const f = checkLength(enValue, deValue);
        if (f) {
          stats.length++;
          fileFindings.push({
            type: "LENGTH_BLOWUP",
            keyPath,
            confidence: "medium",
            detail: `ratio ${f.ratio} (en ${f.enLen} chars -> de ${f.deLen} chars)`,
            value: deValue,
            enValue,
          });
        }
      }

      if (enabledChecks.has("glossary") && enValue !== undefined) {
        for (const f of checkGlossaryTerm(enValue, deValue, glossaryMatchers)) {
          stats.glossary++;
          fileFindings.push({
            type: "GLOSSARY_TERM_MISSING",
            keyPath,
            confidence: "high",
            detail: `en has "${f.english}", de value has none of [${f.expected.join(", ")}]`,
            value: deValue,
            enValue,
          });
        }
      }
    }

    if (fileFindings.length > 0) {
      findingsByFile[fileName] = fileFindings;
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ stats, findingsByFile }, null, 2));
    return;
  }

  console.log(`de-lint: ${stats.filesChecked} files, ${stats.keysChecked} string keys checked`);
  console.log(
    `raw finding counts -- capitalisation: ${stats.cap}, register: ${stats.register}, ` +
      `imperative-button: ${stats.verb}, length: ${stats.length}, glossary: ${stats.glossary}, ` +
      `acronym: ${stats.acronym}`,
  );
  console.log("");

  const fileNames = Object.keys(findingsByFile).sort();
  if (fileNames.length === 0) {
    console.log("No findings.");
    return;
  }

  for (const fileName of fileNames) {
    console.log(`=== ${fileName} ===`);
    for (const f of findingsByFile[fileName]) {
      if (f.type === "PARSE_ERROR") {
        console.log(`  [PARSE_ERROR] ${f.message}`);
        continue;
      }
      console.log(`  [${f.type}] (${f.confidence}) ${f.keyPath}: ${f.detail}`);
    }
    console.log("");
  }
}

main();
