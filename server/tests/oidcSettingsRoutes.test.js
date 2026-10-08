import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { mockGetRoleByName } from "./helpers/mockPermissionsDb.js";
import { startMockOidcProvider } from "./helpers/mockOidcProvider.js";
import { acquireOidcTestLock } from "./helpers/oidcTestLock.js";

let releaseOidcTestLock;
beforeAll(async () => {
  releaseOidcTestLock = await acquireOidcTestLock();
});
afterAll(() => {
  releaseOidcTestLock?.();
});

// GET/PUT /api/auth/oidc/settings and POST /api/auth/oidc/test-connection --
// the OIDC-configurable-from-the-panel work. Two things this file exists
// specifically to prove, per the operator's own ruling:
//   1. clientSecret is NEVER echoed back by GET, not even masked -- only
//      whether it's configured.
//   2. THE TRAP: a PUT that saves new settings must make getOidcConfig()
//      re-run discovery against the NEW issuer, not keep serving a
//      memoized Configuration built from the OLD one. Without
//      resetOidcConfigCache() in the save path, this is exactly the "save
//      reports success, panel keeps using the old config until restart"
//      bug the whole feature exists to avoid.

const settingsStore = new Map();

// A custom role holding panel.settings and nothing else -- the delegate the
// provider fields are now closed to (SECURITY 2026-10-08, #2).
vi.mock("../database/init.js", () => ({
  getRoleByName: async (name) =>
    name === "settings-only"
      ? { id: "role-settings-only", name: "settings-only", capabilities: ["panel.settings"], isSeeded: false }
      : mockGetRoleByName(name),
  getSetting: async (key) => settingsStore.get(key) ?? null,
  setSetting: async (key, value) => {
    settingsStore.set(key, value);
  },
}));

// Seeded with a real directory before the dynamic import below: importing
// services/oidc.js pulls in utils/logger.js, which calls getDataPaths()
// and mkdirSyncs a logs dir at MODULE IMPORT TIME -- tmpDir must already
// be a real path at that first import, not just non-undefined later.
let tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcp-oidc-settings-seed-"));
vi.mock("../utils/paths.js", () => ({
  getDataPaths: () => ({ dataDir: tmpDir, logsDir: tmpDir }),
}));

const { default: oidcRouter } = await import("../routes/oidc.js");
const { resetOidcConfigCache, getOidcConfig } = await import("../services/oidc.js");

const ENV_KEYS = [
  "PANEL_OIDC_ISSUER_URL",
  "PANEL_OIDC_CLIENT_ID",
  "PANEL_OIDC_CLIENT_SECRET",
  "PANEL_OIDC_REDIRECT_URI",
  "PANEL_OIDC_SCOPE",
  "PANEL_OIDC_PROVIDER_NAME",
  "PANEL_OIDC_ALLOW_INSECURE_HTTP",
];
function clearOidcEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
}
// The secret lives in its own file, not settingsStore; a secret left over
// from an earlier test now changes what PUT and test-connection allow.
function clearSavedSettings() {
  settingsStore.clear();
  fs.rmSync(path.join(tmpDir, "oidcClientSecret.secret"), { force: true });
}

function getLayer(routePath, method) {
  return oidcRouter.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
}

async function runRoute(routePath, method, req) {
  const res = { status: vi.fn(), json: vi.fn() };
  res.status.mockReturnValue(res);
  const layer = getLayer(routePath, method);
  const handlers = layer.route.stack.map((s) => s.handle);
  let idx = -1;
  const next = async (err) => {
    idx++;
    if (err) throw err;
    if (idx < handlers.length) await handlers[idx](req, res, next);
  };
  await next();
  return res;
}

function makeReq({ body = {}, user = { role: "admin" }, protocol = "https", host = "panel.example.com" } = {}) {
  return {
    body,
    user,
    protocol,
    get: (name) => (name.toLowerCase() === "host" ? host : undefined),
  };
}

