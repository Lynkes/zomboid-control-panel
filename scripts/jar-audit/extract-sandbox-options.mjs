#!/usr/bin/env node
// Extracts the real min/max/default/enum-choice-count for every Project
// Zomboid sandbox option out of the real B42 server jar's compiled
// zombie.SandboxOptions class (plus its five nested option-group classes:
// MultiplierConfig, ZombieLore, ZombieConfig, Map, Basement), and writes a
// committed fixture that a client test diffs SANDBOX_SCHEMA
// (client/src/lib/serverConfigSchema.ts) against on every test run.
//
// WHY THIS EXISTS: round 14/15 of the 2026-09-18 continuous-bug-hunt found
// SANDBOX_SCHEMA had drifted from the real game on ~70 fields -- some
// ranges tighter than the game's (annoying but harmless), some LOOSER
// (the dangerous direction: the panel's own validator accepts a value the
// real B42 sandbox loader then rejects, which is how an operator can save
// a setting that silently locks -- see server/tests or the client sandbox
// test suite for the specific incident this was dispatched from). A schema
// drifting quietly out of sync with the shipped game is invisible
// everywhere else: the TypeScript compiles, existing tests pass, the UI
// renders a perfectly normal-looking min/max. This fixture is what makes
// that drift visible again the next time the schema (or the game) changes.
//
// TECHNIQUE: this class's option definitions are literal constructor calls
// -- `this.field = this.newIntegerOption("Name", min, max, default)` etc.
// -- not built by a runtime loop, so a structural walk of the constructor's
// bytecode (not a flat strings/grep pass, and not `javap` -- no external
// JDK dependency, matching this directory's own existing scripts) recovers
// every option's real bounds exactly. Constructor argument order for each
// factory method was hand-confirmed against IntegerConfigOption/
// EnumConfigOption/DoubleConfigOption's own bytecode (see this repo's
// jim-mtvld337 hive memory, round 14, for the full derivation):
//   newIntegerOption(name, min, max, default)
//   newDoubleOption(name, min, max, default)
//   newBooleanOption(name, default)
//   newEnumOption(name, numChoices, default)  -- min is ALWAYS fixed at 1;
//     PZ's sandbox enum values are 1-based, not 0-based.
//   newStringOption(name, default, maxLen)
// StrongEnumSandboxOption (Java-enum-backed, e.g. InjurySeverity,
// DamageToPlayerFromHitByACar) uses a different constructor shape (a
// Class<EnumType> + enum constant, not two ints) and is NOT extracted here
// -- those fields are intentionally left out of the fixture; the
// comparison test allowlists them.
//
// Usage: node scripts/jar-audit/extract-sandbox-options.mjs <path-to-projectzomboid.jar>
// (no path -> defaults to the well-known dev machine location below)
// READ-ONLY on the jar. Never writes anything under the PZ install.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import unzipper from "unzipper";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../..");

const jarPath = process.argv[2] || "D:/SteamLibrary/steamapps/common/ProjectZomboid/projectzomboid.jar";
const appManifestPath = path.resolve(path.dirname(jarPath), "..", "..", "appmanifest_108600.acf");
const FIXTURE_PATH = path.join(REPO_ROOT, "server/__fixtures__/pzSandboxOptions.json");

if (!fs.existsSync(jarPath)) {
  console.error(`projectzomboid.jar not found at ${jarPath} -- pass the real path as an argument.`);
  process.exit(1);
}

