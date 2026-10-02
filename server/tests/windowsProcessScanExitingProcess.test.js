import { beforeEach, describe, expect, it, vi } from "vitest";

// GH #190: on Windows, a process scan that caught the old JVM while it was
// exiting came back "unparseable" and made the server's state unknown --
// the reporter's log had ~1,400 of those warnings in three weeks, and one
// of them stopped a scheduled restart halfway.
//
// Root cause, reproduced on Windows 11 (2026-10-02): Win32_Process reads a
// process's command line out of that process's own memory. While a JVM
// tears down its heap it is still listed, but with no command line, and
// ConvertTo-Csv writes the null as an empty unquoted field:
//
//   "31144","""C:\...\java.exe"" -Xms4g ...","1790964741863"   (running)
//   "31144",,"1790964741863"                                     (exiting, ~400 ms for a 4 GB heap)
//   <no row>                                                     (gone)
//
// The old row regex required a quoted command line, so the exiting row was
// "malformed" and poisoned the whole scan. Now such a row parses with
// cmd: null, and the scan looks again shortly after: gone (or readable)
// means it was exiting and doesn't count; still listed with no command line
// means a live process the panel may not read, which stays "unknown" -- it
// could be this very server.
//
// These call _scanWindowsServerProcesses() directly, so they run on every
// platform: PowerShell is mocked.

const { execFileMock, logs } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
  logs: { entries: [] },
}));
vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFile: (...args) => execFileMock(...args) };
});
vi.mock("../utils/logger.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createLogger: (source) =>
      new Proxy(
        {},
        {
          get: (_target, level) =>
            level === "then"
              ? undefined
              : (message) => logs.entries.push({ source, level, message: String(message) }),
        },
      ),
  };
});

const {
  ServerManager,
  classifyWin32ProcessRows,
  describeWin32CsvRowShape,
  parseWin32ProcessCsvRow,
  resetWin32ScanMemoryForTests,
  splitWin32ProcessCsvRecords,
} = await import("../services/serverManager.js");

const STARTED_MS = 1790964741863;
const OTHER_STARTED_MS = 1790877243979;
// A stock B42 dedicated server's JVM, as Win32_Process reports it.
const PZ_SERVER_CMD = String.raw`"C:\PZServer\jre64\bin\java.exe" -Djava.awt.headless=true -Dzomboid.steam=1 -Dzomboid.znetlog=1 -XX:+UseZGC -XX:-OmitStackTraceInFastThrow -Xms8g -Xmx8g -Djava.library.path=natives/;natives/win64/;. -cp java/;java/projectzomboid.jar zombie.network.GameServer -statistic 0 -servername Tower`;
const JENKINS_CMD = String.raw`"C:\Program Files\Jenkins\jre\bin\java.exe" -Xrs -Xmx256m -jar "C:\Program Files\Jenkins\jenkins.war" --httpPort=8080`;
const PZ_CLIENT_CMD = String.raw`"D:\SteamLibrary\steamapps\common\ProjectZomboid\ProjectZomboid64.exe"`;

const HEADER = '"ProcessId","CommandLine","StartMs"';
const csvValue = (value) => `"${value.replace(/"/g, '""')}"`;
const row = (pid, cmd, startedMs = STARTED_MS) =>
  `"${pid}",${cmd === null ? "" : csvValue(cmd)},${startedMs === null ? "" : `"${startedMs}"`}`;
const csv = (...rows) => `${[HEADER, ...rows].join("\r\n")}\r\n`;

// One PowerShell answer per call, in order.
function powershellAnswers(...stdouts) {
  const queue = [...stdouts];
  execFileMock.mockImplementation((_file, _args, _opts, callback) => {
    callback(null, queue.length > 0 ? queue.shift() : "", "");
  });
}

function newManager() {
  const manager = new ServerManager();
  manager.sleep = vi.fn(async () => {});
  return manager;
}

const warnings = () =>
  logs.entries.filter((entry) => entry.source === "Server" && entry.level === "warn");

