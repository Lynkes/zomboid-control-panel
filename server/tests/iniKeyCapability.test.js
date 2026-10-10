import { describe, expect, it } from "vitest";
import { INI_KEY_CAPABILITY, governedIniKeysChanged } from "../utils/iniKeyCapability.js";

// Which of the keys that need server.configure (on top of serverfiles.manage)
// a write to the server .ini changes, judged on what the game reads.

describe("INI_KEY_CAPABILITY", () => {
  it("governs the RCON and network keys server.js edits under server.configure", () => {
    expect(INI_KEY_CAPABILITY).toEqual({
      RCONPassword: "server.configure",
      RCONPort: "server.configure",
      DefaultPort: "server.configure",
      UDPPort: "server.configure",
      UPnP: "server.configure",
    });
  });
});

describe("governedIniKeysChanged", () => {
  const live = "PVP=true\nRCONPassword=secret\nRCONPort=27015\nDefaultPort=16261\nUDPPort=16262\nUPnP=true\n";

  it("is empty when nothing governed changes, whatever else does", () => {
    expect(governedIniKeysChanged(live, live.replace("PVP=true", "PVP=false"))).toEqual([]);
    expect(governedIniKeysChanged(live, `# note\r\n${live.replace(/\n/g, "\r\n")}`)).toEqual([]);
    expect(governedIniKeysChanged(live, live.split("\n").reverse().join("\n"))).toEqual([]);
  });

  it("names each governed key whose value changes", () => {
    const next = live
      .replace("RCONPassword=secret", "RCONPassword=other")
      .replace("RCONPort=27015", "RCONPort=1")
      .replace("DefaultPort=16261", "DefaultPort=2")
      .replace("UDPPort=16262", "UDPPort=3")
      .replace("UPnP=true", "UPnP=false");
    expect(governedIniKeysChanged(live, next)).toEqual([
      "RCONPassword",
      "RCONPort",
      "DefaultPort",
      "UDPPort",
      "UPnP",
    ]);
  });

  it("counts a removed governed line and a newly added one", () => {
    expect(governedIniKeysChanged(live, live.replace("RCONPort=27015\n", ""))).toEqual(["RCONPort"]);
    expect(governedIniKeysChanged("PVP=true\n", live)).toEqual([
      "RCONPassword",
      "RCONPort",
      "DefaultPort",
      "UDPPort",
      "UPnP",
    ]);
  });

  it("treats a missing line and an empty one alike (the game reads nothing for either)", () => {
    expect(governedIniKeysChanged("PVP=true\n", "PVP=true\nRCONPassword=\n")).toEqual([]);
  });

  it("reads lines as the game does: a skipped line reads as nothing, and the last line for a key wins", () => {
    // "RCONPort =1" names an option "RCONPort " the game doesn't have.
    expect(governedIniKeysChanged("RCONPort =27099\n", "PVP=true\n")).toEqual([]);
    expect(governedIniKeysChanged("RCONPort =27099\n", "RCONPort=27099\n")).toEqual(["RCONPort"]);
    expect(governedIniKeysChanged("RCONPort=1\nRCONPort=2\n", "RCONPort=2\n")).toEqual([]);
    expect(governedIniKeysChanged("RCONPort=1\nRCONPort=2\n", "RCONPort=2\nRCONPort=1\n")).toEqual(["RCONPort"]);
  });

  it("compares the value, not the key's neighbours or a longer key that contains it", () => {
    expect(governedIniKeysChanged(live, `${live}RCONPortExtra=5\nMyRCONPort=7\n`)).toEqual([]);
    expect(governedIniKeysChanged("", "")).toEqual([]);
  });
});
