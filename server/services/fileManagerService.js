// Server Files: the policy layer between routes/files.js and the backends
// (spec §A2-§A10). Everything a backend doesn't decide lives here: name and
// path rules, protected areas, world-state and live-state gates, operations
// in progress, confirmations, limits, previews and jobs. Backends own
// containment and the atomic filesystem steps; this module never touches the
// filesystem itself.
import path from "path";
import crypto from "crypto";
import { Readable } from "stream";
import { ErrorCode } from "../utils/errorCodes.js";
import { getServer, getServers, getAllSettings, getSetting, setSetting, getFileAudit } from "../database/init.js";
import { createBackup, backupWarningFor } from "../utils/configBackup.js";
import { isLifecycleLockedForServer } from "./lifecycleCoordinator.js";
import { hasActiveSteamOperation } from "./activeSteamOperations.js";
import { installDirKey } from "./bridgeDisk.js";
import { resolveProvider } from "../utils/serverStatusModel.js";
import panelBridge from "./panelBridge.js";
import {
  FM_LIMITS,
  FmError,
  ROOT_IDS,
  TRASH_DIR_NAME,
  TRASH_ID_RE,
  UPLOAD_TEMP_SUFFIX,
  RENAME_TEMP_SUFFIX,
  validateName,
  validateSegments,
} from "./fileManagerContract.js";
import {
  backendForRoot,
  describeProfileRoots,
  folderOf,
  invalidateRootCache,
  isRemoteProfile,
  publicDescriptor,
  remoteKeyOf,
} from "./fileManagerRoots.js";
import {
  buildProtectionContext,
  buildRemoteProtectionContext,
  foldRel,
  isInsideAbs,
  relWithin,
  stricter,
} from "./fileManagerProtectedAreas.js";
import { getRunState, getSharedRunState } from "./fileManagerRunState.js";
import { ConfirmationSet, isExecutableName, parseConfirmField, parseConfirmHeader } from "./fileManagerConfirmations.js";
import {
  HASH_ETAG_RE,
  decodeForEdit,
  decodeTail,
  encodeForSave,
  hasMaskedSecretLines,
  hashEtag,
  isBinaryName,
  isIniName,
  isSecretBearingName,
  maskIniBuffer,
  maskIniText,
  reconcileIniText,
  sha256Hex,
} from "./fileManagerTextCodec.js";
import { isHeldByJob, startJob } from "./fileManagerJobs.js";
import { acquireZipSlot, planZip, streamZip, zipFileName } from "./fileManagerZip.js";
import { validateRemoteRootPath } from "./fileManagerRemoteRoots.js";
import { realpathNative } from "./fileManagerLocalFs.js";

const PROFILE_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const PREVIEW_ID_RE = /^[0-9a-f]{32}$/;
const PREVIEWS_MAX = 200;
const INI_DOWNLOAD_MAX_BYTES = 16 * 1024 * 1024;
const DUPLICATE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const MANAGED_CONFIG_SUFFIXES = [".ini", "_SandboxVars.lua", "_spawnpoints.lua", "_spawnregions.lua"];

// ============================================
// Small helpers
// ============================================

function invalidRequest(field) {
  return new FmError(ErrorCode.FM_INVALID_REQUEST, undefined, { field });
}

function joinRel(parent, name) {
  return parent ? `${parent}/${name}` : name;
}

function parentOf(rel) {
  const idx = rel.lastIndexOf("/");
  return idx === -1 ? "" : rel.slice(0, idx);
}

function requireString(value, field, { allowEmpty = true, max = FM_LIMITS.REL_PATH_MAX_CHARS } = {}) {
  if (typeof value !== "string" || (!allowEmpty && value === "") || value.length > max) throw invalidRequest(field);
  return value;
}

function parseSegments(raw, field = "path") {
  if (typeof raw !== "string") throw invalidRequest(field);
  const result = validateSegments(raw);
  if (!result.ok) throw new FmError(ErrorCode.FM_INVALID_PATH, undefined, { reason: result.reason });
  // Panel-owned names are reachable only through the Trash routes. A Trash
  // folder below the top is another root's (a Zomboid folder inside the game
  // folder): just as out of reach from here.
  if (result.segments.some(isPanelOwnedSegment)) {
    throw new FmError(ErrorCode.FM_INVALID_PATH, undefined, { reason: "reservedPanelName" });
  }
  return result.segments;
}

function isPanelOwnedSegment(segment) {
  const lower = segment.toLowerCase();
  return lower === TRASH_DIR_NAME || lower.endsWith(UPLOAD_TEMP_SUFFIX) || lower.endsWith(RENAME_TEMP_SUFFIX);
}

function checkName(name, { isNew = true } = {}) {
  const result = validateName(name, { isNew });
  if (!result.ok) throw new FmError(ErrorCode.FM_INVALID_NAME, undefined, { reason: result.reason });
  return result.name;
}