beforeEach(() => {
  execFileMock.mockReset();
  logs.entries.length = 0;
  resetWin32ScanMemoryForTests();
});

describe("Win32_Process CSV parsing", () => {
  it("reads the exiting JVM's row (no command line) as cmd: null, not as a broken row", () => {
    expect(parseWin32ProcessCsvRow(row(31144, null))).toEqual({
      pid: "31144",
      cmd: null,
      startedMs: STARTED_MS,
    });
    expect(parseWin32ProcessCsvRow('"31144",,')).toEqual({
      pid: "31144",
      cmd: null,
      startedMs: null,
    });
  });

  it("keeps commas and doubled quotes inside a command line", () => {
    const cmd = String.raw`"C:\Java\java.exe" -Dlist=a,b,c -servername "My, World"`;
    expect(parseWin32ProcessCsvRow(row(42, cmd))).toEqual({
      pid: "42",
      cmd,
      startedMs: STARTED_MS,
    });
  });

  it("rejects text that isn't a ConvertTo-Csv row", () => {
    expect(parseWin32ProcessCsvRow("WARNING: Some diagnostic banner text")).toBeNull();
    expect(parseWin32ProcessCsvRow('"1234","java -servername Tower')).toBeNull();
    expect(parseWin32ProcessCsvRow('"abc","java"')).toBeNull();
    expect(parseWin32ProcessCsvRow('"1","java"x,"1"')).toBeNull();
    expect(parseWin32ProcessCsvRow('"1","a","2","3"')).toBeNull();
  });

  it("keeps a command line with a line break in it as one record", () => {
    const cmd = 'java.exe -Dmotd="line one\r\nline two" zombie.network.GameServer -servername Tower';
    const records = splitWin32ProcessCsvRecords(csv(row(5120, cmd), row(31144, null)));

    expect(records).toHaveLength(3);
    expect(parseWin32ProcessCsvRow(records[1])).toMatchObject({ pid: "5120", cmd: cmd.replace("\r\n", "\n") });
    expect(parseWin32ProcessCsvRow(records[2])).toMatchObject({ pid: "31144", cmd: null });
  });

  it("does not let a stray quote in a non-row line swallow the rows after it", () => {
    const records = splitWin32ProcessCsvRecords(
      `WARNING: "odd quote\r\n${row(5120, PZ_SERVER_CMD)}\r\n`,
    );

    expect(records).toHaveLength(2);
    expect(parseWin32ProcessCsvRow(records[1])?.cmd).toBe(PZ_SERVER_CMD);
  });

  it("sorts a realistic scan into its buckets", () => {
    const rows = classifyWin32ProcessRows(
      csv(
        row(5120, PZ_SERVER_CMD),
        row(6000, JENKINS_CMD, OTHER_STARTED_MS),
        row(6100, PZ_CLIENT_CMD, OTHER_STARTED_MS),
        row(31144, null),
        row(6200, String.raw`"C:\Java\java.exe" -jar "C:\PZ\zomboid-dedicated.jar"`),
        "garbage",
      ),
    );

    expect(rows.matched).toEqual([{ pid: "5120", cmd: PZ_SERVER_CMD, startedMs: STARTED_MS }]);
    expect(rows.ambiguous).toHaveLength(1);
    expect(rows.unreadable).toEqual([{ pid: "31144", startedMs: STARTED_MS }]);
    expect(rows.malformed).toEqual(["garbage"]);
  });

  it("logs a row's shape without its content", () => {
    expect(describeWin32CsvRowShape('"5120","java -adminpassword hunter2')).toBe('"<4>","<27>');
    expect(describeWin32CsvRowShape('"4",,"1789503827395"')).toBe('"<1>",,"<13>"');
    expect(describeWin32CsvRowShape("WARNING: banner")).toBe("<15>");
  });
});

