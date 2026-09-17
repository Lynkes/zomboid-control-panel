const LOCK_KEY = Symbol.for("zomboid-control-panel.oidc-test-lock");

export async function acquireOidcTestLock() {
  const lock = globalThis[LOCK_KEY] || { tail: Promise.resolve() };
  globalThis[LOCK_KEY] = lock;

  const previous = lock.tail;
  let release;
  lock.tail = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  return release;
}