// OIDC (OpenID Connect) sign-in routes — mounted at /api/auth/oidc.
// Additive to the existing local username/password login in routes/auth.js
// (untouched by this file): local login is the permanent fallback, and
// every route here degrades to a clear, safe response when OIDC isn't
// configured rather than ever taking the rest of the panel down with it.
//
// This file owns provider config, the PKCE/state/nonce flow, and ID token
// validation (services/oidc.js). It deliberately does NOT own user or role
// resolution — once a token is validated, /callback hands the (already
// verified) issuer+subject straight to authService.loginWithExternalIdentity(),
// which is Jim's auth.js work and decides find-vs-refuse/role policy.
import crypto from "crypto";
import { Router } from "express";
import rateLimit from "express-rate-limit";
import authService, { requireRole } from "../services/auth.js";
import { createLogger } from "../utils/logger.js";
import { escapeLogText } from "../utils/logText.js";
import { sanitizeError, isMaskedSecret } from "../utils/sanitize.js";
import { ErrorCode } from "../utils/errorCodes.js";
import {
  getOidcSettings,
  getOidcEnvOverrides,
  setOidcSettings,
  isOidcConfigured,
  isValidOidcIssuerUrl,
  isValidOidcRedirectUri,
  buildOidcAuthorizationRequest,
  handleOidcCallback,
  hasOpenIdScope,
  resetOidcConfigCache,
  testOidcDiscovery,
} from "../services/oidc.js";
import { getRefreshCookieOptions } from "../utils/refreshCookie.js";
import { requirePermission } from "../services/permissions.js";

const log = createLogger("OIDC");
const router = Router();

// SECURITY (2026-10-08, #22): one budget per route. /login and /link used
// to share 5 a minute keyed by address, so one stranger on an address
// everyone shares (a proxy without TRUST_PROXY) could refuse every SSO
// sign-in and every admin's link. Building the redirect is cheap; 30 a
// minute still caps how many flows one address can start.
const loginRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Please try again later." },
});
// Runs after the admin check and counts per admin account, so requests from
// anyone else never spend an admin's budget.
const linkRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !req.user?.userId,
  keyGenerator: (req) => `user:${req.user.userId}`,
  message: { error: "Too many SSO link attempts. Please try again later." },
});
// /callback has no address-keyed limiter any more (same finding): five junk
// callbacks a minute used to refuse every sign-in behind a shared address.
// A callback whose state this process did not issue is now refused before
// any request to the provider, and an issued state is single-use and needs
// the browser's own PKCE verifier, so token exchanges are bounded by the two
// limiters above. The global /api limiter still caps raw request volume.

const FLOW_COOKIE_NAME = "oidcFlow";
const FLOW_COOKIE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes — enough for an IdP login + MFA, short enough to limit exposure.

// SECURITY (2026-10-08, #6 and #22): every state /login and /link hand out,
// with a SHA-256 of that flow's PKCE verifier (and, for /link, the account
// being linked). The state travels in URLs (provider and proxy logs, browser
// history) and the flow cookie is unsigned, so the state alone proves
// nothing: a callback is honoured only when its cookie's verifier hashes to
// the recorded one, and only that callback consumes the entry. Consuming it
// on any request that names the state would let a stranger cancel someone
// else's flow. Lost on restart, which reads as an expired flow.
const issuedFlows = new Map();
const MAX_ISSUED_FLOWS = 2000;

function hashCodeVerifier(codeVerifier) {
  return crypto.createHash("sha256").update(codeVerifier).digest();
}

function rememberIssuedFlow(state, codeVerifier, entry, now = Date.now()) {
  for (const [key, value] of issuedFlows) {
    if (value.expiresAt <= now) issuedFlows.delete(key);
  }
  // Oldest first (a Map keeps insertion order); only reached when this many
  // flows were started inside one cookie lifetime.
  while (issuedFlows.size >= MAX_ISSUED_FLOWS) {
    issuedFlows.delete(issuedFlows.keys().next().value);
  }
  issuedFlows.set(state, {
    ...entry,
    verifierHash: hashCodeVerifier(codeVerifier),
    expiresAt: now + FLOW_COOKIE_MAX_AGE_MS,
  });
}