function reservedRealRel(realRel) {
  if (!realRel) return false;
  return realRel.split("/").some(isPanelOwnedSegment);
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function modeString(mode) {
  return Number.isInteger(mode) ? `0${mode.toString(8).padStart(3, "0")}` : null;
}

function userIdOf(user) {
  return user?.userId ?? null;
}

function trashMetaFor(user, reason) {
  return { deletedBy: { userId: user?.userId ?? null, username: user?.username ?? null }, reason };
}

// ============================================
// Profiles and roots
// ============================================

/**
 * The request's profile, read once (spec §A2 "derive once").
 * @returns {Promise<{ profile: object, settings: object, profiles: object[], app: object, policies: Map }>}
 */
export async function loadProfileContext(profileId, app) {
  if (typeof profileId !== "string" || !PROFILE_ID_RE.test(profileId)) throw invalidRequest("profileId");
  const profile = await getServer(profileId);
  if (!profile) throw new FmError(ErrorCode.FM_PROFILE_NOT_FOUND);
  const [settings, profiles] = await Promise.all([getAllSettings(), getServers()]);
  return { profile, settings: settings || {}, profiles: profiles || [], app, policies: new Map(), rootsInfo: null };
}

async function rootsInfoOf(ctx, { fresh = false } = {}) {
  if (!ctx.rootsInfo || fresh) {
    ctx.rootsInfo = await describeProfileRoots(ctx.profile, ctx.settings, { fresh });
  }
  return ctx.rootsInfo;
}

// Local profiles whose folder for this root is the same real folder (they
// share its Trash, its protected set and its live state).
function sharingProfiles(ctx, root) {
  if (root.kind === "sftp" || !root.key) return [ctx.profile];
  const out = [];
  for (const p of ctx.profiles) {
    if (isRemoteProfile(p)) continue;
    const keys =
      root.id === "data" || root.id === "config"
        ? [p.zomboidDataPath, p.serverConfigPath]
        : [folderOf(p.installPath), folderOf(p.serverPath)];
    if (keys.some((k) => k && installDirKey(k) === root.key)) out.push(p);
  }
  if (!out.some((p) => String(p.id) === String(ctx.profile.id))) out.unshift(ctx.profile);
  return out;
}

/** The root, its backend and its rules, once per request per root. */
async function policyFor(ctx, rootId) {
  if (typeof rootId !== "string" || !ROOT_IDS.includes(rootId)) {
    throw new FmError(ErrorCode.FM_ROOT_UNKNOWN, undefined, { root: String(rootId ?? "").replace(/[^A-Za-z]/g, "").slice(0, 20) });
  }
  if (ctx.policies.has(rootId)) return ctx.policies.get(rootId);
  const info = await rootsInfoOf(ctx);
  const root = info.roots.get(rootId);
  if (!root) throw new FmError(ErrorCode.FM_ROOT_UNKNOWN, undefined, { root: rootId });
  if (!root.available) {
    throw new FmError(ErrorCode.FM_ROOT_UNAVAILABLE, undefined, {
      reason: root.unavailableReason || "missing",
      ...(root.unavailableDetail ? { detail: root.unavailableDetail } : {}),
    });
  }
  const backend = backendForRoot(root);
  const sharing = sharingProfiles(ctx, root);
  const rules =
    root.kind === "sftp"
      ? buildRemoteProtectionContext({ rootId, rootReal: root.real, profile: ctx.profile, settings: ctx.settings })
      : buildProtectionContext({
          rootId,
          rootReal: root.real,
          profiles: ctx.profiles.filter((p) => !isRemoteProfile(p)),
          settings: ctx.settings,
          bridgePath: panelBridge?.bridgePath || null,
        });
  const policy = { rootId, root, backend, rules, sharing, rootKey: root.key || `${root.kind}:${root.real}` };
  ctx.policies.set(rootId, policy);
  return policy;
}

function classifyResolved(policy, r) {
  let result = policy.rules.classify(r.realRel, r.stat);
  // The path as navigated too: a link sitting inside a protected folder
  // doesn't become a way through it.
  if (r.rel !== r.realRel) result = stricter(result, policy.rules.classify(r.rel, null));
  return result;
}

// A path that doesn't exist: find its deepest folder that does, and refuse
// with FM_PATH_PROTECTED when that folder (by its real path) is sealed.
async function refuseInsideSealed(policy, segments) {
  for (let k = segments.length - 1; k >= 1; k--) {
    let ancestor;
    try {
      ancestor = await policy.backend.resolve(policy.root, segments.slice(0, k), "list");
    } catch (err) {
      if (err instanceof FmError && err.code === ErrorCode.FM_NOT_FOUND) continue;
      return;
    }
    const protection = classifyResolved(policy, ancestor);
    if (protection?.level === "sealed") throw protectedError(protection);
    return;
  }
}

/** validateSegments + backend.resolve + protection and world-state flags. */
async function resolveIn(ctx, rootId, rawPath, intent, field = "path") {
  const segments = parseSegments(rawPath, field);
  const policy = await policyFor(ctx, rootId);
  // Inside a sealed folder every path is refused the same way, whether it
  // exists or not, so the folder can't be probed.
  if (segments.length > 1) {
    const parent = policy.rules.classify(segments.slice(0, -1).join("/"), null);
    if (parent?.level === "sealed") throw protectedError(parent);
  }
  let r;
  try {
    r = await policy.backend.resolve(policy.root, segments, intent);
  } catch (err) {
    // The same, for a sealed folder reached through a name the lexical check
    // can't see (a link to it, a Windows 8.3 short name): a missing entry
    // answers like an existing one would.
    if (err instanceof FmError && err.code === ErrorCode.FM_NOT_FOUND && segments.length > 1) {
      await refuseInsideSealed(policy, segments);
    }
    throw err;
  }
  if (reservedRealRel(r.realRel)) {
    throw new FmError(ErrorCode.FM_INVALID_PATH, undefined, { reason: "reservedPanelName" });
  }
  r.protection = classifyResolved(policy, r);
  r.worldState = policy.rules.isWorldState(r.realRel);
  return { r, policy, segments };
}

function entryProtection(policy, raw) {
  let result = policy.rules.classify(raw.locRel ?? raw.realRel ?? raw.rel, raw.type === "link" ? null : raw);
  if (raw.realRel && raw.realRel !== raw.locRel) {
    result = stricter(
      result,
      policy.rules.classify(raw.realRel, raw.targetDev !== undefined ? { dev: raw.targetDev, ino: raw.targetIno, type: "file" } : null),
    );
  }
  if (raw.rel && raw.rel !== raw.locRel) result = stricter(result, policy.rules.classify(raw.rel, null));
  return result;
}

/** A RawEntry as the client sees it (spec §A10.1 FileEntry). */
function toFileEntry(policy, raw) {
  const protection = entryProtection(policy, raw);
  const sealed = protection?.level === "sealed";
  const unsupportedName = raw.name !== "" && !validateName(raw.name).ok;
  const binaryHint = isBinaryName(raw.name);
  const editable =
    raw.type === "file" &&
    !binaryHint &&
    !protection &&
    !unsupportedName &&
    policy.root.writable !== false &&
    (raw.size ?? 0) <= FM_LIMITS.TEXT_EDIT_MAX_BYTES;
  return {
    name: raw.name,
    path: raw.rel,
    type: raw.type,
    ...(raw.link ? { link: { inside: Boolean(raw.link.inside), targetType: raw.link.targetType } } : {}),
    size: sealed ? null : raw.size ?? null,
    modifiedAt: sealed ? null : iso(raw.mtimeMs),
    mode: sealed ? null : modeString(raw.mode),
    etag: sealed ? null : raw.etag ?? null,
    protection: protection ? { level: protection.level, area: protection.area } : null,
    flags: {
      editable,
      binaryHint,
      secretBearing: isSecretBearingName(raw.name),
      executable: isExecutableName(raw.name),
      worldState: raw.realRel ? policy.rules.isWorldState(raw.realRel) : false,
      unsupportedName,
    },
  };
}

async function entryOf(policy, r) {
  return toFileEntry(policy, await policy.backend.stat(r));
}

// ============================================
// Gates
// ============================================

function assertRootWritable(policy) {
  if (policy.root.writable === false) {
    throw new FmError(ErrorCode.FM_ROOT_READ_ONLY, undefined, { reason: policy.root.readOnlyReason || "permissions" });
  }
}

function assertNotRoot(r) {
  if (r.rel === "" || r.realRel === "") throw new FmError(ErrorCode.FM_ROOT_IMMUTABLE);
}

function protectedError(protection) {
  return new FmError(ErrorCode.FM_PATH_PROTECTED, undefined, {
    area: protection.area,
    level: protection.level,
    ...(protection.containsProtected ? { containsProtected: true } : {}),
  });
}

function assertUnprotected(r) {
  if (r.protection) throw protectedError(r.protection);
}

function assertReadable(r) {
  if (r.protection && (r.protection.level === "sealed" || r.protection.level === "listOnly")) {
    throw protectedError(r.protection);
  }
}

// The ancestor rule: a folder holding something protected can't be renamed,
// moved or deleted as a whole.
function assertHoldsNothingProtected(policy, r) {
  if (r.linkSelf || r.stat?.type !== "dir") return;
  const inner = policy.rules.protectedWithin(r.realRel) || (r.rel !== r.realRel ? policy.rules.protectedWithin(r.rel) : null);
  if (inner) throw protectedError(inner);
}

// A name the request is about to create (mkdir, upload, rename's new name,
// a move's destination, a restore) must not land in or become a protected
// path, such as PanelBridge.lua in any case.
function assertNewPathAllowed(policy, parentRealRel, parentRel, name) {
  let protection = policy.rules.classify(joinRel(parentRealRel, name), null);
  if (parentRel !== parentRealRel) protection = stricter(protection, policy.rules.classify(joinRel(parentRel, name), null));
  if (protection) throw protectedError(protection);
}

function assertNoOperationInProgress(policy, realRels) {
  if (policy.sharing.some((p) => isLifecycleLockedForServer(p.id))) {
    throw new FmError(ErrorCode.FM_OPERATION_IN_PROGRESS, undefined, { operation: "lifecycle" });
  }
  if (policy.rootId === "install" && policy.root.kind !== "sftp") {
    for (const p of policy.sharing) {
      for (const candidate of [p.installPath, folderOf(p.installPath)]) {
        if (candidate && hasActiveSteamOperation(path.normalize(candidate).toLowerCase())) {
          throw new FmError(ErrorCode.FM_OPERATION_IN_PROGRESS, undefined, { operation: "steam" });
        }
      }
    }
  }
  for (const realRel of realRels) {
    if (isHeldByJob(policy.rootKey, foldRel(realRel))) {
      throw new FmError(ErrorCode.FM_OPERATION_IN_PROGRESS, undefined, { operation: "fileJob" });
    }
  }
}

async function stateOf(ctx, profile, { fresh = false } = {}) {
  if (isRemoteProfile(profile)) return "unknown";
  return getRunState(profile, ctx.app, { fresh });
}

/** The live state that governs a root (spec §A5.5). */
async function rootState(ctx, policy, opts) {
  if (policy.root.kind === "sftp") return "unknown";
  if (policy.rootId === "install" || policy.rootId === "launch") {
    return getSharedRunState(policy.sharing, ctx.app, opts);
  }
  return stateOf(ctx, ctx.profile, opts);
}

// World saves: blocked while their server runs, a confirmation while its
// state is unknown (spec §A5.3).
async function worldStateGate(ctx, policy, realRels, confirmations) {
  const owners = new Set();
  for (const realRel of realRels) {
    for (const owner of policy.rules.worldStateOwners(realRel)) owners.add(owner);
  }
  for (const owner of owners) {
    const state = policy.root.kind === "sftp" ? "unknown" : await stateOf(ctx, owner);
    if (state === "running") throw new FmError(ErrorCode.FM_SERVER_RUNNING_BLOCKED);
    if (state === "unknown") confirmations.requireServerRunning("unknown");
  }
}

// Game install and launch folders: a confirmation while their server runs
// or might (spec §A8).
async function rootStateGate(ctx, policy, confirmations) {
  if (policy.rootId !== "install" && policy.rootId !== "launch") return;
  const state = await rootState(ctx, policy);
  if (state === "running" || state === "unknown") confirmations.requireServerRunning(state);
}

/** Every mutation gate except confirmations, in the spec's order. */
async function mutationGates(ctx, policy, realRels, confirmations) {
  assertRootWritable(policy);
  assertNoOperationInProgress(policy, realRels);
  await worldStateGate(ctx, policy, realRels, confirmations);
  await rootStateGate(ctx, policy, confirmations);
}

// ============================================
// Transfer slots (uploads and downloads)
// ============================================

let transfersGlobal = 0;
/** @type {Map<string, number>} */
const transfersPerUser = new Map();

function acquireTransferSlot(userId) {
  const key = String(userId ?? "-");
  const mine = transfersPerUser.get(key) || 0;
  if (transfersGlobal >= FM_LIMITS.UPLOAD_SLOTS_GLOBAL || mine >= FM_LIMITS.UPLOAD_SLOTS_PER_USER) {
    throw new FmError(ErrorCode.FM_TOO_MANY_TRANSFERS);
  }
  transfersGlobal++;
  transfersPerUser.set(key, mine + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    transfersGlobal--;
    const left = (transfersPerUser.get(key) || 1) - 1;
    if (left <= 0) transfersPerUser.delete(key);
    else transfersPerUser.set(key, left);
  };
}

export function _resetTransferSlotsForTests() {
  transfersGlobal = 0;
  transfersPerUser.clear();
}

// A download whose client stops reading holds its transfer slot; the route
// cuts it off after this long without progress (an upload's idle limit).
let downloadIdleMs = FM_LIMITS.UPLOAD_IDLE_MS;

export function _setDownloadIdleMsForTests(ms) {
  downloadIdleMs = Number.isFinite(ms) && ms > 0 ? ms : FM_LIMITS.UPLOAD_IDLE_MS;
}

async function assertFreeSpace(policy, bytes) {
  if (policy.root.kind === "sftp") return;
  const { free } = await policy.backend.freeSpace(policy.root);
  if (free === null || free === undefined) return;
  const required = bytes + FM_LIMITS.DISK_FREE_FLOOR_BYTES;
  if (free < required) throw new FmError(ErrorCode.FM_INSUFFICIENT_SPACE, undefined, { free, required });
}

// ============================================
// Profiles
// ============================================

function profileFiles(profile, info, extra = {}) {
  const roots = ROOT_IDS.filter((id) => info.roots.has(id)).map((id) => publicDescriptor(info.roots.get(id)));
  const out = {
    id: String(profile.id),
    name: profile.name || profile.serverName || "",
    serverName: profile.serverName || "",
    isActive: Boolean(profile.isActive),
    provider: resolveProvider(profile),
    remote: info.remote
      ? { host: String(info.remote.host), port: Number(info.remote.port), username: String(info.remote.username || "") }
      : null,
    roots,
    bookmarks: info.bookmarks || [],
    ...(info.remoteRoots ? { remoteRoots: info.remoteRoots } : {}),
    ...extra,
  };
  return out;
}

export async function listProfiles() {
  const [profiles, settings] = await Promise.all([getServers(), getAllSettings()]);
  const out = [];
  for (const profile of profiles || []) {
    const info = await describeProfileRoots(profile, settings || {});
    out.push(profileFiles(profile, info));
  }
  return { profiles: out };
}

export async function getProfile(ctx, { fresh = false } = {}) {
  const info = await rootsInfoOf(ctx, { fresh });
  const serverState = await stateOf(ctx, ctx.profile, { fresh });
  return {
    profile: profileFiles(ctx.profile, info, { serverState, serverStateCheckedAt: new Date().toISOString() }),
  };
}

// ============================================
// Reading: list, stat, search, text
// ============================================

function parseIntParam(value, field, { min, max, fallback }) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d{1,9}$/.test(value)) throw invalidRequest(field);
  const n = Number(value);
  if (n < min || n > max) throw invalidRequest(field);
  return n;
}

