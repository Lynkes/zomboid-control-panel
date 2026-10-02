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
const FIXTURE_PATH = path.join(REPO_ROOT, "server/__fixtures__/pzSandboxOptions.json");

if (!fs.existsSync(jarPath)) {
  console.error(`projectzomboid.jar not found at ${jarPath} -- pass the real path as an argument.`);
  process.exit(1);
}

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
