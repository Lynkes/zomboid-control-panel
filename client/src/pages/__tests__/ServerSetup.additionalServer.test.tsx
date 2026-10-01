import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SocketContext } from "@/contexts/SocketContext";
import ServerSetup from "../ServerSetup";
import type { ServerSetupPlan } from "@/lib/api";
import { resetRuntimeInfoForTests } from "@/hooks/useRuntimeInfo";
import enServerSetup from "../../locales/en/serverSetup.json";

// A second server in the all-in-one container: the wizard has to start on
// free ports and a free name, put a full install on the extra-servers
// volume (never /pz-server1, which the next update would erase), give a
// Quick Setup its own data folder, and say when a port collides.

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
Element.prototype.scrollIntoView = vi.fn();

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

const PLAN: ServerSetupPlan = {
  usedPorts: [
    {
      id: "main",
      name: "Main",
      serverName: "servertest",
      installPath: "/pz-server",
      gamePort: 16261,
      udpPort: 16262,
      rconPort: 27015,
    },
  ],
  suggestedPorts: { gamePort: 16263, rconPort: 27016, withinPublishedRange: true },
  allInOne: { serversRoot: "/pz-servers", publishedGamePorts: { start: 16261, end: 16270 } },
};

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    apiFetch: vi.fn().mockResolvedValue({ ok: false } as Response),
    configApi: {
      ...actual.configApi,
      // What the active (first) server leaves in the settings.
      getAppSettings: vi.fn().mockResolvedValue({
        settings: {
          steamcmdPath: "/home/steam/steamcmd",
          serverPath: "/pz-server",
          serverName: "servertest",
          zomboidDataPath: "/zomboid",
          serverPort: 16261,
        },
      }),
    },
    debugApi: { ...actual.debugApi, getRam: vi.fn().mockRejectedValue(new Error("no RAM info in test env")) },
    systemApi: {
      ...actual.systemApi,
      getRuntime: vi.fn().mockResolvedValue({
        platform: "linux",
        family: "posix",
        pathSeparator: "/",
        temporaryDirectory: "/tmp",
        serviceManager: "container",
        restartAssessment: {},
      }),
    },
    serverApi: {
      ...actual.serverApi,
      getBranches: vi.fn().mockResolvedValue({ branches: [] }),
      getSetupPlan: vi.fn(async () => PLAN),
    },
  };
});

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

beforeEach(() => {
  localStorage.clear();
  resetRuntimeInfoForTests();
});

describe("ServerSetup -- another server in the all-in-one container", () => {
  it("full install: a folder on the extra-servers volume, a free name and free ports, and a warning on a taken port", async () => {
    renderServerSetup();
    fireEvent.click(screen.getByText(enServerSetup.modeSelect.fullCard.title, { selector: "h3" }));
    await screen.findByText(enServerSetup.full.step1.title);
    const next = () => fireEvent.click(screen.getByRole("button", { name: enServerSetup.common.nextStepButton }));
    await waitFor(() => expect(screen.getByRole("button", { name: enServerSetup.common.nextStepButton })).toBeEnabled());
    next();

    await screen.findByText(enServerSetup.full.step2.title);
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
    renderServerSetup();
    fireEvent.click(screen.getByText(enServerSetup.modeSelect.quickCard.title, { selector: "h3" }));
    await screen.findByText(enServerSetup.quick.step1.title);
    await screen.findByDisplayValue("/pz-server");
    fireEvent.click(screen.getByRole("button", { name: enServerSetup.common.nextStepButton }));

    await screen.findByText(enServerSetup.quick.step2.title);
    expect(await screen.findByDisplayValue("/pz-servers/servertest2_Data")).toBeInTheDocument();
    expect(screen.getByText(enServerSetup.multiServer.folderTitle)).toBeInTheDocument();
  });
});
