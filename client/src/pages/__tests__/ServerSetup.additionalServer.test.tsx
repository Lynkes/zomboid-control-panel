import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SocketContext } from "@/contexts/SocketContext";
import ServerSetup from "../ServerSetup";
import type { ServerSetupPlan } from "@/lib/api";
import { resetRuntimeInfoForTests } from "@/hooks/useRuntimeInfo";
import enServerSetup from "../../locales/en/serverSetup.json";

// A second server on a host that already has one: the wizard has to start
// on free ports and a free name, give the new server its own folders, and
// say when a port or the data folder collides with another server's.
// In the all-in-one container the folders go on the extra-servers volume
// (never /pz-server1, which the next update would erase); on a native host
// they go beside the active server's install folder.

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
Element.prototype.scrollIntoView = vi.fn();

// What the mocked API answers; each describe sets its own host.
const host = vi.hoisted(() => ({
  plan: null as unknown,
  settings: {} as Record<string, unknown>,
  runtime: {} as Record<string, unknown>,
}));

vi.mock("@/contexts/AuthContext", () => ({
  useAuth: () => ({
    user: { id: "u1", username: "someone", role: "admin", capabilities: [] },
    authEnabled: true,
    isAuthenticated: true,
    isLoading: false,
    needsSetup: false,
    logout: vi.fn(),
    getToken: () => "fake-token",
    can: () => true,
  }),
}));

vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}));

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    apiFetch: vi.fn().mockResolvedValue({ ok: false } as Response),
    configApi: {
      ...actual.configApi,
      // What the active (first) server leaves in the settings.
      getAppSettings: vi.fn(async () => ({ settings: host.settings })),
    },
    debugApi: { ...actual.debugApi, getRam: vi.fn().mockRejectedValue(new Error("no RAM info in test env")) },
    systemApi: {
      ...actual.systemApi,
      getRuntime: vi.fn(async () => host.runtime),
    },
    serverApi: {
      ...actual.serverApi,
      getBranches: vi.fn().mockResolvedValue({ branches: [] }),
      getSetupPlan: vi.fn(async () => host.plan),
    },
  };
});

const MAIN_PORTS = { gamePort: 16261, udpPort: 16262, rconPort: 27015 };
const SUGGESTED_PORTS = { gamePort: 16263, rconPort: 27016, withinPublishedRange: null };

const AIO_PLAN: ServerSetupPlan = {
  usedPorts: [
    { id: "main", name: "Main", serverName: "servertest", installPath: "/pz-server", dataPath: "/zomboid", ...MAIN_PORTS },
  ],
  suggestedPorts: { ...SUGGESTED_PORTS, withinPublishedRange: true },
  allInOne: { serversRoot: "/pz-servers", publishedGamePorts: { start: 16261, end: 16270 } },
  hostLayout: null,
  serversRootEntries: [],
  environmentDataPath: { installPath: "/pz-server", dataPath: "/zomboid" },
};
const AIO_SETTINGS = {
  steamcmdPath: "/home/steam/steamcmd",
  serverPath: "/pz-server",
  serverName: "servertest",
  zomboidDataPath: "/zomboid",
  serverPort: 16261,
};
const RUNTIME_DEFAULTS = { restartAssessment: {} };
const CONTAINER_RUNTIME = {
  ...RUNTIME_DEFAULTS,
  platform: "linux",
  family: "posix",
  pathSeparator: "/",
  temporaryDirectory: "/tmp",
  serviceManager: "container",
};

// The bundled systemd service's install folder.
const LINUX_INSTALL = "/opt/zomboid-panel/data/pzserver";
const LINUX_PLAN: ServerSetupPlan = {
  usedPorts: [
    {
      id: "main",
      name: "Main",
      serverName: "servertest",
      installPath: LINUX_INSTALL,
      dataPath: `${LINUX_INSTALL}_Data`,
      ...MAIN_PORTS,
    },
  ],
  suggestedPorts: SUGGESTED_PORTS,
  allInOne: null,
  hostLayout: { serversRoot: "/opt/zomboid-panel/data", separator: "/" },
  serversRootEntries: ["pzserver", "pzserver_Data", "steamcmd"],
  environmentDataPath: null,
};
const LINUX_SETTINGS = {
  steamcmdPath: "/opt/zomboid-panel/data/steamcmd",
  serverPath: LINUX_INSTALL,
  serverName: "servertest",
  zomboidDataPath: `${LINUX_INSTALL}_Data`,
  serverPort: 16261,
};
const SYSTEMD_RUNTIME = {
  ...RUNTIME_DEFAULTS,
  platform: "linux",
  family: "posix",
  pathSeparator: "/",
  temporaryDirectory: "/tmp",
  serviceManager: "systemd",
};