// The issued entry for this cookie, removed from the map, or null (and the
// entry left alone) when the cookie does not prove it started that flow.
function takeIssuedFlow(flow, now = Date.now()) {
  if (typeof flow.state !== "string" || typeof flow.codeVerifier !== "string") return null;
  const entry = issuedFlows.get(flow.state);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    issuedFlows.delete(flow.state);
    return null;
  }
  if (entry.flowType !== flow.flowType) return null;
  if (!crypto.timingSafeEqual(hashCodeVerifier(flow.codeVerifier), entry.verifierHash)) {
    return null;
  }
  issuedFlows.delete(flow.state);
  return entry;
}

// For tests: forget every issued flow between cases.
export function _resetIssuedOidcFlowsForTests() {
  issuedFlows.clear();
}

// The state/nonce/PKCE cookie deliberately uses SameSite=Lax, not Strict:
// unlike the refresh-token cookie above (only ever sent by same-site XHR
// from the panel's own SPA), this one MUST be sent when the browser lands
// back on /api/auth/oidc/callback via a top-level cross-site GET redirect
// FROM the identity provider's domain — SameSite=Strict cookies are not
// sent on that navigation and the flow would break on every provider.
// Unsigned: tampering with the state, nonce or verifier fails either the
// issued-flow check above or openid-client's own comparisons, and the
// sign-in is refused, same as if the cookie were absent.
function getFlowCookieOptions(req) {
  const forceSecureCookies =
    process.env.HTTPS === "true" || process.env.FORCE_HSTS === "true";
  const requestIsSecure =
    req.secure === true;
  return {
    httpOnly: true,
    secure: forceSecureCookies || requestIsSecure,
    sameSite: "lax",
    path: "/api/auth/oidc",
    maxAge: FLOW_COOKIE_MAX_AGE_MS,
  };
}

// GET /api/auth/oidc/status — public, no secrets. Lets the login screen
// decide whether to offer an SSO option at all.
router.get("/status", async (_req, res) => {
  const settings = await getOidcSettings();
  res.json({
    configured: isOidcConfigured(settings),
    providerName: settings.providerName,
  });
});

// GET /api/auth/oidc/login — starts the flow.
router.get("/login", loginRateLimiter, async (req, res) => {
  const settings = await getOidcSettings();
  if (!isOidcConfigured(settings)) {
    return res.status(404).json({ error: "OIDC is not configured" });
  }

  try {
    const { authorizationUrl, state, nonce, codeVerifier } =
      await buildOidcAuthorizationRequest();
    rememberIssuedFlow(state, codeVerifier, { flowType: "login" });

    res.cookie(
      FLOW_COOKIE_NAME,
      JSON.stringify({ state, nonce, codeVerifier, flowType: "login" }),
      getFlowCookieOptions(req),
    );
    res.redirect(authorizationUrl);
  } catch (error) {
    log.warn(`OIDC login start failed: ${error.message}`);
    res.status(502).json({
      error: sanitizeError(
        "Could not reach the identity provider. Try local sign-in, or contact your administrator.",
      ),
    });
  }
});

