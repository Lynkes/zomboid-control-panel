import { describe, expect, it, vi } from "vitest";

// security audit L4: private-network CORS matching used string prefixes
// ("10.", "192.168."), so attacker-controlled hostnames like 10.evil.com
// were treated as LAN origins. Only real IPv4 literals in the private
// ranges (plus loopback) may match now.
vi.mock("../database/init.js", () => ({
  getRoleByName: vi.fn(),
  getDb: vi.fn(async () => ({ data: {} })),
  peekServerDisplayName: vi.fn(() => null),
}));

const { isPrivateNetworkHost } = await import("../index.js");

describe("isPrivateNetworkHost()", () => {
  it("accepts loopback and every private / CGNAT range", () => {
    for (const host of [
      "localhost",
      "127.0.0.1",
      "::1",
      "[::1]",
      "10.0.0.1",
      "10.255.255.255",
      "192.168.1.20",
      "172.16.0.1",
      "172.31.255.255",
      "100.64.0.1",
      "100.127.255.255",
    ]) {
      expect(isPrivateNetworkHost(host), host).toBe(true);
    }
  });

  it("rejects hostnames that merely start like a private address", () => {
    for (const host of ["10.evil.com", "192.168.1.1.evil.com", "172.16.0.1.nip.io", "100.64.attacker.net"]) {
      expect(isPrivateNetworkHost(host), host).toBe(false);
    }
  });

  it("rejects public addresses at the edges of the private ranges", () => {
    for (const host of ["172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "192.169.0.1", "11.0.0.1", "8.8.8.8"]) {
      expect(isPrivateNetworkHost(host), host).toBe(false);
    }
  });

  it("rejects malformed IPv4 and empty input", () => {
    for (const host of ["256.1.1.1", "10.0.0.256", "10.0.0", "10.0.0.1.2", "", null, undefined]) {
      expect(isPrivateNetworkHost(host), String(host)).toBe(false);
    }
  });
});
