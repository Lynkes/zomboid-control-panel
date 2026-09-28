import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Community request (Discord, a Linux operator, Lifecycle Provider "Direct
// (default)"): "it would be nice if the panel showed server uptime on the
// dashboard" -- it already tried to, but the start time behind it was an
// in-memory timestamp set when THIS panel process spawned the server, with
// an OS lookup (getProcessUptimeSeconds) only as a one-off recovery while
// that timestamp was null. continuous-bug-hunt round 20 had already fixed
// that recovery being a no-op on Windows; what remained:
//
//   - a systemd-managed server has no process-scan PID at all, so after a
//     panel restart (or when systemd started it at boot) its uptime was
//     never known -- the dashboard hid it (uptime 0);
//   - once set, the timestamp was trusted until a status poll happened to
//     catch the server stopped, so a restart between polls (systemd's
//     Restart=on-failure, a crash-restart wrapper) kept counting from the
//     previous process;
//   - switching the active server carried the previous server's start time
//     over to the new one.
//
// getServerStatus() now asks the OS (server/utils/processStartTime.js,
// mocked here -- its per-platform lookups have their own tests) for the
// start time of whichever PID it just found, on every call, through a
// per-PID cache on the manager.
const { readProcessStartTime } = vi.hoisted(() => ({ readProcessStartTime: vi.fn() }));
vi.mock('../utils/processStartTime.js', () => ({ readProcessStartTime }));

const { ServerManager } = await import('../services/serverManager.js');

const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);
const HOUR = 3600 * 1000;

// A manager whose config is already loaded and whose status call never
// touches the network, with the process check replaced by `details`.
function makeManager(details, options) {
  const manager = new ServerManager(options);
  manager.configLoaded = true;
  manager.fetchingIp = true;
  manager.gamePort = 16261;
  manager.serverPath = '/opt/pz';
  manager.getLocalIp = async () => null;
  if (details) manager.getServerProcessDetails = vi.fn(async () => details());
  return manager;
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  readProcessStartTime.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ServerManager.getServerStatus start time', () => {
  it('re-adopts a server this panel process did not start, from the OS start time of the scanned PID', async () => {
    readProcessStartTime.mockResolvedValue(NOW - 5 * HOUR);
    const manager = makeManager(() => ({
      running: true,
      matched: [{ pid: '4242', cmd: 'java zombie.network.GameServer -servername pz' }],
      scanFailed: false,
    }));

    const status = await manager.getServerStatus();

    expect(readProcessStartTime).toHaveBeenCalledWith('4242');
    expect(status.startTime).toEqual(new Date(NOW - 5 * HOUR));
    expect(status.uptime).toBe(5 * 3600);
  });

  it('knows a systemd-managed server\'s start time from the unit\'s MainPID -- it has no process-scan PID at all', async () => {
    readProcessStartTime.mockResolvedValue(NOW - 2 * HOUR);
    const lifecycle = {
      serviceName: 'zomboid-panel-server-1',
      status: vi.fn(async () => ({ running: true, scanFailed: false, activeState: 'active', mainPid: '777' })),
    };
    const manager = makeManager(null, { lifecycleFactory: () => lifecycle });
    manager.lifecycleProvider = 'systemd';
    manager._serverRecord = { id: 1, lifecycleProvider: 'systemd' };

    const status = await manager.getServerStatus();

    expect(status.running).toBe(true);
    expect(readProcessStartTime).toHaveBeenCalledWith('777');
    expect(status.startTime).toEqual(new Date(NOW - 2 * HOUR));
    expect(status.uptime).toBe(2 * 3600);
  });

  it('follows a server restarted between two polls to its new process instead of counting from the old one', async () => {
    let pid = '100';
    readProcessStartTime.mockImplementation(async (asked) => (asked === '100' ? NOW - 30 * HOUR : NOW - 60_000));
    const manager = makeManager(() => ({
      running: true,
      matched: [{ pid, cmd: 'java zombie.network.GameServer' }],
      scanFailed: false,
    }));

    expect((await manager.getServerStatus()).uptime).toBe(30 * 3600);
    pid = '200'; // restarted by a wrapper/systemd; no poll ever saw it stopped
    const status = await manager.getServerStatus();

    expect(status.startTime).toEqual(new Date(NOW - 60_000));
    expect(status.uptime).toBe(60);
  });

  it('does not carry the previous server\'s start time over to a newly selected server', async () => {
    const manager = makeManager(() => ({
      running: true,
      matched: [{ pid: '5000', cmd: 'java zombie.network.GameServer' }],
      scanFailed: false,
    }));
    manager._serverRecord = { id: 1 };
    manager.startTime = new Date(NOW - 48 * HOUR); // server 1's
    manager.loadConfig = async () => {
      manager._serverRecord = { id: 2 };
      manager.configLoaded = true;
    };
    // The OS can't answer for server 2's process: its uptime is unknown,
    // not server 1's.
    readProcessStartTime.mockResolvedValue(null);

    await manager.reloadConfig();
    const status = await manager.getServerStatus();

    expect(status.startTime).toBeNull();
    expect(status.uptime).toBeNull();
  });

  it('keeps the start time across a settings reload of the SAME server', async () => {
    const manager = makeManager(() => ({ running: true, matched: [], scanFailed: false }));
    manager._serverRecord = { id: 1 };
    manager.startTime = new Date(NOW - HOUR); // this panel's launch record
    manager.loadConfig = async () => {
      manager._serverRecord = { id: 1 };
      manager.configLoaded = true;
    };

    await manager.reloadConfig();
    const status = await manager.getServerStatus();

    expect(status.startTime).toEqual(new Date(NOW - HOUR));
  });

  it('falls back to this panel\'s own launch record only when the OS cannot answer', async () => {
    readProcessStartTime.mockResolvedValue(null);
    const manager = makeManager(() => ({
      running: true,
      matched: [{ pid: '4242', cmd: 'java zombie.network.GameServer' }],
      scanFailed: false,
    }));
    manager.startTime = new Date(NOW - 10 * 60_000);

    const status = await manager.getServerStatus();

    expect(status.startTime).toEqual(new Date(NOW - 10 * 60_000));
    expect(status.uptime).toBe(600);
  });

  it('reports an unknown start time as null uptime, never 0', async () => {
    readProcessStartTime.mockResolvedValue(null);
    const manager = makeManager(() => ({ running: true, matched: [], scanFailed: false }));

    const status = await manager.getServerStatus();

    expect(status.running).toBe(true);
    expect(status.startTime).toBeNull();
    expect(status.uptime).toBeNull();
  });
});

