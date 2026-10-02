import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Live state for the Server Files gates (spec §A5.5): one answer per
// provider, "unknown" whenever the signal couldn't be verified, and a 5 s
// cache that `fresh` bypasses.

const { getRunState, getSharedRunState, _setRunStateDepsForTests } = await import("../services/fileManagerRunState.js");

let clock;

function app(services = {}) {
  return { get: (key) => services[key] };
}

beforeEach(() => {
  clock = 1_000_000;
  _setRunStateDepsForTests({ now: () => clock });
});

afterEach(() => {
  _setRunStateDepsForTests({});
});

describe("per provider", () => {
  it("a remote profile is always unknown", async () => {
    expect(await getRunState({ id: "r1", isRemote: true }, app())).toBe("unknown");
  });

  it("Docker: the managed container's signal, scanFailed as unknown", async () => {
    const signal = vi.fn();
    _setRunStateDepsForTests({ now: () => clock, resolveDockerHostSignal: signal });
    const docker = { id: "d1", provider: "docker-local", dockerContainerName: "pz" };
    signal.mockResolvedValueOnce({ running: true, scanFailed: false });
    expect(await getRunState(docker, app({ dockerClient: {} }), { fresh: true })).toBe("running");
    signal.mockResolvedValueOnce({ running: false, scanFailed: false });
    expect(await getRunState(docker, app(), { fresh: true })).toBe("stopped");
    signal.mockResolvedValueOnce({ running: false, scanFailed: true });
    expect(await getRunState(docker, app(), { fresh: true })).toBe("unknown");
    signal.mockRejectedValueOnce(new Error("socket gone"));
    expect(await getRunState(docker, app(), { fresh: true })).toBe("unknown");
  });

  it("systemd/OpenRC: the unit's state, scanFailed as unknown", async () => {
    const status = vi.fn();
    _setRunStateDepsForTests({ now: () => clock, createLinuxServiceLifecycle: () => ({ status }) });
    const unit = { id: "s1", lifecycleProvider: "systemd" };
    status.mockResolvedValueOnce({ running: true, scanFailed: false });
    expect(await getRunState(unit, app(), { fresh: true })).toBe("running");
    status.mockResolvedValueOnce({ running: false, scanFailed: true });
    expect(await getRunState(unit, app(), { fresh: true })).toBe("unknown");
  });

  it("native, active profile: the shared ServerManager's answer", async () => {
    const details = vi.fn();
    const profile = { id: "n1", isActive: true, lifecycleProvider: "direct" };
    const services = { serverManager: { getServerProcessDetails: details } };
    details.mockResolvedValueOnce({ running: true, scanFailed: false });
    expect(await getRunState(profile, app(services), { fresh: true })).toBe("running");
    details.mockResolvedValueOnce({ running: false, scanFailed: true });
    expect(await getRunState(profile, app(services), { fresh: true })).toBe("unknown");
    details.mockRejectedValueOnce(new Error("boom"));
    expect(await getRunState(profile, app(services), { fresh: true })).toBe("unknown");
    expect(await getRunState(profile, app({}), { fresh: true })).toBe("unknown");
  });

  it("native, other profiles: a host scan attributed by -servername/-cachedir", async () => {
    const scan = vi.fn();
    _setRunStateDepsForTests({ now: () => clock, createServerManager: () => ({ scanHostForServerProcesses: scan }) });
    const profile = { id: "n2", isActive: false, serverName: "second", zomboidDataPath: "/srv/zomboid2", installPath: "/srv/pz" };
    scan.mockResolvedValueOnce({ matched: [{ cmd: "java -cp x zombie.network.GameServer -servername first" }], scanFailed: false });
    expect(await getRunState(profile, app(), { fresh: true })).toBe("stopped");
    scan.mockResolvedValueOnce({ matched: [{ cmd: "java -cp x zombie.network.GameServer -servername second" }], scanFailed: false });
    expect(await getRunState(profile, app(), { fresh: true })).toBe("running");
    scan.mockResolvedValueOnce({ matched: [], scanFailed: true });
    expect(await getRunState(profile, app(), { fresh: true })).toBe("unknown");
    // Windows also listed a process the panel can't read: it may be this one.
    const unreadable = [{ pid: "7000", startedMs: 1790964741863 }];
    scan.mockResolvedValueOnce({ matched: [{ cmd: "java -cp x zombie.network.GameServer -servername first" }], unreadable, scanFailed: false });
    expect(await getRunState(profile, app(), { fresh: true })).toBe("unknown");
    scan.mockResolvedValueOnce({ matched: [{ cmd: "java -cp x zombie.network.GameServer -servername second" }], unreadable, scanFailed: false });
    expect(await getRunState(profile, app(), { fresh: true })).toBe("running");
  });
});

describe("cache", () => {
  it("answers from a 5 s cache unless asked fresh", async () => {
    const details = vi.fn().mockResolvedValue({ running: true, scanFailed: false });
    const services = { serverManager: { getServerProcessDetails: details } };
    const profile = { id: "c1", isActive: true };
    expect(await getRunState(profile, app(services))).toBe("running");
    details.mockResolvedValue({ running: false, scanFailed: false });
    clock += 4000;
    expect(await getRunState(profile, app(services))).toBe("running");
    expect(await getRunState(profile, app(services), { fresh: true })).toBe("stopped");
    details.mockResolvedValue({ running: true, scanFailed: false });
    clock += 5001;
    expect(await getRunState(profile, app(services))).toBe("running");
    expect(details).toHaveBeenCalledTimes(3);
  });
});

describe("shared folders", () => {
  it("running if any profile runs, else unknown if any is unknown, else stopped", async () => {
    _setRunStateDepsForTests({
      now: () => clock,
      resolveDockerHostSignal: async () => ({ running: true, scanFailed: false }),
    });
    const services = { serverManager: { getServerProcessDetails: async () => ({ running: false, scanFailed: false }) } };
    const native = { id: "n", isActive: true };
    const remote = { id: "r", isRemote: true };
    const docker = { id: "d", provider: "docker-managed" };
    expect(await getSharedRunState([native], app(services))).toBe("stopped");
    expect(await getSharedRunState([native, remote], app(services))).toBe("unknown");
    expect(await getSharedRunState([native, remote, docker], app(services))).toBe("running");
  });
});
