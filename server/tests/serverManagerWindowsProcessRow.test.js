import { execFileSync } from 'child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Server uptime on Windows: the start time of the dedicated server process
// now rides on the Win32_Process row the process scan (and the pidfile fast
// path) already reads every status poll, as a third CSV column, instead of
// a separate PowerShell lookup by PID -- which was a second cold start per
// process (routinely past its 5s timeout while a loading PZ server
// saturated the CPU) and, cached per PID, could answer for a later process
// that reused the PID.
//
// execFile mocked at module scope, matching serverManagerEmptyScanWindows.
// test.js's own established convention for the scan.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFile: (...args) => execFileMock(...args) };
});

const { ServerManager, parseWin32ProcessCsvRow } = await import('../services/serverManager.js');
const { WIN32_PROCESS_START_MS } = await import('../utils/processStartTime.js');

const STARTED_MS = Date.UTC(2026, 8, 27, 7, 0, 0);
const GAME_SERVER_CMD = 'java.exe -cp X zombie.network.GameServer -servername Test';

describe('parseWin32ProcessCsvRow', () => {
  it('reads the pid, the command line and the start time of a ConvertTo-Csv row', () => {
    expect(parseWin32ProcessCsvRow(`"1234","${GAME_SERVER_CMD}","${STARTED_MS}"`)).toEqual({
      pid: '1234',
      cmd: GAME_SERVER_CMD,
      startedMs: STARTED_MS,
    });
  });

  it('un-doubles quotes inside the command line without mistaking them for a field boundary', () => {
    const row = parseWin32ProcessCsvRow('"1234","java.exe -servername=""My World""","1790000000000"');

    expect(row.cmd).toBe('java.exe -servername="My World"');
    expect(row.startedMs).toBe(1790000000000);
  });

  it('leaves the start time unknown, not the row malformed, when PowerShell wrote StartMs as null or it is absent', () => {
    // A null value is an EMPTY, UNQUOTED field in Windows PowerShell's
    // ConvertTo-Csv; a two-column row is the pre-StartMs shape.
    expect(parseWin32ProcessCsvRow(`"1234","${GAME_SERVER_CMD}",`)).toEqual({
      pid: '1234', cmd: GAME_SERVER_CMD, startedMs: null,
    });
    expect(parseWin32ProcessCsvRow(`"1234","${GAME_SERVER_CMD}"`)).toEqual({
      pid: '1234', cmd: GAME_SERVER_CMD, startedMs: null,
    });
  });

  it('reads a row with no readable command line (null CommandLine) as cmd: null, not as a broken row (GH #190)', () => {
    // Captured live: `"4",,"1789503827395"` (the System process) -- and the
    // same shape for a JVM in the middle of exiting.
    expect(parseWin32ProcessCsvRow('"4",,"1789503827395"')).toEqual({
      pid: '4', cmd: null, startedMs: 1789503827395,
    });
    expect(parseWin32ProcessCsvRow('garbage')).toBeNull();
  });
});

describe('ServerManager Windows process rows carry the start time', () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it.runIf(process.platform === 'win32')(
    'the full scan selects StartMs and keeps it on each matched process',
    async () => {
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        callback(
          null,
          `"ProcessId","CommandLine","StartMs"\r\n"1234","${GAME_SERVER_CMD}","${STARTED_MS}"\r\n`,
          '',
        );
      });

      const manager = new ServerManager();
      const result = await manager._scanDedicatedServerProcesses();

      expect(execFileMock.mock.calls[0][1].at(-1)).toContain(WIN32_PROCESS_START_MS);
      expect(result.matched).toEqual([{ pid: '1234', cmd: GAME_SERVER_CMD, startedMs: STARTED_MS }]);
    },
  );

  it.runIf(process.platform === 'win32')(
    'the pidfile fast path reads the start time in the same query as the command line',
    async () => {
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        callback(null, `"ProcessId","CommandLine","StartMs"\r\n"4242","${GAME_SERVER_CMD}","${STARTED_MS}"\r\n`, '');
      });

      const manager = new ServerManager();
      const live = await manager._getLiveProcess(4242);

      const script = execFileMock.mock.calls[0][1].at(-1);
      expect(script).toContain("ProcessId=4242");
      expect(script).toContain(WIN32_PROCESS_START_MS);
      expect(live).toEqual({ cmd: GAME_SERVER_CMD, startedMs: STARTED_MS });
    },
  );

  it.runIf(process.platform === 'win32')(
    'the fast path reports a PID with no Win32_Process row as not alive',
    async () => {
      // An empty filtered pipeline prints nothing, not even a header.
      execFileMock.mockImplementation((_file, _args, _opts, callback) => {
        callback(null, '', '');
      });

      await expect(new ServerManager()._getLiveProcess(4242)).resolves.toBeNull();
    },
  );

  // Real PowerShell, not a fixture: the same calculated property, run
  // against this test process itself, must come back as a parseable epoch
  // millisecond value close to when Node says this process started.
  it.runIf(process.platform === 'win32')(
    'real end-to-end: Windows PowerShell returns a StartMs this parser reads, matching the process\'s real start',
    () => {
      const output = execFileSync(
        'powershell.exe',
        [
          '-NoLogo',
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}' | Select-Object ProcessId,CommandLine,${WIN32_PROCESS_START_MS} | ConvertTo-Csv -NoTypeInformation`,
        ],
        { encoding: 'utf-8', timeout: 60_000, windowsHide: true },
      );
      const row = output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.startsWith(`"${process.pid}"`))
        .map(parseWin32ProcessCsvRow)[0];

      expect(row?.pid).toBe(String(process.pid));
      // process.uptime() is process-wide, unlike a worker thread's own
      // performance.timeOrigin.
      const processStartedMs = Date.now() - process.uptime() * 1000;
      expect(Math.abs(row.startedMs - processStartedMs)).toBeLessThan(10_000);
    },
    60_000,
  );
});
