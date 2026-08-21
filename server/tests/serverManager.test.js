import { describe, expect, it } from 'vitest';
import {
  isWindowsDedicatedServerCommandLine,
  scoreServerProcessOwnership,
  ServerManager,
} from '../services/serverManager.js';

describe('ServerManager Windows detection', () => {
  it('should recognize WinGSM-style ProjectZomboid server launches', () => {
    const commandLine = '"C:\\WinGSM\\servers\\1\\serverfiles\\ProjectZomboid64.exe" -cachedir="C:\\WinGSM\\servers\\1\\Zomboid" -servername WheelerZoidB42';

    expect(isWindowsDedicatedServerCommandLine(commandLine)).toBe(true);
  });

  it('should recognize Java dedicated server launches', () => {
    const commandLine = '"C:\\serverfiles\\jre64\\bin\\java.exe" -cp %PZ_CLASSPATH% zombie.network.GameServer -servername WheelerZoidB42';

    expect(isWindowsDedicatedServerCommandLine(commandLine)).toBe(true);
  });

  it('should ignore plain client launches without dedicated-server markers', () => {
    const commandLine = '"C:\\Games\\ProjectZomboid\\ProjectZomboid64.exe"';

    expect(isWindowsDedicatedServerCommandLine(commandLine)).toBe(false);
  });
});

describe('ServerManager process ownership', () => {
  const serverA = {
    serverName: 'ServerA',
    savePath: 'C:\\Zomboid\\A',
    serverPath: 'C:\\pz\\a',
  };

  it('claims a process launched with its own -servername', () => {
    const commandLine =
      '"C:\\pz\\a\\jre64\\bin\\java.exe" -cp pz.jar zombie.network.GameServer -servername "ServerA" -cachedir="C:\\Zomboid\\A"';

    expect(scoreServerProcessOwnership(commandLine, serverA)).toBeGreaterThan(0);
  });

  it('disowns a process launched with a different -servername', () => {
    const commandLine =
      '"C:\\pz\\b\\jre64\\bin\\java.exe" -cp pz.jar zombie.network.GameServer -servername "ServerB" -cachedir="C:\\Zomboid\\B"';

    expect(scoreServerProcessOwnership(commandLine, serverA)).toBe(-1);
  });

  it('disowns a process whose -cachedir points at another save folder', () => {
    const commandLine =
      'java zombie.network.GameServer -servername ServerA -cachedir="C:\\Zomboid\\B"';

    expect(scoreServerProcessOwnership(commandLine, serverA)).toBe(-1);
  });

  it('claims a process by install path when no -servername is present', () => {
    const commandLine =
      '"C:\\pz\\a\\jre64\\bin\\java.exe" -cp pz.jar zombie.network.GameServer';

    expect(scoreServerProcessOwnership(commandLine, serverA)).toBeGreaterThan(0);
  });

  it('leaves an unidentifiable stock launch unattributed', () => {
    const commandLine =
      '.\\jre64\\bin\\java.exe -Djava.library.path=natives/ -cp java/. zombie.network.GameServer';

    expect(scoreServerProcessOwnership(commandLine, serverA)).toBe(0);
  });
});

describe('ServerManager detection with two servers on one host', () => {
  // Only Server A is running.
  const running = [
    {
      pid: '111',
      cmd: 'java zombie.network.GameServer -servername "ServerA" -cachedir="C:\\Zomboid\\A"',
    },
  ];

  const makeManager = (config) => {
    const manager = new ServerManager();
    Object.assign(manager, config, { configLoaded: true });
    manager._scanDedicatedServerProcesses = async () => ({
      running: running.length > 0,
      matched: running,
    });
    return manager;
  };

  it('does not report Server B as running while only Server A is up', async () => {
    const serverB = makeManager({
      serverName: 'ServerB',
      savePath: 'C:\\Zomboid\\B',
      serverPath: 'C:\\pz\\b',
    });

    expect(await serverB.checkServerRunning()).toBe(false);
  });

  it('reports Server A as running and owning only its own PID', async () => {
    const serverA = makeManager({
      serverName: 'ServerA',
      savePath: 'C:\\Zomboid\\A',
      serverPath: 'C:\\pz\\a',
    });

    const details = await serverA.getServerProcessDetails();
    expect(details.running).toBe(true);
    expect(details.owned.map((entry) => entry.pid)).toEqual(['111']);
  });
});

describe('ServerManager status state', () => {
  it('clears tracked process state when a graceful stop is accepted', () => {
    const manager = new ServerManager();
    manager.isRunning = true;
    manager.serverProcess = { pid: 1234 };
    manager.startTime = new Date();

    manager.markServerStopped();

    expect(manager.isRunning).toBe(false);
    expect(manager.serverProcess).toBeNull();
    expect(manager.startTime).toBeNull();
  });

  it('clears stale uptime after a confirmed stop', async () => {
    const manager = new ServerManager();
    manager.configLoaded = true;
    manager.configLoadedFor = null;
    manager.fetchingIp = true;
    manager.gamePort = 16261;
    manager.serverPath = 'C:\\pz';
    manager.startTime = new Date(Date.now() - 60_000);
    manager.loadConfig = async () => {};
    manager.getLocalIp = async () => null;
    manager.getServerProcessDetails = async () => ({
      running: false,
      matched: [],
      scanFailed: false,
    });

    const status = await manager.getServerStatus();

    expect(status.running).toBe(false);
    expect(status.startTime).toBeNull();
    expect(status.uptime).toBe(0);
  });
});
