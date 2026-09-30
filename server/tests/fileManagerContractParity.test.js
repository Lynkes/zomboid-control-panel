import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import * as serverContract from "../services/fileManagerContract.js";
import { ErrorCode } from "../utils/errorCodes.js";

// The Server Files contract lives twice: server/services/fileManagerContract.js
// (what the server emits and enforces) and client/src/types/files.ts (what the
// client renders and validates against). Nothing compiles one against the
// other, so a root id, reason, token or limit added on one side only would
// reach the other as an unknown value. This pins the two to the same names,
// values and order, pins the error-status table to the FM_* registry, and
// checks that en/files.json has a string for every value the client renders
// from those lists.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..", "..");
const clientContract = await import("../../client/src/types/files.ts");
const enFiles = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "client", "src", "locales", "en", "files.json"), "utf8"),
);
const nameCases = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "fileManagerNameCases.json"), "utf8"),
);

const SHARED_ARRAYS = [
  "ROOT_IDS",
  "BACKENDS",
  "SERVER_STATES",
  "PROTECTION_LEVELS",
  "PROTECTED_AREAS",
  "CONFIRM_TOKENS",
  "HINTS",
  "ROOT_UNAVAILABLE_REASONS",
  "ROOT_WARNINGS",
  "BOOKMARK_KINDS",
  "TRASH_REASONS",
  "NAME_RULE_REASONS",
  "AUDIT_OPS",
];

describe("Server Files contract: client types and server mirror", () => {
  for (const name of SHARED_ARRAYS) {
    it(`${name} matches in name, values and order`, () => {
      expect(Array.isArray(serverContract[name]), `server ${name}`).toBe(true);
      expect(serverContract[name].length, `server ${name}`).toBeGreaterThan(0);
      expect([...clientContract[name]]).toEqual([...serverContract[name]]);
    });
  }

  it("FM_LIMITS match, and the server copy is frozen all the way down", () => {
    expect(clientContract.FM_LIMITS).toEqual(serverContract.FM_LIMITS);
    expect(Object.isFrozen(serverContract.FM_LIMITS)).toBe(true);
    for (const value of Object.values(serverContract.FM_LIMITS)) {
      if (value && typeof value === "object") expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it("every protected area has exactly one protection level", () => {
    expect(Object.keys(serverContract.PROTECTED_AREA_LEVEL).sort()).toEqual(
      [...serverContract.PROTECTED_AREAS].sort(),
    );
    for (const level of Object.values(serverContract.PROTECTED_AREA_LEVEL)) {
      expect(serverContract.PROTECTION_LEVELS).toContain(level);
    }
  });
});

describe("Server Files contract: errors", () => {
  const fmCodes = Object.keys(ErrorCode).filter((name) => name.startsWith("FM_"));

  it("FM_ERROR_STATUS has a status for every FM_* code and nothing else", () => {
    expect(fmCodes.length).toBeGreaterThan(40);
    expect(Object.keys(serverContract.FM_ERROR_STATUS).sort()).toEqual(
      fmCodes.map((name) => ErrorCode[name]).sort(),
    );
    for (const status of Object.values(serverContract.FM_ERROR_STATUS)) {
      expect(Number.isInteger(status) && status >= 400 && status <= 599).toBe(true);
    }
  });

  it("FmError carries the code as its message, defaults its status, and copies params", () => {
    const params = { reason: "dotSegment" };
    const err = new serverContract.FmError(ErrorCode.FM_INVALID_PATH, undefined, params);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("FM_INVALID_PATH");
    expect(err.code).toBe("FM_INVALID_PATH");
    expect(err.status).toBe(400);
    expect(err.params).toEqual(params);
    expect(err.params).not.toBe(params);

    expect(new serverContract.FmError(ErrorCode.FM_EXISTS, 418).status).toBe(418);
    expect(new serverContract.FmError(ErrorCode.FM_INTERNAL).params).toEqual({});
  });
});

describe("Server Files contract: name rules", () => {
  it("the shared fixture covers every reason, and the validators agree with it", () => {
    const covered = new Set(nameCases.map((c) => c.reason).filter(Boolean));
    expect([...covered].sort()).toEqual([...serverContract.NAME_RULE_REASONS].sort());
    expect(nameCases.some((c) => c.input === "%2e%2e" && c.reason === null)).toBe(true);

    const mismatches = [];
    for (const c of nameCases) {
      const result =
        c.kind === "path"
          ? serverContract.validateSegments(c.input)
          : serverContract.validateName(c.input, { isNew: c.kind === "newName" });
      const got = result.ok ? null : result.reason;
      if (got !== c.reason) mismatches.push({ ...c, got });
    }
    expect(mismatches).toEqual([]);
  });

  it("non-string input is refused as empty", () => {
    for (const value of [undefined, null, 5, ["a"], { a: 1 }]) {
      expect(serverContract.validateSegments(value)).toEqual({ ok: false, reason: "empty" });
      expect(serverContract.validateName(value)).toEqual({ ok: false, reason: "empty" });
    }
  });

  it("a valid path comes back split into its segments", () => {
    expect(serverContract.validateSegments("")).toEqual({ ok: true, segments: [] });
    expect(serverContract.validateSegments("Server/servertest.ini")).toEqual({
      ok: true,
      segments: ["Server", "servertest.ini"],
    });
  });
});

describe("Server Files contract: en/files.json covers every rendered value", () => {
  const keysOf = (obj) => Object.keys(obj).sort();

  it.each([
    ["nameRules", () => enFiles.nameRules, serverContract.NAME_RULE_REASONS],
    ["roots.unavailable", () => enFiles.roots.unavailable, serverContract.ROOT_UNAVAILABLE_REASONS],
    ["roots.warnings", () => enFiles.roots.warnings, serverContract.ROOT_WARNINGS],
    ["roots.labels", () => enFiles.roots.labels, serverContract.ROOT_IDS],
    ["roots.backend", () => enFiles.roots.backend, serverContract.BACKENDS],
    ["protected.areas", () => enFiles.protected.areas, serverContract.PROTECTED_AREAS],
    ["editor.hints", () => enFiles.editor.hints, serverContract.HINTS],
    ["trash.reasons", () => enFiles.trash.reasons, serverContract.TRASH_REASONS],
  ])("%s has exactly one key per value", (_name, section, values) => {
    expect(keysOf(section())).toEqual([...values].sort());
  });

  it("roots.bookmarks has a label for every bookmark kind", () => {
    for (const kind of serverContract.BOOKMARK_KINDS) {
      expect(typeof enFiles.roots.bookmarks[kind], kind).toBe("string");
    }
  });

  it("confirm.tokens has a sentence for every confirmation token", () => {
    for (const token of serverContract.CONFIRM_TOKENS) {
      expect(typeof enFiles.confirm.tokens[token], token).toBe("string");
    }
  });
});