const WINDOWS_PLAN: ServerSetupPlan = {
  usedPorts: [
    {
      id: "main",
      name: "Main",
      serverName: "servertest",
      installPath: "D:\\Servers\\PZ",
      dataPath: "D:\\Servers\\PZ_Data",
      ...MAIN_PORTS,
    },
  ],
  suggestedPorts: SUGGESTED_PORTS,
  allInOne: null,
  hostLayout: { serversRoot: "D:\\Servers", separator: "\\" },
  serversRootEntries: ["PZ", "PZ_Data"],
  environmentDataPath: null,
};
const WINDOWS_SETTINGS = {
  steamcmdPath: "D:\\steamcmd\\steamcmd.exe",
  serverPath: "D:\\Servers\\PZ",
  serverName: "servertest",
  zomboidDataPath: "D:\\Servers\\PZ_Data",
  serverPort: 16261,
};
const WINDOWS_RUNTIME = {
  ...RUNTIME_DEFAULTS,
  platform: "win32",
  family: "windows",
  pathSeparator: "\\",
  temporaryDirectory: "C:\\tmp",
  serviceManager: "none",
};

function renderServerSetup() {
  return render(
    <MemoryRouter>
      <SocketContext.Provider value={null}>
        <TooltipProvider>
          <ServerSetup />
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  );
}

const next = () => fireEvent.click(screen.getByRole("button", { name: enServerSetup.common.nextStepButton }));

async function startFullInstall() {
  renderServerSetup();
  fireEvent.click(screen.getByText(enServerSetup.modeSelect.fullCard.title, { selector: "h3" }));
  await screen.findByText(enServerSetup.full.step1.title);
  await waitFor(() => expect(screen.getByRole("button", { name: enServerSetup.common.nextStepButton })).toBeEnabled());
  next();
  await screen.findByText(enServerSetup.full.step2.title);
}

async function startQuickSetup(installPath: string) {
  renderServerSetup();
  fireEvent.click(screen.getByText(enServerSetup.modeSelect.quickCard.title, { selector: "h3" }));
  await screen.findByText(enServerSetup.quick.step1.title);
  await screen.findByDisplayValue(installPath);
  next();
  await screen.findByText(enServerSetup.quick.step2.title);
}

function typeAdminPassword() {
  fireEvent.change(screen.getByPlaceholderText(enServerSetup.common.adminPasswordPlaceholder), {
    target: { value: "admin-pass" },
  });
}

// The data folder warning, whose path sits in its own <code>.
function dataFolderWarnings(name: string, path: string) {
  const expected = `${name} already keeps its data in ${path}.`;
  return screen.queryAllByText(
    (_, element) => element?.tagName === "SPAN" && (element.textContent ?? "").startsWith(expected),
  );
}

// The leftover data folder warning.
function leftoverWarnings(path: string) {
  const expected = `${path} already exists.`;
  return screen.queryAllByText(
    (_, element) => element?.tagName === "SPAN" && (element.textContent ?? "").startsWith(expected),
  );
}

// A paragraph of the Linux service note, whose path sits in its own <code>.
function linuxNoteLine(text: string) {
  return screen.queryAllByText((_, element) => element?.tagName === "P" && element.textContent === text);
}

function customDataSwitch() {
  const label = screen.getByText(enServerSetup.common.customConfigLocation, { selector: "label" });
  const toggle = label.parentElement?.querySelector('[role="switch"]');
  if (!toggle) throw new Error("no custom data folder switch");
  return toggle;
}

beforeEach(() => {
  localStorage.clear();
  resetRuntimeInfoForTests();
});

