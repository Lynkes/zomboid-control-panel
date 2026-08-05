/**
 * Authentication Service
 * Handles user registration, login, JWT tokens, and session management.
 *
 * Design:
 * - bcryptjs for password hashing (pure JS, compatible with pkg)
 * - JWT access tokens (short-lived, 24h) + refresh tokens (long-lived, 30d)
 * - Auto-login via refresh token stored in httpOnly cookie
 * - First-run setup creates the admin account
 * - JWT secret is auto-generated per installation and stored in db.json
 */

import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { createLogger } from "../utils/logger.js";
import { getSetting, setSetting, getDb, commitNow } from "../database/init.js";

const log = createLogger("Auth");

const BCRYPT_ROUNDS = 12;
const ACCESS_TOKEN_EXPIRY = "24h";
const REFRESH_TOKEN_EXPIRY = "30d";
const REFRESH_TOKEN_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_REFRESH_SESSIONS = 5;
const MAX_FAILED_LOGINS = 10;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;
// Fixed dummy hash used to keep the "user not found" branch of login() at the
// same cost as the "user found, wrong password" branch (bcrypt.compare is the
// expensive step, ~200-300ms at BCRYPT_ROUNDS). Without this, an attacker can
// enumerate valid usernames by measuring response time. This hash matches no
// real password — it's just a fixed bcrypt digest to compare against.
const DUMMY_BCRYPT_HASH =
  "$2a$12$CwTycUXWue0Thq9StjUM0uJ8u2H8ekjqOGWjF/9JMlSlL5C.tZgqe";

class AuthService {
  constructor() {
    this.jwtSecret = null;
    this.initialized = false;
    // Serializes setup/createUser to prevent a race where two concurrent
    // /api/auth/setup requests both pass the needsSetup() check.
    this._writeMutex = Promise.resolve();
  }