function parseEnum(value, field, allowed, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !allowed.includes(value)) throw invalidRequest(field);
  return value;
}

export async function listDir(ctx, query) {
  const offset = parseIntParam(query.offset, "offset", { min: 0, max: FM_LIMITS.LIST_DIR_MAX_ENTRIES, fallback: 0 });
  const limit = parseIntParam(query.limit, "limit", { min: 1, max: FM_LIMITS.LIST_PAGE_MAX, fallback: FM_LIMITS.LIST_PAGE_DEFAULT });
  const sort = parseEnum(query.sort, "sort", ["name", "size", "modified"], "name");
  const order = parseEnum(query.order, "order", ["asc", "desc"], "asc");
  const { r, policy } = await resolveIn(ctx, query.root, query.path ?? "", "list");
  if (r.stat?.type !== "dir") throw new FmError(ErrorCode.FM_NOT_A_DIRECTORY);
  if (r.protection?.level === "sealed") throw protectedError(r.protection);
  const listed = await policy.backend.list(r, { offset, limit, sort, order });
  return {
    dir: await entryOf(policy, r),
    entries: listed.entries.map((raw) => toFileEntry(policy, raw)),
    total: listed.total,
    offset,
    limit,
    sortLimited: Boolean(listed.sortLimited),
    truncated: Boolean(listed.truncated),
    dirEtag: listed.dirEtag,
  };
}

export async function statPath(ctx, query) {
  const { r, policy } = await resolveIn(ctx, query.root, query.path ?? "", "list");
  // A sealed entry is visible only as the locked row its (unsealed) folder
  // lists; anything deeper can't be probed for existence.
  if (r.protection?.level === "sealed" && r.realRel) {
    const parent = policy.rules.classify(parentOf(r.realRel), null);
    if (parent?.level === "sealed") throw protectedError(r.protection);
  }
  return { entry: await entryOf(policy, r) };
}

export async function search(ctx, query) {
  const q = requireString(query.q, "q", { allowEmpty: false, max: 100 });
  if (q.length < 2) throw invalidRequest("q");
  const needle = q.normalize("NFC").toLowerCase();
  const { r, policy } = await resolveIn(ctx, query.root, query.path ?? "", "list");
  if (r.stat?.type !== "dir") throw new FmError(ErrorCode.FM_NOT_A_DIRECTORY);
  if (r.protection?.level === "sealed") throw protectedError(r.protection);
  const started = Date.now();
  const results = [];
  let scanned = 0;
  let truncated = false;
  const sealedAt = (entry) => policy.rules.classify(entry.realRel, entry)?.level === "sealed";
  for await (const entry of policy.backend.walk(r, {
    maxEntries: FM_LIMITS.SEARCH_MAX_VISITED + 1,
    maxDepth: FM_LIMITS.SEARCH_MAX_DEPTH,
    maxMs: FM_LIMITS.SEARCH_MAX_MS,
    prune: (entry) => sealedAt(entry),
  })) {
    scanned++;
    if (scanned > FM_LIMITS.SEARCH_MAX_VISITED || Date.now() - started > FM_LIMITS.SEARCH_MAX_MS) {
      truncated = true;
      break;
    }
    if (entry.type === "link" || sealedAt(entry)) continue;
    // Plain substring on normalized names: never a RegExp built from input.
    if (!entry.name.normalize("NFC").toLowerCase().includes(needle)) continue;
    results.push(
      toFileEntry(policy, {
        name: entry.name,
        rel: entry.rel,
        locRel: entry.realRel,
        realRel: entry.realRel,
        type: entry.type,
        size: entry.type === "file" ? entry.size : null,
        mtimeMs: entry.mtimeMs,
        mode: null,
        dev: entry.dev,
        ino: entry.ino,
        etag: null,
      }),
    );
    if (results.length >= FM_LIMITS.SEARCH_MAX_RESULTS) {
      truncated = true;
      break;
    }
  }
  if (Date.now() - started > FM_LIMITS.SEARCH_MAX_MS) truncated = true;
  return { results, truncated, scanned: Math.min(scanned, FM_LIMITS.SEARCH_MAX_VISITED) };
}

function isProfileIni(ctx, policy, r) {
  const name = ctx.profile.serverName;
  if (!name || !r.realRel) return false;
  const want = policy.rootId === "config" ? `${name}.ini` : `Server/${name}.ini`;
  if (foldRel(r.realRel) === foldRel(want)) return true;
  if (policy.root.kind === "sftp") return false;
  // Local: compare against the profile's own config folder, wherever it is.
  const configDir = ctx.profile.serverConfigPath || (ctx.profile.zomboidDataPath ? path.join(ctx.profile.zomboidDataPath, "Server") : null);
  if (!configDir) return false;
  try {
    const real = realpathNative(configDir);
    return isInsideAbs(path.join(real, `${name}.ini`), r.abs) && isInsideAbs(r.abs, path.join(real, `${name}.ini`));
  } catch {
    return false;
  }
}

// One of the four files the Server Configuration page manages (and backs up).
function managedConfigFile(ctx, policy, r) {
  if (policy.root.kind === "sftp") return null;
  const name = ctx.profile.serverName;
  const configDir = ctx.profile.serverConfigPath || (ctx.profile.zomboidDataPath ? path.join(ctx.profile.zomboidDataPath, "Server") : null);
  if (!name || !configDir) return null;
  let real;
  try {
    real = realpathNative(configDir);
  } catch {
    return null;
  }
  if (!isInsideAbs(real, path.dirname(r.abs)) || !isInsideAbs(path.dirname(r.abs), real)) return null;
  const base = path.basename(r.abs);
  for (const suffix of MANAGED_CONFIG_SUFFIXES) {
    const canonical = `${name}${suffix}`;
    if (base === canonical || (process.platform === "win32" && base.toLowerCase() === canonical.toLowerCase())) {
      return { dir: configDir, file: canonical };
    }
  }
  return null;
}

async function stateForPath(ctx, policy, r) {
  if (policy.root.kind === "sftp") return "unknown";
  const owners = policy.rules.worldStateOwners(r.realRel);
  if (owners.length && r.realRel) return getSharedRunState(owners, ctx.app);
  return rootState(ctx, policy);
}

function hintsFor(ctx, policy, r, state, masked) {
  const hints = [];
  if (state !== "stopped") hints.push("restartToApply");
  const profileIni = isIniName(r.realRel) && isProfileIni(ctx, policy, r);
  if (profileIni) hints.push("panelRewritesKeys");
  if (policy.rootId === "install" && /^media\/lua\/.+\.lua$/i.test(r.realRel)) hints.push("luaChecksum");
  if (policy.rootId === "install") hints.push("steamUpdateOverwrites");
  if (profileIni && ctx.profile.bridgeDelivery === "workshop") hints.push("bridgeWorkshopEntries");
  if (masked) hints.push("secretsMasked");
  return hints;
}

