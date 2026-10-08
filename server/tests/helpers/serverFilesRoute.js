// Runs one Server Files route (routes/serverFiles.js) behind the router's
// own gate, the way Express would.
//
// Every handler reads req.activeServerContext, which the gate sets: the
// second non-route layer, after requirePermission("serverfiles.manage").
// The gate also answers the request itself when production refuses the
// server's folders (SERVER_CONFIG_PATH_OUTSIDE_DATA,
// ZOMBOID_DATA_FOLDER_REFUSED, ...). As in Express, what comes after the
// gate runs only when the gate calls next(). Every caller expects its
// request to get through, so a gate that answers the request itself fails
// the test with the gate's status and body, and one that passes an error on
// rethrows it, instead of the handler running anyway and hiding what
// production does. The other router-level middleware (permissions, the
// remote mirror, the "server must be stopped" guard) has tests of its own
// and is skipped here.
//
// A local server's config folder passes the gate when it is <data
// folder>/Server (or a folder inside it) with that data folder set on the
// record.

export function getServerFilesGate(router) {
  return router.stack.filter((entry) => !entry.route)[1].handle;
}

// `res` is the test's own response double; whatever its shape, the gate's
// answer is recorded on the way through so the failure can name it.
export async function passServerFilesGate(router, req, res, label) {
  const answer = { status: 200, body: undefined };
  const recorder = Object.create(res);
  recorder.status = (code) => {
    answer.status = code;
    res.status(code);
    return recorder;
  };
  recorder.json = (body) => {
    answer.body = body;
    res.json(body);
    return recorder;
  };
  let passed = false;
  await getServerFilesGate(router)(req, recorder, (error) => {
    if (error) throw error;
    passed = true;
  });
  if (!passed) {
    throw new Error(
      `The Server Files gate answered ${label} itself: ${answer.status} ${JSON.stringify(answer.body)}`,
    );
  }
}

export async function runServerFilesRoute(router, routePath, method, req, res) {
  const label = `${method.toUpperCase()} ${routePath}`;
  const layer = router.stack.find(
    (entry) => entry.route?.path === routePath && entry.route.methods[method],
  );
  if (!layer) throw new Error(`No ${label} route registered`);
  await passServerFilesGate(router, req, res, label);

  const handlers = layer.route.stack.map((entry) => entry.handle);
  let index = -1;
  const next = async (error) => {
    index++;
    if (error) throw error;
    if (index < handlers.length) await handlers[index](req, res, next);
  };
  await next();
  return res;
}
