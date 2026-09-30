// Which folders Server Files offers for a server profile, and whether each
// can be opened right now (spec §A3). Local profiles get the game install,
// launch, Zomboid data and server config folders straight from the profile
// (no global fallbacks); the active remote profile gets the same ids over
// its PanelBridge SFTP login (fileManagerRemoteRoots.js / the SFTP backend).
//
// Probing is cached for ROOT_PROBE_CACHE_MS per profile and dropped after
// any mutation, so free space and Trash counts stay close to the truth.
import path from "path";
import { resolveProvider } from "../utils/serverStatusModel.js";
import { hasPzInstallMarker } from "../routes/server.js";
import { FM_LIMITS, FmError } from "./fileManagerContract.js";
import { localBackend } from "./fileManagerLocalBackend.js";
import { createSftpBackend } from "./fileManagerSftpBackend.js";
import { resolveRemoteRoots } from "./fileManagerRemoteRoots.js";
import { isInsideAbs, relFromRoot } from "./fileManagerProtectedAreas.js";
import { lstatBig } from "./fileManagerLocalFs.js";

const backendFactories = new Map([
  ["local", () => localBackend],
  ["sftp", (opts) => createSftpBackend(opts)],
]);

/**
 * Register (or replace) a backend factory. The SFTP workstream's module is
 * registered here at load; tests swap in fakes.
 * @param {"local"|"sftp"} kind
 * @param {(opts: { settings: object, root: object }) => object} factory
 */
export function registerBackend(kind, factory) {
  backendFactories.set(kind, factory);
  probeCache.clear();
}

export function getBackendFactory(kind) {
  return backendFactories.get(kind);
}

/** @type {Map<string, { at: number, sig: string, value: object }>} */
const probeCache = new Map();

export function invalidateRootCache() {
  probeCache.clear();
}

export function isRemoteProfile(profile) {
  return resolveProvider(profile) === "remote-sftp";
}

// A launcher file (.bat/.sh/.exe) stands for the folder it sits in.
export function folderOf(p) {
  if (!p || typeof p !== "string") return "";
  return /\.(bat|sh|exe)$/i.test(p) ? path.dirname(p) : p;
}

export function remoteKeyOf(settings) {
  const host = settings?.panelBridgeSftpHost;
  if (!host) return null;
  const port = Number(settings?.panelBridgeSftpPort) || 22;
  return `${host}:${port}:${settings?.panelBridgeSftpUsername || ""}`;
}

/** The descriptor the client sees: no real path, no internal fields. */
export function publicDescriptor(root) {
  const out = {
    id: root.id,
    backend: root.backend,
    displayPath: root.displayPath ?? null,
    available: Boolean(root.available),
    writable: root.available ? root.writable ?? null : null,
    freeBytes: root.freeBytes ?? null,
    totalBytes: root.totalBytes ?? null,
    warnings: Array.isArray(root.warnings) ? [...root.warnings] : [],
    trashItemCount: root.trashItemCount ?? null,
  };
  if (!root.available) {
    out.unavailableReason = root.unavailableReason || "missing";
    if (root.unavailableDetail) out.unavailableDetail = String(root.unavailableDetail).slice(0, 40);
  }
  if (root.readOnlyReason) out.readOnlyReason = root.readOnlyReason;
  return out;
}

function existsAsDir(rootReal, rel) {
  try {
    return lstatBig(path.join(rootReal, ...rel.split("/"))).isDirectory();
  } catch {
    return false;
  }
}

function localBookmarks(profile, rootsById) {
  const bookmarks = [];
  const data = rootsById.get("data");
  if (data?.available) {
    const candidates = [
      ["Server", "serverSettings"],
      ...(profile.serverName ? [[`Saves/Multiplayer/${profile.serverName}`, "worldSave"]] : []),
      ["db", "playerDb"],
      ["Logs", "logs"],
      ["mods", "localMods"],
    ];
    for (const [rel, kind] of candidates) {
      if (existsAsDir(data.real, rel)) bookmarks.push({ rootId: "data", path: rel, kind });
    }
  }
  const install = rootsById.get("install");
  if (install?.available) {
    for (const [rel, kind] of [
      ["java", "java"],
      ["media/lua", "gameLua"],
      ["steamapps/workshop/content/108600", "workshop"],
    ]) {
      if (existsAsDir(install.real, rel)) bookmarks.push({ rootId: "install", path: rel, kind });
    }
  }
  return bookmarks;
}

function lexicallyWithin(parent, child) {
  if (!parent || !child) return false;
  return isInsideAbs(path.resolve(parent), path.resolve(child));
}