export async function readText(ctx, query) {
  const mode = parseEnum(query.mode, "mode", ["edit", "tail"], "edit");
  const tailBytes = parseIntParam(query.tailBytes, "tailBytes", {
    min: 1,
    max: FM_LIMITS.TEXT_TAIL_MAX,
    fallback: FM_LIMITS.TEXT_TAIL_DEFAULT,
  });
  const { r, policy } = await resolveIn(ctx, query.root, query.path ?? "", "read");
  if (r.stat?.type !== "file") throw new FmError(ErrorCode.FM_NOT_A_FILE);
  assertReadable(r);
  if (isBinaryName(r.name) || isBinaryName(r.realRel)) throw new FmError(ErrorCode.FM_BINARY_FILE);
  const ini = isSecretBearingName(r.name) || isSecretBearingName(r.realRel);

  let content;
  let etag;
  let bom = false;
  let eol;
  let masked = false;
  let truncated = false;
  if (mode === "edit") {
    if (r.stat.size > FM_LIMITS.TEXT_EDIT_MAX_BYTES) {
      throw new FmError(ErrorCode.FM_FILE_TOO_LARGE_FOR_EDITOR, undefined, { limit: FM_LIMITS.TEXT_EDIT_MAX_BYTES });
    }
    const read = await policy.backend.readBytes(r, { maxBytes: FM_LIMITS.TEXT_EDIT_MAX_BYTES });
    if (read.truncated) {
      throw new FmError(ErrorCode.FM_FILE_TOO_LARGE_FOR_EDITOR, undefined, { limit: FM_LIMITS.TEXT_EDIT_MAX_BYTES });
    }
    const decoded = decodeForEdit(read.buffer);
    content = decoded.text;
    bom = decoded.bom;
    eol = decoded.eol;
    etag = hashEtag(read.buffer);
  } else {
    const read = await policy.backend.readBytes(r, { maxBytes: tailBytes, tail: true });
    const decoded = decodeTail(read.buffer, read.truncated);
    content = decoded.text;
    eol = decoded.eol;
    truncated = read.truncated;
    etag = (await policy.backend.stat(r)).etag;
  }
  if (ini) {
    const result = maskIniText(content);
    content = result.text;
    masked = result.masked;
  }
  const state = await stateForPath(ctx, policy, r);
  let readOnlyReason = null;
  if (mode === "tail") readOnlyReason = "tail";
  else if (r.protection) readOnlyReason = "protected";
  else if (policy.root.writable === false) readOnlyReason = "rootReadOnly";
  return {
    entry: await entryOf(policy, r),
    content,
    etag,
    bom,
    eol,
    masked,
    truncated,
    readOnly: readOnlyReason !== null,
    readOnlyReason,
    hints: hintsFor(ctx, policy, r, state, masked),
    serverState: state,
  };
}

// ============================================
// Writing: text, mkdir, rename, move, copy
// ============================================

export async function saveText(ctx, body, user, audit) {
  const content = requireString(body?.content, "content", { max: FM_LIMITS.TEXT_EDIT_MAX_BYTES * 3 });
  const eol = parseEnum(body?.eol, "eol", ["lf", "crlf"], undefined);
  if (eol === undefined) throw invalidRequest("eol");
  if (typeof body?.bom !== "boolean") throw invalidRequest("bom");
  const etag = body?.etag;
  if (etag !== null && (typeof etag !== "string" || !HASH_ETAG_RE.test(etag))) throw invalidRequest("etag");
  const confirm = parseConfirmField(body?.confirm);
  audit.rootId = body?.root;
  audit.paths = [typeof body?.path === "string" ? body.path : ""];
  audit.confirm = confirm;
  audit.op = etag === null ? "files.create" : "files.write";

  const { r, policy, segments } = await resolveIn(ctx, body?.root, body?.path, etag === null ? "create" : "write");
  audit.backend = policy.root.backend;
  if (segments.length === 0) throw new FmError(ErrorCode.FM_NOT_A_FILE);
  if (etag === null) {
    if (!r.isNew) throw new FmError(ErrorCode.FM_EXISTS, undefined, { name: r.name });
    checkName(r.name, { isNew: true });
    assertNewPathAllowed(policy, parentOf(r.realRel), parentOf(r.rel), r.name);
  } else {
    if (r.isNew) throw new FmError(ErrorCode.FM_NOT_FOUND);
    if (r.stat?.type !== "file") throw new FmError(ErrorCode.FM_NOT_A_FILE);
    assertUnprotected(r);
  }
  if (isBinaryName(r.name)) throw new FmError(ErrorCode.FM_BINARY_FILE);

  const confirmations = new ConfirmationSet();
  await mutationGates(ctx, policy, [r.realRel], confirmations);
  if (isExecutableName(r.name)) confirmations.requireExecutable(r.name);
  confirmations.assertConfirmed(confirm);

  let text = content.replace(/\r\n/g, "\n");
  if ((isSecretBearingName(r.name) || isSecretBearingName(r.realRel)) && !r.isNew) {
    const live = await policy.backend.readBytes(r, { maxBytes: FM_LIMITS.TEXT_EDIT_MAX_BYTES });
    const liveText = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(live.buffer);
    text = reconcileIniText(text, liveText.replace(/^\uFEFF/, ""));
  }
  const bytes = encodeForSave(text, { eol, bom: body.bom });

  let backupWarning = null;
  const managed = !r.isNew ? managedConfigFile(ctx, policy, r) : null;
  if (managed) {
    backupWarning = backupWarningFor(await createBackup(managed.dir, managed.file));
  }

  const result = await policy.backend.writeBytesCas(r, bytes, {
    expectedHash: etag,
    trashMeta: trashMetaFor(user, "edited"),
  });
  invalidateRootCache();
  audit.bytes = bytes.length;
  audit.sha256Before = result.sha256Before ?? null;
  audit.sha256After = sha256Hex(bytes);
  if (result.previousTrashId) audit.trashIds = [result.previousTrashId];
  const state = await stateForPath(ctx, policy, r);
  return {
    status: etag === null ? 201 : 200,
    body: {
      entry: toFileEntry(policy, result.entry),
      etag: hashEtag(bytes),
      previousVersion: result.previousTrashId ? { trashId: result.previousTrashId } : null,
      restartRequired: state !== "stopped",
      hints: hintsFor(ctx, policy, r, state, false),
      ...(backupWarning ? { backupWarning } : {}),
    },
  };
}

export async function makeDirectory(ctx, body, user, audit) {
  const name = requireString(body?.name, "name", { allowEmpty: true, max: FM_LIMITS.REL_PATH_MAX_CHARS });
  const confirm = parseConfirmField(body?.confirm);
  audit.rootId = body?.root;
  audit.paths = [joinRel(typeof body?.path === "string" ? body.path : "", String(name))];
  audit.confirm = confirm;
  checkName(name, { isNew: true });
  const { r: parent, policy } = await resolveIn(ctx, body?.root, body?.path ?? "", "list");
  audit.backend = policy.root.backend;
  if (parent.stat?.type !== "dir") throw new FmError(ErrorCode.FM_NOT_A_DIRECTORY);
  assertUnprotected(parent);
  assertNewPathAllowed(policy, parent.realRel, parent.rel, name);
  const confirmations = new ConfirmationSet();
  await mutationGates(ctx, policy, [joinRel(parent.realRel, name)], confirmations);
  confirmations.assertConfirmed(confirm);
  const raw = await policy.backend.mkdir(parent, name);
  invalidateRootCache();
  return { entry: toFileEntry(policy, raw) };
}

export async function renameEntry(ctx, body, user, audit) {
  const newName = requireString(body?.newName, "newName");
  const confirm = parseConfirmField(body?.confirm);
  audit.rootId = body?.root;
  audit.paths = [typeof body?.path === "string" ? body.path : ""];
  audit.confirm = confirm;
  const { r, policy } = await resolveIn(ctx, body?.root, body?.path, "rename");
  audit.backend = policy.root.backend;
  assertNotRoot(r);
  checkName(newName, { isNew: true });
  audit.dest = joinRel(parentOf(r.rel), newName);
  assertUnprotected(r);
  assertHoldsNothingProtected(policy, r);
  const currentName = path.posix.basename(r.realRel);
  if (newName === currentName) throw new FmError(ErrorCode.FM_EXISTS, undefined, { name: newName });
  assertNewPathAllowed(policy, parentOf(r.realRel), parentOf(r.rel), newName);
  const confirmations = new ConfirmationSet();
  await mutationGates(ctx, policy, [r.realRel, joinRel(parentOf(r.realRel), newName)], confirmations);
  if (isExecutableName(newName)) confirmations.requireExecutable(newName);
  confirmations.assertConfirmed(confirm);
  const raw = await policy.backend.rename(r, newName);
  invalidateRootCache();
  return { entry: toFileEntry(policy, raw) };
}

export async function moveEntries(ctx, body, user, audit) {
  const paths = body?.paths;
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > FM_LIMITS.PATHS_PER_REQUEST) throw invalidRequest("paths");
  if (paths.some((p) => typeof p !== "string")) throw invalidRequest("paths");
  const confirm = parseConfirmField(body?.confirm);
  audit.rootId = body?.root;
  audit.paths = paths;
  audit.dest = typeof body?.destDir === "string" ? body.destDir : null;
  audit.confirm = confirm;

  const { r: dest, policy } = await resolveIn(ctx, body?.root, body?.destDir ?? "", "list", "destDir");
  audit.backend = policy.root.backend;
  if (dest.stat?.type !== "dir") throw new FmError(ErrorCode.FM_NOT_A_DIRECTORY);
  assertUnprotected(dest);

  const planned = [];
  const failed = [];
  const confirmations = new ConfirmationSet();
  assertRootWritable(policy);
  for (const p of paths) {
    try {
      const { r } = await resolveIn(ctx, body.root, p, "move");
      assertNotRoot(r);
      assertUnprotected(r);
      assertHoldsNothingProtected(policy, r);
      if (r.stat?.type === "dir" && !r.linkSelf && relWithin(foldRel(r.realRel), foldRel(dest.realRel))) {
        throw new FmError(ErrorCode.FM_MOVE_INTO_SELF);
      }
      const name = path.posix.basename(r.realRel);
      assertNewPathAllowed(policy, dest.realRel, dest.rel, name);
      assertNoOperationInProgress(policy, [r.realRel, joinRel(dest.realRel, name)]);
      await worldStateGate(ctx, policy, [r.realRel, joinRel(dest.realRel, name)], confirmations);
      if (isExecutableName(name)) confirmations.requireExecutable(name);
      planned.push({ r, name });
    } catch (err) {
      if (!(err instanceof FmError)) throw err;
      failed.push({ path: p, code: err.code, ...(Object.keys(err.params || {}).length ? { params: err.params } : {}) });
    }
  }
  await rootStateGate(ctx, policy, confirmations);
  if (planned.length) confirmations.assertConfirmed(confirm);

  const moved = [];
  for (const { r, name } of planned) {
    try {
      await policy.backend.move(r, dest);
      moved.push({ from: r.rel, to: joinRel(dest.rel, name) });
    } catch (err) {
      if (!(err instanceof FmError)) throw err;
      failed.push({ path: r.rel, code: err.code, ...(Object.keys(err.params || {}).length ? { params: err.params } : {}) });
    }
  }
  if (moved.length) invalidateRootCache();
  audit.result = failed.length && moved.length ? "partial" : failed.length ? "failed" : "ok";
  if (failed.length && !moved.length) audit.code = failed[0].code;
  return { moved, failed };
}

