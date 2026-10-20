import { describe, expect, it } from "vitest";
import fs from "fs";

// Supply-chain review 2026-10-20: what reaches users' machines must come
// from a reviewed release, built from exactly what the lockfiles pin, by a
// job whose write token no build dependency can read.

const readRepoFile = (relativePath) =>
  fs.readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");

// The text of one top-level job of a workflow (from "  <name>:" to the next
// two-space-indented key or the end of the file).
function jobText(workflow, name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  expect(start, `job ${name}`).toBeGreaterThan(-1);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[A-Za-z0-9_-]+:\n/);
  const text = next === -1 ? rest : rest.slice(0, next + 1);
  // Without comment lines: only what runs counts.
  return text.split("\n").filter((line) => !line.trim().startsWith("#")).join("\n");
}

describe("demo site deploy", () => {
  const workflow = readRepoFile(".github/workflows/demo-pages.yml");

  it("is read-only by default", () => {
    const header = workflow.slice(0, workflow.indexOf("\njobs:"));
    expect(header).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(header).not.toContain("contents: write");
  });

  it("builds without a write token and without a persisted checkout token", () => {
    const build = jobText(workflow, "build");
    expect(build).toMatch(/permissions:\n {6}contents: read\n/);
    expect(build).not.toMatch(/:\s*write\b/);
    expect(build).toContain("persist-credentials: false");
    expect(build).toContain("npm ci");
    expect(build).not.toMatch(/npm install/);
    expect(build).not.toContain("actions-gh-pages");
  });

  it("publishes from a job that checks out nothing and runs no npm", () => {
    const deploy = jobText(workflow, "deploy");
    expect(deploy).toContain("needs: build");
    expect(deploy).toContain("contents: write");
    expect(deploy).toContain("actions/download-artifact@");
    expect(deploy).toContain("peaceiris/actions-gh-pages@");
    expect(deploy).not.toContain("actions/checkout");
    expect(deploy).not.toMatch(/\bnpm\b|\bnode\b|\bnpx\b/);
  });
});

