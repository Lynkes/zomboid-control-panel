import { describe, expect, it } from "vitest";
import { autoStartEnabled, autoStartServerIds, withAutoStartServer } from "@/lib/autoStartServers";

// Same reading as server/index.js's selectAutoStartServers(), so the
// Dashboard and Settings show the servers the boot will start.

describe("autoStartEnabled()", () => {
  it("reads the switch's boolean and an old settings file's string form", () => {
    expect(autoStartEnabled({ autoStartServer: true })).toBe(true);
    expect(autoStartEnabled({ autoStartServer: "true" })).toBe(true);
    expect(autoStartEnabled({ autoStartServer: false })).toBe(false);
    expect(autoStartEnabled({})).toBe(false);
    expect(autoStartEnabled(null)).toBe(false);
  });
});

describe("autoStartServerIds()", () => {
  it("returns the saved list as strings", () => {
    expect(autoStartServerIds({ autoStartServer: true, autoStartServerIds: ["a", 7] }, "a")).toEqual(["a", "7"]);
    // The list stands even while the switch is off: it is what turning it on starts.
    expect(autoStartServerIds({ autoStartServer: false, autoStartServerIds: ["b"] }, "a")).toEqual(["b"]);
  });

  it("means the active server for a setting saved before servers could be chosen", () => {
    expect(autoStartServerIds({ autoStartServer: true }, 3)).toEqual(["3"]);
    expect(autoStartServerIds({ autoStartServer: false }, 3)).toEqual([]);
    expect(autoStartServerIds({ autoStartServer: true }, null)).toEqual([]);
  });
});

describe("withAutoStartServer()", () => {
  it("adds a server once, at the end", () => {
    expect(withAutoStartServer(["a"], "b", true)).toEqual(["a", "b"]);
    expect(withAutoStartServer(["a", "b"], "a", true)).toEqual(["a", "b"]);
    expect(withAutoStartServer([], 5, true)).toEqual(["5"]);
  });

  it("takes a server out", () => {
    expect(withAutoStartServer(["a", "b"], "a", false)).toEqual(["b"]);
    expect(withAutoStartServer(["a"], "c", false)).toEqual(["a"]);
  });
});
