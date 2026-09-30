import express from "express";
import { requirePermission } from "../services/permissions.js";
import { ErrorCode } from "../utils/errorCodes.js";

// Server Files API (/api/files). Placeholder from the v1.4.1 contract commit;
// the file-manager workstream replaces it with the real router. The blanket
// gate stays the router's first middleware: routeAuthorizationCoverage.test.js
// asserts that exact line.
const router = express.Router();
router.use(requirePermission("files.manage"));

// One route so the route-coverage scan has something to check in this file
// until the real routes land.
router.get("/profiles", (req, res) => {
  res.status(503).json({ error: "Not available yet", code: ErrorCode.FM_INTERNAL });
});

export default router;
