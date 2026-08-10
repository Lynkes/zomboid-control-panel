/* Zomboid Control Panel — Steam Sync popup script
 *
 * Reads sessionid + steamLoginSecure from steamcommunity.com using the
 * WebExtensions cookies API (works on Firefox/Chrome/Edge/Brave). Then
 * logs into the panel with the saved username/password (or a cached
 * access token) and POSTs the cookies to
 * /api/mods/collection/extension-push.
 *
 * Privacy:
 *   - Only talks to (a) the configured panel URL and (b) Steam (locally,
 *     to read cookies via the cookies API).
 *   - Password is NOT persisted unless the user explicitly ticks
 *     "Remember password". Only the access token is cached by default.
 */

const browserAPI = (typeof browser !== 'undefined' && browser.cookies) ? browser : chrome;

const $ = (id) => document.getElementById(id);
const ui = {
  panelUrl: $('panel-url'),
  username: $('username'),
  password: $('password'),
  rememberPassword: $('remember-password'),
  saveBtn: $('save-btn'),
  testBtn: $('test-btn'),
  sendBtn: $('send-btn'),
  setupStatus: $('setup-status'),
  sendStatus: $('send-status'),
};

const STORAGE_KEYS = ['panelUrl', 'username', 'password', 'rememberPassword', 'accessToken'];

function storageGet(keys) {
  return new Promise((resolve) => {
    try {
      browserAPI.storage.local.get(keys, (items) => resolve(items || {}));
    } catch (e) {
      resolve({});
    }
  });
}

function storageSet(items) {
  return new Promise((resolve) => {
    try {
      browserAPI.storage.local.set(items, () => resolve(true));
    } catch (e) {
      resolve(false);
    }
  });
}

function storageRemove(keys) {
  return new Promise((resolve) => {
    try {
      browserAPI.storage.local.remove(keys, () => resolve(true));
    } catch (e) {
      resolve(false);
    }
  });
}

// The manifest only grants host access to the two Steam domains outright
// (needed for the cookies API). Any other origin — the user's own panel
// URL, which can be anything — is requested at runtime via
// optional_host_permissions instead of a blanket http(s)://*/* grant.
function requestOrigin(origin) {
  return new Promise((resolve) => {
    try {
      browserAPI.permissions.request({ origins: [origin] }, (granted) =>
        resolve(!!granted),
      );
    } catch (e) {
      resolve(false);
    }
  });
}

async function ensurePanelPermission(panelUrl) {
  const origin = new URL(panelUrl).origin + '/*';
  const granted = await requestOrigin(origin);
  if (!granted) {
    throw new Error('Permission to contact the panel URL was not granted.');
  }
}

function cookieGet(details) {
  return new Promise((resolve) => {
    try {
      browserAPI.cookies.get(details, (cookie) => resolve(cookie || null));
    } catch (e) {
      resolve(null);
    }
  });
}

function setStatus(el, msg, kind = 'info') {
  el.textContent = msg || '';
  el.className = 'status ' + (kind || 'info');
}

function normaliseUrl(raw) {
  let u = (raw || '').trim();
  if (!u) return '';
  // Add http:// if no scheme — keeps LAN setups easy. Users on a VPS will
  // type https:// explicitly.
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  // Strip trailing slash
  u = u.replace(/\/+$/, '');
  return u;
}

function isSendReady() {
  return !!(
    normaliseUrl(ui.panelUrl.value)
    && ui.username.value.trim()
    && (ui.password.value || true) // password isn't strictly required at this point if a token is cached
  );
}

function refreshSendButton(hasToken) {
  const ready = !!(normaliseUrl(ui.panelUrl.value) && ui.username.value.trim() && (ui.password.value || hasToken));
  ui.sendBtn.disabled = !ready;
}

async function loadSettings() {
  const stored = await storageGet(STORAGE_KEYS);
  ui.panelUrl.value = stored.panelUrl || '';
  ui.username.value = stored.username || '';
  // Only restore the password field if the user previously asked us to.
  ui.rememberPassword.checked = !!stored.rememberPassword;
  ui.password.value = stored.rememberPassword ? (stored.password || '') : '';
  refreshSendButton(!!stored.accessToken);
}

async function saveSettings(silent = false) {
  const panelUrl = normaliseUrl(ui.panelUrl.value);
  const remember = !!ui.rememberPassword.checked;
  const items = {
    panelUrl,
    username: ui.username.value.trim(),
    rememberPassword: remember,
  };
  if (remember) {
    items.password = ui.password.value;
  }
  await storageSet(items);
  if (!remember) {
    // Make sure no stale password lingers in storage.
    await storageRemove(['password']);
  }
  ui.panelUrl.value = panelUrl;
  if (!silent) setStatus(ui.setupStatus, 'Saved.', 'success');
}

async function loginToPanel(panelUrl, username, password) {
  const res = await fetch(panelUrl + '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, rememberMe: false }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch (_) {}
    throw new Error(`Login failed (${res.status})${detail ? ': ' + detail : ''}`);
  }
  const data = await res.json();
  if (!data.accessToken) throw new Error('Login response missing accessToken');
  return data.accessToken;
}