// ---- minimal structural class-file parser (constant pool + one method's
// Code attribute) -- self-contained rather than extending
// classfile-parser.mjs, which deliberately skips attribute bodies
// (bytecode) entirely; see that file's own header for why. Correctly
// reconstructs IEEE754 double constants (the shared parser's generic
// Long/Double handling combines the two halves with plain arithmetic,
// which is right for a signed 64-bit long but NOT for a double's bit
// pattern -- this parser reads the 8 bytes into a Buffer and uses
// readDoubleBE, which is).
function parseClassFile(buf) {
  let p = 0;
  const u1 = () => buf[p++];
  const u2 = () => { const v = buf.readUInt16BE(p); p += 2; return v; };
  const u4 = () => { const v = buf.readUInt32BE(p); p += 4; return v; };

  if (u4() !== 0xcafebabe) throw new Error("not a Java class file");
  u2(); u2(); // minor, major

  const cpCount = u2();
  const cp = new Array(cpCount);
  for (let i = 1; i < cpCount; i++) {
    const tag = u1();
    switch (tag) {
      case 1: { const len = u2(); cp[i] = { tag, value: buf.slice(p, p + len).toString("utf8") }; p += len; break; }
      case 7: case 8: case 16: case 19: case 20: cp[i] = { tag, ref: u2() }; break;
      case 15: cp[i] = { tag, refKind: u1(), ref: u2() }; break;
      case 9: case 10: case 11: case 12: case 17: case 18: cp[i] = { tag, ref1: u2(), ref2: u2() }; break;
      case 3: cp[i] = { tag, value: buf.readInt32BE(p) }; p += 4; break; // Integer
      case 4: cp[i] = { tag, value: buf.readFloatBE(p) }; p += 4; break; // Float
      case 5: cp[i] = { tag, value: buf.readBigInt64BE(p) }; p += 8; i++; break; // Long (2 slots)
      case 6: cp[i] = { tag, value: buf.readDoubleBE(p) }; p += 8; i++; break; // Double (2 slots)
      default: throw new Error(`unknown constant pool tag ${tag} at index ${i}`);
    }
  }
  const utf8 = (idx) => (cp[idx] && cp[idx].tag === 1 ? cp[idx].value : null);

  u2(); // access_flags
  u2(); // this_class
  u2(); // super_class
  const ifaceCount = u2();
  p += ifaceCount * 2;

  function skipAttributes() {
    const count = u2();
    for (let i = 0; i < count; i++) { u2(); const len = u4(); p += len; }
  }
  const fieldsCount = u2();
  for (let i = 0; i < fieldsCount; i++) { u2(); u2(); u2(); skipAttributes(); }

  const methodsCount = u2();
  const methods = [];
  for (let i = 0; i < methodsCount; i++) {
    u2(); // access_flags
    const nameIdx = u2();
    const descIdx = u2();
    const attrCount = u2();
    let codeBytes = null;
    for (let a = 0; a < attrCount; a++) {
      const attrNameIdx = u2();
      const len = u4();
      const attrName = utf8(attrNameIdx);
      const attrEnd = p + len;
      if (attrName === "Code") {
        u2(); // max_stack
        u2(); // max_locals
        const codeLen = u4();
        codeBytes = buf.slice(p, p + codeLen);
      }
      p = attrEnd;
    }
    methods.push({ name: utf8(nameIdx), descriptor: utf8(descIdx), codeBytes });
  }
  return { cp, methods };
}

// Operand byte-length for every standard JVM opcode with a fixed-size
// immediate operand (JVMS 6.5); everything not listed here takes 0.
// tableswitch/lookupswitch/wide are variable-length and handled specially
// below -- a straight-line constructor calling factory methods in sequence
// is never expected to contain one, so hitting one is treated as fatal
// (loud failure beats silently misreading the rest of the stream).
const FIXED_OPERAND_LEN = {
  0x10: 1, 0x11: 2, 0x12: 1, 0x13: 2, 0x14: 2, // bipush sipush ldc ldc_w ldc2_w
  0x15: 1, 0x16: 1, 0x17: 1, 0x18: 1, 0x19: 1, // iload lload fload dload aload
  0x36: 1, 0x37: 1, 0x38: 1, 0x39: 1, 0x3a: 1, // istore lstore fstore dstore astore
  0x84: 2, // iinc
  0x99: 2, 0x9a: 2, 0x9b: 2, 0x9c: 2, 0x9d: 2, 0x9e: 2, // ifeq..ifle
  0x9f: 2, 0xa0: 2, 0xa1: 2, 0xa2: 2, 0xa3: 2, 0xa4: 2, // if_icmp*
  0xa5: 2, 0xa6: 2, // if_acmp*
  0xa7: 2, 0xa8: 2, 0xa9: 1, // goto jsr ret
  0xb2: 2, 0xb3: 2, 0xb4: 2, 0xb5: 2, // getstatic putstatic getfield putfield
  0xb6: 2, 0xb7: 2, 0xb8: 2, // invokevirtual invokespecial invokestatic
  0xb9: 4, 0xba: 4, // invokeinterface invokedynamic
  0xbb: 2, 0xbc: 1, 0xbd: 2, // new newarray anewarray
  0xc0: 2, 0xc1: 2, // checkcast instanceof
  0xc5: 3, 0xc6: 2, 0xc7: 2, // multianewarray ifnull ifnonnull
  0xc8: 4, 0xc9: 4, // goto_w jsr_w
};
const VARIABLE_LEN_OPCODES = new Set([0xaa, 0xab, 0xc4]); // tableswitch lookupswitch wide

