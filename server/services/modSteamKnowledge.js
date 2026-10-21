/**
 * Steam Workshop knowledge cache
 * ------------------------------
 * A cached view of what Steam knows about Workshop items: the title, the
 * tags, the author's "Required items" (Workshop dependencies) and the order
 * of the "Mod ID:" lines in the description. Smart sorting and the mod
 * insights read it; callers never block on Steam unless they ask to.
 *
 * - peekSteamKnowledge(ids): synchronous, cache only.
 * - fetchSteamKnowledge(ids, { refresh, budgetMs }): fetches what is missing
 *   or stale (or everything on refresh, rate-limited), within a time budget.
 * - startSteamKnowledgeFill(ids): fire-and-forget background fill, one at a
 *   time.
 *
 * Sources: details (title, tags, description) come from the public
 * ISteamRemoteStorage/GetPublishedFileDetails endpoint. Required items come
 * from IPublishedFileService/GetDetails (children with file_type 0) when a
 * Steam Web API key is configured, otherwise from the item's public Workshop
 * page. That page is someone else's HTML, so the parser is strict and
 * bounded: it only reads links inside the RequiredItems container.
 *
 * The cache lives in memory (LRU, maxItems) and is persisted, debounced, to
 * <dataDir>/mod-steam-meta.json. Loading validates every entry and drops
 * anything malformed.
 */
import fs from "fs";
import path from "path";
import { createLogger } from "../utils/logger.js";
import { getDataPaths } from "../utils/paths.js";
import { writeFileAtomic } from "../utils/fileWriteQueue.js";
import { getSteamApiKey } from "./steamApiKey.js";

const log = createLogger("ModSteamKnowledge");

export const STEAM_KNOWLEDGE_LIMITS = Object.freeze({
  maxItems: 5000,
  ttlMs: 12 * 60 * 60 * 1000,
  refreshMinIntervalMs: 60_000,
  concurrency: 4,
  budgetMs: 20_000,
  maxRequiredPerItem: 100,
  detailsBatch: 100,
  fetchTimeoutMs: 10_000,
  maxPageBytes: 2 * 1024 * 1024,
  maxTitle: 200,
  maxTags: 30,
  maxTagLength: 50,
  maxModIdOrder: 50,
});

let limits = { ...STEAM_KNOWLEDGE_LIMITS };

const STORE_FILE = "mod-steam-meta.json";
const STORE_SCHEMA = 1;
// A persisted store of maxItems entries with full required-item lists stays
// well under this; anything bigger is not ours to parse.
const MAX_STORE_BYTES = 64 * 1024 * 1024;
const PERSIST_DEBOUNCE_MS = 1000;
// peek/fetch move usedAt on every call; only persist that when it moved a lot.
const USED_PERSIST_THRESHOLD_MS = 60 * 60 * 1000;
// JSON answers from the Web API (100 items with descriptions) are a few MB at
// most; a bigger body is truncated and then fails to parse.
const API_MAX_BYTES = 16 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const MAX_BUDGET_MS = 5 * 60 * 1000;
const MAX_PARSE_CHARS = 4 * 1024 * 1024;
const CONTAINER_SCAN_CHARS = 200 * 1024;
const MAX_CONTAINER_CANDIDATES = 20;
const MAX_DESCRIPTION_CHARS = 100 * 1024;
const MAX_MOD_ID_SCAN = 256;
// Upper bound on the ids one call considers (twice the default cache size).
const MAX_REQUEST_IDS = 10_000;

const USER_AGENT = "ZomboidControlPanel (+mod-insights)";
const DETAILS_URL =
  "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/";
const API_CHILDREN_URL =
  "https://api.steampowered.com/IPublishedFileService/GetDetails/v1/";
const PAGE_HOST = "steamcommunity.com";

const WORKSHOP_ID_RE = /^\d{1,15}$/;
const MOD_ID_VALUE_RE = /^[A-Za-z0-9_.\-]{1,100}$/;
const REQUIRED_HREF_RE =
  /^https?:\/\/steamcommunity\.com\/(?:sharedfiles|workshop)\/filedetails\/\?id=(\d+)(?:&|$)/;
const CONTROL_CHARS_RE = /[\x00-\x1F\x7F-\x9F]/g;

// ─── State ──────────────────────────────────────────────────────────────────

let cache = new Map(); // workshopId -> Entry
let loaded = false;
let epoch = 0; // bumped by the test reset so a stale run never writes back
let lastRefreshStartedAt = null;
let lastRunFailed = false;
let fillPromise = null;
let persistTimer = null;
let persistDirty = false;
let keyConfigured = null; // last known "an API key is configured", null = unknown
let keyProbe = null;
const activeRuns = new Set();

class SkipSignal extends Error {
  constructor() {
    super("budget exhausted");
    this.name = "SkipSignal";
  }
}

// ─── Small helpers ──────────────────────────────────────────────────────────