describe("Dependabot", () => {
  const config = readRepoFile(".github/dependabot.yml");
  const automerge = readRepoFile(".github/workflows/dependabot-automerge.yml");

  it("waits 7 days after a release for every ecosystem", () => {
    const ecosystems = config.match(/- package-ecosystem: /g) || [];
    expect(ecosystems.length).toBeGreaterThanOrEqual(4);
    const cooldowns = config.match(/\n {4}cooldown:\n {6}default-days: 7\n/g) || [];
    expect(cooldowns).toHaveLength(ecosystems.length);
  });

  it("keeps the build tooling in groups of its own, ahead of the catch-all groups", () => {
    for (const [tools, general] of [["root-build-tools", "root-non-breaking"], ["client-build-tools", "client-non-breaking"]]) {
      expect(config.indexOf(`${tools}:`), tools).toBeGreaterThan(-1);
      expect(config.indexOf(`${tools}:`), tools).toBeLessThan(config.indexOf(`${general}:`));
    }
    const rootTools = config.slice(config.indexOf("root-build-tools:"), config.indexOf("root-non-breaking:"));
    expect(rootTools).toContain('"@yao-pkg/pkg"');
    expect(rootTools).toContain('"esbuild"');
    const clientTools = config.slice(config.indexOf("client-build-tools:"), config.indexOf("client-non-breaking:"));
    expect(clientTools).toContain('"vite"');
  });

  it("watches every Dockerfile", () => {
    const docker = config.slice(config.indexOf("package-ecosystem: docker"));
    for (const dir of ["- /\n", "- /docker/all-in-one\n", "- /docker/all-in-one/updater\n"]) {
      expect(docker).toContain(dir);
    }
  });

  it("auto-merges only npm patch and minor updates from the general groups", () => {
    expect(automerge).toMatch(/dependabot\/fetch-metadata@[0-9a-f]{40} # v\d/);
    const mergeStep = automerge.slice(automerge.indexOf("- name: Enable squash auto-merge"));
    const condition = mergeStep.slice(mergeStep.indexOf("if:"), mergeStep.indexOf("env:"));
    expect(condition).toContain("package-ecosystem == 'npm_and_yarn'");
    expect(condition).toContain("'version-update:semver-patch'");
    expect(condition).toContain("'version-update:semver-minor'");
    expect(condition).not.toContain("semver-major");
    expect(condition).toContain("dependency-group == 'root-non-breaking'");
    expect(condition).toContain("dependency-group == 'client-non-breaking'");
    expect(condition).not.toMatch(/build-tools|github_actions|docker/);
    // Every condition is ANDed: an || at the top level would let any one
    // of them through on its own.
    expect(condition.replace(/\([^()]*\)/g, "()")).not.toContain("||");
    // The merge command runs only behind that condition.
    expect(automerge.match(/gh pr merge/g) || []).toHaveLength(1);
  });
});

describe("Docker image tags", () => {
  const workflow = readRepoFile(".github/workflows/docker-publish.yml");

  it("moves latest only on a release tag, and main/edge on main pushes", () => {
    expect(workflow).toContain("flavor: latest=false");
    expect(workflow).toContain("type=raw,value=latest,enable=${{ startsWith(github.ref, 'refs/tags/v') }}");
    expect(workflow.match(/value=latest/g) || []).toHaveLength(1);
    expect(workflow).toContain("type=raw,value=main,enable=${{ github.ref == 'refs/heads/main' }}");
    expect(workflow).toContain("type=raw,value=edge,enable=${{ github.ref == 'refs/heads/main' }}");
  });

  it("builds pull requests without logging in or pushing", () => {
    expect(workflow).toMatch(/\n {2}pull_request:\n/);
    const login = workflow.slice(workflow.indexOf("- name: Log in to GHCR"));
    expect(login.slice(0, login.indexOf("uses:"))).toContain("if: github.event_name != 'pull_request'");
    expect(workflow).toContain("push: ${{ github.event_name != 'pull_request' }}");
    expect(workflow).not.toMatch(/push: true/);
  });

  it("tells users that latest is the newest release", () => {
    const docs = readRepoFile("docs/install/docker.md");
    expect(docs).toContain("`:latest` is the\n  newest release");
    expect(docs).toContain("`:edge`");
  });
});

describe("Docker base images", () => {
  const dockerfiles = ["Dockerfile", "docker/all-in-one/Dockerfile", "docker/all-in-one/updater/Dockerfile"];

  it.each(dockerfiles)("%s pins every base image by digest", (file) => {
    const lines = readRepoFile(file).split("\n").filter((line) => /^FROM\s/i.test(line));
    expect(lines.length).toBeGreaterThan(0);
    const stages = new Set();
    for (const line of lines) {
      const words = line.split(/\s+/).filter((word) => !word.startsWith("--"));
      const image = words[1];
      if (!stages.has(image)) expect(image, line).toMatch(/^[a-z0-9./_-]+:[\w.-]+@sha256:[0-9a-f]{64}$/);
      const alias = /\bAS\s+(\S+)/i.exec(line)?.[1];
      if (alias) stages.add(alias);
    }
  });

  it.each(dockerfiles)("%s pipes nothing from the network into a shell", (file) => {
    const text = readRepoFile(file);
    expect(text).not.toMatch(/\|\s*(ba|da)?sh\b/);
    expect(text).not.toContain("deb.nodesource.com");
  });

  it("the all-in-one image takes Node.js from the official image", () => {
    const text = readRepoFile("docker/all-in-one/Dockerfile");
    expect(text).toMatch(/^FROM node:22-bookworm-slim@sha256:[0-9a-f]{64} AS node-image$/m);
    expect(text).toContain("COPY --from=node-image /usr/local/bin/node /usr/local/bin/node");
    expect(text).toMatch(/node --version/);
  });
});

describe("release builds install exactly what the lockfiles pin", () => {
  it.each([
    "Dockerfile",
    "docker/all-in-one/Dockerfile",
    ".github/workflows/release-artifacts.yml",
    ".github/workflows/demo-pages.yml",
  ])("%s uses npm ci, never npm install", (file) => {
    const text = readRepoFile(file);
    const commands = text.split("\n").filter((line) => !line.trim().startsWith("#"));
    expect(commands.join("\n")).toMatch(/npm ci\b/);
    expect(commands.join("\n")).not.toMatch(/npm install\b/);
  });
});