// Decodes a Code attribute's raw bytes into {op, cpIndex?}[] -- cpIndex is
// resolved for the opcodes this extractor actually cares about (ldc/
// ldc_w/ldc2_w, putfield, invoke*); every other opcode with operands is
// correctly SKIPPED (so the stream stays in sync) but not decoded further.
function decodeCode(codeBytes) {
  const instrs = [];
  let p = 0;
  while (p < codeBytes.length) {
    const op = codeBytes[p];
    const start = p;
    p += 1;
    if (VARIABLE_LEN_OPCODES.has(op)) {
      throw new Error(`hit variable-length opcode 0x${op.toString(16)} at offset ${start} -- extractor does not support tableswitch/lookupswitch/wide`);
    }
    const len = FIXED_OPERAND_LEN[op] || 0;
    let cpIndex = null;
    if (op === 0x12) cpIndex = codeBytes[p]; // ldc: 1-byte index
    else if (op === 0x13 || op === 0x14) cpIndex = codeBytes.readUInt16BE(p); // ldc_w/ldc2_w: 2-byte
    else if (len === 2 && (op === 0xb2 || op === 0xb3 || op === 0xb4 || op === 0xb5 || op === 0xb6 || op === 0xb7 || op === 0xb8 || op === 0xbb || op === 0xc0 || op === 0xc1)) {
      cpIndex = codeBytes.readUInt16BE(p);
    }
    instrs.push({ op, cpIndex });
    p += len;
  }
  return instrs;
}

function constValue(cp, idx) {
  const entry = cp[idx];
  if (!entry) return null;
  if (entry.tag === 1) return entry.value; // Utf8 (used for e.g. String constant's ref target)
  if (entry.tag === 3) return entry.value; // Integer
  if (entry.tag === 4) return entry.value; // Float
  if (entry.tag === 5) return entry.value; // Long (BigInt)
  if (entry.tag === 6) return entry.value; // Double
  if (entry.tag === 8) return constValue(cp, entry.ref); // String -> its Utf8
  return null;
}

const OPCODE_INT_PUSH = {
  0x02: -1, 0x03: 0, 0x04: 1, 0x05: 2, 0x06: 3, 0x07: 4, 0x08: 5, // iconst_m1..5
};

