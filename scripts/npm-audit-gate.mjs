#!/usr/bin/env node
// Fork-only, used by .github/workflows/security-scan.yml. Reads `npm audit
// --json` on stdin and fails only for a package that is vulnerable itself (an
// advisory of its own, not one it inherits from a dependency) at moderate or
// worse, with a fix available. An advisory with no fix yet -- braces, pulled
// by Tailwind and chokidar at build time -- is listed, not failed: otherwise
// the scan would stay red until upstream ships one, and stop meaning anything.
//
// Usage:
//   npm audit --package-lock-only [--omit=dev] --json \
//     | node scripts/npm-audit-gate.mjs <label> [--warn-only]
// Annotates the run (::error / ::warning), appends a table to
// $GITHUB_STEP_SUMMARY when it is set, and exits 1 on a failure unless
// --warn-only.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

export function evaluateAudit(report, { failAt = "moderate" } = {}) {
  const failures = [];
  const notices = [];
  for (const [name, entry] of Object.entries(report?.vulnerabilities ?? {})) {
    const advisories = (entry.via ?? []).filter((via) => via && typeof via === "object");
    const inheritedFrom = (entry.via ?? []).filter((via) => typeof via === "string");
    const item = {
      name,
      severity: entry.severity,
      advisories: advisories.map((advisory) => ({
        title: advisory.title,
        url: advisory.url,
        range: advisory.range,
      })),
      inheritedFrom,
      fixAvailable: entry.fixAvailable !== false,
    };
    const severe = (SEVERITY_RANK[entry.severity] ?? 0) >= SEVERITY_RANK[failAt];
    if (severe && advisories.length > 0 && item.fixAvailable) failures.push(item);
    else notices.push(item);
  }
  return { failures, notices };
}

function describe(item) {
  if (item.advisories.length > 0) {
    return item.advisories.map((advisory) => `${advisory.title} (${advisory.url})`).join("; ");
  }
  return `through ${item.inheritedFrom.join(", ")}`;
}

function summaryTable(label, { failures, notices }) {
  const rows = [
    ...failures.map((item) => `| ${item.name} | ${item.severity} | fix available: **update it** | ${describe(item)} |`),
    ...notices.map((item) => `| ${item.name} | ${item.severity} | ${item.advisories.length === 0 ? "inherited" : item.fixAvailable ? "below the threshold" : "no fix yet"} | ${describe(item)} |`),
  ];
  if (rows.length === 0) return `### npm audit: ${label}\n\nNo advisories.\n\n`;
  return [
    `### npm audit: ${label}`,
    "",
    "| Package | Severity | Status | Advisory |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
    "",
  ].join("\n");
}

async function main() {
  const [label = "dependencies", ...flags] = process.argv.slice(2);
  const warnOnly = flags.includes("--warn-only");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  // No output at all means npm audit never ran: not a clean bill of health.
  if (!input.trim()) {
    console.log(`::error::npm audit (${label}) produced no report`);
    process.exit(1);
  }
  const report = JSON.parse(input);
  if (report.error) {
    console.log(`::error::npm audit (${label}) failed: ${report.error.summary || report.error.code}`);
    process.exit(1);
  }
  const result = evaluateAudit(report);
  for (const item of result.failures) {
    console.log(`::${warnOnly ? "warning" : "error"}::${label}: ${item.name} (${item.severity}) has a fix available -- ${describe(item)}`);
  }
  for (const item of result.notices.filter((notice) => notice.advisories.length > 0)) {
    console.log(`::warning::${label}: ${item.name} (${item.severity}) ${item.fixAvailable ? "" : "has no fix yet "}-- ${describe(item)}`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summaryTable(label, result));
  console.log(`${label}: ${result.failures.length} to update, ${result.notices.length} listed`);
  if (result.failures.length > 0 && !warnOnly) process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
