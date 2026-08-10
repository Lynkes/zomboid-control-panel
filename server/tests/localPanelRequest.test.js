import { afterEach, describe, expect, it, vi } from "vitest";

const { networkInterfacesMock } = vi.hoisted(() => ({
  networkInterfacesMock: vi.fn(),
}));

vi.mock("os", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...actual.default, networkInterfaces: networkInterfacesMock },
    networkInterfaces: networkInterfacesMock,
  };
});

const { isLocalPanelRequest } = await import("../routes/auth.js");

function reqWithRemoteAddress(address) {
  return { socket: { remoteAddress: address }, connection: {} };
}

describe("isLocalPanelRequest (Finding 8: Docker bridge bypass)", () => {
  afterEach(() => {
    networkInterfacesMock.mockReset();
  });

  it("trusts loopback regardless of the host's own interfaces", () => {
    networkInterfacesMock.mockReturnValue({});
    expect(isLocalPanelRequest(reqWithRemoteAddress("127.0.0.1"))).toBe(true);
    expect(isLocalPanelRequest(reqWithRemoteAddress("::1"))).toBe(true);
  });

  it("trusts a genuine LAN address the host itself owns", () => {
    networkInterfacesMock.mockReturnValue({
      eth0: [{ address: "192.168.1.85", family: "IPv4", internal: false }],
    });
    expect(isLocalPanelRequest(reqWithRemoteAddress("192.168.1.85"))).toBe(
      true,
    );
  });

  it("does not trust the host's own docker0 bridge gateway address", () => {
    networkInterfacesMock.mockReturnValue({
      docker0: [{ address: "172.17.0.1", family: "IPv4", internal: false }],
    });
    expect(isLocalPanelRequest(reqWithRemoteAddress("172.17.0.1"))).toBe(
      false,
    );
  });

  it("does not trust a custom docker bridge network's gateway address", () => {
    networkInterfacesMock.mockReturnValue({
      "br-abcdef": [{ address: "172.24.0.1", family: "IPv4", internal: false }],
    });
    expect(isLocalPanelRequest(reqWithRemoteAddress("172.24.0.1"))).toBe(
      false,
    );
  });

  it("rejects a request whose address matches nothing local", () => {
    networkInterfacesMock.mockReturnValue({
      eth0: [{ address: "192.168.1.85", family: "IPv4", internal: false }],
    });
    expect(isLocalPanelRequest(reqWithRemoteAddress("203.0.113.9"))).toBe(
      false,
    );
  });
});
