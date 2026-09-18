import { describe, expect, it } from "vitest";
import { RconService } from "../services/rcon.js";

// 2026-09-18, round 10 (card rcon-rejections-missing-for-steamid-commands,
// Pam's finding). KNOWN_RCON_REJECTIONS had NO entries for banid, unbanid,
// addSteamID, removeSteamID -- a real PZ refusal for any of the four read
// as a plain RCON reply, indistinguishable from success (and banId() below
// persists a local ban record on that false "success", per its own
// comment). Same convention as jimRconBanWhitelistRejectionAnchoring.test.js
// (the username-based ban/whitelist sibling hunt) and
// linuxPlayersRconRejectionAnchoring.test.js: this file only owns the
// discrimination property (does a real rejection fire, does a real success
// stay null) -- the strings themselves are proven real by
// rconRejectionGroundTruth.test.js's fixture drift gate, bytecode-traced
// (javap -c -p -constants) against D:/pz-verify/server/java/projectzomboid.jar
// (see rcon.js's own citation on each new pattern for the exact
// class/method/instruction evidence).
//
// No attacker-controlled-display-name risk here the way kick/ban-by-username
// has: every interpolated value in these four commands' rejection text is a
// SteamID64 the ADMIN typed as an RCON argument, not a player's own chosen
// display name -- still anchored the same strict way regardless, but the
// "a player named themselves a rejection fragment" adversarial angle
// doesn't apply to this command family the way it does to kick/ban/whitelist.

describe("classifyRconResponse: the new SteamID command rejections fire", () => {
  const rcon = new RconService();

  it.each([
    ["banid/unbanid: server not running in Steam mode", "Server is not in Steam mode"],
    [
      "banid/unbanid: argument isn't a valid SteamID64",
      'Expected SteamID but got "not-a-steamid"',
    ],
    [
      "addSteamID/removeSteamID: argument isn't a valid SteamID64",
      'Invalid steamID "not-a-steamid"',
    ],
    [
      "addSteamID: SteamID already on the allowed list",
      "SteamID 76561198000000000 already exists in allowed SteamIDs",
    ],
    [
      "removeSteamID: SteamID was never on the allowed list",
      "SteamID 76561198000000000 doesn't exists in allowed SteamIDs",
    ],
    [
      "addSteamID/removeSteamID: the command's own SQLException catch-all",
      "exception occurs",
    ],
    [
      "banid: RCON connection's role lacks BanUnbanUser (bytecode-confirmed reachable via BanUserBySteamID, unlike unbanid)",
      "You don't have capability to ban/unban users.",
    ],
  ])("%s", (_label, response) => {
    expect(rcon.classifyRconResponse(response)).not.toBeNull();
  });
});

describe("classifyRconResponse: the new SteamID patterns do not misfire on plausible adjacent text", () => {
  const rcon = new RconService();

  it.each([
    // Real success shapes these commands can plausibly produce, per rcon.js's
    // own bytecode-traced comments: banid/unbanid's success text is built
    // from "<username> banned"/"<username> unbanned" plus whitelist-entry
    // detail, never any of the four gate strings below (mutually exclusive
    // code paths -- the gates all `areturn` before the success-building
    // logic ever runs).
    ["not a Steam-mode rejection", "User Bob banned (SteamID 76561198000000000)"],
    ["not an already-allowed rejection", "SteamID 76561198000000000 added to allowed SteamIDs"],
    ["not a not-on-the-list rejection", "SteamID 76561198000000000 removed from allowed SteamIDs"],
    ["not the generic exception text", "SteamID 76561198000000000 is now unbanned"],
  ])("%s", (_label, response) => {
    expect(rcon.classifyRconResponse(response)).toBeNull();
  });
});
