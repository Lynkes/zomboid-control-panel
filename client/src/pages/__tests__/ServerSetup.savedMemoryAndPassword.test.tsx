import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SocketContext } from "@/contexts/SocketContext";
import ServerSetup, { generatePassword, savedMemoryToSliderGb } from "../ServerSetup";
import { resetRuntimeInfoForTests } from "@/hooks/useRuntimeInfo";
import enServerSetup from "../../locales/en/serverSetup.json";
import enServers from "../../locales/en/servers.json";

// Two things the wizard got wrong:
//  - the memory the panel saved is in GB, but the wizard divided it by 1024, so
//    every real value became 0 and the sliders always fell back to 4/8;
//  - the proposed RCON password came from Math.random().

class StubResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: typeof StubResizeObserver }).ResizeObserver = StubResizeObserver;
Element.prototype.scrollIntoView = vi.fn();

const host = vi.hoisted(() => ({ settings: {} as Record<string, unknown> }));

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
      getAppSettings: vi.fn(async () => ({ settings: host.settings })),
    },
    debugApi: { ...actual.debugApi, getRam: vi.fn().mockRejectedValue(new Error("no RAM info in test env")) },
    systemApi: { ...actual.systemApi, getRuntime: vi.fn(async () => ({ restartAssessment: {} })) },
    serverApi: {
      ...actual.serverApi,
      getBranches: vi.fn().mockResolvedValue({ branches: [] }),
      getSetupPlan: vi.fn(async () => ({})),
    },
  };
});

describe("generatePassword", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("is 12 letters and digits by default, with none of the characters the ini handling rejects", () => {
    for (let i = 0; i < 200; i++) {
      const password = generatePassword();
      expect(password).toMatch(/^[A-Za-z0-9]{12}$/);
      expect(password).not.toMatch(/[=;"'\s]/);
    }
    expect(generatePassword(20)).toHaveLength(20);
  });

  it("draws from crypto.getRandomValues and never from Math.random", () => {
    const random = vi.spyOn(Math, "random");
    const getRandomValues = vi.spyOn(crypto, "getRandomValues");

    generatePassword();

    expect(getRandomValues).toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
  });

  it("uses every character of the alphabet and does not repeat", () => {
    const seen = new Set<string>();
    const passwords = new Set<string>();
    for (let i = 0; i < 3000; i++) {
      const password = generatePassword();
      passwords.add(password);
      for (const ch of password) seen.add(ch);
    }
    expect(seen.size).toBe(62);
    expect(passwords.size).toBe(3000);
  });

  it("redraws a value that would favour the first characters (no modulo bias)", () => {
    // 62 does not divide 2^32, so draws at or above the last whole multiple of
    // 62 are thrown away. 0xFFFFFFFF is above it; the next draw, 5, decides.
    const calls: number[] = [0xffffffff, 5];
    vi.spyOn(crypto, "getRandomValues").mockImplementation(((array: Uint32Array) => {
      array[0] = calls.shift() ?? 0;
      return array;
    }) as typeof crypto.getRandomValues);

    expect(generatePassword(1)).toBe("f");
    expect(calls).toHaveLength(0);
  });
});

describe("savedMemoryToSliderGb", () => {
  it("reads the saved value as GB", () => {
    expect(savedMemoryToSliderGb(6, 4, 2, 64)).toBe(6);
    expect(savedMemoryToSliderGb(12, 8, 2, 128)).toBe(12);
    expect(savedMemoryToSliderGb("16", 8, 2, 128)).toBe(16);
  });

  it("still understands a legacy value saved in MB", () => {
    expect(savedMemoryToSliderGb(4096, 4, 2, 64)).toBe(4);
    expect(savedMemoryToSliderGb(8192, 8, 2, 128)).toBe(8);
  });

  it("falls back for anything unusable and keeps the slider's own bounds", () => {
    expect(savedMemoryToSliderGb(undefined, 4, 2, 64)).toBe(4);
    expect(savedMemoryToSliderGb("lots", 4, 2, 64)).toBe(4);
    expect(savedMemoryToSliderGb(0, 4, 2, 64)).toBe(4);
    expect(savedMemoryToSliderGb(1, 4, 2, 64)).toBe(2);
    expect(savedMemoryToSliderGb(100, 4, 2, 64)).toBe(64);
  });
});

describe("ServerSetup -- memory step", () => {
  beforeEach(() => {
    localStorage.clear();
    resetRuntimeInfoForTests();
  });

  async function openMemoryStep() {
    render(
      <MemoryRouter>
        <SocketContext.Provider value={null}>
          <TooltipProvider>
            <ServerSetup />
          </TooltipProvider>
        </SocketContext.Provider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: new RegExp(enServers.addServer.fresh.label) }));
    await screen.findByText(enServerSetup.full.step1.title);
    const next = () => fireEvent.click(screen.getByRole("button", { name: enServerSetup.common.nextStepButton }));
    await waitFor(() => expect(screen.getByRole("button", { name: enServerSetup.common.nextStepButton })).toBeEnabled());
    next();
    await screen.findByText(enServerSetup.full.step2.title);
    next();
    await screen.findByText(enServerSetup.full.step3.title);
  }

  it("shows the memory the panel saved instead of resetting to 4 and 8", async () => {
    host.settings = {
      steamcmdPath: "D:\\steamcmd\\steamcmd.exe",
      serverPath: "D:\\Servers\\PZ",
      serverName: "servertest",
      minMemory: 6,
      maxMemory: 12,
    };

    await openMemoryStep();

    await waitFor(() => expect(screen.getByLabelText(enServerSetup.common.minRamAria)).toHaveValue(6));
    expect(screen.getByLabelText(enServerSetup.common.maxRamAria)).toHaveValue(12);
  });

  it("proposes a 12-character letters-and-digits RCON password", async () => {
    host.settings = {
      steamcmdPath: "D:\\steamcmd\\steamcmd.exe",
      serverPath: "D:\\Servers\\PZ",
      serverName: "servertest",
    };

    await openMemoryStep();

    const passwordInputs = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
    expect(passwordInputs[0].value).toMatch(/^[A-Za-z0-9]{12}$/);
  });
});
