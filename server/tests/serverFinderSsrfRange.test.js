import { describe, expect, it } from "vitest";
import { isPrivateIp } from "../routes/serverFinder.js";

// Regression coverage for docs/qa/kevin-route-hunt.md Finding 5: isPrivateIp()
// (the SSRF deny-list backing GET /query and GET /ping) blocked every usual
// private/reserved range but missed 100.64.0.0/10 (RFC 6598, Carrier-Grade
// NAT / shared address space) entirely -- increasingly used as an internal
// routing range by cloud providers and some Docker/Kubernetes setups.

describe("isPrivateIp: 100.64.0.0/10 (Carrier-Grade NAT) is now blocked", () => {
  it.each([
    "100.64.0.0",
    "100.64.0.1",
    "100.100.100.100",
    "100.127.255.255",
  ])("refuses %s -- inside the CGNAT range", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });

  it.each(["100.63.255.255", "100.128.0.0"])(
    "does NOT block %s -- adjacent but outside the CGNAT range, must not overreach",
    (ip) => {
      expect(isPrivateIp(ip)).toBe(false);
    },
  );
});

describe("isPrivateIp: existing ranges still correctly blocked (no regression)", () => {
  it.each([
    "0.0.0.0",
    "10.0.0.1",
    "127.0.0.1",
    "169.254.169.254", // cloud metadata endpoint
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "224.0.0.1",
  ])("refuses %s", (ip) => {
    expect(isPrivateIp(ip)).toBe(true);
  });
});

describe("isPrivateIp: a legitimate public address still probes -- the other direction", () => {
  it.each(["8.8.8.8", "1.1.1.1", "203.0.113.50"])(
    "does not block %s",
    (ip) => {
      expect(isPrivateIp(ip)).toBe(false);
    },
  );
});
