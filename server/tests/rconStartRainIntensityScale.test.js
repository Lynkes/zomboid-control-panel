import { describe, it, expect, vi } from "vitest";
import { RconService } from "../services/rcon.js";

// continuous-bug-hunt round 31 (Events & Weather page hunt):
// StartRainCommand.class (javap -c-confirmed against D:/pz-verify's real
// B42 dedicated server jar) parses its RCON argument as a PERCENTAGE and
// divides it by 100 itself before calling
// ClimateManager.transmitServerStartRain(float). This service method's own
// contract is 0-1 (validated below, matching Events.tsx's own
// rainIntensity/100 and panelBridgeApi.startRain's identical convention),
// and used to send that 0-1 fraction straight through as the raw RCON
// argument -- so PZ divided it by 100 A SECOND TIME. A 50% slider (0.5)
// reached the game as 0.005; even the slider's own maximum (1.0) reached
// the game as 0.01. Rain was always at least 100x weaker than intended,
// worse than 10,000x at low settings -- indistinguishable from "the button
// did nothing", with no error anywhere to explain why.
describe("RconService.startRain(): scales its 0-1 fraction up to the percentage PZ's own command expects", () => {
  function makeService() {
    const service = new RconService();
    service.execute = vi.fn(async (command) => ({ success: true, response: command }));
    return service;
  }

  it("sends 50 (not 0.5) for a 50% intensity, matching StartRainCommand's own /100 division", async () => {
    const service = makeService();
    await service.startRain(0.5);
    expect(service.execute).toHaveBeenCalledWith("startrain 50");
  });

  it("sends 100 (not 1) for full intensity", async () => {
    const service = makeService();
    await service.startRain(1);
    expect(service.execute).toHaveBeenCalledWith("startrain 100");
  });

  it("sends 5 (not 0.05) for the panelBridge-matching 5% floor", async () => {
    const service = makeService();
    await service.startRain(0.05);
    expect(service.execute).toHaveBeenCalledWith("startrain 5");
  });

  it("sends a bare startrain with no argument when intensity is omitted", async () => {
    const service = makeService();
    await service.startRain();
    expect(service.execute).toHaveBeenCalledWith("startrain");
  });

  it("still rejects an out-of-range intensity -- the scale fix must not loosen existing validation", async () => {
    const service = makeService();
    await expect(service.startRain(1.5)).rejects.toThrow("intensity must be 0-1");
    await expect(service.startRain(-0.1)).rejects.toThrow("intensity must be 0-1");
    expect(service.execute).not.toHaveBeenCalled();
  });
});
