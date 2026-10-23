import { describe, expect, it } from "vitest";
import { evaluateAudit } from "../../scripts/npm-audit-gate.mjs";

// The fork's security scan (.github/workflows/security-scan.yml) fails only
// for a package that is vulnerable itself with a fix available; an advisory
// with no fix yet, or one a package only inherits, is listed instead.

const advisory = (title, url, range) => ({ source: 1, name: "x", title, url, severity: "high", range });

const report = {
  vulnerabilities: {
    "ip-address": {
      severity: "moderate",
      via: [advisory("Address6 zone identifier in quadratic time", "https://github.com/advisories/GHSA-rxp7-6hxx-x8q5", "<=10.7.3")],
      fixAvailable: true,
    },
    braces: {
      severity: "high",
      via: [advisory("stack-exhaustion denial of service", "https://github.com/advisories/GHSA-vfj7-8cjw-p6xm", "<=3.0.3")],
      fixAvailable: false,
    },
    // Marked fixable by npm, but only inherits braces' advisory.
    "fast-glob": { severity: "high", via: ["micromatch"], fixAvailable: true },
    "low-thing": {
      severity: "low",
      via: [advisory("minor", "https://github.com/advisories/GHSA-low", "<1.0.0")],
      fixAvailable: true,
    },
  },
};

describe("npm-audit-gate evaluateAudit()", () => {
  it("fails only a package with an advisory of its own, moderate or worse, and a fix", () => {
    const { failures, notices } = evaluateAudit(report);
    expect(failures.map((item) => item.name)).toEqual(["ip-address"]);
    expect(failures[0].advisories[0].url).toBe("https://github.com/advisories/GHSA-rxp7-6hxx-x8q5");
    expect(notices.map((item) => item.name).sort()).toEqual(["braces", "fast-glob", "low-thing"]);
    expect(notices.find((item) => item.name === "fast-glob").inheritedFrom).toEqual(["micromatch"]);
    expect(notices.find((item) => item.name === "braces").fixAvailable).toBe(false);
  });

  it("takes a stricter threshold, and an empty report", () => {
    expect(evaluateAudit(report, { failAt: "high" }).failures).toEqual([]);
    expect(evaluateAudit({ vulnerabilities: {} })).toEqual({ failures: [], notices: [] });
    expect(evaluateAudit(undefined)).toEqual({ failures: [], notices: [] });
  });
});