describe("gate: requirePermission('panel.settings'), both directions", () => {
  beforeEach(() => {
    clearSavedSettings();
    clearOidcEnv();
    resetOidcConfigCache();
  });

  it("GET /settings refuses a role without panel.settings", async () => {
    const res = await runRoute("/settings", "get", makeReq({ user: { role: "moderator" } }));
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("GET /settings admits a role with panel.settings", async () => {
    const res = await runRoute("/settings", "get", makeReq({ user: { role: "admin" } }));
    expect(res.status).not.toHaveBeenCalledWith(403);
  });

  it("PUT /settings refuses a role without panel.settings", async () => {
    const res = await runRoute(
      "/settings",
      "put",
      makeReq({ user: { role: "moderator" }, body: { providerName: "x" } }),
    );
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("POST /test-connection refuses a role without panel.settings", async () => {
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({ user: { role: "moderator" } }),
    );
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe("GET /settings: clientSecret is never echoed back, not even masked", () => {
  beforeEach(() => {
    clearSavedSettings();
    clearOidcEnv();
    resetOidcConfigCache();
  });

  it("returns clientSecretConfigured:false and no clientSecret field when nothing is set", async () => {
    const res = await runRoute("/settings", "get", makeReq());
    const payload = res.json.mock.calls[0][0];
    expect(payload.clientSecretConfigured).toBe(false);
    expect(payload.clientSecret).toBeUndefined();
  });

  it("after a real secret is saved: reports clientSecretConfigured:true, STILL never the value", async () => {
    await runRoute(
      "/settings",
      "put",
      makeReq({ body: { clientSecret: "s3cr3t-value-do-not-leak" } }),
    );

    const res = await runRoute("/settings", "get", makeReq());
    const payload = res.json.mock.calls[0][0];
    expect(payload.clientSecretConfigured).toBe(true);
    expect(payload.clientSecret).toBeUndefined();
    expect(JSON.stringify(payload)).not.toContain("s3cr3t-value-do-not-leak");
  });

  it("suggestedRedirectUri is derived from the actual request origin, not guessed from stored config", async () => {
    const res = await runRoute(
      "/settings",
      "get",
      makeReq({ protocol: "https", host: "my-panel.example.org:8443" }),
    );
    const payload = res.json.mock.calls[0][0];
    expect(payload.suggestedRedirectUri).toBe(
      "https://my-panel.example.org:8443/api/auth/oidc/callback",
    );
  });

  it("surfaces which fields are env-overridden", async () => {
    process.env.PANEL_OIDC_ISSUER_URL = "https://env-idp.example.com";
    const res = await runRoute("/settings", "get", makeReq());
    const payload = res.json.mock.calls[0][0];
    expect(payload.envOverrides.issuerUrl).toBe(true);
    expect(payload.envOverrides.clientId).toBe(false);
  });
});

describe("PUT /settings: validation", () => {
  beforeEach(() => {
    clearSavedSettings();
    clearOidcEnv();
    resetOidcConfigCache();
  });

  it("rejects a plain-http issuerUrl when allowInsecureHttp is not set", async () => {
    const res = await runRoute(
      "/settings",
      "put",
      makeReq({ body: { issuerUrl: "http://idp.internal" } }),
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(settingsStore.get("oidcIssuerUrl")).toBeUndefined();
  });

  it("accepts a plain-http issuerUrl when allowInsecureHttp is set in the SAME request", async () => {
    const res = await runRoute(
      "/settings",
      "put",
      makeReq({ body: { issuerUrl: "http://idp.internal", allowInsecureHttp: true } }),
    );
    expect(res.status).not.toHaveBeenCalledWith(400);
  });

  it("rejects a malformed redirectUri", async () => {
    const res = await runRoute(
      "/settings",
      "put",
      makeReq({ body: { redirectUri: "not a url at all" } }),
    );
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it("rejects a non-HTTP redirectUri scheme", async () => {
    const res = await runRoute(
      "/settings",
      "put",
      makeReq({ body: { redirectUri: "javascript:alert(1)" } }),
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(settingsStore.get("oidcRedirectUri")).toBeUndefined();
  });

  it("rejects a redirectUri that cannot reach the panel's OIDC callback route", async () => {
    const res = await runRoute(
      "/settings",
      "put",
      makeReq({ body: { redirectUri: "https://panel.example.com/api/auth/oidc/callbak" } }),
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringContaining("/api/auth/oidc/callback") }),
    );
    expect(settingsStore.get("oidcRedirectUri")).toBeUndefined();
  });

  it("accepts the callback route behind a reverse-proxy path prefix", async () => {
    const res = await runRoute(
      "/settings",
      "put",
      makeReq({ body: { redirectUri: "https://panel.example.com/zomboid/api/auth/oidc/callback" } }),
    );
    expect(res.status).not.toHaveBeenCalledWith(400);
    expect(settingsStore.get("oidcRedirectUri")).toBe(
      "https://panel.example.com/zomboid/api/auth/oidc/callback",
    );
  });

  it("rejects redirectUri query parameters because the callback exchange strips them", async () => {
    const res = await runRoute(
      "/settings",
      "put",
      makeReq({ body: { redirectUri: "https://panel.example.com/callback?tenant=one" } }),
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(settingsStore.get("oidcRedirectUri")).toBeUndefined();
  });

  it("rejects a string allowInsecureHttp value instead of treating \"false\" as true", async () => {
    const res = await runRoute(
      "/settings",
      "put",
      makeReq({ body: { allowInsecureHttp: "false" } }),
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(settingsStore.get("oidcAllowInsecureHttp")).toBeUndefined();
  });

  it("rejects a non-empty scope that omits openid", async () => {
    const res = await runRoute(
      "/settings",
      "put",
      makeReq({ body: { scope: "email profile" } }),
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(settingsStore.get("oidcScope")).toBeUndefined();
  });

  it("rejects an invalid redirectUri before Test Connection reaches the provider", async () => {
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({
        body: {
          issuerUrl: "https://idp.example.com",
          clientId: "client",
          clientSecret: "secret",
          redirectUri: "javascript:alert(1)",
        },
      }),
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.stringMatching(/redirectUri/) }),
    );
  });

  it("rejects an edited scope without openid before Test Connection reaches the provider", async () => {
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({
        body: {
          issuerUrl: "https://idp.example.com",
          clientId: "client",
          clientSecret: "secret",
          scope: "email profile",
        },
      }),
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "scope must include openid" });
  });

  it("a resubmitted masked clientSecret placeholder leaves the real stored secret untouched", async () => {
    await runRoute("/settings", "put", makeReq({ body: { clientSecret: "real-secret-1" } }));

    // Simulate the UI echoing back whatever GET showed it (never the real
    // value, but SOME masked-looking placeholder) alongside an unrelated field.
    await runRoute(
      "/settings",
      "put",
      makeReq({ body: { clientSecret: "••••••••1234", providerName: "Renamed" } }),
    );

    const settings = (await runRoute("/settings", "get", makeReq())).json.mock.calls[0][0];
    expect(settings.providerName).toBe("Renamed");
    expect(settings.clientSecretConfigured).toBe(true);
    // The only way to prove the ORIGINAL secret survived without reading it
    // back (which the route correctly never allows) is to check the file
    // on disk directly, once, in this one test.
    const stored = fs.readFileSync(path.join(tmpDir, "oidcClientSecret.secret"), "utf8");
    expect(stored).toBe("real-secret-1");
  });
});

describe("PUT /settings: a successful save actually takes effect without a restart (THE TRAP)", () => {
  let providerA;
  let providerB;

  beforeEach(async () => {
    clearSavedSettings();
    clearOidcEnv();
    resetOidcConfigCache();
    providerA = await startMockOidcProvider({ clientId: "client-a" });
    providerB = await startMockOidcProvider({ clientId: "client-b" });
  });

  afterEach(async () => {
    await providerA.close();
    await providerB.close();
  });

  it("getOidcConfig() reflects a saved change immediately, not after a restart", async () => {
    await runRoute(
      "/settings",
      "put",
      makeReq({
        body: {
          issuerUrl: providerA.baseUrl,
          clientId: "client-a",
          clientSecret: "secret-a",
          redirectUri: `${providerA.baseUrl}/api/auth/oidc/callback`,
          allowInsecureHttp: true,
        },
      }),
    );

    const configA = await getOidcConfig();
    expect(configA.serverMetadata().issuer).toBe(providerA.baseUrl);

    // Now save a DIFFERENT provider entirely -- the exact scenario an
    // operator correcting a wrong issuer URL, or rotating providers, hits.
    await runRoute(
      "/settings",
      "put",
      makeReq({
        body: {
          issuerUrl: providerB.baseUrl,
          clientId: "client-b",
          clientSecret: "secret-b",
          redirectUri: `${providerB.baseUrl}/api/auth/oidc/callback`,
          allowInsecureHttp: true,
        },
      }),
    );

    const configB = await getOidcConfig();
    expect(configB.serverMetadata().issuer).toBe(providerB.baseUrl);
    // If the trap were still present, this would still equal providerA's
    // issuer -- a stale memoized Configuration from before the save.
    expect(configB.serverMetadata().issuer).not.toBe(providerA.baseUrl);
  });
});

describe("POST /test-connection", () => {
  let provider;

  beforeEach(async () => {
    clearSavedSettings();
    clearOidcEnv();
    resetOidcConfigCache();
    provider = await startMockOidcProvider({ clientId: "test-client" });
  });

  afterEach(async () => {
    await provider.close();
  });

  it("succeeds against a real, reachable issuer, and does not persist anything", async () => {
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({
        body: {
          issuerUrl: provider.baseUrl,
          clientId: "test-client",
          clientSecret: "whatever-secret",
          allowInsecureHttp: true,
        },
      }),
    );
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    // bug hunt 2026-08-31-c (under-coverage sweep): the title claims nothing
    // is persisted at all, but this used to check only one specific key
    // (oidcIssuerUrl) out of the five persistable OIDC settings fields --
    // undercutting the actual promise the title makes. settingsStore is the
    // mocked setSetting() sink for every key this route could theoretically
    // write; asserting it stayed empty proves setSetting() was never called
    // at all, not just that one field happened to be untouched.
    expect(settingsStore.size).toBe(0);
  });

  it("fails against an unreachable issuer, with a reason rather than a thrown 500", async () => {
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({
        body: {
          issuerUrl: "http://127.0.0.1:1",
          clientId: "test-client",
          clientSecret: "whatever-secret",
          allowInsecureHttp: true,
        },
      }),
    );
    expect(res.status).not.toHaveBeenCalledWith(500);
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(false);
    expect(payload.error).toBeTruthy();
  });

  it("uses the already-saved clientSecret when the request omits it -- testing a partial edit doesn't require retyping the secret", async () => {
    // The saved secret is only ever sent to the saved issuer as the saved
    // client (SECURITY 2026-10-08, #12), so save those alongside it.
    await runRoute(
      "/settings",
      "put",
      makeReq({
        body: {
          issuerUrl: provider.baseUrl,
          clientId: "test-client",
          clientSecret: "already-saved-secret",
          allowInsecureHttp: true,
        },
      }),
    );

    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({
        body: {
          scope: "openid email",
          // clientSecret deliberately omitted
        },
      }),
    );
    // The mock provider's discovery endpoint doesn't validate the secret at
    // all (see mockOidcProvider.js), so success here just proves the call
    // was made at all with SOME secret filled in rather than failing our
    // own "issuerUrl/clientId/clientSecret all required" pre-check.
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
  });
});

// The headline bug this whole feature exists to fix: discovery alone is an
// unauthenticated GET that never sends clientId/clientSecret anywhere, so a
// wrong secret, wrong client ID, or unregistered redirect URI all silently
// passed the old test. These prove the credential round trip actually
// distinguishes "the provider rejected the client" from "the provider
// accepted the client and only rejected our fabricated code" (the success
// signal) from a third, genuinely ambiguous outcome.
describe("POST /test-connection -- credential check (strictAuth mock)", () => {
  let provider;

  beforeEach(async () => {
    clearSavedSettings();
    clearOidcEnv();
    resetOidcConfigCache();
    provider = await startMockOidcProvider({
      clientId: "real-client",
      strictAuth: { clientSecret: "real-secret" },
    });
  });

  afterEach(async () => {
    await provider.close();
  });

  it("succeeds AND returns the discovered endpoints/scopes when the client authenticates but the fabricated code is rejected (invalid_grant)", async () => {
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({
        body: {
          issuerUrl: provider.baseUrl,
          clientId: "real-client",
          clientSecret: "real-secret",
          allowInsecureHttp: true,
        },
      }),
    );
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.metadata).toEqual({
      issuer: provider.baseUrl,
      authorizationEndpoint: `${provider.baseUrl}/authorize`,
      tokenEndpoint: `${provider.baseUrl}/token`,
      userinfoEndpoint: null,
      jwksUri: `${provider.baseUrl}/jwks`,
      scopesSupported: [],
    });
  });

  it("reports credentials_rejected, not a generic failure, when the client secret is wrong (invalid_client)", async () => {
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({
        body: {
          issuerUrl: provider.baseUrl,
          clientId: "real-client",
          clientSecret: "totally-wrong-secret",
          allowInsecureHttp: true,
        },
      }),
    );
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(false);
    expect(payload.code).toBe("OIDC_CREDENTIALS_REJECTED");
  });

  it("reports credentials_rejected when the client ID is wrong (invalid_client)", async () => {
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({
        body: {
          issuerUrl: provider.baseUrl,
          clientId: "wrong-client-id",
          clientSecret: "real-secret",
          allowInsecureHttp: true,
        },
      }),
    );
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(false);
    expect(payload.code).toBe("OIDC_CREDENTIALS_REJECTED");
  });

  it("reports undetermined, not success, for an OAuth error code that is neither invalid_grant nor invalid_client", async () => {
    provider.setNextGrantError({
      status: 400,
      error: "invalid_request",
      error_description: "redirect_uri is required for this client.",
    });
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({
        body: {
          issuerUrl: provider.baseUrl,
          clientId: "real-client",
          clientSecret: "real-secret",
          allowInsecureHttp: true,
        },
      }),
    );
    const payload = res.json.mock.calls[0][0];
    // The important assertion: this must NOT be reported as success just
    // because discovery worked and the client wasn't explicitly rejected.
    expect(payload.success).toBe(false);
    expect(payload.code).toBe("OIDC_TEST_UNDETERMINED");
  });

  it("keying on the OAuth error code, not the HTTP status, still recognises invalid_client when a provider answers 400 instead of 401", async () => {
    provider.setNextGrantError({
      status: 400,
      error: "invalid_client",
      error_description: "Client authentication failed.",
    });
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({
        body: {
          issuerUrl: provider.baseUrl,
          clientId: "real-client",
          clientSecret: "real-secret",
          allowInsecureHttp: true,
        },
      }),
    );
    const payload = res.json.mock.calls[0][0];
    expect(payload.success).toBe(false);
    expect(payload.code).toBe("OIDC_CREDENTIALS_REJECTED");
  });
});