describe('ServerManager.getProcessStartTime cache', () => {
  it('asks the OS once per PID, not once per status poll', async () => {
    readProcessStartTime.mockResolvedValue(NOW - HOUR);
    const manager = makeManager(() => ({
      running: true,
      matched: [{ pid: '4242', cmd: 'java zombie.network.GameServer' }],
      scanFailed: false,
    }));

    await manager.getServerStatus();
    await manager.getServerStatus();
    await manager.getServerStatus();

    expect(readProcessStartTime).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight lookup between concurrent callers', async () => {
    let resolveLookup;
    readProcessStartTime.mockImplementation(() => new Promise((resolve) => { resolveLookup = resolve; }));
    const manager = new ServerManager();

    const first = manager.getProcessStartTime('4242');
    const second = manager.getProcessStartTime('4242');
    resolveLookup(NOW - HOUR);

    await expect(first).resolves.toBe(NOW - HOUR);
    await expect(second).resolves.toBe(NOW - HOUR);
    expect(readProcessStartTime).toHaveBeenCalledTimes(1);
  });

  it('retries a failed lookup after a minute, not on every poll', async () => {
    readProcessStartTime.mockResolvedValueOnce(null).mockResolvedValue(NOW - HOUR);
    const manager = new ServerManager();

    await expect(manager.getProcessStartTime('4242')).resolves.toBeNull();
    await expect(manager.getProcessStartTime('4242')).resolves.toBeNull();
    expect(readProcessStartTime).toHaveBeenCalledTimes(1);

    vi.setSystemTime(NOW + 61_000);
    await expect(manager.getProcessStartTime('4242')).resolves.toBe(NOW - HOUR);
    expect(readProcessStartTime).toHaveBeenCalledTimes(2);
  });

  it('forgets a PID once its process is seen stopped, so a reused PID is asked about afresh', async () => {
    readProcessStartTime.mockResolvedValueOnce(NOW - 30 * HOUR).mockResolvedValue(NOW - 60_000);
    let details = { running: true, matched: [{ pid: '4242', cmd: 'java zombie.network.GameServer' }], scanFailed: false };
    const manager = makeManager(() => details);

    await manager.getServerStatus();
    details = { running: false, matched: [], scanFailed: false };
    expect((await manager.getServerStatus()).startTime).toBeNull();
    details = { running: true, matched: [{ pid: '4242', cmd: 'java zombie.network.GameServer' }], scanFailed: false };
    const status = await manager.getServerStatus();

    expect(readProcessStartTime).toHaveBeenCalledTimes(2);
    expect(status.uptime).toBe(60);
  });

  it('rejects a non-numeric pid without asking the OS at all', async () => {
    const manager = new ServerManager();

    await expect(manager.getProcessStartTime('not-a-pid; rm -rf /')).resolves.toBeNull();
    await expect(manager.getProcessStartTime('0')).resolves.toBeNull();
    expect(readProcessStartTime).not.toHaveBeenCalled();
  });
});