// POST /api/auth/oidc/link — starts an admin-authorized link flow for an
// existing local account. The selected user id lives server-side, keyed by
// the random OIDC state, rather than in the unsigned browser cookie; changing
// a cookie cannot redirect a verified Google identity onto another account.
router.post("/link", requireRole("admin"), linkRateLimiter, async (req, res) => {
  if (req.user?.authDisabled) {
    return res.status(403).json({
      error: "SSO linking requires an authenticated administrator",
    });
  }
  const initiatorUserId =
    typeof req.user?.userId === "string" ? req.user.userId.trim() : "";
  if (!initiatorUserId) {
    return res.status(403).json({
      error: "SSO linking requires an authenticated administrator",
    });
  }
  const userId = typeof req.body?.userId === "string" ? req.body.userId.trim() : "";
  if (!userId) return res.status(400).json({ error: "userId is required" });

  const settings = await getOidcSettings();
  if (!isOidcConfigured(settings)) {
    return res.status(404).json({ error: "OIDC is not configured" });
  }

  try {
    const users = await authService.getUsers();
    if (!users.some((user) => user.id === userId)) {
      return res.status(404).json({ error: "User not found" });
    }
  } catch (error) {
    log.error(`OIDC identity-link target lookup failed: ${error.message}`);
    return res.status(500).json({
      error: sanitizeError("Could not verify the selected local account. Try again."),
    });
  }

  try {
    // forceLogin: the provider asks for a fresh sign-in, so the identity
    // linked is whoever signs in now, not the admin's own provider session.
    const { authorizationUrl, state, nonce, codeVerifier } =
      await buildOidcAuthorizationRequest({ forceLogin: true });
    rememberIssuedFlow(state, codeVerifier, {
      flowType: "link",
      userId,
      initiatorUserId,
    });
    res.cookie(
      FLOW_COOKIE_NAME,
      JSON.stringify({ state, nonce, codeVerifier, flowType: "link" }),
      getFlowCookieOptions(req),
    );
    res.json({ authorizationUrl });
  } catch (error) {
    log.warn(`OIDC identity-link start failed: ${error.message}`);
    res.status(502).json({
      error: sanitizeError(
        "Could not reach the identity provider. Try again or contact your administrator.",
      ),
    });
  }
});

