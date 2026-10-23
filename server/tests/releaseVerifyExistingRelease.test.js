import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// release-artifacts.yml's "Verify existing release points to this tag commit"
// step read `gh api .../releases/tags/<tag> --jq .target_commitish || true`
// as the release's target. When the release doesn't exist yet, gh api exits
// non-zero but still prints the 404 body (JSON) on stdout, so the step took
// that JSON for a commit, the next gh api call failed, and the step failed
// instead of reaching its own "No existing release" branch.
//
// The step's script runs for real here, with gh stubbed on PATH. POSIX only
// (bash and a shell-script stub); CI runs it on ubuntu.

const WORKFLOW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.github/workflows/release-artifacts.yml");
const STEP = "Verify existing release points to this tag commit";
const posix = process.platform !== "win32";
const tempDirs = [];

// The step's `run: |` block, dedented.
function stepScript() {
  const lines = fs.readFileSync(WORKFLOW, "utf8").replace(/\r\n/g, "\n").split("\n");
  const name = lines.findIndex((line) => line.trim() === `- name: ${STEP}`);
  if (name < 0) throw new Error(`step not found: ${STEP}`);
  const run = lines.findIndex((line, index) => index > name && line.trim() === "run: |");
  const indent = lines[run + 1].match(/^ */)[0].length;
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && line.match(/^ */)[0].length < indent) break;
    body.push(line.slice(indent));
  }
  return body.join("\n");
}

// gh stub: the release lookup answers with `release` (null = 404, the body
// on stdout and exit 1, as gh api does), the commit lookup with `sha`.
function runStep({ release, sha }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-release-verify-"));
  tempDirs.push(root);
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin);
  const gh = path.join(bin, "gh");
  const notFound = '{"message":"Not Found","documentation_url":"https://docs.github.com/rest/releases/releases#get-a-release-by-tag-name","status":"404"}';
  fs.writeFileSync(gh, [
    "#!/bin/sh",
    'case "$2" in',
    release === null
      ? `  */releases/tags/*) echo '${notFound}'; echo 'gh: Not Found (HTTP 404)' >&2; exit 1 ;;`
      : `  */releases/tags/*) echo '${release}'; exit 0 ;;`,
    `  */commits/*) echo '${sha}'; exit 0 ;;`,
    "esac",
    "exit 2",
    "",
  ].join("\n"));
  fs.chmodSync(gh, 0o755);
  return spawnSync("bash", ["-c", stepScript()], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_REF_NAME: "v9.9.9",
      GITHUB_REPOSITORY: "owner/repo",
      GITHUB_SHA: "1111111111111111111111111111111111111111",
      GH_TOKEN: "unused",
    },
    encoding: "utf8",
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!posix)("release-artifacts: verify an existing release before replacing its assets", () => {
  it("goes on when the tag has no release yet", () => {
    const result = runStep({ release: null, sha: "unused" });
    expect(result.stderr).not.toContain("::error::");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("No existing release for v9.9.9");
  });

  it("goes on when the release targets the commit being built", () => {
    const result = runStep({ release: "main", sha: "1111111111111111111111111111111111111111" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Existing release v9.9.9 targets the current tag commit.");
  });

  it("refuses when the release targets another commit", () => {
    const result = runStep({ release: "main", sha: "2222222222222222222222222222222222222222" });
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain("::error::Existing release v9.9.9 targets 2222222222222222222222222222222222222222");
  });
});
