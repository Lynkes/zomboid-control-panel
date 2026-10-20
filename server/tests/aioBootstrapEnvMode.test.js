import { afterEach, describe, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Supply-chain review 2026-10-20: docker/all-in-one/bootstrap.sh wrote .env,
// which holds the updater token (the updater can rebuild and replace the
// panel container), with the default umask -- 0644, readable by every local
// user -- and only then ran chmod 600. It now creates the file owner-only.
//
// The script runs for real up to its first network download, with docker,
// curl and tar stubbed on PATH, and chmod wrapped to record the file's mode
// at the moment chmod is called. POSIX only (file modes); CI runs it on
// ubuntu.

const BOOTSTRAP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../docker/all-in-one/bootstrap.sh");
const posix = process.platform !== "win32";
const tempDirs = [];

function stub(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`);
  fs.chmodSync(file, 0o755);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!posix)("all-in-one bootstrap: .env with the updater token", () => {
  it("is never readable by other users, not even before its chmod", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-bootstrap-"));
    tempDirs.push(root);
    const bin = path.join(root, "bin");
    fs.mkdirSync(bin);
    const modes = path.join(root, "chmod-modes.log");
    const realChmod = execFileSync("sh", ["-c", "command -v chmod"], { encoding: "utf8" }).trim();
    stub(bin, "docker", 'if [ "$1" = info ] && [ "$2" = --format ]; then echo amd64; fi\nexit 0');
    // The release download is where this run stops.
    stub(bin, "curl", "exit 22");
    stub(bin, "tar", "exit 0");
    stub(bin, "chmod", `for last; do :; done\nstat -c %a "$last" >> "${modes}"\nexec "${realChmod}" "$@"`);

    const result = spawnSync("sh", ["-c", 'umask 022; exec sh "$0" 1.2.3', BOOTSTRAP], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PANEL_HOME: path.join(root, "home"), PANEL_LAN_IP: "192.168.1.20" },
      encoding: "utf8",
    });

    const env = path.join(root, "home", "build", "ctx", ".env");
    expect(fs.existsSync(env), result.stderr).toBe(true);
    expect(fs.readFileSync(env, "utf8")).toMatch(/^PANEL_DOCKER_UPDATER_TOKEN=.+$/m);
    // Its mode when chmod 600 ran, then after it.
    expect(fs.readFileSync(modes, "utf8").trim().split("\n")[0]).toBe("600");
    expect(fs.statSync(env).mode & 0o777).toBe(0o600);
    // The umask was the subshell's: what the script creates later keeps the
    // caller's (the build folder the updater container reads).
    expect(fs.statSync(path.join(root, "home", "build", "ctx")).mode & 0o077).not.toBe(0);
    // It went on to the download (and stopped there, on the stub).
    expect(result.status).not.toBe(0);
  });
});

describe("all-in-one bootstrap: where the docs fetch it from", () => {
  const read = (file) => fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", file), "utf8");

  it("points every install command at the released script, never main", () => {
    for (const file of ["README.md", "docs/install/docker.md", "docker/all-in-one/README.md"]) {
      const text = read(file);
      expect(text, file).not.toMatch(/raw\.githubusercontent\.com\/[^\s]*\/main\/docker\/all-in-one\/bootstrap\.sh/);
      expect(text, file).toContain("https://github.com/fpsacha/zomboid-control-panel/releases/latest/download/bootstrap.sh");
    }
  });

  it("attaches the script to each release and lists it in checksums.txt", () => {
    const workflow = read(".github/workflows/release-artifacts.yml").replace(/\r\n/g, "\n");
    expect(workflow).toContain("cp docker/all-in-one/bootstrap.sh bootstrap.sh");
    const checksums = workflow.slice(workflow.indexOf("sha256sum"), workflow.indexOf("> checksums.txt"));
    expect(checksums).toContain("bootstrap.sh");
    const upload = workflow.slice(workflow.indexOf("gh release upload"), workflow.indexOf("checksums.txt; then"));
    expect(upload).toContain("bootstrap.sh");
  });
});