// GET /api/auth/oidc/callback — the redirect back from the IdP. This is a
// full-page browser navigation, not an XHR, so on both success and failure
// it redirects the browser rather than returning raw JSON — always back to
// the panel's own root, which already handles "there's a valid refresh
// cookie" as part of its existing auto-login bootstrap (see
// routes/auth.js's POST /refresh), so no client-side change is needed to
// pick up a session set here. Failures redirect with a short, generic
// reason code only — never a raw error message — for whichever future UI
// work wants to surface it.
router.get("/callback", async (req, res) => {
  const settings = await getOidcSettings();
  if (!isOidcConfigured(settings)) {
    return res.redirect("/?oidcError=not_configured");
  }

  const rawFlowCookie = req.cookies?.[FLOW_COOKIE_NAME];
  const { maxAge: _unused, ...clearFlowCookieOptions } = getFlowCookieOptions(req);
  res.clearCookie(FLOW_COOKIE_NAME, clearFlowCookieOptions);

  let flow;
  try {
    flow = rawFlowCookie ? JSON.parse(rawFlowCookie) : null;
  } catch {
    flow = null;
  }
  if (!flow || (flow.flowType !== "login" && flow.flowType !== "link")) {
    log.warn("OIDC callback with no/invalid flow cookie (expired, or CSRF attempt)");
    return res.redirect("/?oidcError=expired_flow");
  }

  const currentUrl = new URL(settings.redirectUri);
  const queryIndex = req.url.indexOf("?");
  currentUrl.search = queryIndex === -1 ? "" : req.url.slice(queryIndex);

  // Before any request to the provider: the flow must be one this process
  // started, proved by the cookie's verifier, and the provider must have
  // sent back that same state, so only the flow's own callback can end it.
  // A link flow never falls back to ordinary sign-in.
  const isLinkFlow = flow.flowType === "link";
  const issuedFlow =
    currentUrl.searchParams.get("state") === flow.state ? takeIssuedFlow(flow) : null;
  if (!issuedFlow) {
    log.warn("OIDC callback for a flow this panel did not start, or one that already ended");
    return res.redirect(
      isLinkFlow ? "/settings?tab=users&oidcError=link_expired" : "/?oidcError=expired_flow",
    );
  }

  // SECURITY (2026-10-05, H2): everything below that reaches a log line can
  // carry what the caller put in this URL (the query's error/state
  // parameters end up in the client library's error text) or what the
  // provider put in its token (`sub` is only refused for C0 controls), so
  // it is escaped for the log (utils/logText.js).
  let claims;
  try {
    claims = await handleOidcCallback(currentUrl, flow);
  } catch (error) {
    log.warn(`OIDC callback rejected: ${escapeLogText(error.message)}`);
    return res.redirect("/?oidcError=invalid_token");
  }

  if (isLinkFlow) {
    try {
      await authService.linkExternalIdentity(issuedFlow.userId, {
        issuer: claims.iss,
        subject: claims.sub,
        email: claims.email,
      }, {
        actingUserId: issuedFlow.initiatorUserId,
      });
      log.info(`OIDC identity linked to local user ${issuedFlow.userId}`);
      // The account id, not the email: the Users screen reads the linked
      // identity from its own list, so no address lands in the URL.
      return res.redirect(
        `/settings?tab=users&oidcSuccess=linked&linkedUser=${encodeURIComponent(issuedFlow.userId)}`,
      );
    } catch (error) {
      log.warn(`OIDC identity link failed: ${escapeLogText(error.message)}`);
      return res.redirect("/settings?tab=users&oidcError=link_failed");
    }
  }

  // User/role resolution is entirely authService's call (Jim's
  // loginWithExternalIdentity, final signature per god) — this route only
  // supplies the VALIDATED issuer+subject+email and reacts to the outcome.
  // loginWithExternalIdentity does NO token verification itself; that
  // already happened above in handleOidcCallback. Refuse-by-default: an
  // identity with no local account already linked to it is NOT
  // auto-created (linked:false, canBootstrapAdmin:false).
  let result;
  try {
    result = await authService.loginWithExternalIdentity(
      { issuer: claims.iss, subject: claims.sub, email: claims.email },
      true,
    );
  } catch (error) {
    log.error(`OIDC session issuance failed: ${escapeLogText(error.message)}`);
    return res.redirect("/?oidcError=session_failed");
  }

  // -----------------------------------------------------------------------
  // BOOTSTRAP GATE SEAM — DO NOT CALL bootstrapAdminFromExternalIdentity()
  // FROM THIS ROUTE. DO NOT INVENT A GATING MECHANISM HERE.
  // -----------------------------------------------------------------------
  // canBootstrapAdmin:true means zero local users exist — the exact same
  // trust boundary /api/auth/setup relies on for the password path. Kevin
  // is CURRENTLY closing that boundary (a per-install setup secret,
  // generated at first boot, written to console/log) because today it's a
  // free-for-all: whoever reaches a fresh panel first becomes admin. If
  // this route bootstrapped an OIDC admin without going through whatever
  // Kevin lands, it would be a side door around his front door — anyone
  // who can complete a Google login on a fresh panel would own it,
  // regardless of the setup secret. So: this branch NEVER calls
  // bootstrapAdminFromExternalIdentity. It only signals the distinct case
  // (setup_required, not refused) so a future setup flow — gated by
  // Kevin's mechanism, coordinated through god once its shape is settled —
  // can pick it up. Until then a brand-new panel's first admin can only be
  // created via the existing password-based /api/auth/setup route.
  if (!result.linked) {
    log.warn(
      `OIDC identity not linked to any account (sub=${escapeLogText(claims.sub)}, canBootstrapAdmin=${result.canBootstrapAdmin})`,
    );
    return res.redirect(
      result.canBootstrapAdmin ? "/?oidcError=setup_required" : "/?oidcError=refused",
    );
  }

  res.cookie("refreshToken", result.refreshToken, getRefreshCookieOptions(req));
  log.info(`OIDC sign-in: ${result.user.username} (sub=${escapeLogText(claims.sub)})`);
  res.redirect("/");
});

