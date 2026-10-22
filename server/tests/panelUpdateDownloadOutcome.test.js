import { afterEach, describe, expect, it, vi } from "vitest";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Three things downloadUpdate() got wrong about its own outcome:
// - a failed download never told the Updates card, which stayed on
//   "Downloading" (no closing panel:downloadProgress event);
// - a successful re-download after a failed apply left that apply's
//   canRetryApply:false result in place, so "Restart and Apply" stayed
//   disabled after the very re-download the failure banner asked for;
// - checksums were read from the live this.latestRelease, so a background
//   update check landing mid-download failed a valid file as tampered.
process.pkg = {};

vi.mock("../database/init.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, setSetting: vi.fn(async () => {}) };
});

const { PanelUpdateChecker } = await import("../services/panelUpdateChecker.js");

const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

function releaseFixture(version, checksumsUrl) {
  return {
    version,
    assets: [
      { name: "ZomboidControlPanel.exe", size: 8, downloadUrl: `https://example.invalid/${version}.exe` },
      { name: "ZomboidControlPanel-windows.zip", size: 8, downloadUrl: `https://example.invalid/${version}-windows.zip` },
      { name: "ZomboidControlPanel", size: 8, downloadUrl: `https://example.invalid/${version}-linux` },
      { name: "ZomboidControlPanel-linux.tar.gz", size: 8, downloadUrl: `https://example.invalid/${version}-linux.tar.gz` },
      { name: "checksums.txt", size: 100, downloadUrl: checksumsUrl },
    ],
  };
}

describe("downloadUpdate(): what it reports about its own outcome", () => {
  let scratchDir;
  let originalExecPath;

  function setExecPath(p) {
    Object.defineProperty(process, "execPath", { value: p, configurable: true });
  }

  function makeChecker() {
    originalExecPath = process.execPath;
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "download-outcome-"));
    const exePath = path.join(scratchDir, "ZomboidControlPanel.exe");
    fs.writeFileSync(exePath, "fake-exe");
    setExecPath(exePath);

    const emitted = [];
    const checker = new PanelUpdateChecker({ emit: (event, payload) => emitted.push({ event, payload }) });
    checker.currentVersion = "1.0.0";
    checker.updateAvailable = true;
    checker.latestRelease = releaseFixture("1.1.0", "https://example.invalid/1.1.0-checksums.txt");
    checker.preflight = async () => ({ ok: true, blockers: [], warnings: [] });
    checker.downloadFile = async (url, destPath) => {
      fs.writeFileSync(destPath, `content of ${path.basename(new URL(url).pathname)}`);
    };
    const incomingClientPath = path.join(scratchDir, ".incoming-client-stub");
    fs.mkdirSync(incomingClientPath, { recursive: true });
    fs.writeFileSync(path.join(incomingClientPath, "index.html"), "<html></html>");
    fs.writeFileSync(
      path.join(incomingClientPath, "build-info.json"),
      JSON.stringify({ panelVersion: "1.1.0", buildSha: "deadbeef", apiContractVersion: 1 }),
    );
    checker.stageClientDist = async () => ({
      incomingClientPath,
      metadata: { panelVersion: "1.1.0", buildSha: "deadbeef", apiContractVersion: 1 },
    });
    return { checker, emitted };
  }

  afterEach(() => {
    if (scratchDir) fs.rmSync(scratchDir, { recursive: true, force: true });
    if (originalExecPath) setExecPath(originalExecPath);
    scratchDir = null;
  });

  it("emits a closing 'failed' progress event when the download fails, so no card is left on Downloading", async () => {
    const { checker, emitted } = makeChecker();
    checker.downloadFile = async () => {
      throw new Error(`EACCES: permission denied, open '${path.join(scratchDir, "ZomboidControlPanel.exe.new")}'`);
    };

    const result = await checker.downloadUpdate();

    expect(result.success).toBe(false);
    const progress = emitted.filter((e) => e.event === "panel:downloadProgress");
    expect(progress[0]?.payload.status).toBe("downloading");
    const last = progress[progress.length - 1]?.payload;
    expect(last?.status).toBe("failed");
    expect(typeof last?.message).toBe("string");
    // Broadcast to every signed-in socket: never the host path.
    expect(last.message).not.toContain(scratchDir);
    expect(checker.isDownloading).toBe(false);
  });

  it("clears a failed, unretryable apply result once a new bundle is staged", async () => {
    const { checker } = makeChecker();
    checker.verifyChecksum = async () => true;
    checker.lastApplyResult = {
      status: "failed",
      pendingVersion: "1.1.0",
      currentVersion: "1.0.0",
      stagedStillPresent: false,
      canRetryApply: false,
      likelyCause: "av_quarantine",
    };

    const result = await checker.downloadUpdate();

    expect(result.success).toBe(true);
    expect(checker.lastApplyResult).toBeNull();
  });

  it("keeps a success apply result when a new bundle is staged", async () => {
    const { checker } = makeChecker();
    checker.verifyChecksum = async () => true;
    const success = { status: "success", appliedVersion: "1.0.0", at: "2026-10-20T00:00:00.000Z" };
    checker.lastApplyResult = success;

    const result = await checker.downloadUpdate();

    expect(result.success).toBe(true);
    expect(checker.lastApplyResult).toBe(success);
  });

  it("verifies against the checksums of the release it downloaded, even if a background check swaps latestRelease mid-download", async () => {
    const { checker } = makeChecker();
    const oldChecksums = [
      `${sha256("content of 1.1.0.exe")}  ZomboidControlPanel.exe`,
      `${sha256("content of 1.1.0-windows.zip")}  ZomboidControlPanel-windows.zip`,
      `${sha256("content of 1.1.0-linux")}  ZomboidControlPanel`,
      `${sha256("content of 1.1.0-linux.tar.gz")}  ZomboidControlPanel-linux.tar.gz`,
    ].join("\n");
    const newChecksums = [
      `${sha256("other")}  ZomboidControlPanel.exe`,
      `${sha256("other")}  ZomboidControlPanel-windows.zip`,
      `${sha256("other")}  ZomboidControlPanel`,
      `${sha256("other")}  ZomboidControlPanel-linux.tar.gz`,
    ].join("\n");
    checker.fetchReleaseText = async (url) => {
      if (url === "https://example.invalid/1.1.0-checksums.txt") return oldChecksums;
      if (url === "https://example.invalid/1.2.0-checksums.txt") return newChecksums;
      throw new Error(`unexpected url ${url}`);
    };
    const realDownload = checker.downloadFile;
    let swapped = false;
    checker.downloadFile = async (url, destPath, ...rest) => {
      await realDownload(url, destPath, ...rest);
      if (!swapped) {
        swapped = true;
        // checkForUpdate() on its 6-hour timer, or a manual check, landing
        // while this download is still running.
        checker.latestRelease = releaseFixture("1.2.0", "https://example.invalid/1.2.0-checksums.txt");
      }
    };

    const result = await checker.downloadUpdate();

    expect(result.error).toBeUndefined();
    expect(result.success).toBe(true);
    expect(checker._stagedVersionCache).toBe("1.1.0");
  });
});