function defaultCopyName(name) {
  const ext = path.extname(name);
  const base = ext && ext !== name ? name.slice(0, -ext.length) : name;
  return `${base} (copy)${ext && ext !== name ? ext : ""}`;
}

export async function copyEntry(ctx, body, user, audit) {
  const confirm = parseConfirmField(body?.confirm);
  audit.rootId = body?.root;
  audit.paths = [typeof body?.path === "string" ? body.path : ""];
  audit.confirm = confirm;
  const { r: src, policy } = await resolveIn(ctx, body?.root, body?.path, "read");
  audit.backend = policy.root.backend;
  if (src.stat?.type !== "file") throw new FmError(ErrorCode.FM_NOT_A_FILE);
  assertReadable(src);
  if (src.stat.size > DUPLICATE_MAX_BYTES) {
    throw new FmError(ErrorCode.FM_UPLOAD_TOO_LARGE, undefined, { limit: DUPLICATE_MAX_BYTES });
  }
  const { r: dest } = await resolveIn(ctx, body.root, body?.destDir ?? parentOf(src.rel), "list", "destDir");
  if (dest.stat?.type !== "dir") throw new FmError(ErrorCode.FM_NOT_A_DIRECTORY);
  assertUnprotected(dest);
  const newName = body?.newName === undefined || body?.newName === null ? defaultCopyName(path.posix.basename(src.realRel)) : body.newName;
  requireString(newName, "newName");
  checkName(newName, { isNew: true });
  audit.dest = joinRel(dest.rel, newName);
  assertNewPathAllowed(policy, dest.realRel, dest.rel, newName);
  const { r: target } = await resolveIn(ctx, body.root, joinRel(dest.rel, newName), "create", "destDir");
  let overwriteEtag = null;
  const confirmations = new ConfirmationSet();
  if (!target.isNew) {
    if (target.stat?.type !== "file" || target.linkSelf) throw new FmError(ErrorCode.FM_EXISTS, undefined, { name: newName });
    assertUnprotected(target);
    overwriteEtag = (await policy.backend.stat(target)).etag;
    confirmations.requireOverwrite(newName);
  }
  await mutationGates(ctx, policy, [joinRel(dest.realRel, newName)], confirmations);
  if (isExecutableName(newName)) confirmations.requireExecutable(newName);
  confirmations.assertConfirmed(confirm);
  await assertFreeSpace(policy, src.stat.size);
  const raw = await policy.backend.copyFile(src, dest, newName, {
    overwriteEtag,
    trashMeta: trashMetaFor(user, "replaced"),
  });
  invalidateRootCache();
  audit.bytes = src.stat.size;
  return { entry: toFileEntry(policy, raw) };
}

// ============================================
// Delete: preview, trash, permanent
// ============================================

/** @type {Map<string, object>} */
const previews = new Map();

export function _resetPreviewsForTests() {
  previews.clear();
}

function sweepPreviews(now = Date.now()) {
  for (const [id, preview] of previews) {
    if (preview.exp <= now) previews.delete(id);
  }
}

function snapshotOf(stat) {
  return {
    dev: stat?.dev === null || stat?.dev === undefined ? null : String(stat.dev),
    ino: stat?.ino === null || stat?.ino === undefined ? null : String(stat.ino),
    mtimeMs: stat?.mtimeMs ?? null,
  };
}

export async function deletePreview(ctx, body, user) {
  const paths = body?.paths;
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > FM_LIMITS.PATHS_PER_REQUEST) throw invalidRequest("paths");
  if (paths.some((p) => typeof p !== "string")) throw invalidRequest("paths");
  const policy = await policyFor(ctx, body?.root);
  const started = Date.now();
  let budget = FM_LIMITS.PREVIEW_WALK_MAX_ENTRIES;
  const items = [];
  const resolvedItems = [];
  const confirmations = new ConfirmationSet();
  for (const p of paths) {
    let r;
    try {
      ({ r } = await resolveIn(ctx, body.root, p, "delete"));
      assertNotRoot(r);
      assertUnprotected(r);
    } catch (err) {
      // The denial's audit row names the path that was refused.
      if (err instanceof FmError) err.auditPaths = [p];
      throw err;
    }
    const item = {
      path: r.rel,
      type: r.stat.type,
      files: r.stat.type === "dir" ? 0 : 1,
      dirs: r.stat.type === "dir" ? 1 : 0,
      bytes: r.stat.type === "file" ? r.stat.size : 0,
      truncated: false,
      worldState: policy.rules.worldStateOwners(r.realRel).length > 0,
      containsProtected: false,
    };
    // The ancestor rule, from the static anchors and from what the walk finds.
    let inner = !r.linkSelf && r.stat.type === "dir" ? policy.rules.protectedWithin(r.realRel) : null;
    if (r.stat.type === "dir" && !r.linkSelf) {
      for await (const entry of policy.backend.walk(r, {
        maxEntries: budget + 1,
        maxMs: Math.max(0, FM_LIMITS.PREVIEW_WALK_MAX_MS - (Date.now() - started)),
      })) {
        budget--;
        if (budget < 0 || Date.now() - started > FM_LIMITS.PREVIEW_WALK_MAX_MS) {
          item.truncated = true;
          break;
        }
        if (entry.type === "dir") item.dirs++;
        else item.files++;
        if (entry.type === "file") item.bytes += entry.size;
        if (!inner) {
          const found = policy.rules.classify(entry.realRel, entry);
          if (found) inner = { ...found, containsProtected: true };
        }
        if (!item.worldState && policy.rules.isWorldState(entry.realRel)) item.worldState = true;
      }
      if (budget <= 0 || Date.now() - started > FM_LIMITS.PREVIEW_WALK_MAX_MS) item.truncated = true;
    }
    item.containsProtected = Boolean(inner);
    items.push(item);
    resolvedItems.push({ r, item, inner });
    try {
      await worldStateGate(ctx, policy, [r.realRel], confirmations);
    } catch (err) {
      // Running: the delete itself will refuse; the preview still answers.
      if (!(err instanceof FmError) || err.code !== ErrorCode.FM_SERVER_RUNNING_BLOCKED) throw err;
    }
  }
  await rootStateGate(ctx, policy, confirmations);
  const availability = policy.backend.trashAvailability
    ? policy.backend.trashAvailability(policy.root, resolvedItems.map(({ r }) => r))
    : { available: true };

  sweepPreviews();
  while (previews.size >= PREVIEWS_MAX) previews.delete(previews.keys().next().value);
  const previewId = crypto.randomBytes(16).toString("hex");
  const exp = Date.now() + FM_LIMITS.PREVIEW_TTL_MS;
  previews.set(previewId, {
    userId: userIdOf(user),
    profileId: String(ctx.profile.id),
    rootId: policy.rootId,
    exp,
    items: resolvedItems.map(({ r, item, inner }) => ({
      rel: r.rel,
      realRel: r.realRel,
      name: r.name,
      type: r.stat.type,
      files: item.files,
      bytes: item.bytes,
      inner: inner ? { area: inner.area, level: inner.level } : null,
      ...snapshotOf(r.stat),
    })),
  });
  const totals = items.reduce(
    (acc, item) => ({ files: acc.files + item.files, dirs: acc.dirs + item.dirs, bytes: acc.bytes + item.bytes }),
    { files: 0, dirs: 0, bytes: 0 },
  );
  return {
    items,
    totals,
    required: confirmations.required,
    trashAvailable: availability.available,
    ...(availability.available ? {} : { trashUnavailableReason: availability.reason }),
    previewId,
    expiresAt: new Date(exp).toISOString(),
  };
}

