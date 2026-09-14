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
import { Router } from "express";
import rateLimit from "express-rate-limit";
import authService, { requireRole } from "../services/auth.js";
import { createLogger } from "../utils/logger.js";
import { sanitizeError, isMaskedSecret } from "../utils/sanitize.js";
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

// Mirrors routes/auth.js's own loginLimiter (5/min) — same reasoning
// applies here: both routes below do real work (a redirect build, a full
// token exchange + DB lookup) that's worth protecting from abuse, same as
// the local login route already is. Separate instances (not one shared
// limiter) so a legitimate user's normal login→callback round trip doesn't
// spend a single shared budget twice per attempt.
function makeOidcLimiter() {
  return rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many sign-in attempts. Please try again later." },
  });
}
const loginRateLimiter = makeOidcLimiter();
const callbackRateLimiter = makeOidcLimiter();

const FLOW_COOKIE_NAME = "oidcFlow";
const FLOW_COOKIE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes — enough for an IdP login + MFA, short enough to limit exposure.
const pendingIdentityLinks = new Map();

function prunePendingIdentityLinks(now = Date.now()) {
  for (const [state, entry] of pendingIdentityLinks) {
    if (entry.expiresAt <= now) pendingIdentityLinks.delete(state);
  }
}

function rememberPendingIdentityLink(state, entry) {
  pendingIdentityLinks.set(state, entry);
  const cleanup = setTimeout(() => {
    pendingIdentityLinks.delete(state);
  }, Math.max(0, entry.expiresAt - Date.now()));
  cleanup.unref?.();
}

// The state/nonce/PKCE cookie deliberately uses SameSite=Lax, not Strict:
// unlike the refresh-token cookie above (only ever sent by same-site XHR
// from the panel's own SPA), this one MUST be sent when the browser lands
// back on /api/auth/oidc/callback via a top-level cross-site GET redirect
// FROM the identity provider's domain — SameSite=Strict cookies are not
// sent on that navigation and the flow would break on every provider.
// Unsigned is fine: it carries no secret, only values the IdP is separately
// asked to echo back — any tampering just fails the state/nonce/PKCE
// comparison inside openid-client and the sign-in is refused, same as if
// the cookie were absent.
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
router.post("/link", loginRateLimiter, requireRole("admin"), async (req, res) => {
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
    const { authorizationUrl, state, nonce, codeVerifier } =
      await buildOidcAuthorizationRequest();
    prunePendingIdentityLinks();
    rememberPendingIdentityLink(state, {
      userId,
      initiatorUserId,
      expiresAt: Date.now() + FLOW_COOKIE_MAX_AGE_MS,
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
router.get("/callback", callbackRateLimiter, async (req, res) => {
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
  if (!flow) {
    log.warn("OIDC callback with no/invalid flow cookie (expired, or CSRF attempt)");
    return res.redirect("/?oidcError=expired_flow");
  }

  const currentUrl = new URL(settings.redirectUri);
  const queryIndex = req.url.indexOf("?");
  currentUrl.search = queryIndex === -1 ? "" : req.url.slice(queryIndex);

  let claims;
  try {
    claims = await handleOidcCallback(currentUrl, flow);
  } catch (error) {
    log.warn(`OIDC callback rejected: ${error.message}`);
    return res.redirect("/?oidcError=invalid_token");
  }

  const pendingLink = pendingIdentityLinks.get(flow.state);
  if (flow.flowType === "link" && !pendingLink) {
    return res.redirect("/settings?tab=users&oidcError=link_expired");
  }
  if (pendingLink) {
    pendingIdentityLinks.delete(flow.state);
    if (pendingLink.expiresAt <= Date.now()) {
      return res.redirect("/settings?tab=users&oidcError=link_expired");
    }
    try {
      await authService.linkExternalIdentity(pendingLink.userId, {
        issuer: claims.iss,
        subject: claims.sub,
        email: claims.email,
      }, {
        actingUserId: pendingLink.initiatorUserId,
      });
      log.info(`OIDC identity linked to local user ${pendingLink.userId}`);
      return res.redirect("/settings?tab=users&oidcSuccess=linked");
    } catch (error) {
      log.warn(`OIDC identity link failed: ${error.message}`);
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
    log.error(`OIDC session issuance failed: ${error.message}`);
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
      `OIDC identity not linked to any account (sub=${claims.sub}, canBootstrapAdmin=${result.canBootstrapAdmin})`,
    );
    return res.redirect(
      result.canBootstrapAdmin ? "/?oidcError=setup_required" : "/?oidcError=refused",
    );
  }

  res.cookie("refreshToken", result.refreshToken, getRefreshCookieOptions(req));
  log.info(`OIDC sign-in: ${result.user.username} (sub=${claims.sub})`);
  res.redirect("/");
});

// ---------------------------------------------------------------------------
// Settings (Settings screen) — gated on panel.settings, the capability that
// already owns every other panel-wide setting. Not a new capability.
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
  });
});

// PUT /api/auth/oidc/settings — partial update: only fields present in the
// body are touched, same shape as PUT /api/servers/:id.
router.put("/settings", requirePermission("panel.settings"), async (req, res) => {
  try {
    const body = req.body || {};
    const current = await getOidcSettings();
    const updates = {};
    const allowInsecureHttp = readOptionalBoolean(body, "allowInsecureHttp");
    if (!allowInsecureHttp.ok) {
      return res.status(400).json({ error: allowInsecureHttp.error });
    }

    if (body.issuerUrl !== undefined) {
      const value = String(body.issuerUrl).trim();
      if (value) {
        const allowHttp =
          allowInsecureHttp.value !== undefined
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
            error: "redirectUri must be a valid http:// or https:// URL without credentials, query parameters, or a fragment",
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
  const allowInsecureHttp = readOptionalBoolean(body, "allowInsecureHttp");
  if (!allowInsecureHttp.ok) {
    return res.status(400).json({ error: allowInsecureHttp.error });
  }

  const clientSecret =
    body.clientSecret !== undefined && !isMaskedSecret(body.clientSecret)
      ? String(body.clientSecret)
      : current.clientSecret;

  const candidateIssuerUrl =
    body.issuerUrl !== undefined ? String(body.issuerUrl).trim() : current.issuerUrl;
  const candidateRedirectUri =
    body.redirectUri !== undefined ? String(body.redirectUri).trim() : current.redirectUri;
  const candidateAllowInsecureHttp =
    allowInsecureHttp.value !== undefined
      ? allowInsecureHttp.value
      : current.allowInsecureHttp;
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
      error: "redirectUri must be a valid http:// or https:// URL without credentials, query parameters, or a fragment.",
    });
  }

  const result = await testOidcDiscovery({
    issuerUrl: candidateIssuerUrl,
    clientId:
      body.clientId !== undefined ? String(body.clientId).trim() : current.clientId,
    clientSecret,
    redirectUri: candidateRedirectUri,
    allowInsecureHttp: candidateAllowInsecureHttp,
  });

  res.json(result);
});

export default router;