describe("ServerSetup -- another server in the all-in-one container", () => {
  beforeEach(() => {
    host.plan = AIO_PLAN;
    host.settings = AIO_SETTINGS;
    host.runtime = CONTAINER_RUNTIME;
  });

  it("full install: a folder on the extra-servers volume, a free name and free ports, and a warning on a taken port", async () => {
    await startFullInstall();
    await screen.findByDisplayValue("/pz-servers/servertest2");
    expect(screen.getByText(enServerSetup.multiServer.folderTitle)).toBeInTheDocument();
    // The systemd service path means nothing in a container.
    expect(screen.queryByText(enServerSetup.full.step2.linuxNoteTitle)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: enServerSetup.full.step2.useLinuxPath })).not.toBeInTheDocument();

    // The folder follows the name...
    fireEvent.change(screen.getByDisplayValue("servertest2"), { target: { value: "pvp" } });
    await screen.findByDisplayValue("/pz-servers/pvp");
    // ...until the operator types one.
    fireEvent.change(screen.getByDisplayValue("/pz-servers/pvp"), { target: { value: "/pz-servers/mine" } });
    fireEvent.change(screen.getByDisplayValue("pvp"), { target: { value: "pvp2" } });
    expect(screen.getByDisplayValue("/pz-servers/mine")).toBeInTheDocument();

    next();
    await screen.findByText(enServerSetup.full.step3.title);
    expect(screen.getByText(enServerSetup.multiServer.portsTitle)).toBeInTheDocument();
    expect(screen.getByDisplayValue("27016")).toBeInTheDocument();
    const gamePort = screen.getByDisplayValue("16263");

    fireEvent.change(gamePort, { target: { value: "16261" } });
    expect(
      await screen.findByText("Port 16261 is already a game port of Main: the two servers can't run at the same time."),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("16261"), { target: { value: "16271" } });
    expect(await screen.findByText(/Ports 16271–16272 are outside the range Docker publishes/)).toBeInTheDocument();
  });

  it("quick setup: reuses the game files and gets its own data folder on the volume", async () => {
    await startQuickSetup("/pz-server");
    expect(await screen.findByDisplayValue("/pz-servers/servertest2_Data")).toBeInTheDocument();
    expect(screen.getByText(enServerSetup.multiServer.folderTitle)).toBeInTheDocument();
    expect(dataFolderWarnings("Main", "/zomboid")).toHaveLength(0);

    // Without its own folder, PZ_SAVE_PATH would make it share /zomboid.
    fireEvent.click(customDataSwitch());
    await waitFor(() => expect(dataFolderWarnings("Main", "/zomboid")).toHaveLength(1));
  });
});

