import { describe, expect, it, vi } from "vitest";

// "Scheduled restart cancelled" went to Discord through sendNotification()
// directly, so it ignored the Scheduled restart event's toggle on the Discord
// page: an operator who switched that event off (no "restart coming" post)
// still got a "cancelled" post for a restart Discord was never told about.

vi.mock("../database/init.js", () => ({
  getScheduledTasks: vi.fn().mockResolvedValue([]),
  updateTaskLastRun: vi.fn().mockResolvedValue(),
  logServerEvent: vi.fn().mockResolvedValue(),
  logScheduleExecution: vi.fn().mockResolvedValue(),
  getActiveServer: vi.fn().mockResolvedValue(null),
  getServer: vi.fn().mockResolvedValue(null),
  getServers: vi.fn().mockResolvedValue([]),
  getSetting: vi.fn().mockResolvedValue(null),
  setSetting: vi.fn().mockResolvedValue(),
}));

const { Scheduler } = await import("../services/scheduler.js");

function schedulerWith(webhookEvents) {
  const scheduler = new Scheduler({}, {});
  const discordBot = {
    webhookEvents,
    sendNotification: vi.fn(async () => true),
  };
  scheduler.discordBot = discordBot;
  return { scheduler, discordBot };
}

describe("Scheduler._notifyRestartCancelled()", () => {
  it("posts the cancellation when the Scheduled restart event is on", async () => {
    const { scheduler, discordBot } = schedulerWith({
      scheduledRestart: { enabled: true, template: "Restart in {minutes} min" },
    });

    await scheduler._notifyRestartCancelled();

    expect(discordBot.sendNotification).toHaveBeenCalledWith(
      expect.stringContaining("Scheduled restart cancelled"),
    );
  });

  it("posts nothing when the Scheduled restart event is switched off", async () => {
    const { scheduler, discordBot } = schedulerWith({
      scheduledRestart: { enabled: false, template: "Restart in {minutes} min" },
    });

    await scheduler._notifyRestartCancelled();

    expect(discordBot.sendNotification).not.toHaveBeenCalled();
  });

  it("posts nothing when the event was never configured", async () => {
    const { scheduler, discordBot } = schedulerWith({});

    await scheduler._notifyRestartCancelled();

    expect(discordBot.sendNotification).not.toHaveBeenCalled();
  });

  it("does nothing without a Discord bot", async () => {
    const scheduler = new Scheduler({}, {});
    scheduler.discordBot = null;

    await expect(scheduler._notifyRestartCancelled()).resolves.toBeUndefined();
  });
});