// ---------------------------------------------------------------------------
// Settings (Settings screen) — gated on panel.settings, the capability that
// already owns every other panel-wide setting. Not a new capability.
// SECURITY (2026-10-08, #2): the fields that decide WHICH provider vouches
// for sign-ins (issuer, client, secret, redirect URI, plain HTTP) are
// admin-only, the same bar as POST /link. Whoever controls them can have
// that provider assert any identity, which signs them in as any linked
// account, admins included. panel.settings alone keeps the display name and
// scope, and can test the saved provider.
// ---------------------------------------------------------------------------

const MAX_SCOPE_LENGTH = 500;
const MAX_PROVIDER_NAME_LENGTH = 100;
function readOptionalBoolean(body, field) {
  if (body[field] === undefined) return { ok: true, value: undefined };
  if (typeof body[field] !== "boolean") {
    return { ok: false, error: `${field} must be a boolean` };
  }
  return { ok: true, value: body[field] };
}

function isPanelAdmin(req) {
  return req.user?.role === "admin";
}

// Provider fields this body would change. A field resent unchanged (the
// form posts what GET showed it) does not count. Any secret other than the
// masked placeholder counts, even the saved one, so the answer never says
// whether a guess matched.
function changedProviderFields(body, current) {
  const changed = [];
  for (const field of ["issuerUrl", "clientId", "redirectUri"]) {
    if (body[field] !== undefined && String(body[field]).trim() !== current[field]) {
      changed.push(field);
    }
  }
  if (
    body.clientSecret !== undefined &&
    !isMaskedSecret(body.clientSecret) &&
    (String(body.clientSecret) !== "" || Boolean(current.clientSecret))
  ) {
    changed.push("clientSecret");
  }
  if (body.allowInsecureHttp !== undefined && body.allowInsecureHttp !== current.allowInsecureHttp) {
    changed.push("allowInsecureHttp");
  }
  return changed;
}

function refuseProviderFieldsForNonAdmin(req, res, body, current) {
  if (isPanelAdmin(req)) return false;
  const changed = changedProviderFields(body, current);
  if (changed.length === 0) return false;
  res.status(403).json({
    error:
      "Only an administrator can change the issuer URL, client ID, client secret, redirect URI or plain-HTTP setting.",
    code: ErrorCode.OIDC_PROVIDER_FIELDS_ADMIN_ONLY,
  });
  return true;
}

const SECRET_REQUIRED_MESSAGE =
  "Enter the client secret for this provider. The saved secret is only used with the saved issuer URL and client ID.";

function publicSettingsShape(settings) {
  return {
    issuerUrl: settings.issuerUrl,
    clientId: settings.clientId,
    // Same category as the JWT secret: a GET says only whether it's
    // configured, never the value, masked or otherwise. Never echoed back.
    clientSecretConfigured: Boolean(settings.clientSecret),
    redirectUri: settings.redirectUri,
    scope: settings.scope,
    providerName: settings.providerName,
    allowInsecureHttp: settings.allowInsecureHttp,
    configured: isOidcConfigured(settings),
  };
}

// GET /api/auth/oidc/settings — the settings screen's own read.
router.get("/settings", requirePermission("panel.settings"), async (req, res) => {
  const settings = await getOidcSettings();
  res.json({
    ...publicSettingsShape(settings),
    // Which fields are currently pinned by an environment variable, so the
    // UI can show "set via environment variable" instead of accepting an
    // edit that env would silently win over anyway.
    envOverrides: getOidcEnvOverrides(),
    // Derived from THIS request's own origin, not guessed from other
    // settings -- guaranteed to match whatever the operator is actually
    // browsing the panel through right now (reverse proxy, port-forward,
    // custom domain, whatever), for pasting into the identity provider.
    suggestedRedirectUri: `${req.protocol}://${req.get("host")}/api/auth/oidc/callback`,
    // Lets the screen lock the provider fields instead of failing the save.
    providerFieldsEditable: isPanelAdmin(req),
  });
});