// Walks a constructor's decoded instructions with the same state machine
// validated by hand in round 14 (seeking the option-name string constant,
// collecting the numeric/string args that follow, recording on the
// `new*Option` factory call, then ignoring chained .setTranslation()/
// .setValueTranslation() calls until the putfield that ends the whole
// statement) -- reimplemented here over structured {op,cpIndex} objects
// instead of javap's text output, which eliminates the two classes of bug
// that round 14 hit against text (CRLF line endings, and javap switching
// ldc->ldc_w / printing scientific notation past certain thresholds):
// there is no text round-trip here at all, every value comes straight from
// the constant pool.
function extractOptions(cp, instrs) {
  const records = [];
  let state = "seeking";
  let pendingName = null;
  let pendingArgs = [];

  for (const instr of instrs) {
    const { op, cpIndex } = instr;

    if (state === "seeking") {
      if (op === 0x12 || op === 0x13) {
        const v = constValue(cp, cpIndex);
        if (typeof v === "string") { pendingName = v; pendingArgs = []; state = "collecting"; }
      }
      continue;
    }

    if (state === "collecting") {
      if (op in OPCODE_INT_PUSH) { pendingArgs.push(OPCODE_INT_PUSH[op]); continue; }
      if (op === 0x10 || op === 0x11) { pendingArgs.push(instr.imm); continue; } // bipush/sipush handled below
      if (op === 0x0e) { pendingArgs.push(0.0); continue; } // dconst_0
      if (op === 0x0f) { pendingArgs.push(1.0); continue; } // dconst_1
      if (op === 0x12 || op === 0x13 || op === 0x14) {
        const v = constValue(cp, cpIndex);
        // newStringOption(name, defaultValue, maxLen) pushes a SECOND
        // string (the default) while still collecting args for the same
        // option -- push it as a plain arg like any numeric one, don't
        // treat it as a fresh option name (an earlier version of this
        // extractor did, which silently ate WorldItemRemovalList's own
        // record and replaced it with a bogus entry keyed on that
        // default string).
        if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") { pendingArgs.push(Number(v) || v); continue; }
      }
      if (op === 0xb6 && cpIndex != null) {
        // invokevirtual -- is it one of the new*Option factory methods?
        const methodRef = cp[cpIndex];
        if (methodRef && (methodRef.tag === 10 || methodRef.tag === 11)) {
          const nameAndType = cp[methodRef.ref2];
          const methodName = nameAndType ? constValue(cp, nameAndType.ref1) : null;
          if (methodName && /^new\w+Option$/.test(methodName)) {
            records.push({ method: methodName, optionName: pendingName, args: pendingArgs.slice() });
            state = "post";
            continue;
          }
        }
      }
      continue;
    }

    if (state === "post") {
      if (op === 0xb5 && cpIndex != null) { // putfield
        const fieldRef = cp[cpIndex];
        const nameAndType = fieldRef ? cp[fieldRef.ref2] : null;
        const fieldName = nameAndType ? constValue(cp, nameAndType.ref1) : null;
        records[records.length - 1].fieldName = fieldName;
        state = "seeking"; pendingName = null; pendingArgs = [];
      }
      continue;
    }
  }
  return records;
}

// bipush/sipush operands need the raw immediate byte(s), not a cp lookup --
// re-decode with immediates attached (decodeCode() above only resolves
// cpIndex for opcodes that need one; this second pass adds `imm` for the
// two integer-immediate opcodes extractOptions() also consumes).
function decodeCodeWithImmediates(codeBytes) {
  const instrs = decodeCode(codeBytes);
  let p = 0;
  for (const instr of instrs) {
    const { op } = instr;
    p += 1;
    if (op === 0x10) instr.imm = codeBytes.readInt8(p);
    else if (op === 0x11) instr.imm = codeBytes.readInt16BE(p);
    p += FIXED_OPERAND_LEN[op] || 0;
  }
  return instrs;
}

function buildOptionMap(records) {
  const out = {};
  for (const r of records) {
    const { method, optionName, args, fieldName } = r;
    let entry;
    if (method === "newIntegerOption") entry = { type: "integer", min: args[0], max: args[1], default: args[2] };
    else if (method === "newDoubleOption") entry = { type: "double", min: args[0], max: args[1], default: args[2] };
    else if (method === "newBooleanOption") entry = { type: "boolean", default: args[0] };
    else if (method === "newEnumOption" && args.length === 2) entry = { type: "enum", min: 1, max: args[0], default: args[1] };
    else if (method === "newStringOption") entry = { type: "string", default: args[0] };
    else continue; // StrongEnumSandboxOption's newEnumOption(String,Class,Enum) overload -- 0 numeric args; intentionally not extracted, see header comment.
    entry.fieldName = fieldName;
    out[optionName] = entry;
  }
  return out;
}

// { entryClassPath, ctorDescriptorPrefix, qualifiedPrefix }
// qualifiedPrefix is prepended nowhere -- the option names embedded in the
// bytecode are ALREADY fully qualified for the nested classes (e.g.
// "MultiplierConfig.Fitness"), matching SANDBOX_SCHEMA's own
// `${section}.${key}` convention exactly.
const TARGET_CLASSES = [
  "zombie/SandboxOptions.class",
  "zombie/SandboxOptions$MultiplierConfig.class",
  "zombie/SandboxOptions$ZombieLore.class",
  "zombie/SandboxOptions$ZombieConfig.class",
  "zombie/SandboxOptions$Map.class",
  "zombie/SandboxOptions$Basement.class",
];

