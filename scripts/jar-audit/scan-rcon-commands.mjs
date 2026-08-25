#!/usr/bin/env node
// Reads every zombie/commands/serverCommands/*.class out of the real B42
// dedicated server jar and prints its true @CommandName (the literal RCON
// keyword -- often NOT the same as the class name), @CommandArgs/
// @AltCommandArgs (every valid argument-shape variant), @DisabledCommand,
// and @RequiredCapability, straight from the class file's own bytecode
// annotations. No guessing, no wiki, no reading our own comments.
//
// Usage:
//   node scripts/jar-audit/scan-rcon-commands.mjs <path-to-projectzomboid.jar>
//   node scripts/jar-audit/scan-rcon-commands.mjs <jar> --json
//   node scripts/jar-audit/scan-rcon-commands.mjs <jar> --class BanUserCommand
//
// See README.md in this directory for what this can and cannot tell you.

import unzipper from "unzipper";
import { parseClass } from "./classfile-parser.mjs";

const jarPath = process.argv[2];
if (!jarPath) {
  console.error("Usage: node scan-rcon-commands.mjs <path-to-projectzomboid.jar> [--json] [--class <Name>]");
  process.exit(1);
}
const asJson = process.argv.includes("--json");
const classFilterIdx = process.argv.indexOf("--class");
const classFilter = classFilterIdx !== -1 ? process.argv[classFilterIdx + 1] : null;

function annotationElements(classAnnotations, typeSuffix) {
  return classAnnotations.find((a) => a.type.endsWith(typeSuffix + ";"))?.elements ?? null;
}

// @CommandArgs's own elements shape (required/optional/argName), used both
// directly and inside each entry of an @AltCommandArgs array.
function describeArgs(elements) {
  if (!elements) return null;
  const parts = [];
  if (elements.argName) parts.push(`[${elements.argName}]`);
  if (elements.required) {
    const req = Array.isArray(elements.required) ? elements.required : [elements.required];
    parts.push(`required: ${req.join(" ")}`);
  }
  if (elements.optional) {
    const opt = Array.isArray(elements.optional) ? elements.optional : [elements.optional];
    parts.push(`optional: ${opt.join(" ")}`);
  }
  if (elements.varArgs !== undefined) parts.push("varArgs");
  return parts.join(", ") || "(no args)";
}

const d = await unzipper.Open.file(jarPath);
const targets = d.files.filter(
  (f) => f.path.startsWith("zombie/commands/serverCommands/") && f.path.endsWith(".class"),
);

const results = [];
for (const entry of targets) {
  const shortName = entry.path.split("/").pop().replace(/\.class$/, "");
  if (classFilter && shortName !== classFilter) continue;

  const buf = await entry.buffer();
  let info;
  try {
    info = parseClass(buf);
  } catch (err) {
    results.push({ class: shortName, error: err.message });
    continue;
  }

  const nameEl = annotationElements(info.classAnnotations, "CommandName");
  const namesEl = annotationElements(info.classAnnotations, "CommandNames");
  const names = namesEl
    ? [].concat(namesEl.value).map((v) => v?.elements?.name).filter(Boolean)
    : nameEl
      ? [nameEl.name]
      : [];

  const disabled = classAnnotationPresent(info.classAnnotations, "DisabledCommand");
  const capEl = annotationElements(info.classAnnotations, "RequiredCapability");
  const helpEl = annotationElements(info.classAnnotations, "CommandHelp");
  const argsEl = annotationElements(info.classAnnotations, "CommandArgs");
  const altArgsEl = annotationElements(info.classAnnotations, "AltCommandArgs");

  const argVariants = altArgsEl
    ? [].concat(altArgsEl.value).map((v) => describeArgs(v?.elements))
    : argsEl
      ? [describeArgs(argsEl)]
      : [];

  results.push({
    class: shortName,
    names,
    disabled,
    requiredCapability: capEl?.requiredCapability ?? null,
    helpText: helpEl?.helpText ?? null,
    argVariants,
  });
}

function classAnnotationPresent(classAnnotations, typeSuffix) {
  return classAnnotations.some((a) => a.type.endsWith(typeSuffix + ";"));
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  for (const r of results) {
    if (r.error) {
      console.log(`${r.class}: PARSE ERROR -- ${r.error}`);
      continue;
    }
    const nameStr = r.names.length ? r.names.join(" / ") : "(no @CommandName found)";
    console.log(`${r.class}  ->  ${nameStr}${r.disabled ? "  [DISABLED]" : ""}`);
    if (r.requiredCapability) console.log(`    capability: ${r.requiredCapability}`);
    for (const v of r.argVariants) console.log(`    args: ${v}`);
  }
  console.log(`\n${results.length} command classes scanned.`);
}
