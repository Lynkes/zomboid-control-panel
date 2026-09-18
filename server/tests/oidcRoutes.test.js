import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import authService from '../services/auth.js';
import * as dbModule from '../database/init.js';
import { _resetOidcConfigCacheForTests } from '../services/oidc.js';
import oidcRoutes from '../routes/oidc.js';
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
  user = { userId: 'admin-1', role: 'admin' },
} = {}) {
  return { cookies, url, headers, secure, body, user };
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

  function callbackReq({
    state = 'flow-state',
    nonce = 'flow-nonce',
    flowType = 'login',
    missingCookie = false,
  } = {}) {
    const flow = { state, nonce, codeVerifier: 'flow-code-verifier' };
    if (flowType !== null) flow.flowType = flowType;
    return makeReq({
      cookies: missingCookie
        ? {}
        : { oidcFlow: JSON.stringify(flow) },
      url: `${REDIRECT_URI_PATH}?code=test-code&state=${state}`,
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

    for (const flowType of [null, 'unexpected']) {
      const res = makeRes();
      await getHandler('get', '/callback')(callbackReq({ flowType }), res);
      expect(res.redirectedTo).toBe('/?oidcError=expired_flow');
      expect(res.cookies.find((cookie) => cookie.name === 'refreshToken')).toBeUndefined();
    }

    expect(getDbSpy).not.toHaveBeenCalled();
  });

  it('redirects with invalid_token when the ID token fails validation, and never reaches user resolution', async () => {
    provider.setNextIdToken({ claims: { nonce: 'wrong-nonce-entirely' } });
    const getDbSpy = vi.spyOn(dbModule, 'getDb');

    const res = makeRes();
    await getHandler('get', '/callback')(callbackReq(), res);

    expect(res.redirectedTo).toBe('/?oidcError=invalid_token');
    // authService.loginWithExternalIdentity's first move is db.data.users --
    // if the token had reached it, getDb() would have been called.
    expect(getDbSpy).not.toHaveBeenCalled();
  });

  it('redirects with refused when the identity is not linked to any account on an already-initialized panel', async () => {
    provider.setNextIdToken({ claims: { nonce: 'flow-nonce' } });
    vi.spyOn(dbModule, 'getDb').mockResolvedValue({
      data: {
        users: [
          { id: 'existing-1', username: 'admin', role: 'admin', externalIdentities: [] },
        ],
      },
    });

    const res = makeRes();
    await getHandler('get', '/callback')(callbackReq(), res);

    expect(res.redirectedTo).toBe('/?oidcError=refused');
    expect(res.cookies.find((c) => c.name === 'refreshToken')).toBeUndefined();
  });

  it('redirects with setup_required (not an auto-created account) when the identity is unlinked on a brand new panel', async () => {
    provider.setNextIdToken({ claims: { nonce: 'flow-nonce' } });
    vi.spyOn(dbModule, 'getDb').mockResolvedValue({ data: { users: [] } });

    const res = makeRes();
    await getHandler('get', '/callback')(callbackReq(), res);

    expect(res.redirectedTo).toBe('/?oidcError=setup_required');
    expect(res.cookies.find((c) => c.name === 'refreshToken')).toBeUndefined();
  });

  it('redirects with session_failed and issues no cookie when the linked account is locked out', async () => {
    provider.setNextIdToken({ claims: { nonce: 'flow-nonce' } });
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
            lockedUntil: new Date(Date.now() + 60_000).toISOString(),
            externalIdentities: [{ issuer: provider.baseUrl, subject: SUBJECT }],
          },
        ],
      },
    });

    const res = makeRes();
    await getHandler('get', '/callback')(callbackReq(), res);

    expect(res.redirectedTo).toBe('/?oidcError=session_failed');
    expect(res.cookies.find((c) => c.name === 'refreshToken')).toBeUndefined();
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
    await getHandler('get', '/callback')(
      callbackReq({
        state: flow.state,
        nonce: flow.nonce,
        flowType: flow.flowType,
      }),
      callbackRes,
    );

    expect(callbackRes.redirectedTo).toBe('/settings?tab=users&oidcSuccess=linked');
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
      callbackReq({ state: 'missing-link-state', flowType: 'link' }),
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
    await getHandler('get', '/callback')(
      callbackReq({ state: flow.state, nonce: flow.nonce, flowType: flow.flowType }),
      res,
    );

    expect(res.redirectedTo).toBe('/settings?tab=users&oidcError=link_failed');
    expect(target.externalIdentities).toEqual([]);
  });

  it('on success: issues a session cookie identical in shape to local login and redirects to /', async () => {
    provider.setNextIdToken({ claims: { nonce: 'flow-nonce' } });
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
    await getHandler('get', '/callback')(callbackReq(), res);

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
  });
});
