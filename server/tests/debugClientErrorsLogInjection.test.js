import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "fs";
import http from "http";
import path from "path";
import express from "express";

// Security sweep 2026-10-04, SDOS-3: POST /api/debug/client-errors takes no
// login at all (the login page itself can crash), and it interpolated the
// caller's `message` / `error` / `url` into the log line verbatim. A CR/LF in
// any of them started a brand-new line in combined.log -- the file support
// bundles ship -- that nobody could tell from a real panel entry: an
// anonymous POST could write "[INFO] [Auth] Password reset successful for
// user: admin" into the operator's own log.
//
// The first block is the verifier's HTTP repro promoted as-is: the real
// authService.middleware() in front of the real debug router, a token-less
// request over a real socket, and the real combined.log read back off disk
// (this file's own temp logsDir, via vitest.perFileDataDir.setup.mjs). The
// second block pins the per-field escaping through onLog(), the way
// debugClientErrorsLogDetail.test.js reads what the logger actually emits.

const { default: authService } = await import("../services/auth.js");
const { default: debugRouter } = await import("../routes/debug.js");
const { onLog } = await import("../utils/logger.js");
const { getDataPaths } = await import("../utils/paths.js");

const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const NEL = String.fromCharCode(0x0085);
// Anything a log viewer (or String.split) might treat as the end of a line.
const LINE_BREAKS = /[\r\n\u0085\u2028\u2029]/;

function forgedEntry(text) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  return `${ts} [INFO] [Auth] ${text}`;
}

async function waitForLogLine(file, marker, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    if (content.includes(marker)) return content;
    if (Date.now() > deadline) return content;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("unauthenticated POST /api/debug/client-errors can't forge lines in combined.log (SDOS-3)", () => {
  let server;
  let baseUrl;

  beforeAll(async () => {
    await authService.init();
    const app = express();
    // Same order as server/index.js.
    app.use("/api/debug/client-errors", express.json({ limit: "16kb" }));
    app.use(authService.middleware());
    app.use("/api/debug", debugRouter);
    server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it("keeps a CR/LF-laden report on its own single [ClientError] line", async () => {
    const marker = `sdos3-${Date.now()}`;
    const body = {
      message: `${marker} chunk load retry\r\n${forgedEntry("Password reset successful for user: admin")}\n${forgedEntry("User logged in: admin")}`,
      error: `boom\n${forgedEntry("Account locked due to repeated failed logins: admin")}`,
      url: `https://panel.example/login\r\n${forgedEntry("Recovery code used by: admin")}`,
    };
    const res = await fetch(`${baseUrl}/api/debug/client-errors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);

    const logFile = path.join(getDataPaths().logsDir, "combined.log");
    const content = await waitForLogLine(logFile, marker);
    const lines = content.split(/\r?\n/);

    const reportLines = lines.filter((line) => line.includes(marker));
    expect(reportLines).toHaveLength(1);
    expect(reportLines[0]).toMatch(/\[WARN\] \[API:Debug\] \[ClientError\] /);

    // Every injected "entry" is still in the file -- but only inside the
    // report's own line, never as a line of its own.
    for (const injected of [
      "Password reset successful for user: admin",
      "User logged in: admin",
      "Account locked due to repeated failed logins: admin",
      "Recovery code used by: admin",
    ]) {
      const hits = lines.filter((line) => line.includes(injected));
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain(marker);
    }
    // Visible, not silently dropped: an operator can still see what was sent.
    expect(reportLines[0]).toContain("chunk load retry\\r\\n");
  });

  it("still logs an ordinary report with no auth header (the carve-out is unchanged)", async () => {
    const marker = `sdos3-plain-${Date.now()}`;
    const res = await fetch(`${baseUrl}/api/debug/client-errors`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: `${marker} Request failed, retrying (1/3)...`, error: "Failed to fetch" }),
    });
    expect(res.status).toBe(200);
    const content = await waitForLogLine(path.join(getDataPaths().logsDir, "combined.log"), marker);
    const line = content.split(/\r?\n/).find((l) => l.includes(marker));
    expect(line).toMatch(new RegExp(`\\[ClientError\\] ${marker} Request failed, retrying \\(1/3\\)\\.\\.\\. -- Failed to fetch$`));
  });
});

function createResponse() {
  const response = {};
  response.status = (code) => {
    response.statusCode = code;
    return response;
  };
  response.json = (body) => {
    response.body = body;
    return response;
  };
  return response;
}

async function runClientErrors(req) {
  const layer = debugRouter.stack.find(
    (entry) => entry.route?.path === "/client-errors" && entry.route.methods.post,
  );
  const res = createResponse();
  await layer.route.stack[0].handle(req, res, () => {});
  return res;
}

const flush = () => new Promise((resolve) => setImmediate(resolve)); // CallbackTransport dispatches via setImmediate

async function logReport(ip, body) {
  const entries = [];
  const unsubscribe = onLog((entry) => entries.push(entry));
  try {
    const res = await runClientErrors({ ip, body });
    expect(res.body).toEqual({ ok: true });
    await flush();
  } finally {
    unsubscribe();
  }
  const line = entries.find((e) => e.level === "warn" && e.message.startsWith("[ClientError] "));
  expect(line).toBeDefined();
  return line.message;
}

describe("client-error reports escape every line-breaking character, field by field", () => {
  it.each([
    ["message", { message: "a\nb" }],
    ["error", { message: "m", error: "a\nb" }],
    ["url", { message: "m", url: "https://x.example/a\nb" }],
  ])("escapes a newline in `%s`", async (field, body) => {
    const message = await logReport(`10.9.0.${field.length}`, body);
    expect(message).not.toMatch(LINE_BREAKS);
    expect(message).toContain("a\\nb");
  });

  it("escapes CR, NEL, U+2028 and U+2029 and other control characters too", async () => {
    const message = await logReport("10.9.1.1", {
      message: `a\rb${NEL}c${LS}d${PS}e\u0000f\u001bg\th`,
    });
    expect(message).not.toMatch(LINE_BREAKS);
    expect(message).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(message).toBe("[ClientError] a\\rb\\u0085c\\u2028d\\u2029e\\u0000f\\u001bg\\th");
  });

  it("leaves ordinary text, including non-ASCII, untouched", async () => {
    const message = await logReport("10.9.1.2", {
      message: "Échec du chargement — 加载失败",
      error: "TypeError: x is undefined",
      url: "https://panel.example/servers?id=1",
    });
    expect(message).toBe(
      "[ClientError] Échec du chargement — 加载失败 -- TypeError: x is undefined (page: https://panel.example/servers?id=1)",
    );
  });
});
