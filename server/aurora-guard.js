#!/usr/bin/env node
/*
 * Aurora Guard: enforces per-account device limits and expiration dates on the Emby server.
 *
 * Runs on the Emby server PC (see README.md). It has three jobs:
 *  1. Keeps the limits store (data/limits.json): per-user device limit and expiration date. Only this
 *     program reads or writes it; Emby users can't reach it.
 *  2. Serves the admin endpoints Aurora's Admin → Users page uses. Every request carries the caller's own
 *     Emby token, and the guard checks with Emby that the token belongs to an administrator before
 *     anything is read or changed. Ordinary users' tokens are rejected.
 *  3. Every minute, with its own Emby API key: disables accounts past their expiration date, re-enables
 *     ones it disabled whose date was extended, and signs out devices over an account's limit. This is
 *     the real enforcement, and it covers Emby's own apps as well as Aurora.
 *
 * No packages to install: plain Node.js 18 or newer.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const VERSION = '1.0.0';
const DIR = __dirname;
const CONFIG_FILE = process.env.AURORA_GUARD_CONFIG || path.join(DIR, 'config.json');

// ---------- Config ----------
function loadConfig() {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (e) {
    console.error(`Can't read ${CONFIG_FILE}: ${e.message}. Copy config.example.json to config.json and fill it in.`);
    process.exit(1);
  }
  const cfg = {
    embyUrl: 'http://127.0.0.1:8096',
    apiKey: '',
    port: 8922,
    host: '0.0.0.0',
    pfxPath: '',
    pfxPassphrase: '',
    allowInsecureHttp: false,
    intervalSeconds: 60,
    activeWindowMinutes: 5,
    defaultLimit: 2,
    dryRun: false,
    dataDir: path.join(DIR, 'data'),
    ...raw,
  };
  cfg.embyUrl = String(cfg.embyUrl).replace(/\/+$/, '');
  if (!/\/emby$/i.test(cfg.embyUrl)) cfg.embyUrl += '/emby';
  if (!cfg.apiKey) { console.error('config.json needs "apiKey": an Emby API key (Emby dashboard → Advanced → API Keys).'); process.exit(1); }
  cfg.intervalSeconds = Math.max(20, Number(cfg.intervalSeconds) || 60);
  cfg.defaultLimit = Math.max(1, Number(cfg.defaultLimit) || 2);
  return cfg;
}
const cfg = loadConfig();
fs.mkdirSync(cfg.dataDir, { recursive: true });
const STORE_FILE = path.join(cfg.dataDir, 'limits.json');
const LOG_FILE = path.join(cfg.dataDir, 'guard.log');

// ---------- Log ----------
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* logging is best effort */ }
}

// ---------- Store ----------
// { users: { userId: { limit, expires: "YYYY-MM-DD" | null, name, updated, updatedBy } },
//   disabledByGuard: { userId: true }, firstSeen: { userId: { deviceId: ms } }, actions: [...] }
function emptyStore() { return { users: {}, disabledByGuard: {}, firstSeen: {}, actions: [] }; }
let store = emptyStore();
try { store = { ...emptyStore(), ...JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) }; } catch (e) {
  if (e.code !== 'ENOENT') { log('Could not read', STORE_FILE, '-', e.message, '(starting with an empty store; the old file is kept as limits.json.bad)'); try { fs.copyFileSync(STORE_FILE, STORE_FILE + '.bad'); } catch {} }
}
function saveStore() {
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
  fs.renameSync(tmp, STORE_FILE); // atomic, so a crash never leaves half a file
}
function recordAction(action) {
  store.actions.unshift({ at: Date.now(), ...action });
  store.actions = store.actions.slice(0, 300);
}

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00'));
// The account works until the end of its expiration day (server's local time).
const isExpired = (rec) => !!rec?.expires && Date.now() > new Date(rec.expires + 'T23:59:59').getTime();
const limitOf = (userId) => Math.max(1, Number(store.users[userId]?.limit) || cfg.defaultLimit);

