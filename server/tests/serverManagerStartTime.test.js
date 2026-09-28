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
// start time of whichever process it just found, on every call -- or, on
// Windows, takes it from the scan row that found the process.
const { readProcessStartTime } = vi.hoisted(() => ({ readProcessStartTime: vi.fn() }));
vi.mock('../utils/processStartTime.js', async (importOriginal) => ({
  ...(await importOriginal()),
  readProcessStartTime,
}));

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

// A systemd- (or OpenRC-) managed manager whose service status is whatever
// `unit()` says.
function makeSystemdManager(unit, provider = 'systemd') {
  const lifecycle = { serviceName: 'zomboid-panel-server-1', status: vi.fn(async () => unit()) };
  const manager = makeManager(null, { lifecycleFactory: () => lifecycle });
  manager.lifecycleProvider = provider;
  manager._serverRecord = { id: 1, lifecycleProvider: provider };
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
    const manager = makeSystemdManager(() => ({
      running: true, scanFailed: false, activeState: 'active', mainPid: '777',
    }));

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
    readProcessStartTime.mockResolvedValue(null);
    const manager = makeManager(() => ({
      running: true,
      matched: [{ pid: '4242', cmd: 'java zombie.network.GameServer' }],
      scanFailed: false,
    }));
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
    manager._recordLaunchTime();
    vi.setSystemTime(NOW + 10 * 60_000);

    const status = await manager.getServerStatus();

    expect(status.startTime).toEqual(new Date(NOW));
    expect(status.uptime).toBe(600);
  });

  // Review of the second cut: the launch record was never tied to a PID,
  // so it was kept for whatever process ran next -- the one start time the
  // "never carried over to a different PID" rule didn't cover.
  it('ties the launch record to the process it launched, not to whatever runs next', async () => {
    readProcessStartTime.mockResolvedValue(null);
    let pid = '100';
    const manager = makeManager(() => ({
      running: true,
      matched: [{ pid, cmd: 'java zombie.network.GameServer' }],
      scanFailed: false,
    }));
    manager._recordLaunchTime();

    expect((await manager.getServerStatus()).startTime).toEqual(new Date(NOW));
    pid = '200'; // restarted outside the panel between two polls
    const status = await manager.getServerStatus();

    expect(status.startTime).toBeNull();
    expect(status.uptime).toBeNull();
  });

  it('reports no launch record while the check finds no PID to hold it against', async () => {
    const manager = makeManager(() => ({ running: true, matched: [{ cmd: 'java zombie.network.GameServer' }], scanFailed: false }));
    manager._recordLaunchTime();

    const status = await manager.getServerStatus();

    expect(status.running).toBe(true);
    expect(status.startTime).toBeNull();
    expect(status.uptime).toBeNull();
    expect(readProcessStartTime).not.toHaveBeenCalled();
  });

  // Review of the first cut: the fallback above returned whatever
  // this.startTime held, which after any earlier OS answer was the PREVIOUS
  // process's start time -- a confident wrong uptime for a restarted server
  // exactly while the new process couldn't be looked up yet.
  it('never reports the previous process\'s start time for a new PID the OS cannot answer for', async () => {
    let pid = '100';
    readProcessStartTime.mockImplementation(async (asked) => (asked === '100' ? NOW - 30 * HOUR : null));
    const manager = makeManager(() => ({
      running: true,
      matched: [{ pid, cmd: 'java zombie.network.GameServer' }],
      scanFailed: false,
    }));

    expect((await manager.getServerStatus()).uptime).toBe(30 * 3600);
    pid = '200'; // restarted between polls; the new process can't be asked about yet
    const status = await manager.getServerStatus();

    expect(status.startTime).toBeNull();
    expect(status.uptime).toBeNull();
  });

  it('drops a systemd unit\'s start time while it has no main process (activating, auto-restart after a crash)', async () => {
    readProcessStartTime.mockResolvedValue(NOW - 30 * HOUR);
    let unit = { running: true, scanFailed: false, activeState: 'active', mainPid: '777' };
    const manager = makeSystemdManager(() => unit);

    expect((await manager.getServerStatus()).uptime).toBe(30 * 3600);
    // The RestartSec= window: "activating (auto-restart)" counts as running,
    // with MainPID=0 -- which linuxServiceLifecycle reports as no mainPid.
    unit = { running: true, scanFailed: false, activeState: 'activating' };
    const status = await manager.getServerStatus();

    expect(status.running).toBe(true);
    expect(status.startTime).toBeNull();
    expect(status.uptime).toBeNull();
  });

  // Review: an OpenRC service had only this panel's launch record, which
  // survived every supervise-daemon respawn (--respawn-max 0: unlimited) --
  // "up 2d" for a server that crashed and came back minutes ago. Its
  // supervised child PID now plays systemd's MainPID role.
  it('follows an OpenRC supervise-daemon respawn to the new child instead of counting from the first launch', async () => {
    readProcessStartTime.mockImplementation(async (asked) => (asked === '900' ? NOW - 48 * HOUR : NOW - 3 * 60_000));
    let unit = { running: true, scanFailed: false, activeState: 'active', mainPid: '900' };
    const manager = makeSystemdManager(() => unit, 'openrc');
    manager._recordLaunchTime();

    expect((await manager.getServerStatus()).uptime).toBe(48 * 3600);
    unit = { ...unit, mainPid: '901' }; // crashed; supervise-daemon respawned it
    const status = await manager.getServerStatus();

    expect(readProcessStartTime).toHaveBeenLastCalledWith('901');
    expect(status.uptime).toBe(3 * 60);
  });

  it('does not fall back to an unverifiable launch record for an OpenRC service whose child PID is unknown', async () => {
    const manager = makeSystemdManager(
      () => ({ running: true, scanFailed: false, activeState: 'active' }),
      'openrc',
    );
    manager._recordLaunchTime();
    vi.setSystemTime(NOW + 2 * 24 * HOUR);

    const status = await manager.getServerStatus();

    expect(status.running).toBe(true);
    expect(status.startTime).toBeNull();
    expect(status.uptime).toBeNull();
  });

  it('keeps an earlier answer for the SAME process when a later lookup for it fails', async () => {
    readProcessStartTime.mockResolvedValueOnce(NOW - 3 * HOUR).mockResolvedValue(null);
    const manager = makeManager(() => ({
      running: true,
      matched: [{ pid: '4242', cmd: 'java zombie.network.GameServer' }],
      scanFailed: false,
    }));

    await manager.getServerStatus();
    const status = await manager.getServerStatus();

    expect(readProcessStartTime).toHaveBeenCalledTimes(2);
    expect(status.uptime).toBe(3 * 3600);
  });

  it('does not let a lookup that outlived a stop and a fresh launch write the old process\'s start time back', async () => {
    let resolveLookup;
    readProcessStartTime.mockImplementation(() => new Promise((resolve) => { resolveLookup = resolve; }));
    const manager = new ServerManager();

    const inFlight = manager.resolveStartTime({ running: true, matched: [{ pid: '100', cmd: 'java' }] });
    manager._clearRunState(); // the old process was stopped...
    manager._recordLaunchTime(); // ...and this panel launched a new one
    const launchRecord = manager.startTime;
    resolveLookup(NOW - 30 * HOUR); // the old process's answer finally lands

    await expect(inFlight).resolves.toBeNull();
    expect(manager.startTime).toBe(launchRecord);
    expect(manager._startTimePid).toBeNull();
  });

  // Review of the merge: an OpenRC service mid-stop (rc-service status 4)
  // or with a crashed supervise-daemon (32) reads as a failed scan, which
  // skips _clearRunState() -- and the retained start time was reported as
  // the uptime of a server that isn't confirmed running (Discord /status
  // showed the previous run's "3h 0m" beside "Unknown (detection failed)").
  it('reports no uptime while a failed scan cannot confirm the server running, and keeps the start time for the next confirmed scan', async () => {
    readProcessStartTime.mockResolvedValue(null);
    let unit = { running: true, scanFailed: false, activeState: 'active', mainPid: '900' };
    const manager = makeSystemdManager(() => unit, 'openrc');
    readProcessStartTime.mockResolvedValueOnce(NOW - 3 * HOUR);
    expect((await manager.getServerStatus()).uptime).toBe(3 * 3600);

    unit = { running: false, scanFailed: true, activeState: 'deactivating' };
    const status = await manager.getServerStatus();

    expect(status.running).toBe(false);
    expect(status.scanFailed).toBe(true);
    expect(status.startTime).toBeNull();
    expect(status.uptime).toBeNull();
    // Not a confirmed stop: the same process, seen running again, still
    // has its start time.
    unit = { running: true, scanFailed: false, activeState: 'active', mainPid: '900' };
    expect((await manager.getServerStatus()).uptime).toBe(3 * 3600);
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

describe('ServerManager start time from a Windows scan row', () => {
  it('uses the start time the Win32_Process row carried, without asking the OS again', async () => {
    let row = { pid: '4242', cmd: 'java.exe zombie.network.GameServer', startedMs: NOW - 5 * HOUR };
    const manager = makeManager(() => ({ running: true, matched: [row], scanFailed: false }));

    expect((await manager.getServerStatus()).uptime).toBe(5 * 3600);
    // Restarted, and Windows handed the new java.exe the SAME pid: the row
    // was read by the query that identified the process, so it describes
    // the new one.
    row = { ...row, startedMs: NOW - 60_000 };
    expect((await manager.getServerStatus()).uptime).toBe(60);
    expect(readProcessStartTime).not.toHaveBeenCalled();
  });

  it('treats an implausible row value (in the future) as unknown', async () => {
    const manager = makeManager(() => ({
      running: true,
      matched: [{ pid: '4242', cmd: 'java.exe zombie.network.GameServer', startedMs: NOW + HOUR }],
      scanFailed: false,
    }));

    expect((await manager.getServerStatus()).uptime).toBeNull();
    expect(readProcessStartTime).not.toHaveBeenCalled();
  });
});

describe('ServerManager.getProcessStartTime cache', () => {
  // Review of the first cut: successful answers were kept per PID until
  // the panel saw that process stop, so a restart it never saw (a crash
  // wrapper, systemd's Restart=, a non-active server's card) left the old
  // answer behind for whichever later process reused the PID.
  it('asks afresh on every poll, so a reused PID is never served an earlier process\'s start time', async () => {
    readProcessStartTime.mockResolvedValueOnce(NOW - 30 * HOUR).mockResolvedValue(NOW - 60_000);
    const manager = makeManager(() => ({
      running: true,
      matched: [{ pid: '4242', cmd: 'java zombie.network.GameServer' }],
      scanFailed: false,
    }));

    expect((await manager.getServerStatus()).uptime).toBe(30 * 3600);
    const status = await manager.getServerStatus(); // same PID, new process

    expect(readProcessStartTime).toHaveBeenCalledTimes(2);
    expect(status.uptime).toBe(60);
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

  it('rejects a non-numeric pid without asking the OS at all', async () => {
    const manager = new ServerManager();

    await expect(manager.getProcessStartTime('not-a-pid; rm -rf /')).resolves.toBeNull();
    await expect(manager.getProcessStartTime('0')).resolves.toBeNull();
    expect(readProcessStartTime).not.toHaveBeenCalled();
  });
});
