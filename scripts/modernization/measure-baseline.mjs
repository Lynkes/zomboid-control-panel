#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";

function usage() {
  console.error("usage: node scripts/modernization/measure-baseline.mjs --base-url http://127.0.0.1:3001 --route name=/api/auth/status [--route name=/api/server/status] [--samples 50] [--warmup 5] --out <file>");
  process.exit(2);
}

const args = process.argv.slice(2);
const options = { routes: [], samples: 50, warmup: 5 };
for (let index = 0; index < args.length; index += 1) {
  const key = args[index];
  const value = args[index + 1];
  if (key === "--base-url") options.baseUrl = value;
  else if (key === "--route") options.routes.push(value);
  else if (key === "--samples") options.samples = Number(value);
  else if (key === "--warmup") options.warmup = Number(value);
  else if (key === "--out") options.out = value;
  else usage();
  index += 1;
}

if (!options.baseUrl || !options.out || options.routes.length === 0) usage();
if (!Number.isInteger(options.samples) || options.samples < 1 || options.samples > 1000) usage();
if (!Number.isInteger(options.warmup) || options.warmup < 0 || options.warmup > 100) usage();

const routes = options.routes.map((entry) => {
  const equals = entry.indexOf("=");
  if (equals <= 0 || equals === entry.length - 1) usage();
  return { name: entry.slice(0, equals), routePath: entry.slice(equals + 1) };
});

const headers = {};
if (process.env.ZCP_ACCESS_TOKEN) headers.Authorization = `Bearer ${process.env.ZCP_ACCESS_TOKEN}`;

function percentile(sorted, fraction) {
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

async function measure(target) {
  const url = new URL(target.routePath, options.baseUrl).toString();
  const timings = [];
  for (let index = 0; index < options.warmup + options.samples; index += 1) {
    const started = performance.now();
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(10_000) });
    await response.arrayBuffer();
    const duration = performance.now() - started;
    if (!response.ok) throw new Error(`${target.name} returned HTTP ${response.status}`);
    if (index >= options.warmup) timings.push(duration);
  }
  timings.sort((left, right) => left - right);
  return {
    name: target.name,
    method: "GET",
    path: target.routePath,
    samples: timings.length,
    warmup_samples: options.warmup,
    p50_ms: Number(percentile(timings, 0.50).toFixed(3)),
    p95_ms: Number(percentile(timings, 0.95).toFixed(3)),
    max_ms: Number(timings.at(-1).toFixed(3)),
    rss_bytes: process.memoryUsage().rss,
  };
}

const measurements = [];
for (const route of routes) measurements.push(await measure(route));

const output = {
  work_package: "FND-001",
  git_sha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  captured_at: new Date().toISOString(),
  environment: `${process.platform}-${process.arch}; ${options.baseUrl}`,
  measurements,
};

const destination = path.resolve(options.out);
fs.mkdirSync(path.dirname(destination), { recursive: true });
fs.writeFileSync(destination, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`WROTE ${destination}`);