// ---------- Emby ----------
function embyRequest(method, apiPath, { token = cfg.apiKey, body, query } = {}) {
  const url = new URL(cfg.embyUrl + apiPath);
  for (const [k, v] of Object.entries(query || {})) if (v !== undefined && v !== null) url.searchParams.set(k, v);
  const lib = url.protocol === 'https:' ? https : http;
  const data = body === undefined ? null : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = lib.request(url, {
      method,
      timeout: 20000,
      headers: {
        Accept: 'application/json',
        'X-Emby-Token': token,
        'X-Emby-Authorization': `Emby Client="Aurora Guard", Device="Emby server", DeviceId="aurora-guard", Version="${VERSION}"`,
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) { const e = new Error(`Emby ${method} ${apiPath} → ${res.statusCode}`); e.status = res.statusCode; return reject(e); }
        try { resolve(text ? JSON.parse(text) : null); } catch { resolve(text); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Emby did not answer in time')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
const emby = (method, apiPath, opts) => embyRequest(method, apiPath, opts);

async function setDisabled(user, disabled) {
  const fresh = await emby('GET', `/Users/${user.Id}`);
  await emby('POST', `/Users/${user.Id}/Policy`, { body: { ...(fresh.Policy || {}), IsDisabled: !!disabled } });
}

// ---------- Is the caller an Emby administrator? ----------
// The caller's own token must be able to use an administrators-only Emby endpoint (/Auth/Keys). An ordinary
// account's token is refused by Emby itself, so this can't be faked by sending a different user id.
const adminCache = new Map(); // sha256(token) -> { ok, until }
async function isAdminToken(token) {
  if (!token || typeof token !== 'string' || token.length > 200) return false;
  const key = crypto.createHash('sha256').update(token).digest('hex');
  const hit = adminCache.get(key);
  if (hit && hit.until > Date.now()) return hit.ok;
  let ok = false;
  try { await emby('GET', '/Auth/Keys', { token }); ok = true; } catch (e) {
    if (!e.status) throw e; // Emby unreachable: can't tell, so the request fails rather than passing
  }
  adminCache.set(key, { ok, until: Date.now() + 60000 });
  if (adminCache.size > 500) adminCache.delete(adminCache.keys().next().value);
  return ok;
}

// The user a token belongs to (for /check, which any signed-in user may call about themselves).
async function userOfToken(token, userId) {
  if (!token || !userId || !/^[\w-]{1,64}$/.test(userId)) return null;
  try {
    const me = await emby('GET', '/Users/Me', { token }).catch(async (e) => {
      if (e.status === 404 || e.status === 400) return emby('GET', `/Users/${userId}`, { token });
      throw e;
    });
    return me && me.Id === userId ? me : null;
  } catch { return null; }
}

// ---------- Enforcement ----------
const windowMs = () => cfg.activeWindowMinutes * 60000;
let lastRun = { at: 0, ok: false, error: '', actions: 0 };

function activeByUser(sessions) {
  const now = Date.now(), byUser = new Map();
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s.UserId || !s.DeviceId || s.DeviceId === 'aurora-guard') continue;
    const at = Date.parse(s.LastActivityDate || 0) || 0;
    if (now - at > windowMs()) continue;
    if (!byUser.has(s.UserId)) byUser.set(s.UserId, new Map());
    const devices = byUser.get(s.UserId);
    const d = devices.get(s.DeviceId) || { deviceId: s.DeviceId, name: s.DeviceName || 'Device', client: s.Client || '', sessions: [], at: 0, playing: false };
    d.sessions.push(s.Id);
    d.at = Math.max(d.at, at);
    d.playing = d.playing || !!s.NowPlayingItem;
    devices.set(s.DeviceId, d);
  }
  return byUser;
}

async function signOutDevice(user, device, reason) {
  if (cfg.dryRun) { log('[dry run] would sign out', device.name, `(${device.client})`, 'from', user.Name, '-', reason); return; }
  for (const id of device.sessions) {
    // Tell Emby's own apps why, then stop playback and remove the device (which cancels its sign-in).
    await emby('POST', `/Sessions/${encodeURIComponent(id)}/Message`, { body: { Header: 'Signed out', Text: reason, TimeoutMs: 15000 } }).catch(() => {});
    await emby('POST', `/Sessions/${encodeURIComponent(id)}/Playing/Stop`).catch(() => {});
  }
  await emby('DELETE', '/Devices', { query: { Id: device.deviceId } });
  log('Signed out', device.name, `(${device.client})`, 'from', user.Name, '-', reason);
}

// One pass. onlyUserId: just that account (after an admin changes it).
async function enforce(onlyUserId) {
  const users = await emby('GET', '/Users');
  const sessions = await emby('GET', '/Sessions');
  const active = activeByUser(sessions);
  let actions = 0;
  let changed = false;
  for (const user of Array.isArray(users) ? users : []) {
    if (onlyUserId && user.Id !== onlyUserId) continue;
    if (user.Policy?.IsAdministrator) continue; // admins are never limited or disabled
    const rec = store.users[user.Id];
    // Expiration: switch the account off in Emby, where no app can get round it.
    if (isExpired(rec) && !user.Policy?.IsDisabled) {
      if (cfg.dryRun) log('[dry run] would disable expired account', user.Name);
      else {
        await setDisabled(user, true);
        store.disabledByGuard[user.Id] = true;
        recordAction({ type: 'disabled', userId: user.Id, name: user.Name, why: `expired ${rec.expires}` });
        log('Disabled', user.Name, '- expired', rec.expires);
        changed = true;
      }
      actions++;
      continue;
    }
    // Extended (or the date removed) after the guard switched it off: switch it back on.
    if (!isExpired(rec) && user.Policy?.IsDisabled && store.disabledByGuard[user.Id]) {
      if (cfg.dryRun) log('[dry run] would re-enable', user.Name);
      else {
        await setDisabled(user, false);
        delete store.disabledByGuard[user.Id];
        recordAction({ type: 'enabled', userId: user.Id, name: user.Name, why: rec?.expires ? `extended to ${rec.expires}` : 'no expiration' });
        log('Re-enabled', user.Name);
        changed = true;
      }
      actions++;
      continue;
    }
    if (user.Policy?.IsDisabled) continue;
    // Device limit: count distinct devices active on the account; sign out the newest arrivals over the limit.
    const devices = active.get(user.Id);
    const seen = store.firstSeen[user.Id] || (store.firstSeen[user.Id] = {});
    if (!devices) continue;
    for (const d of devices.values()) if (!seen[d.deviceId]) { seen[d.deviceId] = Date.now(); changed = true; }
    const limit = limitOf(user.Id);
    if (devices.size <= limit) continue;
    const ordered = [...devices.values()].sort((a, b) => (seen[a.deviceId] - seen[b.deviceId]) || (a.at - b.at));
    for (const d of ordered.slice(limit)) {
      const reason = `This account is in use on more than ${limit} ${limit === 1 ? 'device' : 'devices'}. Sign out on another device to use this one.`;
      try {
        await signOutDevice(user, d, reason);
        if (!cfg.dryRun) {
          delete seen[d.deviceId];
          recordAction({ type: 'signedOut', userId: user.Id, name: user.Name, device: d.name, client: d.client, why: `over the limit of ${limit}` });
          changed = true;
        }
        actions++;
      } catch (e) { log('Could not sign out', d.name, 'from', user.Name, '-', e.message); }
    }
  }
  // Forget devices not seen for a week.
  const cutoff = Date.now() - 7 * 86400000;
  for (const [uid, seen] of Object.entries(store.firstSeen)) {
    const live = active.get(uid);
    for (const [dev, t] of Object.entries(seen)) if (t < cutoff && !live?.has(dev)) { delete seen[dev]; changed = true; }
  }
  if (changed) saveStore();
  return actions;
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  try {
    const actions = await enforce();
    lastRun = { at: Date.now(), ok: true, error: '', actions };
  } catch (e) {
    lastRun = { at: Date.now(), ok: false, error: e.message, actions: 0 };
    log('Check failed:', e.message);
  } finally { running = false; }
}

// ---------- HTTP ----------
function send(res, status, body) {
  const data = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    // Aurora runs from the app (and from a browser), so it calls from another origin. Every request still
    // needs an Emby administrator's token; nothing is shared through cookies.
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'X-Emby-Token, Content-Type',
    'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 64 * 1024) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('bad JSON')); } });
    req.on('error', reject);
  });
}