export async function deleteItems(ctx, body, user, audit) {
  const mode = parseEnum(body?.mode, "mode", ["trash", "permanent"], undefined);
  if (!mode) throw invalidRequest("mode");
  const confirm = parseConfirmField(body?.confirm);
  audit.op = mode === "trash" ? "files.delete.trash" : "files.delete.permanent";
  audit.rootId = body?.root;
  audit.confirm = confirm;
  const previewId = body?.previewId;
  sweepPreviews();
  const preview = typeof previewId === "string" && PREVIEW_ID_RE.test(previewId) ? previews.get(previewId) : null;
  if (
    !preview ||
    preview.userId !== userIdOf(user) ||
    preview.profileId !== String(ctx.profile.id) ||
    preview.rootId !== body?.root
  ) {
    throw new FmError(ErrorCode.FM_PREVIEW_EXPIRED);
  }
  audit.paths = preview.items.map((item) => item.rel);
  const policy = await policyFor(ctx, body.root);
  audit.backend = policy.root.backend;

  // Every item must still be exactly what the operator was shown.
  const resolved = [];
  for (const item of preview.items) {
    let r;
    try {
      ({ r } = await resolveIn(ctx, body.root, item.rel, "delete"));
    } catch (err) {
      if (err instanceof FmError && err.code === ErrorCode.FM_NOT_FOUND) throw new FmError(ErrorCode.FM_PREVIEW_STALE);
      throw err;
    }
    const now = snapshotOf(r.stat);
    if (now.dev !== item.dev || now.ino !== item.ino || now.mtimeMs !== item.mtimeMs) {
      throw new FmError(ErrorCode.FM_PREVIEW_STALE);
    }
    assertNotRoot(r);
    assertUnprotected(r);
    assertHoldsNothingProtected(policy, r);
    if (item.inner) throw protectedError({ ...item.inner, containsProtected: true });
    resolved.push({ r, item });
  }

  const confirmations = new ConfirmationSet();
  await mutationGates(ctx, policy, resolved.map(({ r }) => r.realRel), confirmations);
  if (mode === "permanent") {
    confirmations.requirePermanent();
    const expected = resolved.length === 1 ? resolved[0].item.name : String(resolved.length);
    confirmations.assertConfirmed(confirm);
    if (body?.typedConfirmation !== expected) throw new FmError(ErrorCode.FM_TYPED_CONFIRMATION_MISMATCH);
  } else {
    confirmations.assertConfirmed(confirm);
  }
  if (mode === "trash") {
    const trashed = [];
    const failed = [];
    for (const { r, item } of resolved) {
      try {
        const { trashId } = await policy.backend.trashMove(r, {
          ...trashMetaFor(user, "deleted"),
          bytes: item.bytes,
          files: item.files,
        });
        trashed.push({ path: r.rel, trashId });
      } catch (err) {
        if (!(err instanceof FmError)) throw err;
        failed.push({ path: r.rel, code: err.code, ...(Object.keys(err.params || {}).length ? { params: err.params } : {}) });
      }
    }
    invalidateRootCache();
    // Nothing could go to Trash (another device, or no Trash folder): answer
    // with that, so the client offers a permanent delete instead.
    // The preview stays valid for that permanent delete.
    if (!trashed.length && failed.length && failed.every((f) => f.code === ErrorCode.FM_TRASH_UNAVAILABLE)) {
      throw new FmError(ErrorCode.FM_TRASH_UNAVAILABLE, undefined, failed[0].params || { reason: "notWritable" });
    }
    previews.delete(previewId);
    audit.trashIds = trashed.map((t) => t.trashId);
    audit.bytes = resolved.reduce((sum, { item }) => sum + item.bytes, 0);
    audit.result = failed.length && trashed.length ? "partial" : failed.length ? "failed" : "ok";
    if (failed.length && !trashed.length) audit.code = failed[0].code;
    return { status: 200, body: { trashed, failed } };
  }

  previews.delete(previewId);
  const holds = resolved.map(({ r }) => ({ rootKey: policy.rootKey, realRel: foldRel(r.realRel) }));
  const total = resolved.reduce((sum, { item }) => sum + item.files + 1, 0);
  audit.bytes = resolved.reduce((sum, { item }) => sum + item.bytes, 0);
  const deferred = audit.defer();
  const jobId = startJob({ ownerUserId: userIdOf(user), kind: "permanentDelete", holds, total }, async (onProgress) => {
    let base = 0;
    try {
      for (const { r } of resolved) {
        let last = 0;
        await policy.backend.deletePermanent(r, (done) => {
          last = done;
          onProgress(base + done, total);
        });
        base += last;
      }
      invalidateRootCache();
      await deferred.finish(null);
    } catch (err) {
      invalidateRootCache();
      await deferred.finish(err);
      throw err;
    }
  });
  return { status: 202, body: { jobId } };
}

// ============================================
// Upload
// ============================================

function decodeHeader(value, field) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string" || value.length > FM_LIMITS.REL_PATH_MAX_CHARS * 3) throw invalidRequest(field);
  try {
    return decodeURIComponent(value);
  } catch {
    throw invalidRequest(field);
  }
}

// Walk the upload's destination folder: existing levels are resolved, the
// first missing level and everything after it are returned as names to
// create (only allowed with X-File-Mkdirs: 1).
async function resolveUploadDir(ctx, policy, rootId, dirSegments) {
  let current = await policy.backend.resolve(policy.root, [], "list");
  current.protection = classifyResolved(policy, current);
  for (let i = 0; i < dirSegments.length; i++) {
    const prefix = dirSegments.slice(0, i + 1).join("/");
    const { r } = await resolveIn(ctx, rootId, prefix, "create");
    if (r.isNew) return { dir: current, missing: dirSegments.slice(i) };
    if (r.stat?.type !== "dir") throw new FmError(ErrorCode.FM_NOT_A_DIRECTORY);
    current = r;
  }
  return { dir: current, missing: [] };
}

/**
 * Every upload check except the byte stream: shared by the preflight and
 * the upload itself.
 */
async function checkUploadTarget(ctx, policy, rootId, { dirSegments, subSegments = [], name, size, confirmations }) {
  const limit = FM_LIMITS.UPLOAD_MAX_BYTES[policy.root.kind === "sftp" ? "sftp" : "local"];
  if (!Number.isSafeInteger(size) || size < 0) throw invalidRequest("size");
  if (size > limit) throw new FmError(ErrorCode.FM_UPLOAD_TOO_LARGE, undefined, { limit });
  // The name's own rules first, so a bad name is reported as a name. The
  // panel's reserved names are refused even over an existing entry.
  checkName(name, { isNew: false });
  const reserved = validateName(name, { isNew: true });
  if (!reserved.ok && reserved.reason === "reservedPanelName") {
    throw new FmError(ErrorCode.FM_INVALID_NAME, undefined, { reason: reserved.reason });
  }
  const { dir, missing } = await resolveUploadDir(ctx, policy, rootId, [...dirSegments, ...subSegments]);
  assertUnprotected(dir);
  let parentRealRel = dir.realRel;
  let parentRel = dir.rel;
  for (const level of missing) {
    checkName(level, { isNew: true });
    assertNewPathAllowed(policy, parentRealRel, parentRel, level);
    parentRealRel = joinRel(parentRealRel, level);
    parentRel = joinRel(parentRel, level);
  }
  let willReplace = false;
  let currentEtag;
  let target = null;
  if (!missing.length) {
    const { r } = await resolveIn(ctx, rootId, joinRel(dir.rel, name), "create");
    target = r;
    if (!r.isNew) {
      // Only a regular file directly at that name can be replaced; a link
      // (even to a file inside the root) is never written through.
      const direct = foldRel(r.realRel) === foldRel(joinRel(dir.realRel, name));
      if (r.stat?.type !== "file" || r.linkSelf || !direct) throw new FmError(ErrorCode.FM_EXISTS, undefined, { name });
      assertUnprotected(r);
      willReplace = true;
      currentEtag = (await policy.backend.stat(r)).etag;
    }
  }
  checkName(name, { isNew: !willReplace });
  if (!willReplace) assertNewPathAllowed(policy, parentRealRel, parentRel, name);
  const targetRealRel = joinRel(parentRealRel, name);
  assertNoOperationInProgress(policy, [targetRealRel]);
  if (confirmations) {
    await worldStateGate(ctx, policy, [targetRealRel], confirmations);
    if (isExecutableName(name)) confirmations.requireExecutable(name);
    if (willReplace) confirmations.requireOverwrite(name);
  }
  return { dir, missing, willReplace, currentEtag, target, targetRealRel };
}

export async function uploadPreflight(ctx, body) {
  const files = body?.files;
  if (!Array.isArray(files) || files.length > FM_LIMITS.UPLOAD_FILES_PER_BATCH) throw invalidRequest("files");
  const dirSegments = parseSegments(body?.dir ?? "", "dir");
  const policy = await policyFor(ctx, body?.root);
  assertRootWritable(policy);
  const batch = new ConfirmationSet();
  await rootStateGate(ctx, policy, batch);
  const out = [];
  for (const file of files) {
    const relPath = typeof file?.relPath === "string" ? file.relPath : "";
    try {
      if (typeof file?.relPath !== "string" || relPath === "") throw invalidRequest("relPath");
      const parsed = validateSegments(relPath);
      if (!parsed.ok) throw new FmError(ErrorCode.FM_INVALID_NAME, undefined, { reason: parsed.reason });
      const segs = parsed.segments;
      const perFile = new ConfirmationSet();
      const result = await checkUploadTarget(ctx, policy, body.root, {
        dirSegments,
        subSegments: segs.slice(0, -1),
        name: segs[segs.length - 1],
        size: file?.size,
        confirmations: perFile,
      });
      for (const token of perFile.required) batch.tokens.add(token);
      for (const name of perFile.executableNames) batch.requireExecutable(name);
      for (const name of perFile.overwriteNames) batch.requireOverwrite(name);
      if (perFile.serverState) batch.serverState = batch.serverState === "running" ? "running" : perFile.serverState;
      out.push({
        relPath,
        ok: true,
        willReplace: result.willReplace,
        ...(result.currentEtag ? { currentEtag: result.currentEtag } : {}),
      });
    } catch (err) {
      if (!(err instanceof FmError)) throw err;
      out.push({
        relPath,
        ok: false,
        willReplace: false,
        code: err.code,
        ...(Object.keys(err.params || {}).length ? { params: err.params } : {}),
      });
    }
  }
  // The same details an FM_CONFIRMATION_REQUIRED carries, so the one
  // pre-upload prompt can name the files each token is about.
  const required = batch.required;
  return { files: out, required, ...(required.length ? { details: batch.details() } : {}) };
}

