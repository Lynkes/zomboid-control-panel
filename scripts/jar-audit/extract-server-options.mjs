#!/usr/bin/env node
// Extracts the real min/max/default for every Project Zomboid server.ini
// option out of the real B42 jar's compiled zombie.network.ServerOptions
// class, and writes a committed fixture that a client test diffs
// INI_SCHEMA (client/src/lib/serverConfigSchema.ts) against on every run.
//
// WHY THIS EXISTS: GH#182. INI_SCHEMA's VoiceMaxDistance was capped at 1000
// while the game accepts 0-100000, so the Server Settings form refused a
// value the server itself takes. The Sandbox tab already had this kind of
// gate (extract-sandbox-options.mjs + sandboxSchemaBoundsGroundTruth.test.ts);
// the INI table never did, so its ranges had drifted silently on several
// fields. This is the same technique pointed at ServerOptions.
//
// TECHNIQUE: every option is a literal constructor call in ServerOptions'
// own <init>:
//   this.field = new XServerOption(this, "Name", ...args)
// compiled as `new X; dup; aload_0; ldc "Name"; <args>; invokespecial
// X.<init>; putfield field`. Argument orders, hand-confirmed against each
// class's bytecode (javap -c on the 42.21 jar, GH#182):
//   BooleanServerOption(owner, name, default)
//   IntegerServerOption(owner, name, min, max, default)
//   DoubleServerOption(owner, name, min, max, default)
//   EnumServerOption(owner, name, numChoices, default) -- min is fixed at 1
//     (EnumConfigOption passes iconst_1 to IntegerConfigOption's min)
//   StringServerOption / TextServerOption(owner, name, default, maxLength)
// Out-of-range values are NOT clamped by the game: IntegerConfigOption /
// DoubleConfigOption.setValue() log and keep the previous value, so a
// panel range wider than the game's silently loses the operator's edit,
// and a narrower one blocks a value the game would have used.
//
// Usage: node scripts/jar-audit/extract-server-options.mjs <path-to-projectzomboid.jar>
// (no path -> defaults to the well-known dev machine location below)
// READ-ONLY on the jar. Never writes anything under the PZ install.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import unzipper from "unzipper";
import {
  constValue,
  decodeCodeWithImmediates,
  OPCODE_INT_PUSH,
  parseClassFile,
} from "./constructor-bytecode.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

const jarPath = process.argv[2] || "D:/SteamLibrary/steamapps/common/ProjectZomboid/projectzomboid.jar";
const appManifestPath = path.resolve(path.dirname(jarPath), "..", "..", "appmanifest_108600.acf");
const FIXTURE_PATH = path.join(REPO_ROOT, "server/__fixtures__/pzServerOptions.json");
const TARGET_CLASS = "zombie/network/ServerOptions.class";
const OPTION_CLASS_RE = /^zombie\/network\/ServerOptions\$(\w+)ServerOption$/;

if (!fs.existsSync(jarPath)) {
  console.error(`projectzomboid.jar not found at ${jarPath} -- pass the real path as an argument.`);
  process.exit(1);
}

function className(cp, classIdx) {
  const entry = cp[classIdx];
  return entry && entry.tag === 7 ? constValue(cp, entry.ref) : null;
}

function memberRef(cp, refIdx) {
  const ref = cp[refIdx];
  if (!ref || (ref.tag !== 9 && ref.tag !== 10 && ref.tag !== 11)) return null;
  const nameAndType = cp[ref.ref2];
  return {
    owner: className(cp, ref.ref1),
    name: nameAndType ? constValue(cp, nameAndType.ref1) : null,
  };
}

// Opcodes that leave a value on the stack this extractor cannot resolve to
// a literal (field reads, calls, loads). Seeing one between `new X` and
// X.<init> means an argument was computed, not written as a constant -- the
// record is flagged rather than trusted.
const NON_CONSTANT_PRODUCERS = new Set([
  0xb2, 0xb4, // getstatic getfield
  0xb6, 0xb8, 0xb9, 0xba, // invokevirtual invokestatic invokeinterface invokedynamic
  0x15, 0x16, 0x17, 0x18, // iload lload fload dload
  0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21, // iload_0..3 lload_0..3
  0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x29, // fload_0..3 dload_0..3
]);

function extractOptions(cp, instrs) {
  const records = [];
  let current = null;
  let awaitingPutfield = null;

  for (const instr of instrs) {
    const { op, cpIndex } = instr;

    if (awaitingPutfield && op === 0xb5) {
      awaitingPutfield.fieldName = memberRef(cp, cpIndex)?.name ?? null;
      awaitingPutfield = null;
      continue;
    }

    if (!current) {
      if (op === 0xbb) {
        const match = OPTION_CLASS_RE.exec(className(cp, cpIndex) ?? "");
        if (match) current = { kind: match[1], classRef: className(cp, cpIndex), name: null, args: [], nonConstant: false };
      }
      continue;
    }

    if (op in OPCODE_INT_PUSH) { current.args.push(OPCODE_INT_PUSH[op]); continue; }
    if (op === 0x10 || op === 0x11) { current.args.push(instr.imm); continue; } // bipush/sipush
    if (op === 0x0e) { current.args.push(0); continue; } // dconst_0
    if (op === 0x0f) { current.args.push(1); continue; } // dconst_1
    if (op === 0x01) { current.args.push(null); continue; } // aconst_null
    if (op === 0x12 || op === 0x13 || op === 0x14) {
      const v = constValue(cp, cpIndex);
      if (typeof v === "string" && current.name === null) current.name = v;
      else current.args.push(typeof v === "bigint" ? Number(v) : v);
      continue;
    }
    if (NON_CONSTANT_PRODUCERS.has(op)) { current.nonConstant = true; continue; }
    if (op === 0xb7) {
      const ref = memberRef(cp, cpIndex);
      if (ref && ref.owner === current.classRef && ref.name === "<init>") {
        records.push(current);
        awaitingPutfield = current;
        current = null;
      }
    }
  }
  return records;
}