const d = await unzipper.Open.file(jarPath);
let allOptions = {};
let classesScanned = 0;
for (const classPath of TARGET_CLASSES) {
  const entry = d.files.find((f) => f.path === classPath);
  if (!entry) {
    console.error(`WARNING: ${classPath} not found in jar -- skipping (fixture will be missing its options)`);
    continue;
  }
  const buf = await entry.buffer();
  const { cp, methods } = parseClassFile(buf);
  // The constructor is always named "<init>"; SandboxOptions' own
  // constructor takes no args ("()V"), the five nested classes each take
  // one (SandboxOptions) arg ("(Lzombie/SandboxOptions;)V") -- either way
  // there is exactly one <init> with a Code attribute worth walking.
  const ctor = methods.find((m) => m.name === "<init>" && m.codeBytes);
  if (!ctor) {
    console.error(`WARNING: no constructor with a Code attribute found in ${classPath}`);
    continue;
  }
  const instrs = decodeCodeWithImmediates(ctor.codeBytes);
  const records = extractOptions(cp, instrs);
  const options = buildOptionMap(records);
  allOptions = { ...allOptions, ...options };
  classesScanned++;
  console.error(`${classPath} -> ${Object.keys(options).length} options`);
}

let buildId = null;
let gitVersionRevision = null;
try {
  const manifest = fs.readFileSync(appManifestPath, "utf8");
  buildId = manifest.match(/"buildid"\s*"(\d+)"/)?.[1] ?? null;
} catch {
  /* see extract-rcon-rejection-strings.mjs's identical handling -- not
     every jar location (e.g. a bare dedicated-server install) has an
     appmanifest_108600.acf two directories up. */
}
try {
  const gv = d.files.find((f) => f.path === "zombie/GitVersion.class");
  if (gv) {
    const { cp } = parseClassFile(await gv.buffer());
    const revisionStrings = cp.filter((c) => c && c.tag === 1 && /^[0-9a-f]{10,12}$/i.test(c.value));
    gitVersionRevision = revisionStrings[0]?.value ?? null;
  }
} catch {
  /* optional, purely a supplementary traceable identifier -- see
     extract-rcon-rejection-strings.mjs's own precedent for using it when
     pzBuildId can't be resolved (round 10 of the same hunt). */
}
if (!buildId) {
  console.error(
    `WARNING: could not determine pzBuildId (looked for ${appManifestPath}). ` +
    "Falling back to zombie.GitVersion's embedded revision string as a traceable identifier.",
  );
}

const fixture = {
  _provenance: {
    pzAppId: "108600",
    pzBuildId: buildId,
    pzGitVersionRevision: gitVersionRevision,
    extractedAt: new Date().toISOString().slice(0, 10),
    jarSourcePath: jarPath,
    classesScanned,
    optionsExtracted: Object.keys(allOptions).length,
    technique:
      "Structural walk of zombie.SandboxOptions's (+ 5 nested option-group classes') own constructor " +
      "bytecode -- a self-contained class-file + Code-attribute parser in this script (not `javap`, no " +
      "external JDK dependency; not a flat strings/grep pass). Every field's min/max/default is read " +
      "directly off the constant-pool arguments to its `new*Option(...)` factory call, per the argument " +
      "orders documented in this script's own header comment. StrongEnumSandboxOption fields " +
      "(Java-enum-backed, e.g. InjurySeverity) are NOT extracted -- see header.",
    note:
      "client/src/lib/__tests__/sandboxSchemaGroundTruth.test.ts diffs SANDBOX_SCHEMA against this " +
      "fixture on every run. An option missing here that exists in the schema, or vice versa, or a " +
      "min/max/default disagreement, means either the schema has drifted from the real game or this jar " +
      "is a different build than the one the schema was last checked against -- not a fixture bug.",
  },
  options: allOptions,
};

fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
fs.writeFileSync(FIXTURE_PATH, JSON.stringify(fixture, null, 2) + "\n", "utf8");
console.log(`Wrote fixture: ${FIXTURE_PATH}`);
console.log(`Scanned ${classesScanned} classes, extracted ${Object.keys(allOptions).length} options, build ${buildId ?? "(unknown, see GitVersion revision " + gitVersionRevision + ")"}.`);