describe("ServerSetup -- another server on a native host", () => {
  it("Linux full install: a folder beside the active install, its data beside that, and a warning once it lands on the active server's", async () => {
    host.plan = LINUX_PLAN;
    host.settings = LINUX_SETTINGS;
    host.runtime = SYSTEMD_RUNTIME;

    await startFullInstall();
    await screen.findByDisplayValue("/opt/zomboid-panel/data/servertest2");
    expect(screen.getByText(enServerSetup.multiServer.hostFolderTitle)).toBeInTheDocument();
    expect(screen.getAllByText("/opt/zomboid-panel/data/servertest2_Data").length).toBeGreaterThan(0);
    // The active server's data folder, prefilled from the settings, is gone.
    expect(screen.queryByText(enServerSetup.full.step2.setBadge)).not.toBeInTheDocument();
    expect(dataFolderWarnings("Main", `${LINUX_INSTALL}_Data`)).toHaveLength(0);
    // The systemd service path is the active server's install folder: no
    // note pointing there under the folder proposed for this one, and no
    // button filling it in.
    expect(screen.queryByText(enServerSetup.full.step2.linuxNoteTitle)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: enServerSetup.full.step2.useLinuxPath })).not.toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue("servertest2"), { target: { value: "pvp" } });
    await screen.findByDisplayValue("/opt/zomboid-panel/data/pvp");

    // Linux folders that differ by case are two folders.
    fireEvent.change(screen.getByDisplayValue("/opt/zomboid-panel/data/pvp"), {
      target: { value: "/opt/zomboid-panel/data/PZSERVER" },
    });
    await screen.findByDisplayValue("/opt/zomboid-panel/data/PZSERVER");
    expect(dataFolderWarnings("Main", `${LINUX_INSTALL}_Data`)).toHaveLength(0);

    // Installing into the active server's folder would share its data folder.
    fireEvent.change(screen.getByDisplayValue("/opt/zomboid-panel/data/PZSERVER"), { target: { value: LINUX_INSTALL } });
    await waitFor(() => expect(dataFolderWarnings("Main", `${LINUX_INSTALL}_Data`)).toHaveLength(1));

    next();
    await screen.findByText(enServerSetup.full.step3.title);
    typeAdminPassword();
    next();
    await screen.findByText(enServerSetup.full.step4.title);
    expect(screen.getByText(enServerSetup.common.summaryDataFolder)).toBeInTheDocument();
    expect(screen.getByTitle(`${LINUX_INSTALL}_Data`)).toBeInTheDocument();
    expect(dataFolderWarnings("Main", `${LINUX_INSTALL}_Data`)).toHaveLength(1);
  });

  it("Windows quick setup: reuses the active install, gets its own data folder beside it, and warns when the active server's is picked", async () => {
    host.plan = WINDOWS_PLAN;
    host.settings = WINDOWS_SETTINGS;
    host.runtime = WINDOWS_RUNTIME;

    await startQuickSetup("D:\\Servers\\PZ");
    const dataInput = await screen.findByDisplayValue("D:\\Servers\\servertest2_Data");
    expect(screen.getByText(enServerSetup.multiServer.hostFolderTitle)).toBeInTheDocument();
    expect(dataFolderWarnings("Main", "D:\\Servers\\PZ_Data")).toHaveLength(0);

    // Windows folders don't differ by case.
    fireEvent.change(dataInput, { target: { value: "d:\\servers\\pz_data" } });
    await waitFor(() => expect(dataFolderWarnings("Main", "D:\\Servers\\PZ_Data")).toHaveLength(1));
    fireEvent.change(screen.getByDisplayValue("d:\\servers\\pz_data"), { target: { value: "D:\\Servers\\PZ_Data" } });
    await screen.findByDisplayValue("D:\\Servers\\PZ_Data");

    typeAdminPassword();
    next();
    await screen.findByText(enServerSetup.quick.step3.title);
    expect(screen.getByTitle("D:\\Servers\\PZ_Data")).toBeInTheDocument();
    expect(dataFolderWarnings("Main", "D:\\Servers\\PZ_Data")).toHaveLength(1);
  });

  it("with no folder to propose, still drops the active server's data folder and flags the default that lands on it", async () => {
    // A container whose install folder's parent isn't a volume: the server
    // offers no root, and PZ_SAVE_PATH belongs to /pz-server.
    host.plan = {
      ...AIO_PLAN,
      suggestedPorts: SUGGESTED_PORTS,
      allInOne: null,
      hostLayout: { serversRoot: null, separator: "/" },
    };
    host.settings = AIO_SETTINGS;
    host.runtime = CONTAINER_RUNTIME;

    await startQuickSetup("/pz-server");
    await waitFor(() => expect(dataFolderWarnings("Main", "/zomboid")).toHaveLength(1));
    expect(customDataSwitch()).toHaveAttribute("aria-checked", "false");
    expect(screen.queryByText(enServerSetup.multiServer.hostFolderTitle)).not.toBeInTheDocument();
  });

  // PZ_SAVE_PATH without PZ_SERVER_PATH (a native .env, the plain
  // docker-compose) is every install's data folder: a full install left on
  // the default would share it with the active server.
  it("full install with PZ_SAVE_PATH for every install: names its own data folder beside it instead of the shared one", async () => {
    host.plan = {
      ...LINUX_PLAN,
      usedPorts: [{ ...LINUX_PLAN.usedPorts[0], dataPath: "/srv/zomboid" }],
      environmentDataPath: { installPath: null, dataPath: "/srv/zomboid" },
    };
    host.settings = { ...LINUX_SETTINGS, zomboidDataPath: "/srv/zomboid" };
    host.runtime = SYSTEMD_RUNTIME;

    await startFullInstall();
    await screen.findByDisplayValue("/opt/zomboid-panel/data/servertest2");
    await waitFor(() => expect(screen.getAllByText("/opt/zomboid-panel/data/servertest2_Data").length).toBeGreaterThan(0));
    // Set as this server's custom data folder.
    expect(screen.getByText(enServerSetup.full.step2.setBadge)).toBeInTheDocument();
    expect(screen.queryAllByText("/srv/zomboid")).toHaveLength(0);
    expect(dataFolderWarnings("Main", "/srv/zomboid")).toHaveLength(0);

    // It still follows the name.
    fireEvent.change(screen.getByDisplayValue("servertest2"), { target: { value: "pvp" } });
    await waitFor(() => expect(screen.getAllByText("/opt/zomboid-panel/data/pvp_Data").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByText(enServerSetup.full.step2.customDataLocation));
    expect(await screen.findByDisplayValue("/opt/zomboid-panel/data/pvp_Data")).toBeInTheDocument();
  });

  // A leftover servertest2_Data from a deleted profile would hand the new
  // server the old one's settings and world, and another profile's install
  // folder would be shared.
  it("starts on a name whose folders are free, and flags a leftover data folder the operator's name lands on", async () => {
    host.plan = {
      ...LINUX_PLAN,
      usedPorts: [
        ...LINUX_PLAN.usedPorts,
        {
          id: "other",
          name: "Other",
          serverName: "other",
          installPath: "/opt/zomboid-panel/data/servertest3",
          dataPath: "/srv/other",
          gamePort: 16263,
          udpPort: 16264,
          rconPort: 27016,
        },
      ],
      serversRootEntries: [...LINUX_PLAN.serversRootEntries, "servertest2_Data"],
    };
    host.settings = LINUX_SETTINGS;
    host.runtime = SYSTEMD_RUNTIME;

    await startFullInstall();
    await screen.findByDisplayValue("/opt/zomboid-panel/data/servertest4");
    expect(screen.getByDisplayValue("servertest4")).toBeInTheDocument();
    expect(leftoverWarnings("/opt/zomboid-panel/data/servertest4_Data")).toHaveLength(0);

    fireEvent.change(screen.getByDisplayValue("servertest4"), { target: { value: "servertest2" } });
    await screen.findByDisplayValue("/opt/zomboid-panel/data/servertest2");
    await waitFor(() => expect(leftoverWarnings("/opt/zomboid-panel/data/servertest2_Data")).toHaveLength(1));

    // The active server's own data folder is shared, not left over.
    fireEvent.change(screen.getByDisplayValue("/opt/zomboid-panel/data/servertest2"), { target: { value: LINUX_INSTALL } });
    await waitFor(() => expect(dataFolderWarnings("Main", `${LINUX_INSTALL}_Data`)).toHaveLength(1));
    expect(leftoverWarnings(`${LINUX_INSTALL}_Data`)).toHaveLength(0);
  });
});