describe("Windows process scan: a process that exits mid-scan (GH #190)", () => {
  it("skips the exiting server's row once a second look shows it gone", async () => {
    powershellAnswers(csv(row(5120, null)), "");
    const manager = newManager();

    const result = await manager._scanWindowsServerProcesses();

    expect(result).toEqual({ running: false, matched: [] });
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(manager.sleep).toHaveBeenCalledWith(750);
    expect(warnings()).toEqual([]);
  });

  it("skips it when other, unrelated JVMs are still there on the second look", async () => {
    powershellAnswers(
      csv(row(6000, JENKINS_CMD, OTHER_STARTED_MS), row(5120, null), row(6100, PZ_CLIENT_CMD, OTHER_STARTED_MS)),
      csv(row(6000, JENKINS_CMD, OTHER_STARTED_MS), row(6100, PZ_CLIENT_CMD, OTHER_STARTED_MS)),
    );

    const result = await newManager()._scanWindowsServerProcesses();

    expect(result).toEqual({ running: false, matched: [] });
    expect(warnings()).toEqual([]);
  });

  it("reports the server running when the second look can read it after all", async () => {
    powershellAnswers(csv(row(5120, null)), csv(row(5120, PZ_SERVER_CMD)));

    const result = await newManager()._scanWindowsServerProcesses();

    expect(result).toEqual({
      running: true,
      matched: [{ pid: "5120", cmd: PZ_SERVER_CMD, startedMs: STARTED_MS }],
    });
  });

  it("does not look twice when a server is plainly running next to an unreadable process", async () => {
    powershellAnswers(csv(row(5120, PZ_SERVER_CMD), row(7000, null, OTHER_STARTED_MS)));

    const result = await newManager()._scanWindowsServerProcesses();

    expect(result.running).toBe(true);
    expect(result.matched).toHaveLength(1);
    // Still reported, for a server none of `matched` belongs to.
    expect(result.unreadable).toEqual([{ pid: "7000", startedMs: OTHER_STARTED_MS }]);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("stays unknown for a process that is still there with no command line -- it could be this server", async () => {
    powershellAnswers(csv(row(7000, null, OTHER_STARTED_MS)), csv(row(7000, null, OTHER_STARTED_MS)));

    const result = await newManager()._scanWindowsServerProcesses();

    expect(result).toEqual({
      running: false,
      matched: [],
      scanFailed: true,
      unreadable: [{ pid: "7000", startedMs: OTHER_STARTED_MS }],
    });
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].message).toMatch(/7000/);
    expect(warnings()[0].message).toMatch(/administrator or by another Windows user/);
  });

  it("does not pay for a second look, or warn again, on every poll for that same process", async () => {
    powershellAnswers(
      csv(row(7000, null, OTHER_STARTED_MS)),
      csv(row(7000, null, OTHER_STARTED_MS)),
      csv(row(7000, null, OTHER_STARTED_MS)),
      csv(row(7000, null, OTHER_STARTED_MS)),
    );

    await newManager()._scanWindowsServerProcesses();
    const second = await newManager()._scanWindowsServerProcesses();
    const third = await newManager()._scanWindowsServerProcesses();

    expect(second.scanFailed).toBe(true);
    expect(third.scanFailed).toBe(true);
    // 2 for the first poll, then 1 each.
    expect(execFileMock).toHaveBeenCalledTimes(4);
    expect(warnings()).toHaveLength(1);
  });

  it("looks again for a NEW process with no command line even after an earlier one was remembered", async () => {
    powershellAnswers(
      csv(row(7000, null, OTHER_STARTED_MS)),
      csv(row(7000, null, OTHER_STARTED_MS)),
      csv(row(7000, null, OTHER_STARTED_MS), row(5120, null)),
      csv(row(7000, null, OTHER_STARTED_MS)),
    );

    await newManager()._scanWindowsServerProcesses();
    const result = await newManager()._scanWindowsServerProcesses();

    // 5120 exited; 7000 is still unreadable, so the answer stays unknown.
    expect(result.scanFailed).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(4);
  });

  it("still fails closed, without a second look, on output that isn't CSV at all -- and says what it looked like", async () => {
    powershellAnswers(`WARNING: banner\r\n${row(5120, null)}\r\n"6000","java -adminpassword hunter2\r\n`);

    const result = await newManager()._scanWindowsServerProcesses();

    expect(result).toEqual({ running: false, matched: [], scanFailed: true });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].message).toMatch(/unparseable output \(2 row\(s\), first shaped <15>\)/);
    expect(warnings()[0].message).not.toMatch(/hunter2/);
  });

  it("warns about the same unparseable output once, then logs repeats at debug", async () => {
    powershellAnswers("garbage\r\n", "garbage\r\n", "garbage\r\n");

    for (let i = 0; i < 3; i++) {
      expect((await newManager()._scanWindowsServerProcesses()).scanFailed).toBe(true);
    }

    expect(warnings()).toHaveLength(1);
    expect(
      logs.entries.filter((entry) => entry.level === "debug" && /unparseable/.test(entry.message)),
    ).toHaveLength(2);
  });

  it("recognizes a server whose command line has a line break in it", async () => {
    const cmd = 'java.exe -Dmotd="a\r\nb" zombie.network.GameServer -servername Tower';
    powershellAnswers(csv(row(5120, cmd)));

    const result = await newManager()._scanWindowsServerProcesses();

    expect(result.running).toBe(true);
    expect(result.matched[0].pid).toBe("5120");
  });

  it("an empty answer is still a confirmed stop", async () => {
    powershellAnswers("");

    await expect(newManager()._scanWindowsServerProcesses()).resolves.toEqual({
      running: false,
      matched: [],
    });
  });

  // Review finding (2026-10-02): a row with no command line was dropped as
  // soon as ANY server was recognized, so on a host running several
  // servers, one whose JVM the panel can't read (or that is exiting) read
  // as confidently stopped while another server ran.
  describe("on a host where another server is running", () => {
    function managerFor(serverName) {
      const manager = newManager();
      manager.loadConfig = async () => {};
      manager.usesManagedServiceLifecycle = () => false;
      manager.serverName = serverName;
      manager._tryPidFileFastPath = async () => null;
      manager._scanDedicatedServerProcesses = () => manager._scanWindowsServerProcesses();
      return manager;
    }
    const OTHER_SERVER_CMD = PZ_SERVER_CMD.replace("-servername Tower", "-servername Other");

    it("reads this server as unknown, not stopped, when a process it can't read is listed too", async () => {
      powershellAnswers(csv(row(4000, OTHER_SERVER_CMD, OTHER_STARTED_MS), row(7000, null)));
      const manager = managerFor("Tower");
      manager.isRunning = true;

      const details = await manager.getServerProcessDetails();

      expect(details).toMatchObject({
        running: false,
        scanFailed: true,
        unreadable: [{ pid: "7000", startedMs: STARTED_MS }],
      });
      // An unknown answer doesn't overwrite the last known state.
      expect(manager.isRunning).toBe(true);
      expect(warnings().some((entry) => /7000/.test(entry.message) && /"Tower"/.test(entry.message))).toBe(true);
    });

    it("still reads the server that IS recognized as running", async () => {
      powershellAnswers(csv(row(4000, OTHER_SERVER_CMD, OTHER_STARTED_MS), row(7000, null)));

      const details = await managerFor("Other").getServerProcessDetails();

      expect(details).toMatchObject({ running: true, scanFailed: false });
      expect(details.unreadable).toBeUndefined();
    });

    it("with nothing unreadable, another server running still means this one is stopped", async () => {
      powershellAnswers(csv(row(4000, OTHER_SERVER_CMD, OTHER_STARTED_MS)));

      await expect(managerFor("Tower").getServerProcessDetails()).resolves.toMatchObject({
        running: false,
        scanFailed: false,
      });
    });
  });

  it.runIf(process.platform === "win32")(
    "the host-wide scan reports the exiting server as stopped, not unknown, and records it",
    async () => {
      powershellAnswers(csv(row(5120, null)), "");
      const manager = newManager();
      manager.isRunning = true;

      const result = await manager._scanDedicatedServerProcesses();

      expect(result).toEqual({ running: false, matched: [] });
      expect(manager.isRunning).toBe(false);
    },
  );
});