// PUT /api/auth/oidc/settings — partial update: only fields present in the
// body are touched, same shape as PUT /api/servers/:id.
router.put("/settings", requirePermission("panel.settings"), async (req, res) => {
  try {
    const body = req.body || {};
    const current = await getOidcSettings();
    if (refuseProviderFieldsForNonAdmin(req, res, body, current)) return;
    const envOverrides = getOidcEnvOverrides();
    const updates = {};
    const allowInsecureHttp = readOptionalBoolean(body, "allowInsecureHttp");
    if (!allowInsecureHttp.ok) {
      return res.status(400).json({ error: allowInsecureHttp.error });
    }

    if (body.issuerUrl !== undefined) {
      const value = String(body.issuerUrl).trim();
      if (value) {
        // An env-pinned switch wins at runtime, so validate against it.
        const allowHttp =
          allowInsecureHttp.value !== undefined && !envOverrides.allowInsecureHttp
            ? allowInsecureHttp.value
            : current.allowInsecureHttp;
        if (!isValidOidcIssuerUrl(value, allowHttp)) {
          return res.status(400).json({
            error: allowHttp
              ? "issuerUrl must be a valid URL"
              : "issuerUrl must be a valid https:// URL (enable allowInsecureHttp to permit http://)",
          });
        }
      }
      updates.issuerUrl = value;
    }

    if (body.clientId !== undefined) {
      updates.clientId = String(body.clientId).trim();
    }

    if (body.clientSecret !== undefined) {
      // A resubmitted masked placeholder means "leave it as-is" -- same
      // round-trip convention as every other secret field in this app.
      if (!isMaskedSecret(body.clientSecret)) {
        updates.clientSecret = String(body.clientSecret);
      }
    }

    if (body.redirectUri !== undefined) {
      const value = String(body.redirectUri).trim();
      if (value) {
        if (!isValidOidcRedirectUri(value)) {
          return res.status(400).json({
            error: "redirectUri must be a valid http:// or https:// URL ending in /api/auth/oidc/callback, without credentials, query parameters, or a fragment",
          });
        }
      }
      updates.redirectUri = value;
    }

    if (body.scope !== undefined) {
      const value = String(body.scope).trim();
      if (value.length > MAX_SCOPE_LENGTH) {
        return res
          .status(400)
          .json({ error: `scope must be ${MAX_SCOPE_LENGTH} characters or fewer` });
      }
      if (value && !hasOpenIdScope(value)) {
        return res.status(400).json({ error: "scope must include openid" });
      }
      updates.scope = value;
    }

    if (body.providerName !== undefined) {
      const value = String(body.providerName).trim();
      if (value.length > MAX_PROVIDER_NAME_LENGTH) {
        return res
          .status(400)
          .json({ error: `providerName must be ${MAX_PROVIDER_NAME_LENGTH} characters or fewer` });
      }
      updates.providerName = value;
    }

    if (allowInsecureHttp.value !== undefined) {
      updates.allowInsecureHttp = allowInsecureHttp.value;
    }

    // SECURITY (2026-10-08, #12): the saved secret was issued by the saved
    // provider; moving to another issuer without entering that provider's
    // secret would send the old one there on the next sign-in. Skipped when
    // env pins either value: a UI edit cannot change what is used then.
    if (
      updates.issuerUrl &&
      updates.issuerUrl !== current.issuerUrl &&
      updates.clientSecret === undefined &&
      current.clientSecret &&
      !envOverrides.issuerUrl &&
      !envOverrides.clientSecret
    ) {
      return res.status(400).json({
        error: SECRET_REQUIRED_MESSAGE,
        code: ErrorCode.OIDC_CLIENT_SECRET_REQUIRED,
      });
    }

    await setOidcSettings(updates);

    // THE TRAP: getOidcConfig() memoizes discovery process-wide and only a
    // FAILED discovery clears it. Without this line, a save reports
    // success and the panel keeps authenticating against the OLD provider
    // config until the process restarts -- the panel asserting something
    // false about itself on the exact screen built to fix a broken login.
    resetOidcConfigCache();

    const settings = await getOidcSettings();
    log.info(
      `OIDC settings updated (fields: ${Object.keys(updates).join(", ") || "none"})`,
    );
    res.json({ success: true, ...publicSettingsShape(settings) });
  } catch (error) {
    log.error(`Failed to update OIDC settings: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// POST /api/auth/oidc/test-connection — runs discovery only (no login round
// trip, nothing persisted, the live memoized config is untouched) against
// either the values in the body or, for any field left out, whatever is
// currently saved -- so the operator can test a partial edit (e.g. just a
// rotated client secret) without retyping everything, and test BEFORE
// committing a change that might be wrong.
router.post("/test-connection", requirePermission("panel.settings"), async (req, res) => {
  const body = req.body || {};
  const current = await getOidcSettings();
  if (refuseProviderFieldsForNonAdmin(req, res, body, current)) return;
  const allowInsecureHttp = readOptionalBoolean(body, "allowInsecureHttp");
  if (!allowInsecureHttp.ok) {
    return res.status(400).json({ error: allowInsecureHttp.error });
  }

  const candidateIssuerUrl =
    body.issuerUrl !== undefined ? String(body.issuerUrl).trim() : current.issuerUrl;
  const candidateClientId =
    body.clientId !== undefined ? String(body.clientId).trim() : current.clientId;
  const candidateRedirectUri =
    body.redirectUri !== undefined ? String(body.redirectUri).trim() : current.redirectUri;
  // SECURITY (2026-10-08, #12): an env-pinned switch is what sign-in will
  // use, so a test cannot turn plain HTTP on past it.
  const candidateAllowInsecureHttp =
    allowInsecureHttp.value !== undefined && !getOidcEnvOverrides().allowInsecureHttp
      ? allowInsecureHttp.value
      : current.allowInsecureHttp;

  // SECURITY (2026-10-08, #12): the saved (or env) secret goes only to the
  // saved issuer as the saved client. A test against anything else must
  // bring its own secret, or the panel would post the real one to whatever
  // token endpoint the chosen issuer names, without saving or logging it.
  let clientSecret;
  if (body.clientSecret !== undefined && !isMaskedSecret(body.clientSecret)) {
    clientSecret = String(body.clientSecret);
  } else {
    if (
      current.clientSecret &&
      (candidateIssuerUrl !== current.issuerUrl || candidateClientId !== current.clientId)
    ) {
      return res.status(400).json({
        error: SECRET_REQUIRED_MESSAGE,
        code: ErrorCode.OIDC_CLIENT_SECRET_REQUIRED,
      });
    }
    clientSecret = current.clientSecret;
  }
  const candidateScope =
    body.scope !== undefined ? String(body.scope).trim() : current.scope;
  if (candidateScope && !hasOpenIdScope(candidateScope)) {
    return res.status(400).json({ error: "scope must include openid" });
  }
  if (!isValidOidcIssuerUrl(candidateIssuerUrl, candidateAllowInsecureHttp)) {
    return res.status(400).json({
      error: candidateAllowInsecureHttp
        ? "issuerUrl must be a valid http:// or https:// URL without credentials, query parameters, or a fragment."
        : "issuerUrl must be a valid https:// URL without credentials, query parameters, or a fragment.",
    });
  }
  if (candidateRedirectUri && !isValidOidcRedirectUri(candidateRedirectUri)) {
    return res.status(400).json({
      error: "redirectUri must be a valid http:// or https:// URL ending in /api/auth/oidc/callback, without credentials, query parameters, or a fragment.",
    });
  }

  const result = await testOidcDiscovery({
    issuerUrl: candidateIssuerUrl,
    clientId: candidateClientId,
    clientSecret,
    redirectUri: candidateRedirectUri,
    allowInsecureHttp: candidateAllowInsecureHttp,
  });

  res.json(result);
});

export default router;