// SECURITY (2026-10-08, #2): whoever sets the issuer, client or redirect URI
// decides which provider vouches for sign-ins, and so can sign in as any
// linked account. panel.settings alone keeps the display name and scope.
describe("provider fields are admin-only", () => {
  const settingsOnly = { role: "settings-only", userId: "delegate-1" };

  beforeEach(() => {
    clearSavedSettings();
    clearOidcEnv();
    resetOidcConfigCache();
  });

  it("a panel.settings-only role cannot change the issuer, client, secret, redirect URI or plain-HTTP switch", async () => {
    for (const body of [
      { issuerUrl: "https://evil.example/.well-known/openid-configuration" },
      { clientId: "attacker-client" },
      { clientSecret: "attacker-secret" },
      { redirectUri: "https://evil.example/api/auth/oidc/callback" },
      { allowInsecureHttp: true },
    ]) {
      const res = await runRoute("/settings", "put", makeReq({ user: settingsOnly, body }));
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: "OIDC_PROVIDER_FIELDS_ADMIN_ONLY" }),
      );
    }
    expect(settingsStore.size).toBe(0);
  });

  it("the same role can still change the display name and scope, and resend unchanged fields", async () => {
    const res = await runRoute(
      "/settings",
      "put",
      makeReq({
        user: settingsOnly,
        // What the form posts back untouched: empty provider fields and an
        // empty secret box while no secret is saved.
        body: { providerName: "Company SSO", scope: "openid email", issuerUrl: "", clientSecret: "" },
      }),
    );
    expect(res.status).not.toHaveBeenCalledWith(403);
    expect(settingsStore.get("oidcProviderName")).toBe("Company SSO");
    expect(settingsStore.get("oidcScope")).toBe("openid email");
  });

  it("the same role cannot test against another provider", async () => {
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({ user: settingsOnly, body: { issuerUrl: "https://evil.example" } }),
    );
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("GET tells the screen which callers may edit the provider fields", async () => {
    const delegate = (await runRoute("/settings", "get", makeReq({ user: settingsOnly }))).json.mock.calls[0][0];
    expect(delegate.providerFieldsEditable).toBe(false);
    const admin = (await runRoute("/settings", "get", makeReq())).json.mock.calls[0][0];
    expect(admin.providerFieldsEditable).toBe(true);
  });
});

