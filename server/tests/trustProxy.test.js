import { describe, expect, it } from "vitest";
import express from "express";
import { parseTrustProxySetting, trustProxyHopCountWarning } from "../utils/trustProxy.js";

describe("parseTrustProxySetting", () => {
  it.each(["", "0", "false", "off", "none"])(
    "disables proxy trust for %j",
    (value) => {
      expect(parseTrustProxySetting(value)).toBe(false);
    },
  );

  it("maps true to one trusted hop instead of Express's unsafe trust-all mode", () => {
    expect(parseTrustProxySetting("true")).toBe(1);
  });

  it.each([
    ["1", 1],
    ["2", 2],
  ])("parses %j as %i trusted hops", (value, expected) => {
    expect(parseTrustProxySetting(value)).toBe(expected);
  });

  it("accepts an IP or subnet list supported by Express", () => {
    const setting = parseTrustProxySetting("127.0.0.1, 10.0.0.0/8");
    const app = express();

    app.set("trust proxy", setting);

    expect(setting).toEqual(["127.0.0.1", "10.0.0.0/8"]);
    expect(app.get("trust proxy")).toEqual(setting);
  });

  it.each(["-1", "9007199254740992"])(
    "does not enable an invalid numeric value %j",
    (value) => {
      expect(parseTrustProxySetting(value)).toBe(false);
    },
  );
});

// Auth audit 2026-10-08, #7: a hop count trusts X-Forwarded-For from
// whatever connects directly. With Docker publishing port 3001 on every
// address (and bypassing UFW), anyone reaching it named their own address on
// each sign-in attempt, and with it got a fresh lockout budget. "1" keeps
// meaning one hop, but the panel says so at startup.
describe("trustProxyHopCountWarning", () => {
  it.each(["1", "true", "2"])("warns about the hop count %j", (value) => {
    const warning = trustProxyHopCountWarning(value);

    expect(warning).toContain(`TRUST_PROXY=${value}`);
    expect(warning).toContain("PANEL_BIND_ADDRESS=127.0.0.1");
    expect(warning).toContain("TRUST_PROXY=loopback");
  });

  it.each(["loopback", "127.0.0.1", "127.0.0.1, 10.0.0.0/8", "false", "", undefined])(
    "stays quiet for %j, which names the proxy or trusts nothing",
    (value) => {
      expect(trustProxyHopCountWarning(value)).toBeNull();
    },
  );
});