// Slow down anyone guessing tokens.
const failures = new Map();
function tooManyFailures(ip) {
  const f = failures.get(ip);
  return f && f.count >= 20 && Date.now() - f.since < 10 * 60000;
}
function noteFailure(ip) {
  const f = failures.get(ip);
  if (!f || Date.now() - f.since > 10 * 60000) failures.set(ip, { count: 1, since: Date.now() });
  else f.count++;
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const ip = req.socket.remoteAddress || '';
  if (req.method === 'OPTIONS') return send(res, 204);
  if (url.pathname === '/health' && req.method === 'GET') {
    return send(res, 200, { ok: true, service: 'aurora-guard', version: VERSION });
  }
  if (tooManyFailures(ip)) return send(res, 429, { error: 'Too many failed attempts. Try again in a few minutes.' });
  const token = String(req.headers['x-emby-token'] || '');

  // Any signed-in user, about their own account only. Aurora uses it to explain a block up front; it is
  // not where limits are enforced, and it never returns the store.
  if (url.pathname === '/check' && req.method === 'GET') {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    if (!me) { noteFailure(ip); return send(res, 401, { error: 'Not signed in' }); }
    if (me.Policy?.IsAdministrator) return send(res, 200, { allowed: true });
    const rec = store.users[me.Id];
    if (isExpired(rec)) return send(res, 200, { allowed: false, reason: 'expired', message: `This account expired on ${rec.expires}. Contact the admin to renew it.` });
    const deviceId = url.searchParams.get('deviceId') || '';
    const phase = url.searchParams.get('phase') === 'play' ? 'play' : 'signin';
    const devices = activeByUser(await emby('GET', '/Sessions')).get(me.Id) || new Map();
    let others = [...devices.values()].filter((d) => d.deviceId !== deviceId);
    if (phase === 'play') others = others.filter((d) => d.playing);
    const limit = limitOf(me.Id);
    if (others.length >= limit) {
      const n = others.length;
      return send(res, 200, { allowed: false, reason: 'limit', message: phase === 'play'
        ? `This account is already playing on ${n} other ${n === 1 ? 'device' : 'devices'}. Stop playback on another device to continue.`
        : `This account is already in use on ${n} ${n === 1 ? 'device' : 'devices'}. Sign out on another device to continue.` });
    }
    return send(res, 200, { allowed: true });
  }

  // Everything else: Emby administrators only.
  let admin = false;
  try { admin = await isAdminToken(token); } catch (e) { return send(res, 502, { error: `Can't reach Emby to check who you are: ${e.message}` }); }
  if (!admin) { noteFailure(ip); return send(res, 403, { error: 'Emby administrators only' }); }

  if (url.pathname === '/limits' && req.method === 'GET') {
    return send(res, 200, {
      defaultLimit: cfg.defaultLimit, dryRun: !!cfg.dryRun, users: store.users,
      disabledByGuard: store.disabledByGuard, lastRun, intervalSeconds: cfg.intervalSeconds,
      migrated: !!store.migratedOldLimits,
    });
  }
  // Aurora moves limits saved by its older versions into the guard once, then marks it done here, so values
  // written later into user-writable preferences are never imported.
  if (url.pathname === '/migrated' && req.method === 'PUT') { store.migratedOldLimits = true; saveStore(); return send(res, 200, { ok: true }); }
  if (url.pathname === '/actions' && req.method === 'GET') return send(res, 200, { actions: store.actions.slice(0, 100) });

  const m = url.pathname.match(/^\/limits\/([\w-]{1,64})$/);
  if (m && req.method === 'PUT') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const limit = Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return send(res, 400, { error: 'limit must be a whole number from 1 to 50' });
    if (body.expires !== null && body.expires !== undefined && body.expires !== '' && !isDate(body.expires)) return send(res, 400, { error: 'expires must be YYYY-MM-DD or null' });
    let user;
    try { user = await emby('GET', `/Users/${m[1]}`); } catch (e) { return send(res, e.status === 404 ? 404 : 502, { error: e.status === 404 ? 'No such user' : e.message }); }
    store.users[m[1]] = { limit, expires: body.expires || null, name: user.Name, updated: Date.now() };
    recordAction({ type: 'limits', userId: m[1], name: user.Name, why: `limit ${limit}, ${body.expires ? 'expires ' + body.expires : 'no expiration'}` });
    saveStore();
    log('Limits for', user.Name, 'set to', limit, body.expires ? `expiring ${body.expires}` : 'no expiration');
    // Apply it now rather than at the next minute.
    let applied = true;
    try { await enforce(m[1]); } catch (e) { applied = false; log('Applying', user.Name, 'failed:', e.message); }
    const fresh = await emby('GET', `/Users/${m[1]}`).catch(() => user);
    return send(res, 200, { ok: true, applied, record: store.users[m[1]], disabled: !!fresh.Policy?.IsDisabled, disabledByGuard: !!store.disabledByGuard[m[1]] });
  }
  if (m && req.method === 'DELETE') {
    const had = store.users[m[1]];
    delete store.users[m[1]]; delete store.disabledByGuard[m[1]]; delete store.firstSeen[m[1]];
    if (had) recordAction({ type: 'removed', userId: m[1], name: had.name, why: 'limits removed' });
    saveStore();
    return send(res, 200, { ok: true });
  }
  // The admin switched an account on or off by hand: the guard stops treating it as its own doing.
  const mm = url.pathname.match(/^\/limits\/([\w-]{1,64})\/manual$/);
  if (mm && req.method === 'PUT') {
    delete store.disabledByGuard[mm[1]];
    saveStore();
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'Not found' });
}