// SECURITY (2026-10-08, #12): test-connection used to send the stored (or
// env) client secret to whatever issuer the request named.
describe("the saved client secret stays with the saved provider", () => {
  let saved;
  let other;

  beforeEach(async () => {
    clearSavedSettings();
    clearOidcEnv();
    resetOidcConfigCache();
    saved = await startMockOidcProvider({ clientId: "real-client" });
    other = await startMockOidcProvider({ clientId: "real-client" });
    await runRoute(
      "/settings",
      "put",
      makeReq({
        body: {
          issuerUrl: saved.baseUrl,
          clientId: "real-client",
          clientSecret: "real-secret",
          allowInsecureHttp: true,
        },
      }),
    );
  });

  afterEach(async () => {
    clearOidcEnv();
    await saved.close();
    await other.close();
  });

  it("testing a different issuer without a secret returns 400 and sends no token request", async () => {
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({ body: { issuerUrl: other.baseUrl } }),
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "OIDC_CLIENT_SECRET_REQUIRED" }),
    );
    expect(other.tokenRequests).toBe(0);
  });

  it("testing a different client ID without a secret returns 400 too", async () => {
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({ body: { clientId: "another-client" } }),
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(saved.tokenRequests).toBe(0);
  });

  it("a different issuer with its own secret is tested normally", async () => {
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({ body: { issuerUrl: other.baseUrl, clientSecret: "other-secret" } }),
    );
    expect(res.json.mock.calls[0][0].success).toBe(true);
    expect(other.tokenRequests).toBe(1);
  });

  it("a request cannot turn plain HTTP on past an environment pin", async () => {
    process.env.PANEL_OIDC_ALLOW_INSECURE_HTTP = "false";
    const res = await runRoute(
      "/test-connection",
      "post",
      makeReq({ body: { issuerUrl: other.baseUrl, clientSecret: "other-secret", allowInsecureHttp: true } }),
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(other.tokenRequests).toBe(0);
  });

  it("saving a new issuer without a new secret is refused, and works with one", async () => {
    const refused = await runRoute(
      "/settings",
      "put",
      makeReq({ body: { issuerUrl: other.baseUrl } }),
    );
    expect(refused.status).toHaveBeenCalledWith(400);
    expect(refused.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: "OIDC_CLIENT_SECRET_REQUIRED" }),
    );
    expect(settingsStore.get("oidcIssuerUrl")).toBe(saved.baseUrl);

    const accepted = await runRoute(
      "/settings",
      "put",
      makeReq({ body: { issuerUrl: other.baseUrl, clientSecret: "other-secret" } }),
    );
    expect(accepted.status).not.toHaveBeenCalledWith(400);
    expect(settingsStore.get("oidcIssuerUrl")).toBe(other.baseUrl);
  });
});