describe("ServerSetup -- the first server", () => {
  it("offers the Linux service path, and names the data folder the server will really use", async () => {
    host.plan = { ...LINUX_PLAN, usedPorts: [], hostLayout: { serversRoot: null, separator: "/" }, serversRootEntries: [] };
    host.settings = { ...LINUX_SETTINGS, zomboidDataPath: "/srv/pz-data" };
    host.runtime = SYSTEMD_RUNTIME;

    await startFullInstall();
    await screen.findByDisplayValue(LINUX_INSTALL);
    expect(screen.getByRole("button", { name: enServerSetup.full.step2.useLinuxPath })).toBeInTheDocument();
    // A custom data folder isn't beside the install folder.
    await waitFor(() =>
      expect(
        linuxNoteLine("The server data folder is /srv/pz-data. Both folders must be writable."),
      ).toHaveLength(1),
    );

    fireEvent.click(screen.getByText(enServerSetup.full.step2.customDataLocation));
    const toggle = screen
      .getByText(enServerSetup.common.useCustomLocation, { selector: "label" })
      .parentElement?.querySelector('[role="switch"]');
    if (!toggle) throw new Error("no custom data folder switch");
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(
        linuxNoteLine(
          `The server data folder is created beside the install folder: ${LINUX_INSTALL}_Data. Both folders must be writable.`,
        ),
      ).toHaveLength(1),
    );
  });

  // The demo build answers every GET it doesn't mock with {success, demo},
  // which has no usedPorts.
  it("survives an answer that isn't a setup plan", async () => {
    host.plan = { success: true, demo: true };
    host.settings = { steamcmdPath: LINUX_SETTINGS.steamcmdPath };
    host.runtime = SYSTEMD_RUNTIME;

    await startFullInstall();
    expect(screen.getByText(enServerSetup.full.step2.installFolderLabel)).toBeInTheDocument();
    expect(screen.queryByText(enServerSetup.multiServer.hostFolderTitle)).not.toBeInTheDocument();
    expect(screen.getByDisplayValue("myserver")).toBeInTheDocument();
  });
});