// Read a (small) request body into memory with the upload's own limits.
function readBodyLimited(source, declaredSize) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let received = 0;
    let settled = false;
    let timer = null;
    const done = (err, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      source.removeListener("data", onData);
      source.removeListener("end", onEnd);
      source.removeListener("error", onError);
      source.removeListener("aborted", onError);
      if (err) rejectPromise(err);
      else resolvePromise(value);
    };
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => done(new FmError(ErrorCode.FM_UPLOAD_SIZE_MISMATCH)), FM_LIMITS.UPLOAD_IDLE_MS);
      timer.unref?.();
    };
    const onData = (chunk) => {
      received += chunk.length;
      if (received > declaredSize) return done(new FmError(ErrorCode.FM_UPLOAD_SIZE_MISMATCH));
      chunks.push(chunk);
      arm();
    };
    const onEnd = () =>
      received === declaredSize
        ? done(null, Buffer.concat(chunks))
        : done(new FmError(ErrorCode.FM_UPLOAD_SIZE_MISMATCH));
    const onError = () => done(new FmError(ErrorCode.FM_UPLOAD_SIZE_MISMATCH));
    source.on("data", onData);
    source.on("end", onEnd);
    source.on("error", onError);
    source.on("aborted", onError);
    arm();
  });
}

/**
 * POST /upload. `req` is the raw request; every check runs before a byte of
 * the body is read.
 */
export async function receiveUpload(ctx, req, user, audit) {
  const contentType = String(req.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/octet-stream") throw new FmError(ErrorCode.FM_UNSUPPORTED_MEDIA_TYPE);
  const lengthHeader = req.get("content-length");
  if (lengthHeader === undefined) throw new FmError(ErrorCode.FM_LENGTH_REQUIRED);
  if (!/^\d{1,15}$/.test(lengthHeader)) throw invalidRequest("Content-Length");
  const declared = Number(lengthHeader);
  const rootId = req.get("x-file-root");
  const dirRaw = decodeHeader(req.get("x-file-dir"), "X-File-Dir");
  const name = decodeHeader(req.get("x-file-name"), "X-File-Name");
  const mkdirs = req.get("x-file-mkdirs") === "1";
  const overwriteEtag = req.get("x-file-overwrite-etag") || null;
  if (overwriteEtag !== null && (overwriteEtag.length > 200 || !/^[\x21-\x7e]+$/.test(overwriteEtag))) {
    throw invalidRequest("X-File-Overwrite-Etag");
  }
  const confirm = parseConfirmHeader(req.get("x-file-confirm"));
  audit.rootId = rootId;
  audit.paths = [joinRel(dirRaw, name)];
  audit.confirm = confirm;
  if (!name) throw new FmError(ErrorCode.FM_INVALID_NAME, undefined, { reason: "empty" });

  const policy = await policyFor(ctx, rootId);
  audit.backend = policy.root.backend;
  const dirSegments = parseSegments(dirRaw, "dir");
  const confirmations = new ConfirmationSet();
  assertRootWritable(policy);
  const check = await checkUploadTarget(ctx, policy, rootId, {
    dirSegments,
    name,
    size: declared,
    confirmations,
  });
  if (check.missing.length && !mkdirs) throw new FmError(ErrorCode.FM_NOT_FOUND);
  if (check.willReplace && overwriteEtag === null) throw new FmError(ErrorCode.FM_EXISTS, undefined, { name });
  if (!check.willReplace && overwriteEtag !== null) throw new FmError(ErrorCode.FM_CONFLICT);
  await rootStateGate(ctx, policy, confirmations);
  confirmations.assertConfirmed(confirm);
  await assertFreeSpace(policy, declared);
  const release = acquireTransferSlot(userIdOf(user));
  try {
    // Missing folders, one level at a time; each one was checked above. A
    // folder upload sends two files at a time, so another upload of the
    // same batch may have just made the level: that's fine as long as it is
    // now an unprotected folder.
    let dir = check.dir;
    for (const level of check.missing) {
      try {
        await policy.backend.mkdir(dir, level);
      } catch (err) {
        if (!(err instanceof FmError) || err.code !== ErrorCode.FM_EXISTS) throw err;
        const { r: made } = await resolveIn(ctx, rootId, joinRel(dir.rel, level), "list");
        const direct = foldRel(made.realRel) === foldRel(joinRel(dir.realRel, level));
        if (made.stat?.type !== "dir" || !direct) throw err;
        assertUnprotected(made);
      }
      ({ r: dir } = await resolveIn(ctx, rootId, joinRel(dir.rel, level), "list"));
      assertUnprotected(dir);
    }
    let source = req;
    let size = declared;
    // A masked .ini downloaded earlier and uploaded back over the live file
    // gets its secrets put back, like a save from the editor.
    if (check.willReplace && isSecretBearingName(name) && declared <= FM_LIMITS.TEXT_EDIT_MAX_BYTES) {
      const buffer = await readBodyLimited(req, declared);
      const text = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(buffer);
      if (hasMaskedSecretLines(text)) {
        const live = await policy.backend.readBytes(check.target, { maxBytes: FM_LIMITS.TEXT_EDIT_MAX_BYTES });
        const liveText = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true }).decode(live.buffer).replace(/^\uFEFF/, "");
        const crlf = /\r\n/.test(text) && !/(^|[^\r])\n/.test(text);
        const bom = text.startsWith("\uFEFF");
        let merged = reconcileIniText(text.replace(/^\uFEFF/, ""), liveText);
        if (crlf) merged = merged.replace(/\n/g, "\r\n");
        const body = Buffer.from(`${bom ? "\uFEFF" : ""}${merged}`, "utf8");
        source = Readable.from([body]);
        size = body.length;
      } else {
        source = Readable.from([buffer]);
      }
    }
    const result = await policy.backend.receiveUpload(dir, name, source, {
      declaredSize: size,
      maxBytes: FM_LIMITS.UPLOAD_MAX_BYTES[policy.root.kind === "sftp" ? "sftp" : "local"],
      overwriteEtag,
      trashMeta: trashMetaFor(user, "replaced"),
    });
    invalidateRootCache();
    audit.bytes = size;
    audit.sha256After = result.sha256;
    if (result.replacedTrashId) audit.trashIds = [result.replacedTrashId];
    return {
      entry: toFileEntry(policy, result.entry),
      sha256: result.sha256,
      replaced: result.replacedTrashId ? { trashId: result.replacedTrashId } : null,
    };
  } finally {
    release();
  }
}

// ============================================
// Download and zip
// ============================================

export async function openDownload(ctx, query, user, audit) {
  audit.rootId = query.root;
  audit.paths = [typeof query.path === "string" ? query.path : ""];
  const { r, policy } = await resolveIn(ctx, query.root, query.path ?? "", "read");
  audit.backend = policy.root.backend;
  if (r.stat?.type !== "file") throw new FmError(ErrorCode.FM_NOT_A_FILE);
  assertReadable(r);
  if (r.stat.size > FM_LIMITS.DOWNLOAD_MAX_BYTES) {
    throw new FmError(ErrorCode.FM_DOWNLOAD_TOO_LARGE, undefined, { limit: FM_LIMITS.DOWNLOAD_MAX_BYTES });
  }
  const release = acquireTransferSlot(userIdOf(user));
  try {
    const etag = (await policy.backend.stat(r)).etag;
    const name = path.posix.basename(r.rel) || path.posix.basename(r.realRel);
    if (isSecretBearingName(name) || isSecretBearingName(r.realRel)) {
      const read = await policy.backend.readBytes(r, { maxBytes: INI_DOWNLOAD_MAX_BYTES });
      if (read.truncated) {
        throw new FmError(ErrorCode.FM_DOWNLOAD_TOO_LARGE, undefined, { limit: INI_DOWNLOAD_MAX_BYTES });
      }
      const masked = maskIniBuffer(read.buffer);
      audit.bytes = masked.buffer.length;
      return { name, etag, size: masked.buffer.length, buffer: masked.buffer, masked: true, release };
    }
    const handle = await policy.backend.openReadStream(r);
    audit.bytes = handle.size;
    return {
      name,
      etag,
      size: handle.size,
      stream: handle.stream,
      close: handle.close,
      masked: false,
      release,
      idleMs: downloadIdleMs,
    };
  } catch (err) {
    release();
    throw err;
  }
}

/** Plan a zip (JSON 413 before the first byte), then hand back a streamer. */
export async function prepareZip(ctx, body, user, audit) {
  const paths = body?.paths;
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > FM_LIMITS.PATHS_PER_REQUEST) throw invalidRequest("paths");
  if (paths.some((p) => typeof p !== "string")) throw invalidRequest("paths");
  audit.rootId = body?.root;
  audit.paths = paths;
  const policy = await policyFor(ctx, body?.root);
  audit.backend = policy.root.backend;
  const items = [];
  for (const p of paths) {
    const { r } = await resolveIn(ctx, body.root, p, "read");
    assertReadable(r);
    items.push(r);
  }
  const release = acquireZipSlot(userIdOf(user));
  try {
    const plan = await planZip({
      backend: policy.backend,
      items,
      classify: (realRel, stat) => policy.rules.classify(realRel, stat),
    });
    return {
      fileName: zipFileName(ctx.profile.serverName, policy.rootId, items),
      plan,
      release,
      stream: (res) => streamZip({ res, backend: policy.backend, root: policy.root, plan }),
    };
  } catch (err) {
    release();
    throw err;
  }
}