function buildOptionMap(records) {
  const out = {};
  const skipped = [];
  for (const r of records) {
    const { kind, name, args, nonConstant, fieldName } = r;
    if (!name || nonConstant) { skipped.push({ name, kind, reason: nonConstant ? "computed argument" : "no name" }); continue; }
    let entry;
    if (kind === "Integer" && args.length === 3) entry = { type: "integer", min: args[0], max: args[1], default: args[2] };
    else if (kind === "Double" && args.length === 3) entry = { type: "double", min: args[0], max: args[1], default: args[2] };
    else if (kind === "Enum" && args.length === 2) entry = { type: "enum", min: 1, max: args[0], default: args[1] };
    else if (kind === "Boolean" && args.length === 1) entry = { type: "boolean", default: args[0] === 1 };
    else if ((kind === "String" || kind === "Text") && args.length === 2) entry = { type: kind === "Text" ? "text" : "string", default: args[0], maxLength: args[1] };
    else { skipped.push({ name, kind, reason: `unexpected argument shape (${args.length} args)` }); continue; }
    entry.fieldName = fieldName;
    out[name] = entry;
  }
  return { options: out, skipped };
}

const d = await unzipper.Open.file(jarPath);
const classEntry = d.files.find((f) => f.path === TARGET_CLASS);
if (!classEntry) {
  console.error(`${TARGET_CLASS} not found in ${jarPath}`);
  process.exit(1);
}
const { cp, methods } = parseClassFile(await classEntry.buffer());
const ctor = methods.find((m) => m.name === "<init>" && m.codeBytes);
if (!ctor) {
  console.error(`no constructor with a Code attribute found in ${TARGET_CLASS}`);
  process.exit(1);
}
const records = extractOptions(cp, decodeCodeWithImmediates(ctor.codeBytes));
const { options, skipped } = buildOptionMap(records);
for (const s of skipped) console.error(`SKIPPED ${s.kind} ${s.name ?? "(unnamed)"}: ${s.reason}`);

let buildId = null;
let gitVersionRevision = null;
try {
  const manifest = fs.readFileSync(appManifestPath, "utf8");
  buildId = manifest.match(/"buildid"\s*"(\d+)"/)?.[1] ?? null;
} catch {
  /* a bare dedicated-server install has no appmanifest two levels up --
     same handling as extract-sandbox-options.mjs. */
}
try {
  const gv = d.files.find((f) => f.path === "zombie/GitVersion.class");
  if (gv) {
    const parsed = parseClassFile(await gv.buffer());
    gitVersionRevision = parsed.cp.find((c) => c && c.tag === 1 && /^[0-9a-f]{10,12}$/i.test(c.value))?.value ?? null;
  }
} catch {
  /* optional supplementary identifier, see extract-sandbox-options.mjs */
}
// Human-readable game version: Core's static initializer builds
// `new GameVersion(major, minor, suffix)` with literal ints.
let gameVersion = null;
try {
  const core = d.files.find((f) => f.path === "zombie/core/Core.class");
  if (core) {
    const parsed = parseClassFile(await core.buffer());
    const clinit = parsed.methods.find((m) => m.name === "<clinit>" && m.codeBytes);
    const instrs = clinit ? decodeCodeWithImmediates(clinit.codeBytes) : [];
    const at = instrs.findIndex((i) => i.op === 0xbb && className(parsed.cp, i.cpIndex) === "zombie/core/GameVersion");
    const ints = instrs.slice(at + 1, at + 6)
      .map((i) => (i.op in OPCODE_INT_PUSH ? OPCODE_INT_PUSH[i.op] : i.op === 0x10 || i.op === 0x11 ? i.imm : null))
      .filter((v) => v !== null);
    if (at >= 0 && ints.length >= 2) gameVersion = `${ints[0]}.${ints[1]}`;
  }
} catch {
  /* optional, purely informational */
}

const fixture = {
  _provenance: {
    pzAppId: "108600",
    pzGameVersion: gameVersion,
    pzBuildId: buildId,
    pzGitVersionRevision: gitVersionRevision,
    extractedAt: new Date().toISOString().slice(0, 10),
    jarSourcePath: jarPath,
    optionsExtracted: Object.keys(options).length,
    skipped,
    technique:
      "Structural walk of zombie.network.ServerOptions's constructor bytecode (shared reader in " +
      "scripts/jar-audit/constructor-bytecode.mjs; not javap, not a strings pass). Each option's " +
      "min/max/default is read off the constant-pool arguments to its `new XServerOption(this, name, ...)` " +
      "call, per the argument orders in extract-server-options.mjs's header.",
    note:
      "client/src/lib/__tests__/iniSchemaBoundsGroundTruth.test.ts diffs INI_SCHEMA against this fixture " +
      "on every run. A disagreement means the schema drifted from the real game or this jar is a newer " +
      "build than the one the schema was last checked against.",
  },
  options,
};

fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + "\n", "utf8");
console.log(`Wrote fixture: ${FIXTURE_PATH}`);
console.log(`Extracted ${Object.keys(options).length} options (${skipped.length} skipped), build ${buildId ?? "(unknown, GitVersion " + gitVersionRevision + ")"}.`);
