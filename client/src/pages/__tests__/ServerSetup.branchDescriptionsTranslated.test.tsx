import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SocketContext } from "@/contexts/SocketContext";
import type { Socket } from "socket.io-client";
import i18n from "@/i18n";
import ServerSetup from "../ServerSetup";
import { configApi, debugApi, serverApi } from "@/lib/api";
import frServerSetup from "../../locales/fr/serverSetup.json";
import frServers from "../../locales/fr/servers.json";

// The version picker in the full-install wizard printed the branch
// description exactly as the API (or the wizard's own built-in list) gave it:
// English in every language. The Servers page already resolves it through
// servers:steamDialog.branchDescriptions.<branch>, falling back to the given
// text for a branch we have no wording for; the wizard now does the same.

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

vi.mock("@/lib/api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api")>("@/lib/api");
  return {
    ...actual,
    apiFetch: vi.fn().mockResolvedValue({ ok: false } as Response),
    configApi: {
      ...actual.configApi,
      getAppSettings: vi.fn().mockResolvedValue({ settings: { steamcmdPath: "/opt/steamcmd" } }),
    },
    debugApi: { ...actual.debugApi, getRam: vi.fn().mockRejectedValue(new Error("no RAM info in test env")) },
    serverApi: { ...actual.serverApi, getBranches: vi.fn() },
  };
});

const getAppSettings = vi.mocked(configApi.getAppSettings);
const getRam = vi.mocked(debugApi.getRam);
const getBranches = vi.mocked(serverApi.getBranches);

function createFakeSocket() {
  return { on: vi.fn(), off: vi.fn(), emit: vi.fn() } as unknown as Socket;
}

beforeEach(() => {
  getAppSettings.mockResolvedValue({ settings: { steamcmdPath: "/opt/steamcmd" } } as never);
  getRam.mockRejectedValue(new Error("no RAM info in test env"));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  void i18n.changeLanguage("en");
});

// From the mode-select screen to Step 2 with the version picker open.
async function openVersionPicker() {
  render(
    <MemoryRouter>
      <SocketContext.Provider value={createFakeSocket()}>
        <TooltipProvider>
          <ServerSetup />
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole("button", { name: new RegExp(frServers.addServer.fresh.label) }));
  await screen.findByText(frServerSetup.full.step1.title);
  fireEvent.click(screen.getByRole("button", { name: frServerSetup.common.nextStepButton }));
  await screen.findByText(frServerSetup.full.step2.title);

  const trigger = screen.getAllByRole("combobox")[0];
  await vi.waitFor(() => expect(trigger).toBeEnabled());
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const listbox = await screen.findByRole("listbox");
  return within(listbox).getAllByRole("option").map((option) => option.textContent ?? "");
}

describe("ServerSetup.tsx: the version picker shows branch descriptions in the active language", () => {
  it("translates the built-in list shown when the branches cannot be fetched", async () => {
    void i18n.changeLanguage("fr");
    getBranches.mockRejectedValue(new Error("steamcmd unavailable"));

    const options = await openVersionPicker();

    const text = options.join(" | ");
    expect(text).toContain(frServers.steamDialog.branchDescriptions.unstable);
    expect(text).toContain(frServers.steamDialog.branchDescriptions.iwbums);
    expect(text).toContain(frServers.steamDialog.branchDescriptions.legacy41);
    expect(text).not.toContain("Build 41 Multiplayer");
    expect(text).not.toContain("Legacy Build 41 branch");
  });

  it("translates a fetched branch we have wording for and keeps Steam's own text for one we do not", async () => {
    void i18n.changeLanguage("fr");
    getBranches.mockResolvedValue({
      branches: [
        { name: "public", description: "public" },
        { name: "unstable", description: "Steam says: unstable" },
        { name: "brand-new-beta", description: "Steam says: brand new beta" },
      ],
    } as never);

    const options = await openVersionPicker();

    const text = options.join(" | ");
    expect(text).toContain(frServerSetup.full.step2.buildStable);
    expect(text).toContain(frServers.steamDialog.branchDescriptions.unstable);
    expect(text).not.toContain("Steam says: unstable");
    expect(text).toContain("Steam says: brand new beta");
  });
});
