/**
 * Which Steam Workshop item this panel build delivers PanelBridge through.
 *
 * The id ships WITH each panel release (pz-mod/workshop/published.json,
 * embedded into exe builds as PANEL_BRIDGE_WORKSHOP_JSON) and is never
 * fetched from the network: a server that switches to Workshop delivery
 * downloads and runs whatever Lua that item holds, so the id has to come
 * from the same reviewed, versioned artifact as the panel itself. The only
 * override is the maintainer's PANEL_BRIDGE_WORKSHOP_ID environment
 * variable, for live-testing an item before its id is committed -- and that
 * override always marks the release as a preview. A published.json that
 * fails validation stays invalid even with the override set: a corrupted
 * or foreign document is a broken install, not something to paper over.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { BRIDGE_MOD_ID } from "./bridgeDeliveryContract.js";
import { createLogger } from "../utils/logger.js";

const log = createLogger("BridgeWorkshopRelease");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Same upper bound as the engine's isValidSteamID (an unsigned 64-bit id):
// GameServer drops any WorkshopItems= entry that fails it, which would leave
// Mods= naming a mod nobody can download -- every join then fails with
// ModRequired. Stricter at the bottom, like scripts/workshop/lib.mjs: 0 is
// never a published item (isValidSteamID accepts it, so WorkshopItems=0
// would abort a Workshop server's startup), and the id is taken only in
// its plain decimal form. The heartbeat reports that form, and the status
// compares the two as strings, so "03712345678" would never confirm.
const WORKSHOP_ID_RE = /^[1-9]\d{0,19}$/;
const MAX_STEAM_ID = 18446744073709551615n;
const VISIBILITIES = new Set(["public", "unlisted"]);

let cached = null;

export function isValidWorkshopId(value) {
  if (typeof value !== "string" || !WORKSHOP_ID_RE.test(value)) return false;
  return BigInt(value) <= MAX_STEAM_ID;
}

// Dev checkout, packaged binary, then module-relative -- the same candidate
// order panelBridgeInstaller.js uses for the Lua source.
function fileCandidates() {
  return [
    path.join(process.cwd(), "pz-mod", "workshop", "published.json"),
    path.join(path.dirname(process.execPath), "pz-mod", "workshop", "published.json"),
    path.join(__dirname, "..", "..", "pz-mod", "workshop", "published.json"),
  ];
}

function readBaseDocument() {
  const embedded =
    typeof PANEL_BRIDGE_WORKSHOP_JSON !== "undefined" ? PANEL_BRIDGE_WORKSHOP_JSON : "";
  if (typeof embedded === "string" && embedded.length > 0) {
    return { source: "embedded", text: embedded };
  }
  for (const candidate of fileCandidates()) {
    try {
      if (fs.existsSync(candidate)) {
        return { source: "file", text: fs.readFileSync(candidate, "utf8") };
      }
    } catch {
      /* try the next candidate */
    }
  }
  return { source: "none", text: null };
}

function emptyRelease(source) {
  return {
    status: "not-published",
    source,
    modId: BRIDGE_MOD_ID,
    workshopId: null,
    visibility: null,
    publishedVersion: null,
    publishedAt: null,
    preview: true,
    linuxChecksumVerified: false,
  };
}

function invalid(source, reason) {
  log.error(`PanelBridge Workshop release data is invalid (${source}): ${reason}`);
  return { ...emptyRelease(source), status: "invalid" };
}

function computeRelease() {
  const base = readBaseDocument();
  let release;
  if (base.text === null) {
    release = emptyRelease("none");
  } else {
    let doc;
    try {
      doc = JSON.parse(base.text);
    } catch (error) {
      return invalid(base.source, `not valid JSON: ${error.message}`);
    }
    if (!doc || typeof doc !== "object" || doc.schema !== 1) {
      return invalid(base.source, "unsupported schema");
    }
    if (doc.modId !== BRIDGE_MOD_ID) {
      return invalid(base.source, `modId must be ${BRIDGE_MOD_ID}`);
    }
    if (doc.workshopId !== null && doc.workshopId !== undefined && !isValidWorkshopId(doc.workshopId)) {
      return invalid(base.source, "workshopId is not a valid Steam item id");
    }
    const liveVerified = doc.liveVerified && typeof doc.liveVerified === "object" ? doc.liveVerified : {};
    const workshopId = doc.workshopId || null;
    release = {
      status: workshopId ? "published" : "not-published",
      source: base.source,
      modId: BRIDGE_MOD_ID,
      workshopId,
      visibility: VISIBILITIES.has(doc.visibility) ? doc.visibility : null,
      publishedVersion: typeof doc.publishedVersion === "string" ? doc.publishedVersion : null,
      publishedAt: typeof doc.publishedAt === "string" ? doc.publishedAt : null,
      // Preview until the maintainer has recorded a live test on BOTH server
      // OSes -- the Linux-server/Windows-client checksum is the one result
      // that can't be settled from the jar.
      preview: liveVerified.windowsServer == null || liveVerified.linuxServer == null,
      linuxChecksumVerified: liveVerified.linuxServer?.nonAdminJoinWithChecksumOn === true,
    };
  }
  return applyEnvOverride(release);
}

function applyEnvOverride(release) {
  const override = process.env.PANEL_BRIDGE_WORKSHOP_ID;
  if (override === undefined || override === "") return release;
  if (!isValidWorkshopId(override)) {
    log.error(
      `Ignoring PANEL_BRIDGE_WORKSHOP_ID=${JSON.stringify(override)}: not a valid Steam Workshop item id`,
    );
    return release;
  }
  log.warn(
    `PanelBridge Workshop item id overridden by PANEL_BRIDGE_WORKSHOP_ID=${override} (testing only)`,
  );
  return {
    ...release,
    status: "published",
    source: "env",
    workshopId: override,
    preview: true,
  };
}

export function getWorkshopRelease() {
  if (!cached) cached = computeRelease();
  return cached;
}

export function _resetWorkshopReleaseCacheForTests() {
  cached = null;
}
