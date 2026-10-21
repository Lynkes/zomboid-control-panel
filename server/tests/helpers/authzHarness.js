// Real-module harness for access-control tests: the unmocked database
// (per-file temp data dir, see vitest.perFileDataDir.setup.mjs), the real
// authService middleware and real roles, behind a real HTTP listener. A test
// builds the app it needs with mount(), signs in as a user holding exactly
// the capabilities it names, and calls routes the way a browser would --
// so a gate in middleware, in the handler, or in a service is all covered.
import http from "node:http";
import express from "express";

const init = await import("../../database/init.js");
const { default: authService } = await import("../../services/auth.js");
const perms = await import("../../services/permissions.js");

export { init, authService, perms };

let adminUserId = null;

export async function setupAuth() {
  if (adminUserId) return adminUserId;
  await authService.init();
  const db = await init.getDb();
  if (!db.data.users.some((u) => u.username === "rootadmin")) {
    await authService.createUser("rootadmin", "Correct-horse-battery-9", "admin");
  }
  adminUserId = (await init.getDb()).data.users.find((u) => u.username === "rootadmin").id;
  return adminUserId;
}

let roleCounter = 0;

// A signed-in user whose role holds exactly `capabilities`. Returns the
// access token.
export async function tokenWithCapabilities(capabilities) {
  const actingUserId = await setupAuth();
  roleCounter += 1;
  const name = `authz-role-${roleCounter}`;
  const role = await perms.createRole({ name, capabilities }, { actingUser: { role: "admin" } });
  const username = `authzuser${roleCounter}`;
  const password = `Authz-user-pass-${roleCounter}-xq`;
  await authService.createUser(username, password, "moderator", { actingUserId });
  const user = (await init.getDb()).data.users.find((u) => u.username === username);
  await authService.changeUserRoleById(user.id, role.id, { actingUserId });
  const login = await authService.login(username, password, false, { clientKey: username });
  return login.accessToken;
}

export async function adminToken() {
  await setupAuth();
  const login = await authService.login("rootadmin", "Correct-horse-battery-9", false, {
    clientKey: "rootadmin",
  });
  return login.accessToken;
}

// mounts: [[prefix, router], ...]; appSettings: { name: value } for app.set.
export async function startApp(mounts, appSettings = {}) {
  const app = express();
  app.use(express.json());
  app.use(authService.middleware());
  for (const [key, value] of Object.entries(appSettings)) app.set(key, value);
  for (const [prefix, router] of mounts) app.use(prefix, router);
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();

  function call(method, urlPath, token, body) {
    return new Promise((resolve, reject) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const headers = {};
      if (token) headers.authorization = `Bearer ${token}`;
      if (data) {
        headers["content-type"] = "application/json";
        headers["content-length"] = Buffer.byteLength(data);
      }
      const req = http.request(
        { host: "127.0.0.1", port, path: urlPath, method, headers },
        (res) => {
          let text = "";
          res.on("data", (chunk) => (text += chunk));
          res.on("end", () => {
            let json = null;
            try {
              json = text ? JSON.parse(text) : null;
            } catch {
              /* not JSON */
            }
            resolve({ status: res.statusCode, body: json, text });
          });
        },
      );
      req.on("error", reject);
      if (data) req.write(data);
      req.end();
    });
  }

  return {
    app,
    call,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
