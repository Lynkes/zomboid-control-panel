import { afterEach, describe, expect, it } from "vitest";
import http from "http";
import net from "net";
import express from "express";
import {
  HEADERS_TIMEOUT_MS,
  PANEL_SERVER_TIMEOUTS,
  REQUEST_BODY_DEADLINE_MS,
  extendRequestBodyDeadline,
  installRequestBodyDeadline,
} from "../utils/requestBodyDeadline.js";

// index.js turns Node's server-wide requestTimeout off and gives every
// request its own deadline instead, so one route (a Server Files upload)
// can be given hours without every other body, /api/auth/login's included,
// being allowed to trickle in for as long.

let server;

afterEach(async () => {
  if (!server) return;
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  server = null;
});

async function start(app, deadlineMs) {
  server = installRequestBodyDeadline(http.createServer(PANEL_SERVER_TIMEOUTS, app), { deadlineMs });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server.address().port;
}

// Headers, then `bytes` of a declared 100-byte body one byte per `everyMs`.
function trickle(port, path, { everyMs, bytes }) {
  return new Promise((resolve) => {
    const socket = net.connect(port, "127.0.0.1");
    let answer = "";
    let sent = 0;
    let timer = null;
    const started = Date.now();
    socket.on("data", (d) => (answer += d.toString("latin1")));
    socket.on("error", () => {});
    socket.on("close", () => {
      clearInterval(timer);
      resolve({ status: answer.split("\r\n")[0] || null, closedAfterMs: Date.now() - started, sent });
    });
    socket.on("connect", () => {
      socket.write(`POST ${path} HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n`);
      timer = setInterval(() => {
        if (sent >= bytes) {
          clearInterval(timer);
          return;
        }
        sent += 1;
        socket.write(" ");
      }, everyMs);
    });
  });
}

describe("PANEL_SERVER_TIMEOUTS", () => {
  it("turns Node's requestTimeout off and keeps its headersTimeout (which would follow it to 0)", () => {
    const s = http.createServer(PANEL_SERVER_TIMEOUTS);
    expect(s.requestTimeout).toBe(0);
    expect(s.headersTimeout).toBe(HEADERS_TIMEOUT_MS);
    expect(HEADERS_TIMEOUT_MS).toBe(http.createServer().headersTimeout);
    expect(REQUEST_BODY_DEADLINE_MS).toBe(http.createServer().requestTimeout);
  });
});

describe("the per-request body deadline", () => {
  it("cuts a body still trickling in at the deadline, like Node's own requestTimeout (408)", async () => {
    const app = express();
    app.use(express.json());
    app.post("/api/auth/login", (_req, res) => res.json({ ok: true }));
    const port = await start(app, 500);
    const result = await trickle(port, "/api/auth/login", { everyMs: 50, bytes: 100 });
    // The 408 goes out first, but a client still sending may lose it to the
    // reset, as with Node's own: what counts is that the connection went.
    expect([null, "HTTP/1.1 408 Request Timeout"]).toContain(result.status);
    expect(result.closedAfterMs).toBeLessThan(3000);
    expect(result.sent).toBeLessThan(100);
  });

  it("lets a request whose route extended it take longer", async () => {
    const app = express();
    app.post(
      "/upload",
      (req, _res, next) => {
        extendRequestBodyDeadline(req, 60_000);
        next();
      },
      (req, res) => {
        let n = 0;
        req.on("data", (chunk) => (n += chunk.length));
        req.on("end", () => res.json({ n }));
      },
    );
    const port = await start(app, 300);
    const status = await new Promise((resolve) => {
      const req = http.request(`http://127.0.0.1:${port}/upload`, { method: "POST", headers: { "content-length": "4" } });
      req.on("response", (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      req.on("error", () => resolve("reset"));
      let sent = 0;
      const timer = setInterval(() => {
        sent += 1;
        if (sent === 4) {
          clearInterval(timer);
          req.end("x");
        } else req.write("x");
      }, 250);
    });
    expect(status).toBe(200);
  });

  it("leaves a request that arrived whole alone, however long its answer takes, and times each request on a connection anew", async () => {
    const app = express();
    app.use(express.json());
    app.post("/slow-answer", (_req, res) => setTimeout(() => res.json({ ok: true }), 600));
    const port = await start(app, 300);
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const post = () =>
      new Promise((resolve, reject) => {
        const req = http.request(`http://127.0.0.1:${port}/slow-answer`, {
          method: "POST",
          agent,
          headers: { "content-type": "application/json" },
        });
        req.on("response", (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        });
        req.on("error", reject);
        req.end("{}");
      });
    try {
      expect(await post()).toBe(200);
      expect(await post()).toBe(200);
    } finally {
      agent.destroy();
    }
  });

  it("does nothing on a server it wasn't installed on", () => {
    expect(() => extendRequestBodyDeadline({ complete: false }, 1000)).not.toThrow();
  });
});

describe("the routes that take uploads", () => {
  it("give their own request the long window, and only after the permission check", async () => {
    const { default: backupRouter } = await import("../routes/backup.js");
    const { default: filesRouter } = await import("../routes/files.js");
    const names = (router, path) => router.stack.find((layer) => layer.route?.path === path)?.route.stack.map((layer) => layer.name);
    // backup.js: requirePermission("backups.manage"), then the window.
    const backup = names(backupRouter, "/upload");
    expect(backup.indexOf("slowBodyAllowed")).toBe(1);
    // files.js: files.manage is checked router-wide before any route
    // (routeAuthorizationCoverage.test.js holds that line in place).
    const files = names(filesRouter, "/profiles/:profileId/upload");
    expect(files[0]).toBe("slowBodyAllowed");
  });
});
