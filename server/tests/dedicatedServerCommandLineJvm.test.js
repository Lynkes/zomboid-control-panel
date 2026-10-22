import { describe, expect, it, vi, afterEach, afterAll } from "vitest";

// The "custom generic setup" fallback rule of the dedicated-server matcher
// ("names zomboid AND carries -server/startserver") had no JVM requirement, so
// anything merely mentioning a zomboid path and "-server" counted as the
// server: `tail -f .../Zomboid/Logs/..._DebugLog-server.txt`, `less` on the
// same log, or the start-server_<name>.sh wrapper script that is still alive
// while it waits on the java child. That process then won the "unattributable"
// bucket whenever the real server was stopped, so the panel showed Running,
// refused Start, and Stop killed the wrong thing. A dedicated server is always,
// by the time it runs, a JVM -- the fallback now requires a java/javaw token.

const execMock = vi.fn();
vi.mock("child_process", () => ({
  exec: (...args) => execMock(...args),
  execFile: vi.fn(),
  spawn: vi.fn(),
}));

vi.mock("../database/init.js", () => ({
  getActiveServer: vi.fn(async () => null),
  getServer: vi.fn(async () => null),
  getServers: vi.fn(async () => []),
  getSetting: vi.fn(async () => null),
  setSetting: vi.fn(async () => {}),
  logServerEvent: vi.fn(async () => {}),
}));

vi.mock("../utils/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const originalPlatform = process.platform;
Object.defineProperty(process, "platform", {
  value: "linux",
  configurable: true,
});

const {
  ServerManager,
  isLinuxDedicatedServerCommandLine,
  isWindowsDedicatedServerCommandLine,
} = await import("../services/serverManager.js");

afterEach(() => {
  execMock.mockReset();
});

afterAll(() => {
  Object.defineProperty(process, "platform", {
    value: originalPlatform,
    configurable: true,
  });
});

const NOT_A_SERVER_LINUX = [
  "tail -f /home/pz/Zomboid/Logs/2026-10-10_12-00-00_DebugLog-server.txt",
  "less /home/pz/Zomboid/Logs/2026-10-10_12-00-00_DebugLog-server.txt",
  "grep -r startserver /home/pz/Zomboid/Server",
  "bash /home/pz/start-server_My Zomboid Server.sh",
  "/bin/bash /opt/pz/StartServer_zomboid.sh",
  // "java" only as a path segment / property, never the executable.
  "tail -f /home/java/Zomboid/Logs/x_DebugLog-server.txt",
  "vim -Djava.zomboid=1 /home/pz/Zomboid/Server/servertest-server.ini",
];

const REAL_SERVER_LINUX = [
  // rule 1 (direct GameServer launch) is untouched
  "/home/pz/jre64/bin/java -Djava.awt.headless=true -cp /home/pz/java/* zombie.network.GameServer -servername My Zomboid Server",
  // rule 2 (native launcher) is untouched
  "/home/pz/ProjectZomboid64 -servername X -cachedir=/home/pz/Zomboid",
  // rule 3 with a real JVM: a -jar launcher, absolute and bare java
  "/usr/lib/jvm/java-17-openjdk-amd64/bin/java -jar /opt/zomboid/launcher.jar -server",
  "java -Xmx8g -jar /srv/zomboid-server.jar startserver",
  "/usr/bin/env java -jar /srv/zomboid/launcher.jar -server",
];

const NOT_A_SERVER_WINDOWS = [
  'cmd.exe /c "C:\\Servers\\Zomboid\\StartServer64_My Zomboid Server.bat"',
  'powershell.exe -Command Get-Content -Wait C:\\Users\\pz\\Zomboid\\Logs\\x_DebugLog-server.txt',
  '"C:\\Windows\\System32\\notepad.exe" C:\\Users\\pz\\Zomboid\\Server\\startserver.txt',
  // "java" as a folder name, not the executable
  '"C:\\java\\tools\\wrapper.exe" C:\\Zomboid\\run -server',
];

const REAL_SERVER_WINDOWS = [
  '"C:\\serverfiles\\jre64\\bin\\java.exe" -cp %PZ_CLASSPATH% zombie.network.GameServer -servername X',
  '"C:\\WinGSM\\servers\\1\\serverfiles\\ProjectZomboid64.exe" -cachedir="C:\\WinGSM\\servers\\1\\Zomboid" -servername X',
  '"C:\\Program Files\\Java\\jre\\bin\\javaw.exe" -jar C:\\Zomboid\\launcher.jar -server',
  'C:\\jre64\\bin\\java.exe -jar C:\\Zomboid\\launcher.jar startserver',
];

describe("isLinuxDedicatedServerCommandLine(): the zomboid + -server fallback needs a JVM", () => {
  it.each(NOT_A_SERVER_LINUX)("does not treat %s as a dedicated server", (cmd) => {
    expect(isLinuxDedicatedServerCommandLine(cmd)).toBe(false);
  });

  it.each(REAL_SERVER_LINUX)("still recognizes %s", (cmd) => {
    expect(isLinuxDedicatedServerCommandLine(cmd)).toBe(true);
  });
});

describe("isWindowsDedicatedServerCommandLine(): the zomboid + -server fallback needs a JVM", () => {
  it.each(NOT_A_SERVER_WINDOWS)("does not treat %s as a dedicated server", (cmd) => {
    expect(isWindowsDedicatedServerCommandLine(cmd)).toBe(false);
  });

  it.each(REAL_SERVER_WINDOWS)("still recognizes %s", (cmd) => {
    expect(isWindowsDedicatedServerCommandLine(cmd)).toBe(true);
  });
});

describe("Linux host scan: a log tail or wrapper script is not a server process", () => {
  function mockPgrep(lines) {
    execMock.mockImplementation((cmd, _opts, callback) => {
      if (String(cmd).startsWith("pgrep")) {
        callback(null, `${lines.join("\n")}\n`);
      } else {
        callback(new Error("unexpected exec call in this test: " + cmd));
      }
    });
  }

  it("reports an idle host (no candidates, not unknown) when only a tail and a wrapper script mention the server", async () => {
    const base = process.pid + 100;
    mockPgrep([
      `${base} tail -f /home/pz/Zomboid/Logs/2026-10-10_DebugLog-server.txt`,
      `${base + 1} bash /home/pz/start-server_My Zomboid Server.sh`,
    ]);

    const scan = await new ServerManager().scanHostForServerProcesses();

    expect(scan.matched).toEqual([]);
    expect(scan.running).toBe(false);
    expect(scan.scanFailed).toBeFalsy();
  });

  it("positive control: the real java process is the only candidate when the tail and wrapper are alive beside it", async () => {
    const base = process.pid + 200;
    mockPgrep([
      `${base} tail -f /home/pz/Zomboid/Logs/2026-10-10_DebugLog-server.txt`,
      `${base + 1} bash /home/pz/start-server_My Zomboid Server.sh`,
      `${base + 2} /home/pz/jre64/bin/java -cp /home/pz/* zombie.network.GameServer -servername My Zomboid Server`,
    ]);

    const scan = await new ServerManager().scanHostForServerProcesses();

    expect(scan.matched.map((entry) => entry.pid)).toEqual([String(base + 2)]);
    expect(scan.running).toBe(true);
  });
});
