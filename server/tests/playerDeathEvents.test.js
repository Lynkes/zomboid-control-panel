import { describe, expect, it } from "vitest";
import { createPlayerDeathRouter } from "../services/playerDeathEvents.js";

// Where a death reaches the Discord notice, the player history row and the
// player:death socket event. The bridge and the user log can both report the
// same death; two deaths on the same tile are not the same death.

function setup({ bridgeReportsDeaths = false } = {}) {
  let clock = 1_000_000;
  const delivered = [];
  const router = createPlayerDeathRouter({
    bridge: { reportsPlayerDeaths: () => bridgeReportsDeaths },
    onDeath: (death) => delivered.push(death),
    now: () => clock,
  });
  return {
    router,
    delivered,
    advance: (ms) => {
      clock += ms;
    },
    settle: () => new Promise((resolve) => setImmediate(resolve)),
  };
}

const death = (extra = {}) => ({ player: "Bob", x: 10801, y: 9370, z: 0, pvp: false, location: "10801,9370,0", ...extra });

describe("player death routing", () => {
  it("delivers two bridge deaths on the same tile within 5 minutes as two deaths", async () => {
    const { router, delivered, advance, settle } = setup({ bridgeReportsDeaths: true });
    router.fromBridge(death());
    advance(30_000);
    router.fromBridge(death());
    await settle();
    expect(delivered).toHaveLength(2);
  });

  it("still tells two different players or tiles apart", async () => {
    const { router, delivered, settle } = setup({ bridgeReportsDeaths: true });
    router.fromBridge(death());
    router.fromBridge(death({ player: "Carol" }));
    router.fromBridge(death({ x: 1, location: "1,9370,0" }));
    await settle();
    expect(delivered.map((d) => d.player)).toEqual(["Bob", "Carol", "Bob"]);
  });

  it("delivers a user-log death and the matching bridge death once", async () => {
    const { router, delivered, settle } = setup();
    router.fromUserLog(death());
    router.fromBridge(death());
    await settle();
    expect(delivered).toHaveLength(1);
  });

  it("delivers a bridge death and the matching user-log line once", async () => {
    // The bridge answered, then stopped for a moment; the game still wrote the line.
    const { router, delivered, settle } = setup();
    router.fromBridge(death());
    router.fromUserLog(death());
    await settle();
    expect(delivered).toHaveLength(1);
  });

  it("matches a user-log death with one bridge death only; the next one on that tile is new", async () => {
    const { router, delivered, advance, settle } = setup();
    router.fromUserLog(death());
    advance(10_000);
    router.fromBridge(death());
    advance(10_000);
    router.fromBridge(death());
    await settle();
    expect(delivered).toHaveLength(2);
  });

  it("ignores the user log while a live bridge reports deaths", async () => {
    const { router, delivered, settle } = setup({ bridgeReportsDeaths: true });
    router.fromUserLog(death());
    await settle();
    expect(delivered).toHaveLength(0);
    router.fromBridge(death());
    await settle();
    expect(delivered).toHaveLength(1);
  });

  it("delivers the same death again once the 5 minute window has passed", async () => {
    const { router, delivered, advance, settle } = setup();
    router.fromUserLog(death());
    advance(5 * 60 * 1000 + 1);
    router.fromUserLog(death());
    advance(5 * 60 * 1000 + 1);
    router.fromBridge(death());
    await settle();
    expect(delivered).toHaveLength(3);
  });
});