async function describeLocal(profile) {
  const specs = {
    install: { id: "install", path: folderOf(profile.installPath) },
    launch: profile.serverPath ? { id: "launch", path: folderOf(profile.serverPath) } : null,
    data: { id: "data", path: profile.zomboidDataPath || "" },
    config: profile.serverConfigPath ? { id: "config", path: profile.serverConfigPath } : null,
  };
  const described = new Map();
  for (const [id, spec] of Object.entries(specs)) {
    if (!spec) continue;
    const root = await localBackend.describeRoot(spec);
    described.set(id, { ...root, kind: "local" });
  }

  const bookmarksExtra = [];
  const install = described.get("install");
  const launch = described.get("launch");
  if (launch) {
    const sameOrInside =
      install?.real && launch.real
        ? isInsideAbs(install.real, launch.real)
        : lexicallyWithin(install?.path, launch.path);
    if (sameOrInside) described.delete("launch");
  }
  const data = described.get("data");
  const config = described.get("config");
  if (config) {
    const inside =
      data?.real && config.real ? isInsideAbs(data.real, config.real) : lexicallyWithin(data?.path, config.path);
    if (inside) {
      described.delete("config");
      const rel = data?.real && config.real ? relFromRoot(data.real, config.real) : null;
      if (rel) bookmarksExtra.push({ rootId: "data", path: rel, kind: "serverSettings" });
    }
  }
  if (install?.available && !hasPzInstallMarker(install.real)) {
    install.warnings = [...install.warnings, "noInstallMarker"];
  }

  const bookmarks = localBookmarks(profile, described);
  for (const extra of bookmarksExtra) {
    if (!bookmarks.some((b) => b.rootId === extra.rootId && b.path === extra.path)) bookmarks.unshift(extra);
  }
  return { roots: described, bookmarks, remote: null, remoteRoots: undefined };
}

function unavailableRemote(id, reason, detail) {
  return {
    id,
    backend: "sftp",
    displayPath: null,
    available: false,
    unavailableReason: reason,
    ...(detail ? { unavailableDetail: detail } : {}),
    writable: null,
    freeBytes: null,
    totalBytes: null,
    warnings: [],
    trashItemCount: null,
    real: null,
    kind: "sftp",
  };
}

async function describeRemote(profile, settings) {
  const isActive = Boolean(profile.isActive);
  let resolved;
  try {
    resolved = await resolveRemoteRoots({ profile, settings, isActive });
  } catch (err) {
    resolved = {
      roots: [],
      unavailable: { reason: err instanceof FmError ? err.params?.reason || "remoteNotConfigured" : "remoteNotConfigured" },
      remote: null,
      derivedDataPath: null,
    };
  }
  const described = new Map();
  if (!isActive || resolved?.unavailable) {
    const reason = !isActive ? "remoteNotActive" : resolved.unavailable.reason || "remoteNotConfigured";
    for (const id of ["data", "install"]) described.set(id, unavailableRemote(id, reason, resolved?.unavailable?.detail));
  } else {
    const factory = backendFactories.get("sftp");
    for (const spec of resolved.roots || []) {
      if (spec.unavailableReason) {
        described.set(spec.id, unavailableRemote(spec.id, spec.unavailableReason));
        continue;
      }
      try {
        const backend = factory({ settings, root: spec });
        const root = await backend.describeRoot(spec);
        described.set(spec.id, { ...root, kind: "sftp", backendInstance: backend });
      } catch (err) {
        const reason = err instanceof FmError && err.params?.reason ? err.params.reason : "sftpUnreachable";
        described.set(spec.id, unavailableRemote(spec.id, reason));
      }
    }
    if (!described.has("install")) described.set("install", unavailableRemote("install", "remoteInstallNotSet"));
  }
  const key = remoteKeyOf(settings);
  const override = key ? settings?.fileManagerRemoteRoots?.[key] : null;
  return {
    roots: described,
    bookmarks: [],
    remote: resolved?.remote || null,
    remoteRoots: {
      installPath: typeof override?.installPath === "string" ? override.installPath : null,
      dataPath: typeof override?.dataPath === "string" ? override.dataPath : null,
      derivedDataPath: resolved?.derivedDataPath ?? null,
    },
  };
}

function signatureOf(profile, settings) {
  return JSON.stringify([
    profile.installPath,
    profile.serverPath,
    profile.zomboidDataPath,
    profile.serverConfigPath,
    profile.serverName,
    profile.isActive,
    resolveProvider(profile),
    isRemoteProfile(profile) ? remoteKeyOf(settings) : null,
    isRemoteProfile(profile) ? settings?.fileManagerRemoteRoots ?? null : null,
    isRemoteProfile(profile) ? settings?.panelBridgeSftpConfigPath ?? null : null,
    isRemoteProfile(profile) ? settings?.panelBridgeSftpBridgePath ?? null : null,
  ]);
}

/**
 * Every root of a profile, probed (cached).
 * @returns {Promise<{ roots: Map<string, object>, bookmarks: object[], remote: object|null, remoteRoots?: object }>}
 */
export async function describeProfileRoots(profile, settings, { fresh = false } = {}) {
  const key = String(profile.id);
  const sig = signatureOf(profile, settings);
  const cached = probeCache.get(key);
  if (!fresh && cached && cached.sig === sig && Date.now() - cached.at < FM_LIMITS.ROOT_PROBE_CACHE_MS) {
    return cached.value;
  }
  const value = isRemoteProfile(profile) ? await describeRemote(profile, settings) : await describeLocal(profile);
  probeCache.set(key, { at: Date.now(), sig, value });
  return value;
}

/** The backend that serves a described root. */
export function backendForRoot(root) {
  if (root?.kind === "sftp") return root.backendInstance;
  return localBackend;
}
