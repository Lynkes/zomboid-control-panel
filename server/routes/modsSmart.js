import express from "express";
import fs from "fs";
import { createLogger } from "../utils/logger.js";
import { requirePermission } from "../services/permissions.js";
import { ErrorCode } from "../utils/errorCodes.js";
import { sanitizeError, sanitizeErrorParams } from "../utils/sanitize.js";
import { backupWarningFor } from "../utils/configBackup.js";
import { readTextFile } from "../utils/modIni.js";
import { createModOrderRule, deleteModOrderRule, getModOrderRules } from "../database/init.js";
import {
  MOD_ORDER_RULE_LIMITS,
  cleanRuleModId,
  findOrderRuleCycle,
  normalizeOrderRule,
  usableOrderRules,
  validateOrderRuleInput,
} from "../utils/modOrderRules.js";
import { HEALTH_FIX_ACTIONS, computeModHealth, findHealthFix, isHealthIssueId } from "../utils/modHealth.js";
import { applyModListFix } from "../services/modIniEdit.js";
import {
  buildModInsights,
  changesLoading,
  loadHealthExtras,
  loadModSmartContext,
  planFor,
  requireEdgesOf,
} from "../services/modSmartContext.js";
import { fetchSteamKnowledge, peekSteamKnowledge, startSteamKnowledgeFill } from "../services/modSteamKnowledge.js";
import {
  cachedConflictPairs,
  getActiveServerPaths,
  getSanitizedIniPath,
  locateModsOnDisk,
  resolveActiveServerIniOrRespond,
  withIniLock,
  writeIniWithBackup,
} from "./mods.js";

// Smart load order for the Mods page, mounted at /api/mods next to
// routes/mods.js (whose 10k lines this keeps out of):
//   GET    /order-rules            the stored order rules
//   POST   /order-rules            pin "load `before` before `after`"
//   DELETE /order-rules/:id
//   POST   /load-order/plan        the best order for Mods= and why
//   GET    /health                 what is wrong with the mod list
//   POST   /health/fix             apply one of an issue's own fixes
//   GET    /insights               what the panel makes of each mod
// Pure logic lives in utils/ (modSmartSort, modClassification, modHealth,
// modOrderRules); disk reads in services/modSmartContext.js. Writes go
// through routes/mods.js's ini lock and backup-before-write wrapper (which
// also keeps PanelBridge's managed entries), like every other mod edit.

const log = createLogger("API:Mods");
const router = express.Router();

// Same capability as every route of routes/mods.js (reads like GET
// /current-config, writes like the /groups writes): mods.manage. On each
// route, not router.use(): this router shares /api/mods with routes/mods.js,
// and a router-wide gate would also catch the requests meant for that file's
// unauthenticated /thumbnail/:workshopId (see its router.use comment).
const requireModsManage = requirePermission("mods.manage");

const PLAN_LIMITS = Object.freeze({ maxOrder: 2000, maxConflictPairs: 20_000 });
const FIX_PARAMS_MAX_CHARS = 20_000;

function respondInvalid(res, code, field, message) {
  return res.status(400).json({ error: message, code, params: sanitizeErrorParams({ field }) });
}

// The active server's ini and install folder without answering an error:
// order rules work without a server, they only lose the require= check.
async function quietActiveIni() {
  try {
    const { serverConfigPath, serverName, serverPath } = await getActiveServerPaths();
    const iniPath = getSanitizedIniPath(serverConfigPath, serverName);
    if (!iniPath || !fs.existsSync(iniPath)) return null;
    return { iniPath, serverPath };
  } catch {
    return null;
  }
}

function steamStatusFor(ctx) {
  return peekSteamKnowledge(ctx.workshopItems).status;
}

// ─── Order rules ──────────────────────────────────────────────────────────

