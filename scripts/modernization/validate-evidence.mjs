#!/usr/bin/env node
// Field lists below (assertKeys allow-lists, required checks) are a hand-rolled mirror of
// docs/modernization/templates/RESULTS.schema.json and PERF.schema.json. Nothing enforces
// the two stay in sync -- if either schema file changes, update this validator to match.
import fs from "node:fs";
import path from "node:path";

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

const rawArgs = process.argv.slice(2);
let resultsPath;
let perfPath;
for (let index = 0; index < rawArgs.length; index += 1) {
  const arg = rawArgs[index];
  if (arg === "--results") resultsPath = rawArgs[++index];
  else if (arg === "--perf") perfPath = rawArgs[++index];
  else if (!resultsPath) resultsPath = arg;
  else if (!perfPath) perfPath = arg;
  else {
    console.error(`unexpected argument: ${arg}`);
    process.exit(2);
  }
}
if (!resultsPath) {
  console.error("usage: node scripts/modernization/validate-evidence.mjs <RESULTS.json> [PERF.json]");
  console.error("   or: node scripts/modernization/validate-evidence.mjs --results <RESULTS.json> [--perf <PERF.json>]");
  process.exit(2);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(file), "utf8"));
  } catch (error) {
    fail(`${file}: ${error.message}`);
  }
}

function isDateTime(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function isSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}
function isWp(value) {
  return typeof value === "string" && /^[A-Z][A-Z0-9]*-[0-9]{3}$/.test(value);
}
function isNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0;
}
function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
}
function assertKeys(value, allowed, label) {
  assertObject(value, label);
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) fail(`${label} has unknown fields: ${extras.join(", ")}`);
}

const result = readJson(resultsPath);
assertKeys(result, [
  "work_package", "git_sha", "baseline_sha", "started_at", "finished_at",
  "feature_flags", "commands", "outcome", "blocked_reason", "known_risks", "evidence_files",
], "results");
if (!isWp(result.work_package)) fail("invalid work_package");
if (!isSha(result.git_sha)) fail("invalid git_sha");
if (result.baseline_sha !== undefined && !isSha(result.baseline_sha)) fail("invalid baseline_sha");
if (!isDateTime(result.started_at) || !isDateTime(result.finished_at)) fail("invalid timestamps");
if (!Array.isArray(result.commands)) fail("commands must be an array");
if (!["passed", "failed", "blocked"].includes(result.outcome)) fail("invalid outcome");
if (result.outcome !== "blocked" && result.commands.length === 0) fail("passed/failed outcome requires commands");
if (result.outcome === "blocked" && (typeof result.blocked_reason !== "string" || result.blocked_reason.length === 0 || result.blocked_reason.length > 2000)) fail("blocked outcome requires bounded blocked_reason");
if (result.feature_flags !== undefined) {
  assertObject(result.feature_flags, "feature_flags");
  for (const [key, value] of Object.entries(result.feature_flags)) {
    if (!["boolean", "string", "number"].includes(typeof value) && value !== null) fail(`feature_flags.${key}`);
    if (typeof value === "number" && !Number.isFinite(value)) fail(`feature_flags.${key}`);
  }
}
for (const field of ["known_risks", "evidence_files"]) {
  if (result[field] !== undefined && (!Array.isArray(result[field]) || result[field].some((item) => typeof item !== "string"))) fail(`${field} must be a string array`);
}
for (const [index, command] of result.commands.entries()) {
  assertKeys(command, ["command", "cwd", "exit_code", "duration_ms", "tests_passed", "tests_failed", "tests_skipped", "output_excerpt"], `commands[${index}]`);
  if (typeof command.command !== "string" || command.command.length === 0) fail(`commands[${index}].command`);
  if (typeof command.cwd !== "string" || command.cwd.length === 0) fail(`commands[${index}].cwd`);
  if (!Number.isInteger(command.exit_code)) fail(`commands[${index}].exit_code`);
  if (!isNonNegativeInteger(command.duration_ms)) fail(`commands[${index}].duration_ms`);
  for (const field of ["tests_passed", "tests_failed", "tests_skipped"]) {
    if (command[field] !== undefined && !isNonNegativeInteger(command[field])) fail(`commands[${index}].${field}`);
  }
  if (command.output_excerpt !== undefined && (typeof command.output_excerpt !== "string" || command.output_excerpt.length > 4000)) fail(`commands[${index}].output_excerpt`);
}
console.log(`PASS results=${path.resolve(resultsPath)}`);

if (perfPath) {
  const perf = readJson(perfPath);
  assertKeys(perf, ["work_package", "git_sha", "captured_at", "environment", "measurements"], "perf");
  if (!isWp(perf.work_package) || !isSha(perf.git_sha) || !isDateTime(perf.captured_at)) fail("invalid PERF identity fields");
  if (perf.environment !== undefined && typeof perf.environment !== "string") fail("perf.environment");
  if (!Array.isArray(perf.measurements) || perf.measurements.length === 0) fail("PERF measurements required");
  for (const [index, item] of perf.measurements.entries()) {
    assertKeys(item, ["name", "method", "path", "samples", "warmup_samples", "p50_ms", "p95_ms", "max_ms", "rss_bytes", "bundle_bytes"], `measurements[${index}]`);
    if (typeof item.name !== "string" || item.name.length === 0) fail(`measurements[${index}].name`);
    for (const field of ["method", "path"]) {
      if (item[field] !== undefined && typeof item[field] !== "string") fail(`measurements[${index}].${field}`);
    }
    if (!isNonNegativeInteger(item.samples) || item.samples < 1) fail(`measurements[${index}].samples`);
    for (const field of ["p50_ms", "p95_ms"]) {
      if (typeof item[field] !== "number" || !Number.isFinite(item[field]) || item[field] < 0) fail(`measurements[${index}].${field}`);
    }
    for (const field of ["warmup_samples", "rss_bytes", "bundle_bytes"]) {
      if (item[field] !== undefined && !isNonNegativeInteger(item[field])) fail(`measurements[${index}].${field}`);
    }
    if (item.max_ms !== undefined && (typeof item.max_ms !== "number" || !Number.isFinite(item.max_ms) || item.max_ms < 0)) fail(`measurements[${index}].max_ms`);
  }
  console.log(`PASS perf=${path.resolve(perfPath)}`);
}