  // Run a critical section serialized against other mutex holders.
  _withMutex(fn) {
    const run = this._writeMutex.then(fn, fn);
    this._writeMutex = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  ensureUserAuthState(user) {
    if (!Number.isInteger(user.tokenGen)) {
      user.tokenGen = 0;
    }

    if (!Array.isArray(user.refreshSessions)) {
      user.refreshSessions = [];
    }

    const now = Date.now();
    user.refreshSessions = user.refreshSessions
      .filter((session) => session && typeof session.id === "string")
      .filter((session) => {
        const expiresAt = Date.parse(session.expiresAt || "");
        return Number.isNaN(expiresAt) || expiresAt > now;
      })
      .slice(-MAX_REFRESH_SESSIONS);
  }

  createRefreshSession(user) {
    this.ensureUserAuthState(user);

    const timestamp = new Date().toISOString();
    const session = {
      id: crypto.randomUUID(),
      createdAt: timestamp,
      lastUsedAt: timestamp,
      expiresAt: new Date(Date.now() + REFRESH_TOKEN_LIFETIME_MS).toISOString(),
    };

    user.refreshSessions.push(session);
    if (user.refreshSessions.length > MAX_REFRESH_SESSIONS) {
      user.refreshSessions = user.refreshSessions.slice(-MAX_REFRESH_SESSIONS);
    }

    return session;
  }

  findRefreshSession(user, sessionId) {
    this.ensureUserAuthState(user);
    return (
      user.refreshSessions.find((session) => session.id === sessionId) || null
    );
  }

  revokeRefreshSession(user, sessionId) {
    this.ensureUserAuthState(user);
    const initialLength = user.refreshSessions.length;
    user.refreshSessions = user.refreshSessions.filter(
      (session) => session.id !== sessionId,
    );
    return user.refreshSessions.length !== initialLength;
  }

  async authenticateAccessToken(token) {
    try {
      const payload = jwt.verify(token, this.jwtSecret);
      if (payload.type === "refresh") {
        return null;
      }

      const db = await getDb();
      const users = db.data.users || [];
      const user = users.find((entry) => entry.id === payload.userId);
      if (!user) {
        return null;
      }

      this.ensureUserAuthState(user);
      const currentGen = user.tokenGen || 0;
      const tokenGen = payload.tokenGen ?? 0;
      if (tokenGen !== currentGen) {
        return null;
      }

      return {
        userId: user.id,
        username: user.username,
        role: user.role,
        tokenGen: currentGen,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Initialize the auth service — loads or generates JWT secret
   */
  async init() {
    try {
      // Load or generate JWT secret
      let secret = await getSetting("jwtSecret");
      if (!secret) {
        secret = crypto.randomBytes(64).toString("hex");
        await setSetting("jwtSecret", secret);
        log.info("Generated new JWT secret");
      }
      this.jwtSecret = secret;
      this.initialized = true;
      log.info("Auth service initialized");
    } catch (error) {
      log.error(`Failed to initialize auth service: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check if setup is needed (no users exist)
   */
  async needsSetup() {
    const db = await getDb();
    const users = db.data.users || [];
    return users.length === 0;
  }

  /**
   * Check if authentication is enabled
   */
  async isAuthEnabled() {
    const authEnabled = await getSetting("authEnabled");
    // Default to true once users exist
    if (authEnabled === undefined || authEnabled === null) {
      const needsSetup = await this.needsSetup();
      return !needsSetup; // Auth enabled only if users exist
    }
    return authEnabled !== false;
  }

  /**
   * Create a new user account (admin)
   */
  async createUser(username, password) {
    return this._withMutex(async () => {
      if (!username || !password) {
        throw new Error("Username and password are required");
      }

      if (username.length < 3 || username.length > 32) {
        throw new Error("Username must be 3-32 characters");
      }

      if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
        throw new Error(
          "Username can only contain letters, numbers, underscores and hyphens",
        );
      }

      if (password.length < 6) {
        throw new Error("Password must be at least 6 characters");
      }

      if (password.length > 128) {
        throw new Error("Password must be 128 characters or fewer");
      }

      const db = await getDb();
      if (!db.data.users) {
        db.data.users = [];
      }

      // Check for duplicate username
      const existing = db.data.users.find(
        (u) => u.username.toLowerCase() === username.toLowerCase(),
      );
      if (existing) {
        throw new Error("Username already exists");
      }

      const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);
      const user = {
        id: crypto.randomUUID(),
        username,
        password: hashedPassword,
        role: "admin",
        createdAt: new Date().toISOString(),
        lastLogin: null,
      };

      db.data.users.push(user);
      await commitNow();

      log.info(`User created: ${username}`);
      return { id: user.id, username: user.username, role: user.role };
    });
  }

  /**
   * Authenticate user and return tokens
   */
  async login(username, password, rememberMe = true) {
    if (!username || !password) {
      throw new Error("Username and password are required");
    }

    const db = await getDb();
    const users = db.data.users || [];
    const user = users.find(
      (u) => u.username.toLowerCase() === username.toLowerCase(),
    );

    if (!user) {
      // Run a bcrypt compare against a fixed dummy hash so this branch costs
      // about the same as the "wrong password" branch below — otherwise an
      // attacker can enumerate valid usernames by measuring response time
      // (missing user ~1ms vs. existing user ~200-300ms for bcrypt.compare).
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
      throw new Error("Invalid username or password");
    }

    // Account lockout: reject early if the account is currently locked.
    // Generic error message keeps username enumeration impossible. Also run
    // the dummy compare here so a locked account doesn't become a distinct,
    // faster timing signature from a normal wrong-password attempt.
    const lockedUntil = user.lockedUntil ? Date.parse(user.lockedUntil) : 0;
    if (lockedUntil && lockedUntil > Date.now()) {
      await bcrypt.compare(password, DUMMY_BCRYPT_HASH);
      throw new Error("Invalid username or password");
    }

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) {
      user.failedLoginCount = (user.failedLoginCount || 0) + 1;
      if (user.failedLoginCount >= MAX_FAILED_LOGINS) {
        user.lockedUntil = new Date(
          Date.now() + LOCKOUT_DURATION_MS,
        ).toISOString();
        user.failedLoginCount = 0;
        log.warn(
          `Account locked due to repeated failed logins: ${user.username}`,
        );
      }
      try {
        await commitNow();
      } catch (error) {
        // Losing this write silently would let brute-force lockout state vanish.
        log.error(
          `Failed to persist failed-login state for ${user.username}: ${error.message}`,
        );
      }
      throw new Error("Invalid username or password");
    }

    // Successful auth — clear lockout state.
    user.failedLoginCount = 0;
    user.lockedUntil = null;

    this.ensureUserAuthState(user);

    // Update last login
    user.lastLogin = new Date().toISOString();
    const refreshSession = rememberMe ? this.createRefreshSession(user) : null;
    await commitNow();

    // Generate tokens
    const accessToken = this.generateAccessToken(user);
    const refreshToken = refreshSession
      ? this.generateRefreshToken(user, refreshSession.id)
      : null;

    log.info(`User logged in: ${username}`);
    return {
      user: { id: user.id, username: user.username, role: user.role },
      accessToken,
      refreshToken,
    };
  }

  /**
   * Generate a short-lived access token
   */
  generateAccessToken(user) {
    return jwt.sign(
      {
        userId: user.id,
        username: user.username,
        role: user.role,
        tokenGen: user.tokenGen || 0,
      },
      this.jwtSecret,
      { expiresIn: ACCESS_TOKEN_EXPIRY },
    );
  }

  /**
   * Generate a long-lived refresh token (for auto-login / remember me)
   * Includes tokenGen counter so tokens can be invalidated by incrementing the counter.
   */
  generateRefreshToken(user, sessionId) {
    return jwt.sign(
      {
        userId: user.id,
        type: "refresh",
        tokenGen: user.tokenGen || 0,
        sessionId,
      },
      this.jwtSecret,
      { expiresIn: REFRESH_TOKEN_EXPIRY },
    );
  }

  /**
   * Verify an access token and return the payload
   */
  verifyAccessToken(token) {
    try {
      const payload = jwt.verify(token, this.jwtSecret);
      // Reject refresh tokens used as access tokens (token type confusion)
      if (payload.type === "refresh") return null;
      return payload;
    } catch (error) {
      return null;
    }
  }

  /**
   * Refresh the access token using a refresh token.
   * Also rotates the refresh token (issues a new one, old one becomes invalid on next gen bump).
   */
  async refreshAccessToken(refreshToken) {
    try {
      const payload = jwt.verify(refreshToken, this.jwtSecret);
      if (payload.type !== "refresh") {
        throw new Error("Invalid token type");
      }

      const db = await getDb();
      const users = db.data.users || [];
      const user = users.find((u) => u.id === payload.userId);

      if (!user) {
        throw new Error("User not found");
      }

      this.ensureUserAuthState(user);

      // Validate tokenGen — reject tokens from before a password change or logout-all
      const currentGen = user.tokenGen || 0;
      const tokenGen = payload.tokenGen ?? 0;
      if (tokenGen !== currentGen) {
        throw new Error("Refresh token has been revoked");
      }

      if (!payload.sessionId) {
        throw new Error("Refresh token session is missing");
      }

      if (!this.findRefreshSession(user, payload.sessionId)) {
        throw new Error("Refresh token session is no longer active");
      }

      this.revokeRefreshSession(user, payload.sessionId);
      const newSession = this.createRefreshSession(user);
      await commitNow();

      const accessToken = this.generateAccessToken(user);
      const newRefreshToken = this.generateRefreshToken(user, newSession.id);
      return {
        user: { id: user.id, username: user.username, role: user.role },
        accessToken,
        refreshToken: newRefreshToken,
      };
    } catch (error) {
      return null;
    }
  }

  /**
   * Change user password
   */
  async changePassword(userId, currentPassword, newPassword) {
    if (!newPassword || newPassword.length < 6) {
      throw new Error("New password must be at least 6 characters");
    }

    const db = await getDb();
    const users = db.data.users || [];
    const user = users.find((u) => u.id === userId);

    if (!user) {
      throw new Error("User not found");
    }

    const valid = await bcrypt.compare(currentPassword, user.password);
    if (!valid) {
      throw new Error("Current password is incorrect");
    }

    user.password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    // Bump tokenGen to invalidate all existing refresh tokens
    user.tokenGen = (user.tokenGen || 0) + 1;
    user.refreshSessions = [];
    await commitNow();

    log.info(`Password changed for user: ${user.username}`);
    return true;
  }

  /**
   * Get all users (without password hashes)
   */
  async getUsers() {
    const db = await getDb();
    const users = db.data.users || [];
    return users.map((u) => ({
      id: u.id,
      username: u.username,
      role: u.role,
      createdAt: u.createdAt,
      lastLogin: u.lastLogin,
    }));
  }

  async logout(refreshToken) {
    if (!refreshToken) {
      return false;
    }

    try {
      // Decode without verifying so we can still revoke an expired-but-known session.
      const payload = jwt.decode(refreshToken);
      if (
        !payload ||
        typeof payload !== "object" ||
        payload.type !== "refresh" ||
        !payload.sessionId
      ) {
        return false;
      }

      const db = await getDb();
      const users = db.data.users || [];
      const user = users.find((entry) => entry.id === payload.userId);
      if (!user) {
        return false;
      }

      const revoked = this.revokeRefreshSession(user, payload.sessionId);
      if (revoked) {
        await commitNow();
      }

      return revoked;
    } catch (error) {
      return false;
    }
  }

  /**
   * Reset password for the first admin user (no auth required).
   * Caller must verify the reset token before calling this.
   */
  async resetPassword(newPassword) {
    if (
      !newPassword ||
      typeof newPassword !== "string" ||
      newPassword.length < 6
    ) {
      throw new Error("Password must be at least 6 characters");
    }
    if (newPassword.length > 128) {
      throw new Error("Password must be 128 characters or fewer");
    }

    const db = await getDb();
    const users = db.data.users || [];
    if (users.length === 0) {
      throw new Error("No user accounts exist. Use setup instead.");
    }

    // Reset the first admin account
    const user = users.find((u) => u.role === "admin") || users[0];
    user.password = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    user.tokenGen = (user.tokenGen || 0) + 1;
    user.refreshSessions = [];
    await commitNow();

    log.info(`Password reset for user: ${user.username}`);
    return { username: user.username };
  }

  /**
   * Generate single-use recovery codes for the admin account.
   *
   * Only the hashes are stored, so a database copy cannot be turned back into
   * usable codes. The plaintext is returned once and never recoverable after.
   */
  async generateRecoveryCodes(count = 10) {
    const db = await getDb();
    const users = db.data.users || [];
    const user = users.find((u) => u.role === "admin") || users[0];
    if (!user) throw new Error("No user accounts exist. Use setup instead.");

    const codes = [];
    const hashes = [];
    for (let i = 0; i < count; i++) {
      const raw = crypto.randomBytes(15).toString("base64url").slice(0, 20).toUpperCase();
      const code = `${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}`;
      codes.push(code);
      hashes.push({
        hash: crypto.createHash("sha256").update(code, "utf8").digest("hex"),
        usedAt: null,
      });
    }

    await setSetting("authRecoveryCodes", JSON.stringify(hashes));
    await setSetting("authRecoveryCodesCreatedAt", new Date().toISOString());
    log.info(`Generated ${count} recovery codes for user: ${user.username}`);
    return { codes, createdAt: new Date().toISOString() };
  }

  async getRecoveryCodeStatus() {
    const stored = await getSetting("authRecoveryCodes");
    const createdAt = await getSetting("authRecoveryCodesCreatedAt");
    let entries = [];
    try {
      entries = stored ? JSON.parse(stored) : [];
    } catch {
      entries = [];
    }
    const remaining = entries.filter((entry) => !entry.usedAt).length;
    return { configured: entries.length > 0, remaining, total: entries.length, createdAt: createdAt || null };
  }

  /**
   * Consume a recovery code and set a new password. The code is burned whether
   * or not the caller knows the old password, so each one works exactly once.
   */
  async redeemRecoveryCode(code, newPassword) {
    if (typeof code !== "string" || !code.trim()) {
      throw new Error("A recovery code is required");
    }
    const stored = await getSetting("authRecoveryCodes");
    let entries = [];
    try {
      entries = stored ? JSON.parse(stored) : [];
    } catch {
      entries = [];
    }
    if (entries.length === 0) {
      throw new Error("No recovery codes have been generated for this panel.");
    }

    const candidate = crypto
      .createHash("sha256")
      .update(code.trim().toUpperCase(), "utf8")
      .digest();
    const match = entries.find((entry) => {
      if (entry.usedAt) return false;
      const storedDigest = Buffer.from(entry.hash, "hex");
      if (storedDigest.length !== candidate.length) return false;
      return crypto.timingSafeEqual(storedDigest, candidate);
    });
    if (!match) {
      throw new Error("That recovery code is not valid or has already been used.");
    }

    const result = await this.resetPassword(newPassword);
    match.usedAt = new Date().toISOString();
    await setSetting("authRecoveryCodes", JSON.stringify(entries));
    const remaining = entries.filter((entry) => !entry.usedAt).length;
    log.info(`Recovery code redeemed for ${result.username}; ${remaining} remaining`);
    return { ...result, remaining };
  }

  /**
   * Express middleware — verifies JWT and attaches user to req
   * Skips auth check if auth is disabled or setup is needed
   */
  middleware() {
    return async (req, res, next) => {
      try {
        // Only protect API routes — let static files and SPA page routes through
        if (!req.path.startsWith("/api")) {
          return next();
        }

        // Always allow auth routes (login, setup, status)
        if (req.path.startsWith("/api/auth/")) {
          return next();
        }

        // Allow health check
        if (req.path === "/api/health") {
          return next();
        }

        // Allow map tile proxy (loaded via <img> tags, can't send auth headers).
        // Both /tiles/ (B42 iso via map.projectzomboid.com) and /b41tiles/ (B41) and
        // /toptiles/ (B42 top-down for ChunkCleaner) must bypass — the proxy itself
        // only forwards to the hardcoded public domain, so there's no SSRF surface.
        if (
          req.path.startsWith("/api/map/tiles/") ||
          req.path.startsWith("/api/map/b41tiles/") ||
          req.path.startsWith("/api/map/toptiles/")
        ) {
          return next();
        }

        // Allow mod thumbnail proxy (also loaded via <img> tags). Only proxies
        // Steam Workshop preview URLs already stored in our DB — no arbitrary SSRF.
        if (req.path.startsWith("/api/mods/thumbnail/")) {
          return next();
        }

        // Skip auth if no users exist (setup needed)
        const needsSetup = await this.needsSetup();
        if (needsSetup) {
          return next();
        }

        // Skip auth if it's been explicitly disabled
        const authEnabled = await this.isAuthEnabled();
        if (!authEnabled) {
          return next();
        }

        // Extract token from Authorization header
        const authHeader = req.headers.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
          return res
            .status(401)
            .json({ error: "Authentication required", code: "AUTH_REQUIRED" });
        }

        const token = authHeader.substring(7);
        const payload = await this.authenticateAccessToken(token);

        if (!payload) {
          return res
            .status(401)
            .json({ error: "Invalid or expired token", code: "TOKEN_EXPIRED" });
        }

        // Attach user info to request
        req.user = payload;
        next();
      } catch (error) {
        log.error(`Auth middleware error: ${error.message}`);
        return res.status(500).json({ error: "Authentication error" });
      }
    };
  }
}

// Singleton instance
const authService = new AuthService();
export default authService;

/**
 * Express middleware factory — requires req.user.role to be one of the
 * given roles. Must run AFTER authService.middleware() so req.user is set.
 *
 * Currently every account is created with role 'admin' (see createUser()),
 * so this is a no-op today — but every route handler in this app grants
 * full power (RCON god-mode, file delete, server install/wipe, panel
 * self-update) with zero authorization check beyond "is logged in". Wiring
 * this in now on destructive/privileged routes makes that boundary explicit
 * ahead of a non-admin role ever being introduced, instead of every future
 * route inheriting full access by default.
 */
export function requireRole(...roles) {
  return (req, res, next) => {
    // No auth configured (setup pending / auth disabled) — middleware()
    // already let the request through without setting req.user in that
    // case, so there's nothing to check here.
    if (!req.user) return next();
    if (roles.includes(req.user.role)) return next();
    return res.status(403).json({ error: "Insufficient permissions" });
  };
}
