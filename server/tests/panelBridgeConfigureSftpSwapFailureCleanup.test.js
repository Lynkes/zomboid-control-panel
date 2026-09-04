import { describe, it, expect, vi, beforeEach } from "vitest";

// 2026-09-04, overnight bug hunt (Angela's fence: panelBridge*):
// configureSftp() connects a brand-new PanelBridgeSftpTransport FIRST (its
// own try/catch already handles that failing cleanly, leaving the old
// bridge untouched -- see the comment above it). But once that new
// transport is confirmed connected, the swap that follows (stop the old
// bridge, stop the old transport, this.configure(), assign the new
// transport, this.start()) ran with no protection at all. If anything in
// that sequence threw -- this.configure() on a bad path, a future edit to
// this.start() that can throw -- the freshly-connected transport was
// silently leaked (its SFTP connection and poll timer keep running, owned
// by nothing) and this.sftpTransport was left either pointing at the OLD
// transport (already stopped two lines up -- the bridge would report
// itself configured against a transport that isn't running) or in
// whatever partial state the throw happened to catch it in.
//
// Fix: wrap the swap in its own try/catch. On failure: null out
// sftpTransport (the old one is guaranteed already stopped by this point,
// so keeping that reference would be misleading either way), stop the new
// transport so it isn't leaked, and rethrow the original error.

const mockTransport = {
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  getStatus: vi.fn(() => ({ type: "sftp", running: true })),
};

vi.mock("../services/panelBridgeSftp.js", () => ({
  PanelBridgeSftpTransport: vi.fn(function PanelBridgeSftpTransport() {
    return mockTransport;
  }),
}));

const { PanelBridge } = await import("../services/panelBridge.js");

beforeEach(() => {
  mockTransport.start.mockClear();
  mockTransport.stop.mockClear();
  mockTransport.getStatus.mockClear();
  mockTransport.start.mockImplementation(async () => {});
  mockTransport.stop.mockImplementation(async () => {});
});

describe("PanelBridge.configureSftp cleans up the new transport when the post-connect swap fails", () => {
  it("stops the newly-connected transport and clears sftpTransport when this.configure() throws mid-swap", async () => {
    const bridge = new PanelBridge();
    vi.spyOn(bridge, "configure").mockImplementation(() => {
      throw new Error("swap failed");
    });

    await expect(
      bridge.configureSftp({ host: "h", username: "u", password: "p", bridgePath: "/b" }, "/cache"),
    ).rejects.toThrow("swap failed");

    // The transport DID connect successfully -- it must not be left running,
    // orphaned, with nothing tracking it.
    expect(mockTransport.stop).toHaveBeenCalled();
    expect(bridge.sftpTransport).toBeNull();
  });

  it("still succeeds normally when nothing in the swap throws (control)", async () => {
    const bridge = new PanelBridge();

    const result = await bridge.configureSftp(
      { host: "h", username: "u", password: "p", bridgePath: "/b" },
      "/cache",
    );

    expect(result).toBe(bridge.bridgePath);
    expect(bridge.sftpTransport).toBe(mockTransport);
    // stop() was NOT called on the successful path -- there was no old
    // transport to replace and nothing failed.
    expect(mockTransport.stop).not.toHaveBeenCalled();
    bridge.stop();
  });

  it("leaves the previously-running bridge untouched when the NEW transport itself fails to connect (existing behavior, unchanged)", async () => {
    const bridge = new PanelBridge();
    mockTransport.start.mockImplementationOnce(async () => {
      throw new Error("connect failed");
    });

    await expect(
      bridge.configureSftp({ host: "h", username: "u", password: "p", bridgePath: "/b" }, "/cache"),
    ).rejects.toThrow("connect failed");

    expect(bridge.sftpTransport).toBeNull();
    expect(bridge.isRunning).toBe(false);
  });
});