async function readSteamCookies() {
  // steamcommunity.com first — that's where Workshop write requests go, so
  // its cookies are the canonical ones. store.steampowered.com is a
  // fallback in case the user is only logged in there.
  const tryHosts = ['https://steamcommunity.com', 'https://store.steampowered.com'];
  let sessionid = null;
  let steamLoginSecure = null;
  for (const url of tryHosts) {
    if (!sessionid) {
      const c = await cookieGet({ url, name: 'sessionid' });
      if (c?.value) sessionid = c.value;
    }
    if (!steamLoginSecure) {
      const c = await cookieGet({ url, name: 'steamLoginSecure' });
      if (c?.value) steamLoginSecure = c.value;
    }
    if (sessionid && steamLoginSecure) break;
  }
  return { sessionid, steamLoginSecure };
}

async function pushCookies(panelUrl, token, sessionid, steamLoginSecure) {
  const res = await fetch(panelUrl + '/api/mods/collection/extension-push', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + token,
    },
    body: JSON.stringify({ sessionid, steamLoginSecure }),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error || ''; } catch (_) {}
    const err = new Error(`Push failed (${res.status})${detail ? ': ' + detail : ''}`);
    err.status = res.status;
    throw err;
  }
  return await res.json();
}

async function obtainToken(panelUrl, username, password, cachedToken) {
  // We don't bother validating cached tokens up front — the push endpoint
  // will reject expired tokens with 401 and we'll re-login then.
  if (cachedToken) return { token: cachedToken, fromCache: true };
  if (!password) throw new Error('Password is required for the first login. Tick "Remember password" to skip this next time.');
  const token = await loginToPanel(panelUrl, username, password);
  return { token, fromCache: false };
}

async function doTest() {
  setStatus(ui.setupStatus, 'Testing login…', 'info');
  try {
    const panelUrl = normaliseUrl(ui.panelUrl.value);
    if (!panelUrl) throw new Error('Panel URL is required');
    if (!ui.username.value.trim()) throw new Error('Username is required');
    if (!ui.password.value) throw new Error('Password is required');
    await ensurePanelPermission(panelUrl);
    const token = await loginToPanel(panelUrl, ui.username.value.trim(), ui.password.value);
    await saveSettings(true);
    await storageSet({ accessToken: token });
    setStatus(ui.setupStatus, 'Login OK — settings saved.', 'success');
    refreshSendButton(true);
  } catch (err) {
    setStatus(ui.setupStatus, err.message, 'error');
  }
}

async function doSend() {
  ui.sendBtn.disabled = true;
  setStatus(ui.sendStatus, 'Reading Steam cookies…', 'info');
  try {
    const stored = await storageGet(STORAGE_KEYS);
    const panelUrl = normaliseUrl(stored.panelUrl || ui.panelUrl.value);
    const username = (stored.username || ui.username.value || '').trim();
    const password = ui.password.value || stored.password || '';
    if (!panelUrl || !username) {
      throw new Error('Configure Panel URL + username first.');
    }
    await ensurePanelPermission(panelUrl);

    const { sessionid, steamLoginSecure } = await readSteamCookies();
    if (!sessionid || !steamLoginSecure) {
      throw new Error('Steam cookies not found — sign in at steamcommunity.com first.');
    }

    let { token } = await obtainToken(panelUrl, username, password, stored.accessToken);
    setStatus(ui.sendStatus, 'Sending cookies to panel…', 'info');
    try {
      await pushCookies(panelUrl, token, sessionid, steamLoginSecure);
    } catch (err) {
      if (err.status === 401 && password) {
        // Cached token rejected — log in again with the password we have.
        setStatus(ui.sendStatus, 'Session expired, re-authenticating…', 'info');
        token = await loginToPanel(panelUrl, username, password);
        await storageSet({ accessToken: token });
        await pushCookies(panelUrl, token, sessionid, steamLoginSecure);
      } else {
        throw err;
      }
    }
    await storageSet({ accessToken: token });

    setStatus(ui.sendStatus, 'Cookies sent. Workshop sync is ready.', 'success');
  } catch (err) {
    setStatus(ui.sendStatus, err.message, 'error');
  } finally {
    ui.sendBtn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  ui.saveBtn.addEventListener('click', () => saveSettings());
  ui.testBtn.addEventListener('click', doTest);
  ui.sendBtn.addEventListener('click', doSend);
  // Re-enable the send button live as the user types — beats showing a
  // confusing "Configure …" error after they click.
  const refresh = async () => {
    const stored = await storageGet(['accessToken']);
    refreshSendButton(!!stored.accessToken);
  };
  ui.panelUrl.addEventListener('input', refresh);
  ui.username.addEventListener('input', refresh);
  ui.password.addEventListener('input', refresh);
  ui.rememberPassword.addEventListener('change', async () => {
    if (!ui.rememberPassword.checked) {
      // Tearing down the remember toggle clears the stored password immediately.
      await storageRemove(['password']);
    }
  });
});