// ============================================
// Trash
// ============================================

export async function listTrashItems(ctx, query) {
  const policy = await policyFor(ctx, query.root);
  let originalPath = null;
  if (query.originalPath !== undefined) {
    originalPath = requireString(query.originalPath, "originalPath");
    parseSegments(originalPath, "originalPath");
  }
  let items = await policy.backend.trashList(policy.root);
  if (originalPath !== null) {
    const wanted = foldRel(originalPath);
    items = items.filter((item) => foldRel(item.originalPath) === wanted);
  }
  return {
    items: items.map((item) => ({
      trashId: item.trashId,
      originalPath: item.originalPath,
      type: item.type,
      bytes: item.bytes,
      files: item.files,
      deletedAt: item.deletedAt,
      deletedBy: { username: item.deletedBy?.username ?? null },
      reason: item.reason,
      expiresAt: item.expiresAt,
    })),
    totalBytes: items.reduce((sum, item) => sum + (item.bytes || 0), 0),
  };
}

export async function restoreTrashItem(ctx, body, user, audit) {
  const trashId = body?.trashId;
  if (typeof trashId !== "string" || !TRASH_ID_RE.test(trashId)) throw invalidRequest("trashId");
  const confirm = parseConfirmField(body?.confirm);
  audit.rootId = body?.root;
  audit.trashIds = [trashId];
  audit.confirm = confirm;
  const policy = await policyFor(ctx, body?.root);
  audit.backend = policy.root.backend;
  const items = await policy.backend.trashList(policy.root);
  const item = items.find((i) => i.trashId === trashId);
  if (!item) throw new FmError(ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
  audit.paths = [item.originalPath];
  // meta.json is untrusted: the target goes back through the name rules and
  // resolution like any other path.
  const segments = parseSegments(item.originalPath, "originalPath");
  const originalName = segments[segments.length - 1];
  let name = originalName;
  if (body?.restoreAs !== undefined && body?.restoreAs !== null) {
    name = checkName(requireString(body.restoreAs, "restoreAs"), { isNew: true });
  }
  const parentRel = segments.slice(0, -1).join("/");
  const { r: parent } = await resolveIn(ctx, body.root, parentRel, "list");
  if (parent.stat?.type !== "dir") throw new FmError(ErrorCode.FM_NOT_FOUND);
  assertUnprotected(parent);
  const { r: target } = await resolveIn(ctx, body.root, joinRel(parent.rel, name), "create");
  if (!target.isNew) throw new FmError(ErrorCode.FM_EXISTS, undefined, { name });
  assertNewPathAllowed(policy, parent.realRel, parent.rel, name);
  audit.dest = joinRel(parent.rel, name);
  const confirmations = new ConfirmationSet();
  await mutationGates(ctx, policy, [joinRel(parent.realRel, name)], confirmations);
  if (isExecutableName(name)) confirmations.requireExecutable(name);
  confirmations.assertConfirmed(confirm);
  const raw = await policy.backend.trashRestore(policy.root, trashId, name === originalName ? undefined : name);
  invalidateRootCache();
  audit.bytes = item.bytes;
  return { entry: toFileEntry(policy, raw) };
}

/**
 * An earlier version of a file, straight from Trash, decoded like GET /text
 * mode=edit (same size limit and refusals, .ini secrets masked). The editor's
 * "Previous versions" loads it as unsaved text. A read: not audited.
 */
export async function readTrashText(ctx, query) {
  const trashId = query.trashId;
  if (typeof trashId !== "string" || !TRASH_ID_RE.test(trashId)) throw invalidRequest("trashId");
  const policy = await policyFor(ctx, query.root);
  const items = await policy.backend.trashList(policy.root);
  const item = items.find((i) => i.trashId === trashId);
  if (!item) throw new FmError(ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
  if (item.type !== "file") throw new FmError(ErrorCode.FM_NOT_A_FILE);
  // meta.json is untrusted: the original path goes through the name rules,
  // and a version of something now sealed stays unreadable.
  const segments = parseSegments(item.originalPath, "originalPath");
  const protection = policy.rules.classify(segments.join("/"), null);
  if (protection?.level === "sealed") throw protectedError(protection);
  const name = segments[segments.length - 1];
  if (isBinaryName(name)) throw new FmError(ErrorCode.FM_BINARY_FILE);
  const read = await policy.backend.trashReadBytes(policy.root, trashId, { maxBytes: FM_LIMITS.TEXT_EDIT_MAX_BYTES });
  if (read.truncated) {
    throw new FmError(ErrorCode.FM_FILE_TOO_LARGE_FOR_EDITOR, undefined, { limit: FM_LIMITS.TEXT_EDIT_MAX_BYTES });
  }
  const decoded = decodeForEdit(read.buffer);
  let content = decoded.text;
  let masked = false;
  if (isSecretBearingName(name)) {
    const result = maskIniText(content);
    content = result.text;
    masked = result.masked;
  }
  return { content, bom: decoded.bom, eol: decoded.eol, masked };
}

export async function purgeTrash(ctx, body, user, audit) {
  const confirm = parseConfirmField(body?.confirm);
  audit.rootId = body?.root;
  audit.confirm = confirm;
  const policy = await policyFor(ctx, body?.root);
  audit.backend = policy.root.backend;
  const all = body?.all === true;
  const requested = body?.trashIds;
  if (!all) {
    if (!Array.isArray(requested) || requested.length === 0 || requested.length > FM_LIMITS.PATHS_PER_REQUEST) {
      throw invalidRequest("trashIds");
    }
    if (requested.some((id) => typeof id !== "string" || !TRASH_ID_RE.test(id))) throw invalidRequest("trashIds");
  }
  const listed = await policy.backend.trashList(policy.root);
  let targets;
  if (all) {
    targets = listed;
  } else {
    targets = [];
    for (const id of new Set(requested)) {
      const found = listed.find((item) => item.trashId === id);
      if (!found) throw new FmError(ErrorCode.FM_TRASH_ITEM_NOT_FOUND);
      targets.push(found);
    }
  }
  audit.trashIds = targets.map((t) => t.trashId);
  audit.paths = targets.map((t) => t.originalPath);
  assertRootWritable(policy);
  const confirmations = new ConfirmationSet();
  confirmations.requirePermanent();
  confirmations.assertConfirmed(confirm);
  // Emptying the whole Trash is confirmed with the count (whatever it is);
  // deleting one chosen item with its name.
  const expected = !all && targets.length === 1 ? path.posix.basename(targets[0].originalPath) : String(targets.length);
  if (body?.typedConfirmation !== expected) throw new FmError(ErrorCode.FM_TYPED_CONFIRMATION_MISMATCH);
  audit.bytes = targets.reduce((sum, t) => sum + (t.bytes || 0), 0);
  const deferred = audit.defer();
  const jobId = startJob(
    { ownerUserId: userIdOf(user), kind: "trashPurge", holds: [], total: targets.length },
    async (onProgress) => {
      let done = 0;
      try {
        for (const target of targets) {
          await policy.backend.deletePermanent({ root: policy.root, trashId: target.trashId }, () => {});
          done++;
          onProgress(done, targets.length);
        }
        invalidateRootCache();
        await deferred.finish(null);
      } catch (err) {
        invalidateRootCache();
        await deferred.finish(err);
        throw err;
      }
    },
  );
  return { jobId };
}

// ============================================
// Remote roots
// ============================================

export async function setRemoteRoots(ctx, body, user, audit) {
  audit.rootId = null;
  if (!isRemoteProfile(ctx.profile) || !ctx.profile.isActive) {
    throw new FmError(ErrorCode.FM_ROOT_UNAVAILABLE, undefined, { reason: "remoteNotActive" });
  }
  const key = remoteKeyOf(ctx.settings);
  if (!key) throw new FmError(ErrorCode.FM_ROOT_UNAVAILABLE, undefined, { reason: "remoteNotConfigured" });
  const clean = (value, field) => {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value !== "string") throw invalidRequest(field);
    validateRemoteRootPath(value, { allowSlash: true });
    return value;
  };
  const installPath = clean(body?.installPath, "installPath");
  const dataPath = clean(body?.dataPath, "dataPath");
  audit.paths = [installPath, dataPath].filter(Boolean);
  const existing = (await getSetting("fileManagerRemoteRoots")) || {};
  const next = { ...(existing && typeof existing === "object" ? existing : {}), [key]: { installPath, dataPath } };
  await setSetting("fileManagerRemoteRoots", next);
  invalidateRootCache();
  const settings = await getAllSettings();
  const fresh = { ...ctx, settings: settings || {}, policies: new Map(), rootsInfo: null };
  return getProfile(fresh, { fresh: true });
}

// ============================================
// Audit listing
// ============================================

export async function listAudit(query) {
  let profileId;
  if (query.profileId !== undefined) {
    if (typeof query.profileId !== "string" || !PROFILE_ID_RE.test(query.profileId)) throw invalidRequest("profileId");
    profileId = query.profileId;
  }
  const limit = parseIntParam(query.limit, "limit", { min: 1, max: 500, fallback: 100 });
  const entries = await getFileAudit({ profileId, limit });
  return { entries };
}

