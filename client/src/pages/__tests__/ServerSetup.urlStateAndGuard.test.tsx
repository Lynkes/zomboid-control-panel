import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation, useNavigate } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SocketContext } from "@/contexts/SocketContext";
import ServerSetup from "../ServerSetup";
import enServerSetup from "../../locales/en/serverSetup.json";
import enServers from "../../locales/en/servers.json";
import enShell from "../../locales/en/shell.json";

// UX restructure (slice B, Add a Server): the wizard's place lives in the
// URL (?mode=fresh|existing&step=n). The Servers page and the Dashboard link
// straight into a mode, a reload keeps the step, and every move is a history
// entry so the browser's Back walks back through the steps. Leaving part-way
// asks first, since the admin password is never stored.

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
      getAppSettings: vi.fn().mockResolvedValue({ settings: { serverPath: "/opt/pz-server", steamcmdPath: "/opt/steamcmd" } }),
    },
    debugApi: { ...actual.debugApi, getRam: vi.fn().mockRejectedValue(new Error("no RAM info in test env")) },
    serverApi: {
      ...actual.serverApi,
      getBranches: vi.fn().mockResolvedValue({ branches: [] }),
      getSetupPlan: vi.fn().mockResolvedValue({}),
    },
  };
});

vi.mock("@/components/ui/use-toast", () => ({
  useToast: () => ({ toast: vi.fn(), dismiss: vi.fn(), toasts: [] }),
}));

let currentSearch = "";
let goBack: () => void = () => {};
function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  currentSearch = location.search;
  goBack = () => navigate(-1);
  return null;
}

function renderAt(entry: string) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <SocketContext.Provider value={null}>
        <TooltipProvider>
          <ServerSetup />
          <LocationProbe />
        </TooltipProvider>
      </SocketContext.Provider>
    </MemoryRouter>,
  );
}

const next = () => fireEvent.click(screen.getByRole("button", { name: enServerSetup.common.nextStepButton }));

function beforeUnloadPrevented(): boolean {
  const event = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe("ServerSetup: the wizard's place is in the URL", () => {
  it("opens Use existing server files straight from a link, under the Servers breadcrumb", async () => {
    renderAt("/server-setup?mode=existing");
    expect(await screen.findByText(enServerSetup.quick.step1.title)).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: enShell.nav.items.serverSetup })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: enShell.nav.items.myServers })).toHaveAttribute("href", "/servers");
    // The header names the flow and says what this step is for.
    expect(screen.getByText(enServers.addServer.existing.label)).toBeInTheDocument();
    expect(screen.getByText(enServerSetup.quick.step1.description)).toBeInTheDocument();
  });

  it("keeps the step across a reload (step=2 opens step 2)", async () => {
    renderAt("/server-setup?mode=fresh&step=2");
    expect(await screen.findByText(enServerSetup.full.step2.title)).toBeInTheDocument();
  });

  it("reads an unknown mode or step as the choice screen / step 1", async () => {
    renderAt("/server-setup?mode=bogus&step=9");
    expect(await screen.findByRole("list", { name: enServers.addServer.listLabel })).toBeInTheDocument();
    cleanup();
    renderAt("/server-setup?mode=fresh&step=9");
    expect(await screen.findByText(enServerSetup.full.step1.title)).toBeInTheDocument();
  });

  it("picking a mode and each Next are history entries: browser Back walks back through them", async () => {
    renderAt("/server-setup");
    fireEvent.click(await screen.findByRole("button", { name: new RegExp(enServers.addServer.existing.label) }));
    await screen.findByText(enServerSetup.quick.step1.title);
    expect(currentSearch).toBe("?mode=existing&step=1");

    await screen.findByDisplayValue("/opt/pz-server");
    next();
    await screen.findByText(enServerSetup.quick.step2.title);
    expect(currentSearch).toBe("?mode=existing&step=2");

    goBack();
    expect(await screen.findByText(enServerSetup.quick.step1.title)).toBeInTheDocument();
    goBack();
    expect(await screen.findByRole("list", { name: enServers.addServer.listLabel })).toBeInTheDocument();
  });

  it("the footer's first Back returns to the choice of mode", async () => {
    renderAt("/server-setup?mode=fresh&step=1");
    await screen.findByText(enServerSetup.full.step1.title);
    fireEvent.click(screen.getByRole("button", { name: enServerSetup.common.chooseSetupType }));
    expect(await screen.findByRole("list", { name: enServers.addServer.listLabel })).toBeInTheDocument();
    expect(currentSearch).toBe("");
  });
});

describe("ServerSetup: leaving a wizard part-way asks first", () => {
  it("does not guard the choice screen or a wizard nothing was typed into", async () => {
    renderAt("/server-setup");
    await screen.findByRole("list", { name: enServers.addServer.listLabel });
    expect(beforeUnloadPrevented()).toBe(false);
    cleanup();
    renderAt("/server-setup?mode=existing&step=1");
    await screen.findByText(enServerSetup.quick.step1.title);
    expect(beforeUnloadPrevented()).toBe(false);
  });

  it("guards once the operator is past the first step or typed the admin password", async () => {
    renderAt("/server-setup?mode=existing&step=1");
    await screen.findByDisplayValue("/opt/pz-server");
    next();
    await screen.findByText(enServerSetup.quick.step2.title);
    await waitFor(() => expect(beforeUnloadPrevented()).toBe(true));
  });
});