function capString(value, max) {
  if (value.length <= max) return value;
  let out = value.slice(0, max);
  const last = out.charCodeAt(out.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
  return out;
}

function cleanText(value, max) {
  if (typeof value !== "string") return null;
  const text = value.replace(CONTROL_CHARS_RE, " ").replace(/\s+/g, " ").trim();
  if (!text) return null;
  return capString(text, max) || null;
}

function isWorkshopId(value) {
  return typeof value === "string" && WORKSHOP_ID_RE.test(value);
}

function idFromUnknown(value) {
  if (typeof value === "string") return isWorkshopId(value) ? value : null;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    const text = String(value);
    return WORKSHOP_ID_RE.test(text) ? text : null;
  }
  return null;
}

function normalizeIds(workshopIds) {
  let list = [];
  if (Array.isArray(workshopIds)) list = workshopIds;
  else if (
    workshopIds &&
    typeof workshopIds === "object" &&
    typeof workshopIds[Symbol.iterator] === "function"
  ) {
    list = [...workshopIds];
  }
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    if (out.length >= MAX_REQUEST_IDS) break;
    const id = idFromUnknown(raw);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function isPartStale(timestamp, now) {
  if (typeof timestamp !== "number") return true;
  const age = now - timestamp;
  // A timestamp far in the future (clock moved back) is not trusted either.
  return age > limits.ttlMs || age < -limits.ttlMs;
}

function needsDetails(entry, now) {
  return !entry || isPartStale(entry.detailsAt, now);
}

function needsRequires(entry, now) {
  return !entry || isPartStale(entry.requiresAt, now);
}

function recentlyFailed(entry, now) {
  return (
    !!entry &&
    typeof entry.failedAt === "number" &&
    now - entry.failedAt >= 0 &&
    now - entry.failedAt < limits.refreshMinIntervalMs
  );
}

function newEntry(workshopId, now) {
  return {
    workshopId,
    title: null,
    tags: [],
    requires: null,
    requiresSource: null,
    modIdOrder: [],
    detailsAt: null,
    requiresAt: null,
    failedAt: null,
    usedAt: now,
  };
}

function cloneEntry(entry) {
  return {
    ...entry,
    tags: [...entry.tags],
    requires: entry.requires ? entry.requires.map((r) => ({ ...r })) : null,
    modIdOrder: [...entry.modIdOrder],
  };
}

function safeMessage(err, secret) {
  let message;
  if (err?.name === "AbortError") message = "timed out";
  else message = String(err?.message || err || "unknown error");
  if (secret) message = message.split(secret).join("[redacted]");
  return capString(message.replace(CONTROL_CHARS_RE, " "), 200);
}

function delay(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

// ─── Pure parsers ───────────────────────────────────────────────────────────

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(text) {
  return text.replace(
    /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/g,
    (match, dec, hex, name) => {
      if (name) return NAMED_ENTITIES[name];
      const code = dec !== undefined ? parseInt(dec, 10) : parseInt(hex, 16);
      if (
        !Number.isFinite(code) ||
        code <= 0 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        return match;
      }
      return String.fromCodePoint(code);
    },
  );
}

function isWhitespaceCode(charCode) {
  return charCode === 32 || charCode === 9 || charCode === 10 || charCode === 13 || charCode === 12;
}

// "<div" + whitespace, ">" or "/" (case-insensitive).
function isOpenDivAt(text, i) {
  if (text.slice(i, i + 4).toLowerCase() !== "<div") return false;
  const next = text.charCodeAt(i + 4);
  return isWhitespaceCode(next) || next === 62 || next === 47;
}

function isCloseDivAt(text, i) {
  if (text.slice(i, i + 5).toLowerCase() !== "</div") return false;
  const next = text.charCodeAt(i + 5);
  return isWhitespaceCode(next) || next === 62;
}

/**
 * Locate the RequiredItems container. Returns
 * { kind: "none" } when the page has none,
 * { kind: "giveup" } when one was found but its end could not be determined,
 * { kind: "found", start, end } with the content range otherwise.
 */
function findRequiredItemsContainer(text) {
  const needles = ['id="RequiredItems"', "id='RequiredItems'"];
  const positions = [];
  for (const needle of needles) {
    let from = 0;
    while (positions.length < MAX_CONTAINER_CANDIDATES * 2) {
      const idx = text.indexOf(needle, from);
      if (idx === -1) break;
      positions.push(idx);
      from = idx + needle.length;
    }
  }
  positions.sort((a, b) => a - b);

  let candidates = 0;
  for (const idx of positions) {
    if (candidates >= MAX_CONTAINER_CANDIDATES) break;
    candidates++;
    // The attribute must be its own attribute (not data-id=...).
    if (idx === 0 || !isWhitespaceCode(text.charCodeAt(idx - 1))) continue;
    const windowStart = Math.max(0, idx - 2048);
    const before = text.slice(windowStart, idx);
    const ltRel = before.lastIndexOf("<");
    if (ltRel === -1 || before.indexOf(">", ltRel) !== -1) continue;
    const lt = windowStart + ltRel;
    if (!isOpenDivAt(text, lt)) continue;
    const after = text.slice(idx, idx + 4096);
    const gtRel = after.indexOf(">");
    if (gtRel === -1) return { kind: "giveup" };
    const contentStart = idx + gtRel + 1;
    const limit = Math.min(text.length, contentStart + CONTAINER_SCAN_CHARS);

    let depth = 1;
    let pos = contentStart;
    while (pos < limit) {
      const open = text.indexOf("<", pos);
      if (open === -1 || open >= limit) return { kind: "giveup" };
      if (text.startsWith("<!--", open)) {
        const endComment = text.indexOf("-->", open + 4);
        if (endComment === -1 || endComment >= limit) return { kind: "giveup" };
        pos = endComment + 3;
        continue;
      }
      const closing = isCloseDivAt(text, open);
      if (closing || isOpenDivAt(text, open)) {
        const gt = text.indexOf(">", open);
        if (gt === -1 || gt >= limit) return { kind: "giveup" };
        if (closing) {
          depth--;
          if (depth === 0) return { kind: "found", start: contentStart, end: open };
        } else {
          depth++;
        }
        pos = gt + 1;
        continue;
      }
      pos = open + 1;
    }
    return { kind: "giveup" };
  }
  return { kind: "none" };
}

// Linear tag stripper: drops tags, and <script>/<style> elements whole.
function stripTags(html) {
  let out = "";
  let pos = 0;
  while (pos < html.length) {
    const lt = html.indexOf("<", pos);
    if (lt === -1) {
      out += html.slice(pos);
      break;
    }
    out += html.slice(pos, lt) + " ";
    const head = html.slice(lt, lt + 8).toLowerCase();
    const raw = /^<(script|style)[\s>/]/.exec(head);
    if (raw) {
      const closeRe = raw[1] === "script" ? /<\/script\s*>/gi : /<\/style\s*>/gi;
      closeRe.lastIndex = lt;
      const close = closeRe.exec(html);
      if (!close) break;
      pos = close.index + close[0].length;
      continue;
    }
    const gt = html.indexOf(">", lt);
    if (gt === -1) break; // unterminated tag: drop the rest
    pos = gt + 1;
  }
  return out;
}

function hrefFromTag(tag) {
  const m = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(tag);
  if (!m) return null;
  return m[1] ?? m[2] ?? m[3] ?? null;
}

/**
 * Parse the "Required items" of a Workshop item page.
 * @returns {{ workshopId: string, title: string|null }[] | null} null when the
 *   text does not look like a Workshop item page (or the container could not
 *   be delimited), [] when the page lists no required items.
 */
export function parseRequiredItemsFromPage(html, selfId) {
  if (typeof html !== "string") return null;
  const text = html.length > MAX_PARSE_CHARS ? html.slice(0, MAX_PARSE_CHARS) : html;
  const looksLikePage =
    text.includes("workshopItemTitle") ||
    text.includes('id="RequiredItems"') ||
    text.includes("id='RequiredItems'");
  if (!looksLikePage) return null;

  const container = findRequiredItemsContainer(text);
  if (container.kind === "none") return [];
  if (container.kind === "giveup") return null;

  const self = selfId === undefined || selfId === null ? null : String(selfId);
  const region = text.slice(container.start, container.end);
  const out = [];
  const seen = new Set();
  const closeAnchor = /<\/a\s*>/gi;
  let pos = 0;
  while (pos < region.length && out.length < limits.maxRequiredPerItem) {
    const lt = region.indexOf("<", pos);
    if (lt === -1) break;
    const c1 = region.charCodeAt(lt + 1);
    const c2 = region.charCodeAt(lt + 2);
    const isAnchor = (c1 === 97 || c1 === 65) && (isWhitespaceCode(c2) || c2 === 62);
    if (!isAnchor) {
      pos = lt + 1;
      continue;
    }
    const gt = region.indexOf(">", lt);
    if (gt === -1) break;
    const tag = region.slice(lt, gt + 1);
    closeAnchor.lastIndex = gt + 1;
    const close = closeAnchor.exec(region);
    const innerEnd = close ? close.index : region.length;
    const inner = region.slice(gt + 1, innerEnd);
    pos = close ? close.index + close[0].length : region.length;

    const rawHref = hrefFromTag(tag);
    if (rawHref === null) continue;
    const href = rawHref.replace(/&amp;/g, "&");
    const m = REQUIRED_HREF_RE.exec(href);
    if (!m) continue;
    const workshopId = m[1];
    if (!WORKSHOP_ID_RE.test(workshopId)) continue;
    if (workshopId === self || seen.has(workshopId)) continue;
    seen.add(workshopId);
    out.push({
      workshopId,
      title: cleanText(decodeEntities(stripTags(inner)), limits.maxTitle),
    });
  }
  return out;
}

const MOD_ID_LABEL_SOURCE = "mod\\s*id\\s*[:=]\\s*";
// BBCode wrapped around the label or the value: "[b]Mod ID:[/b] foo".
const BBCODE_TAG_RE = /^\[\/?[A-Za-z*]{1,10}\]\s*/;

/**
 * Every value after "Mod ID:" / "ModID:" / "Mod Id =" in a description, in
 * order. The value runs to the end of the line or the next "[" / "<".
 * @returns {string[]}
 */
export function parseModIdOrderFromDescription(text) {
  if (typeof text !== "string") return [];
  const src = text.length > MAX_DESCRIPTION_CHARS ? text.slice(0, MAX_DESCRIPTION_CHARS) : text;
  const label = new RegExp(MOD_ID_LABEL_SOURCE, "gi");
  const out = [];
  const seen = new Set();
  let m;
  while (out.length < limits.maxModIdOrder && (m = label.exec(src)) !== null) {
    let start = label.lastIndex;
    for (let i = 0; i < 4; i++) {
      const tag = BBCODE_TAG_RE.exec(src.slice(start, start + 32));
      if (!tag) break;
      start += tag[0].length;
    }
    // A valid value is at most 100 characters, so the scan is bounded.
    const scanLimit = Math.min(src.length, start + MAX_MOD_ID_SCAN);
    let end = start;
    while (end < scanLimit) {
      const code = src.charCodeAt(end);
      if (code === 10 || code === 13 || code === 91 || code === 60) break;
      end++;
    }
    const value = src.slice(start, end).trim();
    if (MOD_ID_VALUE_RE.test(value)) {
      if (!seen.has(value)) {
        seen.add(value);
        out.push(value);
      }
      label.lastIndex = Math.max(end, label.lastIndex);
    } else {
      // Not a value: look for the next label right after this one, so an
      // empty "Mod ID:" line does not swallow the label on the next line.
      label.lastIndex = Math.max(start, m.index + 1);
    }
  }
  return out;
}

// ─── Validation of Steam answers and persisted entries ──────────────────────

function cleanTags(rawTags) {
  if (!Array.isArray(rawTags)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of rawTags) {
    if (out.length >= limits.maxTags) break;
    const value = typeof raw === "string" ? raw : raw && typeof raw === "object" ? raw.tag : null;
    if (typeof value !== "string") continue;
    const tag = value.replace(CONTROL_CHARS_RE, " ").trim();
    if (!tag || tag.length > limits.maxTagLength || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

function cleanModIdOrder(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const value of raw) {
    if (out.length >= limits.maxModIdOrder) break;
    if (typeof value !== "string" || !MOD_ID_VALUE_RE.test(value) || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function cleanRequires(raw, selfId) {
  if (!Array.isArray(raw)) return null;
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (out.length >= limits.maxRequiredPerItem) break;
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const id = item.workshopId;
    if (!isWorkshopId(id) || id === selfId || seen.has(id)) continue;
    seen.add(id);
    out.push({ workshopId: id, title: cleanText(item.title, limits.maxTitle) });
  }
  return out;
}

function cleanTimestamp(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function validateEntry(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  if (!isWorkshopId(raw.workshopId)) return null;
  const id = raw.workshopId;
  const entry = newEntry(id, 0);
  entry.detailsAt = cleanTimestamp(raw.detailsAt);
  entry.requiresAt = cleanTimestamp(raw.requiresAt);
  entry.failedAt = cleanTimestamp(raw.failedAt);
  entry.usedAt = typeof raw.usedAt === "number" && Number.isFinite(raw.usedAt) && raw.usedAt >= 0
    ? raw.usedAt
    : 0;
  if (entry.detailsAt !== null) {
    entry.title = cleanText(raw.title, limits.maxTitle);
    entry.tags = cleanTags(raw.tags);
    entry.modIdOrder = cleanModIdOrder(raw.modIdOrder);
  }
  if (entry.requiresAt !== null) {
    entry.requires = cleanRequires(raw.requires, id);
    if (entry.requires === null) entry.requiresAt = null;
    else entry.requiresSource =
      raw.requiresSource === "api" || raw.requiresSource === "page" ? raw.requiresSource : null;
  }
  if (entry.detailsAt === null && entry.requiresAt === null && entry.failedAt === null) return null;
  return entry;
}

// ─── Cache, LRU and persistence ─────────────────────────────────────────────

function storePath() {
  return path.join(getDataPaths().dataDir, STORE_FILE);
}

function loadFromDisk() {
  const map = new Map();
  let raw;
  try {
    const file = storePath();
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_STORE_BYTES) {
      log.debug("Steam knowledge store ignored (not a file or too large)");
      return map;
    }
    raw = fs.readFileSync(file, "utf-8");
  } catch (err) {
    if (err?.code !== "ENOENT") {
      log.debug(`Steam knowledge store unreadable, starting empty: ${safeMessage(err)}`);
    }
    return map;
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.debug(`Steam knowledge store is corrupt, starting empty: ${safeMessage(err)}`);
    return map;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    parsed.schema !== STORE_SCHEMA ||
    !Array.isArray(parsed.items)
  ) {
    log.debug("Steam knowledge store has an unknown shape, starting empty");
    return map;
  }
  const valid = [];
  for (const item of parsed.items) {
    const entry = validateEntry(item);
    if (entry) valid.push(entry);
  }
  valid.sort((a, b) => b.usedAt - a.usedAt);
  for (const entry of valid) {
    if (map.size >= limits.maxItems) break;
    if (!map.has(entry.workshopId)) map.set(entry.workshopId, entry);
  }
  return map;
}

function ensureLoaded() {
  if (loaded) return;
  loaded = true;
  cache = loadFromDisk();
}

function writeNow() {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!persistDirty) return;
  persistDirty = false;
  try {
    const payload = { schema: STORE_SCHEMA, items: [...cache.values()] };
    writeFileAtomic(storePath(), JSON.stringify(payload));
  } catch (err) {
    persistDirty = true;
    log.debug(`Steam knowledge store not saved: ${safeMessage(err)}`);
  }
}

function schedulePersist() {
  persistDirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(writeNow, PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
}

function evictIfNeeded() {
  if (cache.size <= limits.maxItems) return;
  const byUse = [...cache.values()].sort((a, b) => a.usedAt - b.usedAt);
  let excess = cache.size - limits.maxItems;
  for (const entry of byUse) {
    if (excess <= 0) break;
    cache.delete(entry.workshopId);
    excess--;
  }
}

function markUsed(ids, now) {
  let moved = false;
  for (const id of ids) {
    const entry = cache.get(id);
    if (!entry) continue;
    if (now - entry.usedAt > USED_PERSIST_THRESHOLD_MS) moved = true;
    entry.usedAt = now;
  }
  if (moved) schedulePersist();
}

function getOrCreate(id, now) {
  let entry = cache.get(id);
  if (!entry) {
    entry = newEntry(id, now);
    cache.set(id, entry);
  }
  return entry;
}

// ─── Status ─────────────────────────────────────────────────────────────────

function sourceFor(ids) {
  if (keyConfigured === true) return "api";
  if (keyConfigured === false) return "page";
  // Key state unknown (no fetch yet in this process): go by the data.
  for (const id of ids) {
    if (cache.get(id)?.requiresSource === "api") return "api";
  }
  return "page";
}

function snapshot(ids, { rateLimited = false } = {}) {
  const now = Date.now();
  const items = new Map();
  let known = 0;
  let stale = false;
  let oldest = null;
  for (const id of ids) {
    const entry = cache.get(id);
    if (entry) items.set(id, cloneEntry(entry));
    if (entry && (entry.detailsAt !== null || entry.requiresAt !== null)) {
      known++;
      const times = [entry.detailsAt, entry.requiresAt].filter((t) => t !== null);
      const older = Math.min(...times);
      if (oldest === null || older < oldest) oldest = older;
    }
    if (needsDetails(entry, now) || needsRequires(entry, now)) stale = true;
  }
  const status = {
    source: known === 0 ? "none" : sourceFor(ids),
    fetchedAt: oldest === null ? null : new Date(oldest).toISOString(),
    stale,
    failed: lastRunFailed,
    pending: fillPromise !== null,
  };
  if (rateLimited) status.rateLimited = true;
  status.known = known;
  status.total = ids.length;
  return { items, status };
}

async function readApiKey() {
  try {
    const key = await getSteamApiKey();
    const usable = typeof key === "string" && key.length >= 10 ? key : null;
    keyConfigured = usable !== null;
    return usable;
  } catch (err) {
    log.debug(`Steam API key unavailable: ${safeMessage(err)}`);
    keyConfigured = false;
    return null;
  }
}

function probeKeyInBackground() {
  if (keyConfigured !== null || keyProbe) return;
  const probeEpoch = epoch;
  keyProbe = readApiKey()
    .catch(() => null)
    .finally(() => {
      if (probeEpoch === epoch) keyProbe = null;
    });
}

// ─── Network ────────────────────────────────────────────────────────────────

function abortError() {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

// Settle on abort even when the underlying promise ignores the signal.
function raceAbort(promise, signal) {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(abortError());
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {});
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

function discardBody(res) {
  try {
    const pending = res.body?.cancel?.();
    if (pending && typeof pending.catch === "function") pending.catch(() => {});
  } catch {
    /* nothing to release */
  }
}

async function readBodyCapped(res, maxBytes, signal) {
  const body = res.body;
  if (body && typeof body.getReader === "function") {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (total < maxBytes) {
        const { done, value } = await raceAbort(reader.read(), signal);
        if (done) break;
        if (!value || !value.byteLength) continue;
        const take = Math.min(value.byteLength, maxBytes - total);
        chunks.push(take === value.byteLength ? value : value.subarray(0, take));
        total += take;
      }
    } finally {
      try {
        const cancelled = reader.cancel();
        if (cancelled && typeof cancelled.catch === "function") cancelled.catch(() => {});
      } catch {
        /* already released */
      }
    }
    return new TextDecoder("utf-8").decode(Buffer.concat(chunks));
  }
  const text = await raceAbort(Promise.resolve(res.text()), signal);
  return text.length > maxBytes ? text.slice(0, maxBytes) : text;
}

function runExpired(run) {
  return run.expired || run.epoch !== epoch || Date.now() >= run.deadline;
}

function expireRun(run) {
  run.expired = true;
  for (const controller of run.controllers) controller.abort();
  run.controllers.clear();
}

/**
 * One request under the run's budget and the per-request timeout. The
 * handler reads the body inside the same window, so a slow body is cut too.
 */
async function withRequest(run, url, init, handler) {
  if (runExpired(run)) throw new SkipSignal();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.fetchTimeoutMs);
  timer.unref?.();
  run.controllers.add(controller);
  try {
    const res = await raceAbort(
      Promise.resolve(globalThis.fetch(url, { ...init, signal: controller.signal })),
      controller.signal,
    );
    return await handler(res, controller.signal);
  } catch (err) {
    if (run.expired || run.epoch !== epoch) throw new SkipSignal();
    throw err;
  } finally {
    clearTimeout(timer);
    run.controllers.delete(controller);
  }
}

async function readJson(res, signal) {
  if (!res.ok) {
    discardBody(res);
    throw new Error(`HTTP ${res.status}`);
  }
  return JSON.parse(await readBodyCapped(res, API_MAX_BYTES, signal));
}

function noteFailure(run, ids, what, err, secret) {
  if (run.epoch !== epoch) return;
  run.failed = true;
  const now = Date.now();
  for (const id of ids) getOrCreate(id, now).failedAt = now;
  log.debug(`Steam knowledge: ${what} failed: ${safeMessage(err, secret)}`);
}

function responseItems(data) {
  const list = data?.response?.publishedfiledetails;
  return Array.isArray(list) ? list : null;
}

function applyDetails(run, id, item) {
  if (run.epoch !== epoch) return;
  const now = Date.now();
  const entry = getOrCreate(id, now);
  entry.title = cleanText(item.title, limits.maxTitle);
  entry.tags = cleanTags(item.tags);
  entry.modIdOrder = parseModIdOrderFromDescription(item.description);
  entry.detailsAt = now;
}

function applyRequires(run, id, requires, source) {
  if (run.epoch !== epoch) return;
  const now = Date.now();
  const entry = getOrCreate(id, now);
  entry.requires = requires;
  entry.requiresSource = source;
  entry.requiresAt = now;
}

async function runDetails(run, ids) {
  for (let i = 0; i < ids.length; i += limits.detailsBatch) {
    if (runExpired(run)) return;
    const batch = ids.slice(i, i + limits.detailsBatch);
    const params = new URLSearchParams();
    params.set("itemcount", String(batch.length));
    batch.forEach((id, idx) => params.set(`publishedfileids[${idx}]`, id));
    let data;
    try {
      data = await withRequest(
        run,
        DETAILS_URL,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": USER_AGENT,
          },
          body: params.toString(),
          redirect: "error",
        },
        readJson,
      );
    } catch (err) {
      if (err instanceof SkipSignal) return;
      noteFailure(run, batch, "details batch", err);
      continue;
    }
    const list = responseItems(data);
    if (!list) {
      noteFailure(run, batch, "details batch", new Error("unexpected response shape"));
      continue;
    }
    const waiting = new Set(batch);
    const failedIds = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const id = idFromUnknown(item.publishedfileid);
      if (id === null || !waiting.has(id)) continue;
      waiting.delete(id);
      if (item.result === 1) applyDetails(run, id, item);
      else failedIds.push(id);
    }
    failedIds.push(...waiting);
    if (failedIds.length) {
      noteFailure(run, failedIds, "details", new Error(`${failedIds.length} item(s) unavailable`));
    }
  }
}

function requiredFromChildren(children, selfId) {
  if (!Array.isArray(children)) return [];
  const out = [];
  const seen = new Set();
  for (const child of children) {
    if (out.length >= limits.maxRequiredPerItem) break;
    if (!child || typeof child !== "object" || child.file_type !== 0) continue;
    const id = idFromUnknown(child.publishedfileid);
    if (id === null || id === selfId || seen.has(id)) continue;
    seen.add(id);
    out.push({ workshopId: id, title: null });
  }
  return out;
}

async function runRequiresApi(run, ids, apiKey) {
  for (let i = 0; i < ids.length; i += limits.detailsBatch) {
    if (runExpired(run)) return;
    const batch = ids.slice(i, i + limits.detailsBatch);
    const params = new URLSearchParams({ key: apiKey, includechildren: "true" });
    batch.forEach((id, idx) => params.append(`publishedfileids[${idx}]`, id));
    let data;
    try {
      // The URL carries the key: never log it.
      data = await withRequest(
        run,
        `${API_CHILDREN_URL}?${params}`,
        { method: "GET", headers: { "User-Agent": USER_AGENT }, redirect: "error" },
        readJson,
      );
    } catch (err) {
      if (err instanceof SkipSignal) return;
      noteFailure(run, batch, "required items batch", err, apiKey);
      continue;
    }
    const list = responseItems(data);
    if (!list) {
      noteFailure(run, batch, "required items batch", new Error("unexpected response shape"));
      continue;
    }
    const waiting = new Set(batch);
    const failedIds = [];
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const id = idFromUnknown(item.publishedfileid);
      if (id === null || !waiting.has(id)) continue;
      waiting.delete(id);
      if (item.result === 1) applyRequires(run, id, requiredFromChildren(item.children, id), "api");
      else failedIds.push(id);
    }
    failedIds.push(...waiting);
    if (failedIds.length) {
      noteFailure(run, failedIds, "required items", new Error(`${failedIds.length} item(s) unavailable`));
    }
  }
}

function redirectTarget(currentUrl, location) {
  if (typeof location !== "string" || !location) throw new Error("redirect without a location");
  let next;
  try {
    next = new URL(location, currentUrl);
  } catch {
    throw new Error("redirect to an invalid location");
  }
  if (
    next.protocol !== "https:" ||
    next.hostname !== PAGE_HOST ||
    next.port !== "" ||
    next.username !== "" ||
    next.password !== ""
  ) {
    throw new Error("redirect off steamcommunity.com refused");
  }
  return next.href;
}

async function fetchPageRequires(run, id) {
  let url = `https://${PAGE_HOST}/sharedfiles/filedetails/?id=${id}`;
  let html;
  try {
    let redirects = 0;
    for (;;) {
      const currentUrl = url;
      const step = await withRequest(
        run,
        currentUrl,
        {
          method: "GET",
          headers: { "Accept-Language": "en", "User-Agent": USER_AGENT },
          redirect: "manual",
        },
        async (res, signal) => {
          if (res.status >= 300 && res.status < 400) {
            const location = res.headers?.get?.("location") ?? null;
            discardBody(res);
            return { location };
          }
          if (!res.ok) {
            discardBody(res);
            throw new Error(`HTTP ${res.status}`);
          }
          return { html: await readBodyCapped(res, limits.maxPageBytes, signal) };
        },
      );
      if (typeof step.html === "string") {
        html = step.html;
        break;
      }
      if (redirects >= MAX_REDIRECTS) throw new Error("too many redirects");
      redirects++;
      url = redirectTarget(currentUrl, step.location);
    }
  } catch (err) {
    if (err instanceof SkipSignal) return;
    noteFailure(run, [id], `Workshop page ${id}`, err);
    return;
  }
  const requires = parseRequiredItemsFromPage(html, id);
  if (requires === null) {
    noteFailure(run, [id], `Workshop page ${id}`, new Error("not a Workshop item page"));
    return;
  }
  applyRequires(run, id, requires, "page");
}

async function runRequiresPages(run, ids) {
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      if (runExpired(run)) return;
      const id = ids[next++];
      await fetchPageRequires(run, id);
    }
  };
  const workers = Math.max(1, Math.min(limits.concurrency, ids.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

async function runFetch(ids, { refresh, budgetMs, apiKey }) {
  const now = Date.now();
  const detailIds = [];
  const requireIds = [];
  for (const id of ids) {
    const entry = cache.get(id);
    if (refresh || needsDetails(entry, now)) detailIds.push(id);
    if (refresh || needsRequires(entry, now)) requireIds.push(id);
  }
  if (!detailIds.length && !requireIds.length) return;

  const run = {
    epoch,
    deadline: now + budgetMs,
    expired: false,
    failed: false,
    controllers: new Set(),
  };
  activeRuns.add(run);
  const deadlineTimer = setTimeout(() => expireRun(run), budgetMs);
  deadlineTimer.unref?.();
  try {
    await Promise.all([
      detailIds.length ? runDetails(run, detailIds) : null,
      requireIds.length
        ? apiKey
          ? runRequiresApi(run, requireIds, apiKey)
          : runRequiresPages(run, requireIds)
        : null,
    ]);
  } finally {
    clearTimeout(deadlineTimer);
    activeRuns.delete(run);
  }
  if (run.epoch !== epoch) return;
  lastRunFailed = run.failed;
  evictIfNeeded();
  schedulePersist();
}

function normalizeBudget(budgetMs) {
  if (typeof budgetMs !== "number" || !Number.isFinite(budgetMs)) return limits.budgetMs;
  return Math.min(Math.max(0, budgetMs), MAX_BUDGET_MS);
}

async function waitAtMost(promise, ms) {
  if (ms <= 0) return;
  await Promise.race([promise.then(() => {}, () => {}), delay(ms)]);
}

async function fetchCore(ids, { refresh, budgetMs, waitForFill }) {
  const startedAt = Date.now();
  if (!ids.length) return snapshot(ids);
  const apiKey = await readApiKey();
  if (refresh) {
    const since = lastRefreshStartedAt === null ? null : startedAt - lastRefreshStartedAt;
    if (since !== null && since >= 0 && since < limits.refreshMinIntervalMs) {
      markUsed(ids, startedAt);
      return snapshot(ids, { rateLimited: true });
    }
    lastRefreshStartedAt = startedAt;
  } else if (waitForFill && fillPromise) {
    // A background fill is already fetching (most likely) the same ids:
    // let it finish within this call's budget instead of asking twice.
    await waitAtMost(fillPromise, budgetMs);
  }
  markUsed(ids, Date.now());
  const remaining = budgetMs - (Date.now() - startedAt);
  if (remaining > 0) await runFetch(ids, { refresh, budgetMs: remaining, apiKey });
  return snapshot(ids);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Cache-only view. Loads the persisted store on first use.
 * @returns {{ items: Map<string, object>, status: object }}
 */
export function peekSteamKnowledge(workshopIds) {
  try {
    ensureLoaded();
    const ids = normalizeIds(workshopIds);
    markUsed(ids, Date.now());
    probeKeyInBackground();
    return snapshot(ids);
  } catch (err) {
    log.debug(`Steam knowledge peek failed: ${safeMessage(err)}`);
    return snapshot([]);
  }
}

/**
 * Fetch what is missing or stale (everything with refresh: true, at most
 * once per refreshMinIntervalMs), within budgetMs. Never throws.
 */
export async function fetchSteamKnowledge(
  workshopIds,
  { refresh = false, budgetMs = limits.budgetMs } = {},
) {
  let ids = [];
  try {
    ensureLoaded();
    ids = normalizeIds(workshopIds);
    return await fetchCore(ids, {
      refresh: refresh === true,
      budgetMs: normalizeBudget(budgetMs),
      waitForFill: true,
    });
  } catch (err) {
    log.debug(`Steam knowledge fetch failed: ${safeMessage(err)}`);
    lastRunFailed = true;
    try {
      return snapshot(ids);
    } catch {
      return snapshot([]);
    }
  }
}

/**
 * Start a background fill for the missing/stale ids unless one is running.
 * Ids that failed less than refreshMinIntervalMs ago are left for later.
 * @returns {boolean} whether a fill was started
 */
export function startSteamKnowledgeFill(workshopIds) {
  try {
    if (fillPromise) return false;
    ensureLoaded();
    const now = Date.now();
    const wanted = normalizeIds(workshopIds).filter((id) => {
      const entry = cache.get(id);
      return (needsDetails(entry, now) || needsRequires(entry, now)) && !recentlyFailed(entry, now);
    });
    if (!wanted.length) return false;
    const fillEpoch = epoch;
    const promise = fetchCore(wanted, {
      refresh: false,
      budgetMs: limits.budgetMs,
      waitForFill: false,
    })
      .catch((err) => {
        if (fillEpoch === epoch) lastRunFailed = true;
        log.debug(`Steam knowledge fill failed: ${safeMessage(err)}`);
      })
      .finally(() => {
        if (fillPromise === promise) fillPromise = null;
      });
    fillPromise = promise;
    return true;
  } catch (err) {
    log.debug(`Steam knowledge fill not started: ${safeMessage(err)}`);
    return false;
  }
}

/** Wait for a running fill, then write any pending change to disk now. */
export async function flushSteamKnowledge() {
  if (fillPromise) await fillPromise.catch(() => {});
  writeNow();
}

export function _resetSteamKnowledgeForTests() {
  epoch++;
  for (const run of activeRuns) expireRun(run);
  activeRuns.clear();
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  persistDirty = false;
  cache = new Map();
  loaded = false;
  lastRefreshStartedAt = null;
  lastRunFailed = false;
  fillPromise = null;
  keyConfigured = null;
  keyProbe = null;
  limits = { ...STEAM_KNOWLEDGE_LIMITS };
}

export function _setSteamKnowledgeLimitsForTests(partialLimits = {}) {
  for (const [key, value] of Object.entries(partialLimits || {})) {
    if (!Object.prototype.hasOwnProperty.call(STEAM_KNOWLEDGE_LIMITS, key)) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    limits[key] = value;
  }
}
