import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PanelBridge } from "../services/panelBridge.js";

describe("PanelBridge.sendCommand pending registration", () => {
  let tempDir;

  afterEach(() => {
    vi.restoreAllMocks();
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("captures a result that arrives immediately while the inbox write is yielding", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "panelbridge-fast-result-"));
    const bridge = new PanelBridge();
    bridge.configure(tempDir, true);
    bridge.isRunning = true;
    bridge.getConnectionDiagnostics = vi.fn(() => ({ canSendCommands: true, summary: "healthy" }));
    bridge._enqueueCommand = vi.fn(async (id) => {
      bridge.processResult({
        id,
        success: true,
        data: { message: "fast response" },
        timestamp: Date.now(),
      });
    });

    await expect(bridge.sendCommand("ping")).resolves.toEqual({
      success: true,
      data: { message: "fast response" },
    });
    expect(bridge.pendingCommands.size).toBe(0);
  });
});