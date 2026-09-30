import express from "express";
import { requirePermission } from "../services/permissions.js";
import { ErrorCode } from "../utils/errorCodes.js";

// Character sheet API (/api/player-character). Placeholder from the v1.4.1
// contract commit; the character workstream replaces it.
const router = express.Router();

const CHARACTER_SECTIONS = new Set(["summary", "stats", "skills", "traits", "inventory"]);

router.get("/:username", requirePermission("players.view"), (req, res) => {
  const { sections } = req.query;
  if (
    sections !== undefined &&
    (typeof sections !== "string" || sections.split(",").some((s) => !CHARACTER_SECTIONS.has(s)))
  ) {
    return res
      .status(400)
      .json({ error: "Unknown character section requested.", code: ErrorCode.CHARACTER_INVALID_SECTIONS });
  }
  return res.status(503).json({ error: "Not available yet", code: ErrorCode.CHARACTER_SHEET_FAILED });
});

export default router;