router.get("/order-rules", requireModsManage, async (req, res) => {
  try {
    const rules = (await getModOrderRules()).map(normalizeOrderRule);
    res.json({ rules, max: MOD_ORDER_RULE_LIMITS.maxRules });
  } catch (error) {
    log.error(`Failed to get mod order rules: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Body { before, after, note?, source?, replaceOpposite? }. A rule that is
// stored already comes back with existing: true (200). With replaceOpposite
// a stored rule the other way round is replaced (resolving a conflict the
// other way). A rule that would close a loop with the stored rules and the
// require= links of the active server's mods is refused (409).
router.post("/order-rules", requireModsManage, async (req, res) => {
  try {
    const parsed = validateOrderRuleInput(req.body);
    if (!parsed.ok) {
      return respondInvalid(res, ErrorCode.MODS_ORDER_RULE_INVALID, parsed.field, `Invalid order rule: ${parsed.field}`);
    }
    const replaceOpposite = req.body?.replaceOpposite;
    if (replaceOpposite !== undefined && typeof replaceOpposite !== "boolean") {
      return respondInvalid(res, ErrorCode.MODS_ORDER_RULE_INVALID, "replaceOpposite", "Invalid order rule: replaceOpposite");
    }
    const candidate = parsed.value;

    let requireEdges = [];
    const active = await quietActiveIni();
    if (active) {
      const ctx = await loadModSmartContext({ content: readTextFile(active.iniPath), serverPath: active.serverPath });
      requireEdges = requireEdgesOf(ctx);
    }

    const stored = usableOrderRules(await getModOrderRules());
    const opposite = replaceOpposite
      ? stored.filter((r) => r.before === candidate.after && r.after === candidate.before).map((r) => r.id)
      : [];
    const result = await createModOrderRule(
      { ...candidate, createdBy: req.user?.username || null },
      {
        maxRules: MOD_ORDER_RULE_LIMITS.maxRules,
        replaceIds: opposite,
        check: (kept) => {
          const duplicate = usableOrderRules(kept).find((r) => r.before === candidate.before && r.after === candidate.after);
          if (duplicate) return { duplicate };
          const cycle = findOrderRuleCycle({ rules: kept, requireEdges, candidate });
          return cycle ? { cycle } : null;
        },
      },
    );
    if (result.limit) {
      return res.status(409).json({
        error: `At most ${MOD_ORDER_RULE_LIMITS.maxRules} order rules can be kept`,
        code: ErrorCode.MODS_ORDER_RULE_LIMIT,
        params: sanitizeErrorParams({ max: MOD_ORDER_RULE_LIMITS.maxRules }),
      });
    }
    if (result.refused?.duplicate) {
      return res.json({ rule: normalizeOrderRule(result.refused.duplicate), existing: true, replaced: [] });
    }
    if (result.refused?.cycle) {
      const { cycle, edges } = result.refused.cycle;
      return res.status(409).json({
        error: "This rule would make a loop with other rules or required mods",
        code: ErrorCode.MODS_ORDER_RULE_CYCLE,
        params: sanitizeErrorParams({ count: cycle.length - 1 }),
        details: { cycle, edges },
      });
    }
    log.info(`Added mod order rule: ${candidate.before} before ${candidate.after} (${candidate.source})`);
    res.status(201).json({ rule: normalizeOrderRule(result.rule), existing: false, replaced: opposite });
  } catch (error) {
    log.error(`Failed to add mod order rule: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

router.delete("/order-rules/:id", requireModsManage, async (req, res) => {
  try {
    const id = String(req.params.id || "");
    if (id.length > 64 || !(await deleteModOrderRule(id))) {
      return res.status(404).json({ error: "Order rule not found", code: ErrorCode.MODS_ORDER_RULE_NOT_FOUND });
    }
    log.info(`Deleted mod order rule ${id}`);
    res.json({ success: true });
  } catch (error) {
    log.error(`Failed to delete mod order rule: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ─── The plan ─────────────────────────────────────────────────────────────

// The ids of a request list, cleaned like Mods= reads them (backslashes
// gone, trimmed; none of CR, LF, ";", "=" or a control character), or null.
function cleanIdList(list, max) {
  if (!Array.isArray(list) || list.length > max) return null;
  const out = [];
  for (const raw of list) {
    const id = cleanRuleModId(raw);
    if (id === null) return null;
    out.push(id);
  }
  return out;
}

function parsePlanBody(body) {
  const input = body && typeof body === "object" && !Array.isArray(body) ? body : {};
  let order;
  if (input.order !== undefined) {
    order = cleanIdList(input.order, PLAN_LIMITS.maxOrder);
    if (!order) return { field: "order" };
    order = [...new Set(order)];
  }
  const mode = input.mode === undefined ? "minimal" : input.mode;
  if (mode !== "minimal" && mode !== "tiered") return { field: "mode" };
  const useGroups = input.groups === undefined ? true : input.groups;
  if (typeof useGroups !== "boolean") return { field: "groups" };
  let conflictPairs;
  if (input.conflictPairs !== undefined) {
    if (!Array.isArray(input.conflictPairs) || input.conflictPairs.length > PLAN_LIMITS.maxConflictPairs) return { field: "conflictPairs" };
    conflictPairs = [];
    for (const pair of input.conflictPairs) {
      const ids = Array.isArray(pair) && pair.length === 2 ? cleanIdList(pair, 2) : null;
      if (!ids) return { field: "conflictPairs" };
      if (ids[0] !== ids[1]) conflictPairs.push(ids);
    }
  }
  return { value: { order, mode, useGroups, conflictPairs } };
}

// Body { order?, mode?, groups?, conflictPairs? }: order is the client's
// (unsaved) Mods= order, default the saved one; mode "minimal" (default) or
// "tiered"; groups false ignores mod groups; conflictPairs [[a, b]] of mods
// that ship the same files (default: the last conflict scan's, while it
// matches the saved config). Nothing is written.
router.post("/load-order/plan", requireModsManage, async (req, res) => {
  try {
    const parsed = parsePlanBody(req.body);
    if (parsed.field) {
      return respondInvalid(res, ErrorCode.MODS_PLAN_INVALID, parsed.field, `Invalid load order request: ${parsed.field}`);
    }
    const active = await resolveActiveServerIniOrRespond(res);
    if (!active) return;
    const { order: givenOrder, mode, useGroups, conflictPairs } = parsed.value;
    const ctx = await loadModSmartContext({
      content: readTextFile(active.iniPath),
      serverPath: active.serverPath,
      extraModIds: givenOrder || [],
    });
    const order = givenOrder || ctx.modsLine;
    const pairs = conflictPairs ?? cachedConflictPairs(ctx.workshopItems, ctx.modsLine, active.serverPath);
    const { plan } = planFor(ctx, { order, mode, useGroups, conflictPairs: pairs });
    res.json({ ...plan, steamStatus: steamStatusFor(ctx) });
  } catch (error) {
    log.error(`Failed to plan the mod load order: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ─── Health ───────────────────────────────────────────────────────────────

async function healthOf(content, serverPath) {
  const ctx = await loadModSmartContext({ content, serverPath });
  const extras = await loadHealthExtras(ctx, { locate: locateModsOnDisk });
  const { plan } = planFor(ctx, {
    order: ctx.modsLine,
    conflictPairs: cachedConflictPairs(ctx.workshopItems, ctx.modsLine, serverPath),
  });
  const health = computeModHealth({
    ...ctx,
    ...extras,
    plan,
    planChangesLoading: plan.changed && changesLoading(ctx, plan.order),
  });
  return { ctx, plan, health: { ...health, steamStatus: steamStatusFor(ctx) } };
}

router.get("/health", requireModsManage, async (req, res) => {
  try {
    const active = await resolveActiveServerIniOrRespond(res);
    if (!active) return;
    const { health } = await healthOf(readTextFile(active.iniPath), active.serverPath);
    res.json(health);
  } catch (error) {
    log.error(`Failed to check mod health: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// Body { issueId, action, params? }: the health check is computed again
// inside the ini lock, the issue found by id and the fix by action (and
// params when the issue offers that action more than once). One backup, one
// write.
router.post("/health/fix", requireModsManage, async (req, res) => {
  try {
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    if (!isHealthIssueId(body.issueId)) {
      return respondInvalid(res, ErrorCode.MODS_HEALTH_FIX_INVALID, "issueId", "Invalid fix request: issueId");
    }
    if (!HEALTH_FIX_ACTIONS.includes(body.action)) {
      return respondInvalid(res, ErrorCode.MODS_HEALTH_FIX_INVALID, "action", "Invalid fix request: action");
    }
    const params = body.params;
    if (
      params !== undefined &&
      params !== null &&
      (typeof params !== "object" || Array.isArray(params) || JSON.stringify(params).length > FIX_PARAMS_MAX_CHARS)
    ) {
      return respondInvalid(res, ErrorCode.MODS_HEALTH_FIX_INVALID, "params", "Invalid fix request: params");
    }

    const active = await resolveActiveServerIniOrRespond(res);
    if (!active) return;
    const { iniPath, serverPath } = active;

    const outcome = await withIniLock(iniPath, async () => {
      const content = readTextFile(iniPath);
      const { plan, health } = await healthOf(content, serverPath);
      const found = findHealthFix(health, body.issueId, body.action, params);
      if (found.error) return found;
      const edit = applyModListFix(content, found.fix, { order: plan.order });
      if (!edit.changed) return { ...found, written: false };
      const backupWarning = backupWarningFor(await writeIniWithBackup(iniPath, edit.content));
      return { ...found, written: true, backupWarning };
    });

    if (outcome.error === "gone") {
      return res.status(404).json({ error: "This problem is gone or has changed", code: ErrorCode.MODS_HEALTH_ISSUE_GONE });
    }
    if (outcome.error) {
      return res.status(400).json({ error: "This fix is not offered for that problem", code: ErrorCode.MODS_HEALTH_FIX_NOT_OFFERED });
    }
    if (outcome.written) {
      log.info(`Mod health fix: ${outcome.fix.action} for ${outcome.issue.kind} (${outcome.fix.label})`);
    }
    const { health } = await healthOf(readTextFile(iniPath), serverPath);
    res.json({
      applied: outcome.written,
      ...(outcome.backupWarning ? { backupWarning: outcome.backupWarning } : {}),
      health,
    });
  } catch (error) {
    log.error(`Failed to apply a mod health fix: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

// ─── Insights ─────────────────────────────────────────────────────────────

// ?refresh=1 fetches the Steam data again now (at most once a minute, within
// a 20 s budget); otherwise what is cached answers and what is missing or
// stale is fetched in the background (steamStatus.pending).
router.get("/insights", requireModsManage, async (req, res) => {
  try {
    const active = await resolveActiveServerIniOrRespond(res);
    if (!active) return;
    const refresh = req.query?.refresh === "1" || req.query?.refresh === "true";
    let content = readTextFile(active.iniPath);
    let ctx = await loadModSmartContext({ content, serverPath: active.serverPath });
    let steamStatus;
    if (refresh) {
      steamStatus = (await fetchSteamKnowledge(ctx.workshopItems, { refresh: true })).status;
      content = readTextFile(active.iniPath);
      ctx = await loadModSmartContext({ content, serverPath: active.serverPath });
    } else {
      startSteamKnowledgeFill(ctx.workshopItems);
    }
    const { built } = planFor(ctx, { order: ctx.modsLine });
    const status = { ...steamStatusFor(ctx), ...(steamStatus?.rateLimited ? { rateLimited: true } : {}) };
    res.json(buildModInsights(ctx, built, status));
  } catch (error) {
    log.error(`Failed to build mod insights: ${error.message}`);
    res.status(500).json({ error: sanitizeError(error.message) });
  }
});

export default router;
