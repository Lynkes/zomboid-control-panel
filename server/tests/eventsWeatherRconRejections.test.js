import { describe, it, expect } from "vitest";
import { RconService } from "../services/rcon.js";

// continuous-bug-hunt round 31 (Events & Weather page hunt): three RCON
// reply literals used by Events.tsx's own commands were missing from
// classifyRconResponse's denylist, so each one was reported as a SUCCESS
// even though PZ refused to run the command -- javap -c-confirmed against
// D:/pz-verify's real B42 jar for every string below, not guessed, and each
// already present in the checked-in ground-truth fixture
// (server/__fixtures__/pzRconRejectionStrings.json), so the drift gate in
// rconRejectionGroundTruth.test.js also covers these three patterns.
describe("RconService.classifyRconResponse(): Events & Weather rejection strings", () => {
  const service = new RconService();

  it("flags LightningCommand/ThunderCommand's 'Pass a username' refusal, not a success", () => {
    const result = service.classifyRconResponse("Pass a username");
    expect(result).not.toBeNull();
    expect(result.error).toMatch(/no player of its own to default to/i);
  });

  it("does not confuse 'Pass a username' with a DIFFERENT command's 'Pass a username or coordinate' text", () => {
    // Two distinct PZ literals share a prefix; the anchored pattern must
    // not conflate a genuinely different command's rejection with this one.
    const result = service.classifyRconResponse("Pass a username or coordinate");
    // Whether or not that OTHER string is itself classified is out of
    // scope here -- the point is this test's own pattern doesn't silently
    // swallow it under the wrong description.
    if (result) expect(result.error).not.toMatch(/no player of its own to default to/i);
  });

  it("flags AlarmCommand's 'Not in a room' refusal, not a success", () => {
    const result = service.classifyRconResponse("Not in a room");
    expect(result).not.toBeNull();
    expect(result.error).toMatch(/cannot succeed here/i);
  });

  it("flags CreateHordeCommand's 'Specify a player to create the horde near to.' refusal, not a success", () => {
    const result = service.classifyRconResponse("Specify a player to create the horde near to.");
    expect(result).not.toBeNull();
    expect(result.error).toMatch(/no target player was given for the horde/i);
  });

  it("still classifies a genuine success (no known rejection text) as null -- not over-matching", () => {
    expect(service.classifyRconResponse("Lightning triggered")).toBeNull();
    expect(service.classifyRconResponse("Thunder triggered")).toBeNull();
    expect(service.classifyRconResponse("Alarm sounded")).toBeNull();
    expect(service.classifyRconResponse("Horde spawned.")).toBeNull();
    expect(service.classifyRconResponse("Rain started")).toBeNull();
  });
});