// ---------- Start ----------
function start() {
  let server;
  const handler = (req, res) => handle(req, res).catch((e) => { log('Request failed:', e.message); try { send(res, 500, { error: 'Internal error' }); } catch {} });
  if (cfg.pfxPath) {
    server = https.createServer({ pfx: fs.readFileSync(cfg.pfxPath), passphrase: cfg.pfxPassphrase || undefined }, handler);
  } else {
    const local = ['127.0.0.1', 'localhost', '::1'].includes(cfg.host);
    if (!local && !cfg.allowInsecureHttp) {
      console.error('No certificate configured. Admin tokens must not travel over plain http on the internet: set "pfxPath" (the same .pfx certificate Emby uses for https), or "host": "127.0.0.1" for local testing.');
      process.exit(1);
    }
    server = http.createServer(handler);
  }
  server.listen(cfg.port, cfg.host, () => {
    log(`Aurora Guard ${VERSION} listening on ${cfg.pfxPath ? 'https' : 'http'}://${cfg.host}:${cfg.port}; Emby at ${cfg.embyUrl};`,
      `checking every ${cfg.intervalSeconds}s${cfg.dryRun ? ' (DRY RUN: nothing is changed, only logged)' : ''}`);
  });
  tick();
  setInterval(tick, cfg.intervalSeconds * 1000);
}

if (require.main === module) start();
module.exports = { enforce, isExpired, activeByUser };
