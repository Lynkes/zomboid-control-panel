import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import authService from '../services/auth.js';
import * as dbModule from '../database/init.js';
import { _resetOidcConfigCacheForTests } from '../services/oidc.js';
import oidcRoutes, { _resetIssuedOidcFlowsForTests } from '../routes/oidc.js';
import authRoutes from '../routes/auth.js';
import { startMockOidcProvider } from './helpers/mockOidcProvider.js';
import { acquireOidcTestLock } from './helpers/oidcTestLock.js';

let releaseOidcTestLock;
beforeAll(async () => {
  releaseOidcTestLock = await acquireOidcTestLock();
});
afterAll(() => {
  releaseOidcTestLock?.();
});

const ENV_KEYS = [
  'PANEL_OIDC_ISSUER_URL',
  'PANEL_OIDC_CLIENT_ID',
  'PANEL_OIDC_CLIENT_SECRET',
  'PANEL_OIDC_REDIRECT_URI',
  'PANEL_OIDC_ALLOW_INSECURE_HTTP',
];

function clearOidcEnv() {
  for (const key of ENV_KEYS) delete process.env[key];
  _resetOidcConfigCacheForTests();
  _resetIssuedOidcFlowsForTests();
}

// Finds a route's handler function directly on the Express Router, the same
// way the router itself would dispatch to it, without needing to spin up a
// real HTTP server (this codebase's tests don't use supertest anywhere, and
// adding it just for these routes would be a second new test-only
// dependency on top of the ones this OIDC work already needed).
function getHandler(method, path) {
  const layer = oidcRoutes.stack.find(
    (l) => l.route?.path === path && l.route.methods[method],
  );
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${path} route registered`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeReq({
  cookies = {},
  url = '/',
  headers = {},
  secure = false,
  body = {},
  params = {},
  user = { userId: 'admin-1', role: 'admin' },
} = {}) {
  return { cookies, url, headers, secure, body, params, user };
}

// Runs every handler on a route (gates included), the way Express would.
async function runRouteChain(router, method, path, req, res) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`No ${method.toUpperCase()} ${path} route registered`);
  for (const { handle } of layer.route.stack) {
    let advanced = false;
    await handle(req, res, () => {
      advanced = true;
    });
    if (!advanced) break;
  }
  return res;
}

function makeRes() {
  const res = {
    statusCode: 200,
    jsonBody: undefined,
    redirectedTo: undefined,
    cookies: [],
    clearedCookies: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.jsonBody = body;
      return this;
    },
    redirect(url) {
      this.redirectedTo = url;
      return this;
    },
    cookie(name, value, options) {
      this.cookies.push({ name, value, options });
      return this;
    },
    clearCookie(name, options) {
      this.clearedCookies.push({ name, options });
      return this;
    },
  };
  return res;
}

describe('routes/oidc.js: /status', () => {
  beforeEach(clearOidcEnv);
  afterEach(clearOidcEnv);

  it('reports unconfigured with no env vars set', async () => {
    const res = makeRes();
    await getHandler('get', '/status')(makeReq(), res);
    expect(res.jsonBody).toEqual({ configured: false, providerName: 'SSO' });
  });

  it('reports configured once all required env vars are set', async () => {
    process.env.PANEL_OIDC_ISSUER_URL = 'https://idp.example.com';
    process.env.PANEL_OIDC_CLIENT_ID = 'panel';
    process.env.PANEL_OIDC_CLIENT_SECRET = 'secret';
    process.env.PANEL_OIDC_REDIRECT_URI = 'https://panel.example.com/api/auth/oidc/callback';

    const res = makeRes();
    await getHandler('get', '/status')(makeReq(), res);
    expect(res.jsonBody.configured).toBe(true);
  });
});

describe('routes/oidc.js: /login', () => {
  beforeEach(clearOidcEnv);
  afterEach(clearOidcEnv);

  it('returns 404 rather than crashing when OIDC is not configured', async () => {
    const res = makeRes();
    await getHandler('get', '/login')(makeReq(), res);
    expect(res.statusCode).toBe(404);
    expect(res.jsonBody).toEqual({ error: 'OIDC is not configured' });
    expect(res.redirectedTo).toBeUndefined();
  });

  it('when configured: redirects to the provider and sets a Lax, path-scoped flow cookie', async () => {
    const provider = await startMockOidcProvider({ clientId: 'panel-test-client' });
    try {
      process.env.PANEL_OIDC_ISSUER_URL = provider.baseUrl;
      process.env.PANEL_OIDC_CLIENT_ID = 'panel-test-client';
      process.env.PANEL_OIDC_CLIENT_SECRET = 'panel-test-secret';
      process.env.PANEL_OIDC_REDIRECT_URI = `${provider.baseUrl}/api/auth/oidc/callback`;
      process.env.PANEL_OIDC_ALLOW_INSECURE_HTTP = 'true';
      _resetOidcConfigCacheForTests();

      const res = makeRes();
      await getHandler('get', '/login')(
        makeReq({ headers: { 'x-forwarded-proto': 'https' } }),
        res,
      );

      expect(res.redirectedTo).toContain(`${provider.baseUrl}/authorize`);
      expect(res.cookies).toHaveLength(1);
      expect(res.cookies[0].name).toBe('oidcFlow');
      expect(res.cookies[0].options.httpOnly).toBe(true);
      expect(res.cookies[0].options.sameSite).toBe('lax');
      expect(res.cookies[0].options.path).toBe('/api/auth/oidc');
      expect(res.cookies[0].options.secure).toBe(false);
      const flow = JSON.parse(res.cookies[0].value);
      expect(flow.flowType).toBe('login');
      expect(flow.state).toEqual(expect.any(String));
      expect(flow.nonce).toEqual(expect.any(String));
      expect(flow.codeVerifier).toEqual(expect.any(String));
    } finally {
      await provider.close();
    }
  });

  it('when the provider is unreachable: responds 502 instead of hanging or crashing the process', async () => {
    process.env.PANEL_OIDC_ISSUER_URL = 'http://127.0.0.1:1';
    process.env.PANEL_OIDC_CLIENT_ID = 'panel';
    process.env.PANEL_OIDC_CLIENT_SECRET = 'secret';
    process.env.PANEL_OIDC_REDIRECT_URI = 'https://panel.example.com/api/auth/oidc/callback';
    process.env.PANEL_OIDC_ALLOW_INSECURE_HTTP = 'true';
    _resetOidcConfigCacheForTests();

    const res = makeRes();
    await getHandler('get', '/login')(makeReq(), res);
    expect(res.statusCode).toBe(502);
    expect(res.redirectedTo).toBeUndefined();
  });

  it('refuses to create a persistent link while authentication is disabled', async () => {
    const res = makeRes();
    await getHandler('post', '/link')(
      makeReq({
        user: { userId: null, role: 'admin', authDisabled: true },
        body: { userId: 'user-42' },
      }),
      res,
    );
    expect(res.statusCode).toBe(403);
    expect(res.jsonBody).toEqual({
      error: 'SSO linking requires an authenticated administrator',
    });
  });
});

describe('routes/oidc.js: /callback', () => {
  let provider;
  const CLIENT_ID = 'panel-test-client';
  const CLIENT_SECRET = 'panel-test-secret';
  const REDIRECT_URI_PATH = '/api/auth/oidc/callback';
  const SUBJECT = 'user-123';

  beforeAll(async () => {
    provider = await startMockOidcProvider({ clientId: CLIENT_ID, defaultSubject: SUBJECT });
  });

  afterAll(async () => {
    await provider.close();
  });

  beforeEach(() => {
    process.env.PANEL_OIDC_ISSUER_URL = provider.baseUrl;
    process.env.PANEL_OIDC_CLIENT_ID = CLIENT_ID;
    process.env.PANEL_OIDC_CLIENT_SECRET = CLIENT_SECRET;
    process.env.PANEL_OIDC_REDIRECT_URI = `${provider.baseUrl}${REDIRECT_URI_PATH}`;
    process.env.PANEL_OIDC_ALLOW_INSECURE_HTTP = 'true';
    _resetOidcConfigCacheForTests();
    provider.setNextIdToken({});
  });

  afterEach(() => {
    clearOidcEnv();
    vi.restoreAllMocks();
  });

  // SECURITY (2026-10-08, #6/#22): a callback is only honoured for a flow
  // this process issued, proved by the cookie's PKCE verifier, so tests
  // start real flows and replay exactly the cookie that call set.
  async function startLoginFlow() {
    const res = makeRes();
    await getHandler('get', '/login')(makeReq(), res);
    return JSON.parse(res.cookies.find((cookie) => cookie.name === 'oidcFlow').value);
  }

  async function startLinkFlow(userId) {
    const res = makeRes();
    await getHandler('post', '/link')(makeReq({ body: { userId } }), res);
    expect(res.statusCode).toBe(200);
    return JSON.parse(res.cookies.find((cookie) => cookie.name === 'oidcFlow').value);
  }

  const UNISSUED_FLOW = {
    state: 'flow-state',
    nonce: 'flow-nonce',
    codeVerifier: 'flow-code-verifier',
    flowType: 'login',
  };

  function callbackReq({ flow = UNISSUED_FLOW, state = flow.state, missingCookie = false } = {}) {
    return makeReq({
      cookies: missingCookie
        ? {}
        : { oidcFlow: JSON.stringify(flow) },
      url: `${REDIRECT_URI_PATH}?code=test-code&state=${encodeURIComponent(state)}`,
    });
  }

  it('redirects with not_configured when OIDC is unconfigured, and never touches the flow cookie', async () => {
    clearOidcEnv();
    const res = makeRes();
    await getHandler('get', '/callback')(callbackReq(), res);
    expect(res.redirectedTo).toBe('/?oidcError=not_configured');
    // The title's second claim ("never touches the flow cookie") had no
    // assertion of its own -- bug hunt 2026-08-31, mechanical sweep for
    // tests whose own name promises more than their body checks. The
    // not_configured branch returns before the route's later
    // res.clearCookie(FLOW_COOKIE_NAME, ...) call, so this must stay empty.
    expect(res.clearedCookies).toHaveLength(0);
  });

  it('redirects with expired_flow when the flow cookie is missing, and clears it defensively either way', async () => {
    const res = makeRes();
    await getHandler('get', '/callback')(callbackReq({ missingCookie: true }), res);
    expect(res.redirectedTo).toBe('/?oidcError=expired_flow');
    expect(res.clearedCookies).toHaveLength(1);
    expect(res.clearedCookies[0].name).toBe('oidcFlow');
  });

  it('rejects a missing or unknown flow type before identity resolution', async () => {
    const getDbSpy = vi.spyOn(dbModule, 'getDb');

    const { flowType: _omitted, ...untyped } = UNISSUED_FLOW;
    for (const flow of [untyped, { ...UNISSUED_FLOW, flowType: 'unexpected' }]) {
      const res = makeRes();
      await getHandler('get', '/callback')(callbackReq({ flow }), res);
      expect(res.redirectedTo).toBe('/?oidcError=expired_flow');
      expect(res.cookies.find((cookie) => cookie.name === 'refreshToken')).toBeUndefined();
    }

    expect(getDbSpy).not.toHaveBeenCalled();
  });

  it('redirects with invalid_token when the ID token fails validation, and never reaches user resolution', async () => {
    const flow = await startLoginFlow();
    provider.setNextIdToken({ claims: { nonce: 'wrong-nonce-entirely' } });
    const getDbSpy = vi.spyOn(dbModule, 'getDb');

    const res = makeRes();
    await getHandler('get', '/callback')(callbackReq({ flow }), res);

    expect(res.redirectedTo).toBe('/?oidcError=invalid_token');
    // authService.loginWithExternalIdentity's first move is db.data.users --
    // if the token had reached it, getDb() would have been called.
    expect(getDbSpy).not.toHaveBeenCalled();
  });

  it('redirects with refused when the identity is not linked to any account on an already-initialized panel', async () => {
    const flow = await startLoginFlow();
    provider.setNextIdToken({ claims: { nonce: flow.nonce } });
    vi.spyOn(dbModule, 'getDb').mockResolvedValue({
      data: {
        users: [
          { id: 'existing-1', username: 'admin', role: 'admin', externalIdentities: [] },
        ],
      },
    });

    const res = makeRes();
    await getHandler('get', '/callback')(callbackReq({ flow }), res);

    expect(res.redirectedTo).toBe('/?oidcError=refused');
    expect(res.cookies.find((c) => c.name === 'refreshToken')).toBeUndefined();
  });

  it('redirects with setup_required (not an auto-created account) when the identity is unlinked on a brand new panel', async () => {
    const flow = await startLoginFlow();
    provider.setNextIdToken({ claims: { nonce: flow.nonce } });
    vi.spyOn(dbModule, 'getDb').mockResolvedValue({ data: { users: [] } });

    const res = makeRes();
    await getHandler('get', '/callback')(callbackReq({ flow }), res);

    expect(res.redirectedTo).toBe('/?oidcError=setup_required');
    expect(res.cookies.find((c) => c.name === 'refreshToken')).toBeUndefined();
  });

  // LOCKOUT (security sweep): failed PASSWORD attempts used to lock the
  // whole account, SSO included, so anyone who knew the username could keep
  // its owner out of SSO by typing wrong passwords. A verified identity is
  // not a password guess: an old account-wide lock no longer refuses it,
  // and signing in clears it.
  it('signs in a linked account that an old account-wide password lock still marks as locked, and clears that lock', async () => {
    const flow = await startLoginFlow();
    provider.setNextIdToken({ claims: { nonce: flow.nonce } });
    authService.jwtSecret = 'test-oidc-route-secret';
    vi.spyOn(dbModule, 'commitNow').mockResolvedValue(undefined);
    const user = {
      id: 'user-42',
      username: 'sso.alice',
      role: 'moderator',
      tokenGen: 0,
      refreshSessions: [],
      failedLoginCount: 4,
      lockedUntil: new Date(Date.now() + 60_000).toISOString(),
      externalIdentities: [{ issuer: provider.baseUrl, subject: SUBJECT }],
    };
    vi.spyOn(dbModule, 'getDb').mockResolvedValue({ data: { users: [user] } });

    const res = makeRes();
    await getHandler('get', '/callback')(callbackReq({ flow }), res);

    expect(res.redirectedTo).toBe('/');
    expect(res.cookies.find((c) => c.name === 'refreshToken')).toBeTruthy();
    expect(user.lockedUntil).toBeUndefined();
    expect(user.failedLoginCount).toBeUndefined();
  });

  it('links a verified identity to the selected existing account instead of issuing a login session', async () => {
    const user = {
      id: 'user-42',
      username: 'alice',
      role: 'moderator',
      externalIdentities: [],
    };
    vi.spyOn(dbModule, 'getDb').mockResolvedValue({
      data: {
        users: [
          { id: 'admin-1', username: 'admin', role: 'admin' },
          user,
        ],
      },
    });
    vi.spyOn(dbModule, 'commitNow').mockResolvedValue(undefined);

    const startRes = makeRes();
    await getHandler('post', '/link')(
      makeReq({ body: { userId: 'user-42' } }),
      startRes,
    );
    expect(startRes.statusCode).toBe(200);
    const flowCookie = startRes.cookies.find((cookie) => cookie.name === 'oidcFlow');
    expect(flowCookie).toBeTruthy();
    const flow = JSON.parse(flowCookie.value);
    expect(flow.flowType).toBe('link');

    provider.setNextIdToken({ claims: { nonce: flow.nonce, email: 'alice@example.com' } });

    const callbackRes = makeRes();
    await getHandler('get', '/callback')(callbackReq({ flow }), callbackRes);

    expect(callbackRes.redirectedTo).toBe('/settings?tab=users&oidcSuccess=linked&linkedUser=user-42');
    expect(callbackRes.cookies.find((cookie) => cookie.name === 'refreshToken')).toBeUndefined();
    expect(user.externalIdentities).toEqual([
      expect.objectContaining({
        issuer: provider.baseUrl,
        subject: SUBJECT,
        email: 'alice@example.com',
      }),
    ]);
  });

  it('refuses a missing local target before starting an identity-provider flow', async () => {
    vi.spyOn(dbModule, 'getDb').mockResolvedValue({
      data: {
        users: [{ id: 'admin-1', username: 'admin', role: 'admin' }],
      },
    });

    const res = makeRes();
    await getHandler('post', '/link')(
      makeReq({ body: { userId: 'deleted-user' } }),
      res,
    );

    expect(res.statusCode).toBe(404);
    expect(res.jsonBody).toEqual({ error: 'User not found' });
    expect(res.cookies).toHaveLength(0);
    expect(res.redirectedTo).toBeUndefined();
  });

  it('does not fall back to ordinary login when a link flow record has expired', async () => {
    provider.setNextIdToken({ claims: { nonce: 'flow-nonce' } });
    const getDbSpy = vi.spyOn(dbModule, 'getDb');

    const res = makeRes();
    await getHandler('get', '/callback')(
      callbackReq({ flow: { ...UNISSUED_FLOW, state: 'missing-link-state', flowType: 'link' } }),
      res,
    );

    expect(res.redirectedTo).toBe('/settings?tab=users&oidcError=link_expired');
    expect(res.cookies.find((cookie) => cookie.name === 'refreshToken')).toBeUndefined();
    expect(getDbSpy).not.toHaveBeenCalled();
  });

  it('refuses a link when the initiating admin loses admin authority before callback', async () => {
    const target = {
      id: 'user-42',
      username: 'alice',
      role: 'moderator',
      externalIdentities: [],
    };
    vi.spyOn(dbModule, 'getDb').mockResolvedValue({
      data: {
        users: [
          { id: 'admin-1', username: 'admin', role: 'admin' },
          target,
        ],
      },
    });

    const startRes = makeRes();
    await getHandler('post', '/link')(
      makeReq({ body: { userId: 'user-42' } }),
      startRes,
    );
    const flow = JSON.parse(startRes.cookies[0].value);
    provider.setNextIdToken({ claims: { nonce: flow.nonce } });

    dbModule.getDb.mockResolvedValue({
      data: {
        users: [
          { id: 'admin-1', username: 'admin', role: 'technician' },
          target,
        ],
      },
    });

    const res = makeRes();
    await getHandler('get', '/callback')(callbackReq({ flow }), res);

    expect(res.redirectedTo).toBe('/settings?tab=users&oidcError=link_failed');
    expect(target.externalIdentities).toEqual([]);
  });

  it('on success: issues a session cookie identical in shape to local login and redirects to /', async () => {
    const flow = await startLoginFlow();
    provider.setNextIdToken({ claims: { nonce: flow.nonce } });
    authService.jwtSecret = 'test-oidc-route-secret';
    vi.spyOn(dbModule, 'commitNow').mockResolvedValue(undefined);
    vi.spyOn(dbModule, 'getDb').mockResolvedValue({
      data: {
        users: [
          {
            id: 'user-42',
            username: 'sso.alice',
            role: 'moderator',
            tokenGen: 0,
            refreshSessions: [],
            externalIdentities: [{ issuer: provider.baseUrl, subject: SUBJECT }],
          },
        ],
      },
    });

    const res = makeRes();
    await getHandler('get', '/callback')(callbackReq({ flow }), res);

    expect(res.redirectedTo).toBe('/');
    const refreshCookie = res.cookies.find((c) => c.name === 'refreshToken');
    expect(refreshCookie).toBeTruthy();
    expect(refreshCookie.options.httpOnly).toBe(true);
    expect(refreshCookie.options.sameSite).toBe('strict');
    expect(refreshCookie.options.path).toBe('/api/auth');
    // The session must be genuinely usable by the rest of the app: verify
    // with the SAME secret authService signed it with that the cookie is a
    // real, validly-signed refresh token for this user, not just that SOME
    // cookie was set. (authService.verifyAccessToken() deliberately refuses
    // refresh-typed tokens -- token-type confusion guard -- so this uses
    // jwt.verify directly, the same way authService.refreshAccessToken()
    // itself validates a refresh token.)
    const decoded = jwt.verify(refreshCookie.value, authService.jwtSecret);
    expect(decoded.type).toBe('refresh');
    expect(decoded.userId).toBe('user-42');

    // Single use: replaying the same callback ends before the provider.
    const tokenRequestsAfterSignIn = provider.tokenRequests;
    const replay = makeRes();
    await getHandler('get', '/callback')(callbackReq({ flow }), replay);
    expect(replay.redirectedTo).toBe('/?oidcError=expired_flow');
    expect(provider.tokenRequests).toBe(tokenRequestsAfterSignIn);
  });

  // SECURITY (2026-10-08, #22): an unknown state used to reach the token
  // endpoint before anything checked it.
  it('refuses a state this panel never issued before any token request', async () => {
    const before = provider.tokenRequests;
    const res = makeRes();
    await getHandler('get', '/callback')(callbackReq(), res);
    expect(res.redirectedTo).toBe('/?oidcError=expired_flow');
    expect(provider.tokenRequests).toBe(before);
  });

  it('a callback naming another state leaves the issued flow usable', async () => {
    const flow = await startLoginFlow();
    const stray = makeRes();
    await getHandler('get', '/callback')(callbackReq({ flow, state: 'some-other-state' }), stray);
    expect(stray.redirectedTo).toBe('/?oidcError=expired_flow');

    provider.setNextIdToken({ claims: { nonce: flow.nonce } });
    vi.spyOn(dbModule, 'getDb').mockResolvedValue({ data: { users: [{ id: 'a', username: 'a', role: 'admin' }] } });
    const res = makeRes();
    await getHandler('get', '/callback')(callbackReq({ flow }), res);
    expect(res.redirectedTo).toBe('/?oidcError=refused');
  });

  // SECURITY (2026-10-08, #6): the state of a failed or cancelled link sits
  // in URLs (provider and proxy logs, history). Knowing it must not be enough
  // to link your own identity to the admin's chosen account, and trying must
  // not cancel the admin's own flow either.
  it("a leaked link state with another verifier links nothing, and the admin's own callback still links", async () => {
    const target = { id: 'user-42', username: 'alice', role: 'moderator', externalIdentities: [] };
    vi.spyOn(dbModule, 'getDb').mockResolvedValue({
      data: { users: [{ id: 'admin-1', username: 'admin', role: 'admin' }, target] },
    });
    vi.spyOn(dbModule, 'commitNow').mockResolvedValue(undefined);

    const flow = await startLinkFlow('user-42');

    const forged = {
      state: flow.state,
      nonce: 'attacker-nonce',
      codeVerifier: 'attacker-verifier',
      flowType: 'link',
    };
    provider.setNextIdToken({ claims: { nonce: 'attacker-nonce', sub: 'attacker-sub' } });
    const forgedRes = makeRes();
    await getHandler('get', '/callback')(callbackReq({ flow: forged }), forgedRes);
    expect(forgedRes.redirectedTo).toBe('/settings?tab=users&oidcError=link_expired');
    expect(target.externalIdentities).toEqual([]);

    provider.setNextIdToken({ claims: { nonce: flow.nonce, sub: 'alice-sub' } });
    const ownRes = makeRes();
    await getHandler('get', '/callback')(callbackReq({ flow }), ownRes);
    expect(ownRes.redirectedTo).toBe('/settings?tab=users&oidcSuccess=linked&linkedUser=user-42');
    expect(target.externalIdentities).toEqual([
      expect.objectContaining({ issuer: provider.baseUrl, subject: 'alice-sub' }),
    ]);
  });

  it("a login state paired with another verifier or a later expiry is refused, and the real flow still signs in", async () => {
    const flow = await startLoginFlow();
    const before = provider.tokenRequests;
    for (const forged of [
      { ...flow, codeVerifier: 'attacker-verifier' },
      { ...flow, expiresAt: flow.expiresAt + 60_000 },
      { ...flow, tag: undefined },
    ]) {
      const res = makeRes();
      await getHandler('get', '/callback')(callbackReq({ flow: forged }), res);
      expect(res.redirectedTo).toBe('/?oidcError=expired_flow');
    }
    expect(provider.tokenRequests).toBe(before);

    provider.setNextIdToken({ claims: { nonce: flow.nonce } });
    vi.spyOn(dbModule, 'getDb').mockResolvedValue({ data: { users: [{ id: 'a', username: 'a', role: 'admin' }] } });
    const res = makeRes();
    await getHandler('get', '/callback')(callbackReq({ flow }), res);
    expect(res.redirectedTo).toBe('/?oidcError=refused');
  });

  // Review of #22: one shared, capped map of issued flows let a /login flood
  // push other people's sign-ins and an admin's link flow out of it.
  it('a flood of /login requests ends neither an admin link flow nor a sign-in already under way', async () => {
    const target = { id: 'user-42', username: 'alice', role: 'moderator', externalIdentities: [] };
    vi.spyOn(dbModule, 'getDb').mockResolvedValue({
      data: { users: [{ id: 'admin-1', username: 'admin', role: 'admin' }, target] },
    });
    vi.spyOn(dbModule, 'commitNow').mockResolvedValue(undefined);

    const linkFlow = await startLinkFlow('user-42');
    const loginFlow = await startLoginFlow();
    const loginHandler = getHandler('get', '/login');
    for (let i = 0; i < 2100; i++) {
      await loginHandler(makeReq({ user: undefined }), makeRes());
    }

    provider.setNextIdToken({ claims: { nonce: linkFlow.nonce, sub: 'alice-sub' } });
    const linked = makeRes();
    await getHandler('get', '/callback')(callbackReq({ flow: linkFlow }), linked);
    expect(linked.redirectedTo).toBe('/settings?tab=users&oidcSuccess=linked&linkedUser=user-42');

    provider.setNextIdToken({ claims: { nonce: loginFlow.nonce, sub: 'someone-else' } });
    const signIn = makeRes();
    await getHandler('get', '/callback')(callbackReq({ flow: loginFlow }), signIn);
    // Reached the provider and came back verified; only the account lookup refused it.
    expect(signIn.redirectedTo).toBe('/?oidcError=refused');
  }, 30_000);

  // SECURITY (2026-10-08, #13): a wrong or hijacked link could only be
  // removed by deleting the account.
  it('an admin can unlink an identity, which ends its sessions and its SSO sign-in', async () => {
    authService.jwtSecret = 'test-oidc-route-secret';
    vi.spyOn(dbModule, 'commitNow').mockResolvedValue(undefined);
    const user = {
      id: 'user-42',
      username: 'sso.alice',
      role: 'moderator',
      tokenGen: 0,
      refreshSessions: [{ id: 'session-1', expiresAt: new Date(Date.now() + 60_000).toISOString() }],
      externalIdentities: [
        { issuer: provider.baseUrl, subject: SUBJECT, email: 'alice@example.com', linkedAt: '2026-10-01T00:00:00.000Z' },
      ],
    };
    vi.spyOn(dbModule, 'getDb').mockResolvedValue({
      data: { users: [{ id: 'admin-1', username: 'admin', role: 'admin' }, user] },
    });

    // The users list shows the link, never the full subject.
    const listed = (await authService.getUsers()).find((u) => u.id === 'user-42');
    expect(listed.externalIdentities).toEqual([
      { issuer: provider.baseUrl, subject: '••••', email: 'alice@example.com', linkedAt: '2026-10-01T00:00:00.000Z' },
    ]);

    const refused = await runRouteChain(
      authRoutes,
      'delete',
      '/users/:id/identities',
      makeReq({ params: { id: 'user-42' }, user: { userId: 'tech-1', role: 'technician' } }),
      makeRes(),
    );
    expect(refused.statusCode).toBe(403);
    expect(user.externalIdentities).toHaveLength(1);

    const res = await runRouteChain(
      authRoutes,
      'delete',
      '/users/:id/identities',
      makeReq({ params: { id: 'user-42' } }),
      makeRes(),
    );
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({
      success: true,
      user: { id: 'user-42', username: 'sso.alice' },
      removed: 1,
    });
    expect(user.externalIdentities).toEqual([]);
    expect(user.tokenGen).toBe(1);
    expect(user.refreshSessions).toEqual([]);

    const flow = await startLoginFlow();
    provider.setNextIdToken({ claims: { nonce: flow.nonce } });
    const signIn = makeRes();
    await getHandler('get', '/callback')(callbackReq({ flow }), signIn);
    expect(signIn.redirectedTo).toBe('/?oidcError=refused');
    expect(signIn.cookies.find((c) => c.name === 'refreshToken')).toBeUndefined();
  });

  it('masks all but the last four characters of a long subject in the users list', async () => {
    vi.spyOn(dbModule, 'getDb').mockResolvedValue({
      data: {
        users: [
          {
            id: 'user-42',
            username: 'alice',
            role: 'moderator',
            externalIdentities: [{ issuer: provider.baseUrl, subject: '109876543210987654321', email: null }],
          },
        ],
      },
    });
    const [listed] = await authService.getUsers();
    expect(listed.externalIdentities[0].subject).toBe('••••4321');
  });
});

// SECURITY (2026-10-08, #22): through a real Express stack, so the gates and
// limiters run in their real order. /login and /link used to share one
// address-keyed budget of 5 a minute that ran before the admin check.
describe('routes/oidc.js: rate limits', () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      const userId = req.get('x-test-user');
      if (userId) req.user = { userId, role: 'admin' };
      next();
    });
    app.use('/api/auth/oidc', oidcRoutes);
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(clearOidcEnv);
  afterEach(clearOidcEnv);

  async function postLink(asUser) {
    const res = await fetch(`${baseUrl}/api/auth/oidc/link`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(asUser ? { 'x-test-user': asUser } : {}) },
      body: JSON.stringify({ userId: 'user-42' }),
    });
    return res.status;
  }

  it("strangers never spend an admin's /link budget, and each admin has their own", async () => {
    for (let i = 0; i < 6; i++) {
      expect(await postLink(null)).toBe(401);
    }
    // OIDC is not configured here, so a request past the limiter gets 404.
    expect(await postLink('admin-1')).toBe(404);
    for (let i = 0; i < 9; i++) await postLink('admin-1');
    expect(await postLink('admin-1')).toBe(429);
    expect(await postLink('admin-2')).toBe(404);
  });

  it('/login has its own, wider budget', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${baseUrl}/api/auth/oidc/login`, { redirect: 'manual' });
      expect(res.status).toBe(404);
    }
  });
});
