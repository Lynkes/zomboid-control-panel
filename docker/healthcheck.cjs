// HEALTHCHECK of both panel images (Dockerfile, docker/all-in-one/Dockerfile):
// GET /api/health on the port the panel really listens on.
//
// The panel writes that port to PANEL_PORT_FILE once it listens
// (server/utils/panelPortFile.js): PORT, else the port saved in Settings,
// else 3001, or a free port it picked when that one was busy. Before that,
// PORT, else 3001. A healthcheck fixed on 3001 read a panel on any other port
// as unhealthy, and the all-in-one updater then rolled the update back.
"use strict";

const fs = require("fs");
const http = require("http");

const TIMEOUT_MS = 4000;

function validPort(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

function resolveHealthcheckPort(env = process.env, readFile = fs.readFileSync) {
  if (env.PANEL_PORT_FILE) {
    try {
      const recorded = validPort(readFile(env.PANEL_PORT_FILE, "utf8"));
      if (recorded) return recorded;
    } catch {
      // Not written yet: the panel is still starting.
    }
  }
  return validPort(env.PORT) ?? 3001;
}

function checkHealth(port, { host = "localhost", timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const request = http.get({ host, port, path: "/api/health", timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("timeout", () => request.destroy(new Error("timed out")));
    request.on("error", () => resolve(false));
  });
}

if (require.main === module) {
  checkHealth(resolveHealthcheckPort()).then((healthy) => process.exit(healthy ? 0 : 1));
}

module.exports = { validPort, resolveHealthcheckPort, checkHealth };
