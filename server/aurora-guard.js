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
 * Also (1.2.0): sends an alert to a webhook (Discord, ntfy.sh, or any JSON webhook) when it signs a device out or
 * hits a certificate problem; GET /status/users (admins) gives live device counts per account; GET /status (public)
 * is a two-line "is it up" page.
 *
 * No packages to install: plain Node.js 18 or newer.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const os = require('os');

const VERSION = '1.5.0';
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
    exitOnCertError: false,
    intervalSeconds: 60,
    activeWindowMinutes: 5,
    defaultLimit: 2,
    dryRun: false,
    // Where to send alerts (Discord webhook, ntfy.sh topic, or any web address that takes JSON). Blank = no alerts.
    alertWebhookUrl: '',
    alertFormat: 'auto', // auto | discord | ntfy | json
    dataDir: path.join(DIR, 'data'),
    ...raw,
  };
  cfg.alertWebhookUrl = String(cfg.alertWebhookUrl || '').trim();
  if (cfg.alertWebhookUrl && !/^https?:\/\/[^\s]+$/i.test(cfg.alertWebhookUrl)) {
    console.error('config.json: "alertWebhookUrl" must start with https:// or http://. Alerts are switched off.');
    cfg.alertWebhookUrl = '';
  }
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
const PROVIDER_FILE = path.join(cfg.dataDir, 'provider.json');

// ---------- Log ----------
function log(...parts) {
  const line = `${new Date().toISOString()} ${parts.join(' ')}`;
  console.log(line);
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2 * 1024 * 1024) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch { /* logging is best effort */ }
}

// ---------- Alerts ----------
// A short message to a webhook when the guard actually signs someone out (never in dry run) or can't load its
// certificate. It must never get in the way: every call is fire-and-forget, has a hard time limit, can't throw, and
// is rate limited. The address is never written to the log (webhook addresses contain a secret).
function alertFormat() {
  const f = String(cfg.alertFormat || 'auto').toLowerCase();
  if (['discord', 'ntfy', 'json'].includes(f)) return f;
  try {
    const u = new URL(cfg.alertWebhookUrl);
    if (/(^|\.)discord(app)?\.com$/i.test(u.hostname) && /\/api\/webhooks\//.test(u.pathname)) return 'discord';
    if (/(^|\.)ntfy(\.|$)/i.test(u.hostname)) return 'ntfy';
  } catch { /* fall through */ }
  return 'json';
}
// Resolves {ok, status, error}. Never rejects, never takes longer than 10 s.
function postAlert(title, text, urgent) {
  return new Promise((resolve) => {
    let settled = false, req = null, deadline = null;
    const done = (r) => { if (settled) return; settled = true; clearTimeout(deadline); try { req && req.destroy(); } catch {} resolve(r); };
    try {
      if (!cfg.alertWebhookUrl) return done({ ok: false, status: 0, error: 'no alertWebhookUrl is set' });
      const target = new URL(cfg.alertWebhookUrl), fmt = alertFormat();
      const headers = { 'User-Agent': `AuroraGuard/${VERSION}` };
      let body;
      if (fmt === 'discord') {
        body = JSON.stringify({ username: 'Aurora Guard', content: `**${title}**\n${text}`.slice(0, 1900) });
        headers['Content-Type'] = 'application/json';
      } else if (fmt === 'ntfy') {
        body = text;
        headers['Content-Type'] = 'text/plain; charset=utf-8';
        headers.Title = title.replace(/[^\x20-\x7e]/g, ''); // header values must be plain ASCII
        headers.Priority = urgent ? 'high' : 'default';
        headers.Tags = urgent ? 'warning' : 'shield';
      } else {
        // "text", "content" and "message" so Slack-style, Discord-style and generic receivers all find the words.
        body = JSON.stringify({ title, text: `${title}\n${text}`, content: `**${title}**\n${text}`, message: text, urgent: !!urgent, host: os.hostname(), version: VERSION, time: new Date().toISOString() });
        headers['Content-Type'] = 'application/json';
      }
      headers['Content-Length'] = Buffer.byteLength(body);
      deadline = setTimeout(() => done({ ok: false, status: 0, error: 'timed out' }), 10000);
      const lib = target.protocol === 'https:' ? https : http;
      req = lib.request(target, { method: 'POST', headers, timeout: 8000 }, (r) => {
        r.resume();
        r.on('end', () => done({ ok: r.statusCode >= 200 && r.statusCode < 300, status: r.statusCode, error: '' }));
        r.on('error', (e) => done({ ok: false, status: 0, error: e.message }));
      });
      req.on('timeout', () => done({ ok: false, status: 0, error: 'timed out' }));
      req.on('error', (e) => done({ ok: false, status: 0, error: e.message }));
      req.end(body);
    } catch (e) { done({ ok: false, status: 0, error: String((e && e.message) || e) }); }
  });
}
let alertFailLogged = 0, alertWindow = [];
function noteAlertFailure(r) {
  if (Date.now() - alertFailLogged < 10 * 60000) return;
  alertFailLogged = Date.now();
  let host = '';
  try { host = new URL(cfg.alertWebhookUrl).host; } catch { /* none */ }
  log(`Alert NOT delivered to ${host}:`, r.status ? `it answered ${r.status}` : r.error, '(the guard carries on; this is logged at most every 10 minutes)');
}
// Sends now (still without waiting for it), at most 12 a hour.
function sendAlert(title, text, urgent) {
  if (!cfg.alertWebhookUrl) return;
  const now = Date.now();
  alertWindow = alertWindow.filter((t) => now - t < 3600000);
  if (alertWindow.length >= 12) { noteAlertFailure({ status: 0, error: 'too many alerts in the last hour, this one was skipped' }); return; }
  alertWindow.push(now);
  postAlert(title, text, urgent).then((r) => { if (!r.ok) noteAlertFailure(r); }).catch(() => {});
}
// Actions taken during one pass are sent together a moment later as one message.
let alertQueue = [], alertTimer = null;
function queueAlert(line) {
  if (!cfg.alertWebhookUrl) return;
  alertQueue.push(line);
  if (!alertTimer) { alertTimer = setTimeout(flushAlerts, 2000); alertTimer.unref(); }
}
function flushAlerts() {
  alertTimer = null;
  const items = alertQueue.splice(0);
  if (!items.length) return;
  const lines = items.slice(0, 10).map((l) => '- ' + l);
  if (items.length > 10) lines.push(`...and ${items.length - 10} more (see guard.log)`);
  sendAlert(items.length === 1 ? 'Aurora Guard took action' : `Aurora Guard took ${items.length} actions`, lines.join('\n'), false);
}

// ---------- Store ----------
// { users: { userId: { limit, expires: "YYYY-MM-DD" | null, name, updated, updatedBy } },
//   disabledByGuard: { userId: true }, firstSeen: { userId: { deviceId: ms } }, actions: [...] }
// The two starter plans, added once on first run (a store that already has a "plans" list, even an empty one, is left alone).
const STARTER_PLANS = [
  { id: 'starter-1m-2c', name: '1 Month · 2 Connections', price: 35, length: 1, unit: 'month', connections: 2, categories: null, active: true },
  { id: 'starter-2m-4c', name: '2 Months · 4 Connections', price: 55, length: 2, unit: 'month', connections: 4, categories: null, active: true },
];
function emptyStore() { return { users: {}, disabledByGuard: {}, firstSeen: {}, actions: [], reports: [], extensions: [], plans: STARTER_PLANS.map((p) => ({ ...p })), subscriptions: [] }; }
let store = emptyStore();
try { store = { ...emptyStore(), ...JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) }; } catch (e) {
  if (e.code !== 'ENOENT') { log('Could not read', STORE_FILE, '-', e.message, '(starting with an empty store; the old file is kept as limits.json.bad)'); try { fs.copyFileSync(STORE_FILE, STORE_FILE + '.bad'); } catch {} }
}
function saveStore() {
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
  fs.renameSync(tmp, STORE_FILE); // atomic, so a crash never leaves half a file
}
// ---------- Channel reports and the TV provider's API ----------
// The provider's API key is set from Aurora's Admin screen and kept ONLY here (data/provider.json, readable by the
// administrators of this PC). It is never sent back to any app: Admin sees whether a key is set and its last 4 characters.
const PROVIDER_DEFAULTS = { enabled: false, url: '', method: 'POST', keyIn: 'header', keyName: 'X-API-Key', key: '', body: '', updated: 0 };
let provider = { ...PROVIDER_DEFAULTS };
try { provider = { ...PROVIDER_DEFAULTS, ...JSON.parse(fs.readFileSync(PROVIDER_FILE, 'utf8')) }; } catch (e) {
  if (e.code !== 'ENOENT') log('Could not read', PROVIDER_FILE, '-', e.message);
}
function saveProvider() {
  const tmp = PROVIDER_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(provider, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, PROVIDER_FILE);
}
const DEFAULT_REPORT_BODY = '{"channel":"{{channel}}","channelId":"{{channelId}}","reason":"{{reason}}","note":"{{note}}","device":"{{device}}","time":"{{time}}"}';
const publicProvider = () => ({
  enabled: !!provider.enabled, url: provider.url, method: provider.method, keyIn: provider.keyIn, keyName: provider.keyName,
  body: provider.body, keySet: !!provider.key, keyLast4: provider.key ? provider.key.slice(-4) : '', updated: provider.updated,
  defaultBody: DEFAULT_REPORT_BODY,
});
// Fills {{channel}}, {{reason}} … into a template; asJson escapes for a JSON string, asUrl for a web address.
function fillTemplate(tpl, values, mode) {
  return String(tpl).replace(/\{\{(\w+)\}\}/g, (_, k) => {
    const v = String(values[k] ?? '');
    return mode === 'url' ? encodeURIComponent(v) : JSON.stringify(v).slice(1, -1);
  });
}
// Sends one report to the provider. Resolves {ok, status, text}; never includes the key.
function sendToProvider(values) {
  return new Promise((resolve) => {
    if (!provider.url || !provider.key) return resolve({ ok: false, status: 0, text: 'The provider address or key is not set.' });
    let target;
    try { target = new URL(fillTemplate(provider.url, values, 'url')); } catch { return resolve({ ok: false, status: 0, text: 'The provider address is not a valid web address.' }); }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') return resolve({ ok: false, status: 0, text: 'The provider address must start with https:// or http://.' });
    const headers = { Accept: 'application/json, text/plain, */*', 'User-Agent': `AuroraGuard/${VERSION}` };
    if (provider.keyIn === 'bearer') headers.Authorization = `Bearer ${provider.key}`;
    else if (provider.keyIn === 'query') target.searchParams.set(provider.keyName || 'api_key', provider.key);
    else headers[provider.keyName || 'X-API-Key'] = provider.key;
    const method = provider.method === 'GET' ? 'GET' : 'POST';
    let data = null;
    if (method === 'POST') {
      data = Buffer.from(fillTemplate(provider.body || DEFAULT_REPORT_BODY, values, 'json'));
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = data.length;
    }
    const lib = target.protocol === 'https:' ? https : http;
    let req;
    try {
    req = lib.request(target, { method, headers, timeout: 10000 }, (r) => {
      const chunks = []; let size = 0;
      r.on('data', (c) => { size += c.length; if (size < 4096) chunks.push(c); });
      r.on('end', () => resolve({ ok: r.statusCode >= 200 && r.statusCode < 300, status: r.statusCode, text: Buffer.concat(chunks).toString('utf8').slice(0, 300) }));
    });
    req.on('timeout', () => req.destroy(new Error('The provider did not answer in time')));
    req.on('error', (e) => resolve({ ok: false, status: 0, text: String(e.message).split(provider.key).join('***') }));
    if (data) req.write(data);
    req.end();
    } catch (e) {
      // A header name or value Node refuses (a space in the name, a line break in the key): say so instead of failing the request.
      resolve({ ok: false, status: 0, text: String(e.message).split(provider.key).join('***') });
    }
  });
}
const REASONS = ['Buffering', 'No picture', 'No sound', 'Wrong channel', 'Channel is down', 'Other'];
const reportSeen = new Map(); // "userId|channelId" -> ms, so one customer can't repeat a report
const reportCount = new Map(); // userId -> { n, since }
function recordAction(action) {
  store.actions.unshift({ at: Date.now(), ...action });
  store.actions = store.actions.slice(0, 300);
}

// ---------- Plan details and extension requests ----------
// A customer sees their own plan (devices allowed, in use now, the date access ends) and may ask for more time;
// the admin approves or denies it in Admin -> Users. Approving moves the expiration date on (from today, or from the
// current date if that is later) and switches the account back on if the guard had switched it off.
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function addDays(day, n) { const d = new Date(day + 'T12:00:00'); d.setDate(d.getDate() + n); return localDay(d); }
const daysUntil = (day) => Math.ceil((new Date(day + 'T23:59:59').getTime() - Date.now()) / 86400000);
const MAX_REQUESTS_PER_MONTH = 4;
function publicRequest(r) {
  return r && { id: r.id, status: r.status, at: r.at, note: r.note, decidedAt: r.decidedAt || null, days: r.days || null, message: r.message || '', newExpires: r.newExpires || null,
    wantedPlan: r.wantedPlanName || null };
}

// ---------- Subscription plans ----------
// A plan is a price for a length of time with a number of connections (devices at once) and, optionally, only some of the
// Live TV categories. Assigning one to a customer sets their device limit, extends their end date and sets their categories,
// and writes a line in the subscription history. The customer's record keeps a copy of the plan as it was then, so changing
// or deleting a plan later never changes what someone already has. (Aurora records the price; it doesn't take payments.)
function addMonths(day, n) {
  const d = new Date(day + 'T12:00:00'), dom = d.getDate();
  d.setMonth(d.getMonth() + n);
  if (d.getDate() !== dom) d.setDate(0); // 31 Jan + 1 month: the last day of February, not early March
  return localDay(d);
}
const addPlanLength = (day, plan) => (plan.unit === 'day' ? addDays(day, plan.length) : addMonths(day, plan.length));
const planLengthText = (p) => `${p.length} ${p.unit}${p.length === 1 ? '' : 's'}`;
// Checks what the admin typed; returns { plan } or { error }.
function cleanPlan(b, id) {
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) return { error: 'Give the plan a name.' };
  const price = Math.round(Number(b.price) * 100) / 100;
  if (!Number.isFinite(price) || price < 0 || price > 100000) return { error: 'The price must be a number from 0 up.' };
  const unit = b.unit === 'day' ? 'day' : 'month', length = Number(b.length);
  if (!Number.isInteger(length) || length < 1 || length > (unit === 'month' ? 60 : 1825)) return { error: `The length must be a whole number of ${unit}s (1 to ${unit === 'month' ? 60 : 1825}).` };
  const connections = Number(b.connections);
  if (!Number.isInteger(connections) || connections < 1 || connections > 50) return { error: 'Connections must be a whole number from 1 to 50.' };
  let categories = null;
  if (b.categories !== null && b.categories !== undefined) {
    if (!Array.isArray(b.categories) || b.categories.length > 5000) return { error: 'The Live TV categories are not valid.' };
    categories = [...new Set(b.categories.map((c) => String(c).slice(0, 160)))];
    if (!categories.length) return { error: 'Choose at least one Live TV category, or allow all of them.' };
  }
  return { plan: { id, name, price, length, unit, connections, categories, active: b.active !== false } };
}
// Puts a plan on an account. mode "extend": time already left is kept and the plan's length added after it; "today": starts now.
function applyPlan(userId, userName, plan, mode, priceOverride) {
  const today = localDay(new Date());
  const rec = store.users[userId] || (store.users[userId] = { limit: plan.connections, expires: null, name: userName, updated: Date.now() });
  const from = mode === 'extend' && rec.expires && rec.expires > today ? rec.expires : today;
  rec.limit = plan.connections;
  rec.expires = addPlanLength(from, plan);
  rec.categories = plan.categories ? [...plan.categories] : null;
  rec.name = userName; rec.updated = Date.now();
  const price = priceOverride !== undefined && priceOverride !== null && priceOverride !== '' && Number.isFinite(Number(priceOverride)) ? Math.max(0, Math.round(Number(priceOverride) * 100) / 100) : plan.price;
  rec.plan = { id: plan.id, name: plan.name, price, connections: plan.connections, length: plan.length, unit: plan.unit, categories: rec.categories, since: today };
  const entry = { id: crypto.randomBytes(5).toString('hex'), at: Date.now(), userId, name: userName, planId: plan.id, planName: plan.name, price, length: plan.length, unit: plan.unit,
    connections: plan.connections, mode, from, expires: rec.expires };
  store.subscriptions = [entry, ...(store.subscriptions || [])].slice(0, 1000);
  recordAction({ type: 'plan', userId, name: userName, why: `${plan.name}: ${plan.connections} connections until ${rec.expires}` });
  return { rec, entry };
}
function subscriptionTotals() {
  const now = new Date(), month = (d) => `${d.getFullYear()}-${d.getMonth()}`;
  const thisKey = month(now), lastKey = month(new Date(now.getFullYear(), now.getMonth() - 1, 1));
  const out = { thisMonth: { count: 0, revenue: 0 }, lastMonth: { count: 0, revenue: 0 } };
  for (const e of store.subscriptions || []) {
    const k = month(new Date(e.at)), t = k === thisKey ? out.thisMonth : k === lastKey ? out.lastMonth : null;
    if (t) { t.count++; t.revenue = Math.round((t.revenue + e.price) * 100) / 100; }
  }
  return out;
}

const isDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T12:00:00Z'); // a real calendar day: 2026-02-31 would roll over into March
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
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
        // Only the guard's own key carries the guard's identity. A customer's token is sent as it is: some Emby
        // versions refuse a token that arrives with another device's name on it ("Not signed in" for everyone).
        ...(token === cfg.apiKey ? { 'X-Emby-Authorization': `Emby Client="Aurora Guard", Device="Emby server", DeviceId="aurora-guard", Version="${VERSION}"` } : {}),
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

// Emby's session list, shared for 3 seconds: at peak time many clients ask "may I play?" at once, and each
// answer would otherwise cost Emby its own /Sessions call. Signing in and the every-minute job always ask fresh,
// so someone who has just signed out on another device isn't told it's still in use.
let sessionsCache = { at: 0, data: null, pending: null };
async function sessionsShared() {
  if (Date.now() - sessionsCache.at < 3000 && sessionsCache.data) return sessionsCache.data;
  if (!sessionsCache.pending) {
    sessionsCache.pending = emby('GET', '/Sessions')
      .then((d) => { sessionsCache = { at: Date.now(), data: d, pending: null }; return d; })
      .catch((e) => { sessionsCache.pending = null; throw e; });
  }
  return sessionsCache.pending;
}

// The user a token belongs to (for /check, which any signed-in user may call about themselves).
const identityCache = new Map(); // sha256(token + userId) -> { me, until }
async function userOfToken(token, userId) {
  if (!token || !userId || !/^[\w-]{1,64}$/.test(userId)) return null;
  const ckey = crypto.createHash('sha256').update(token + '\n' + userId).digest('hex');
  const known = identityCache.get(ckey);
  if (known && known.until > Date.now()) return known.me;
  const me = await lookupUser(token, userId);
  if (me) {
    identityCache.set(ckey, { me, until: Date.now() + 30000 });
    if (identityCache.size > 1000) identityCache.delete(identityCache.keys().next().value);
  }
  return me;
}
// For Emby versions that fail /Users/Me. Reading /Users/{id} alone proves nothing (the caller names the id, and some
// Emby versions let any signed-in user read other accounts' records), so the same token must also be allowed into that
// account's own views, which Emby only lets the account itself (or an administrator) open.
async function userByIdProvingOwnership(token, userId) {
  const me = await emby('GET', `/Users/${userId}`, { token });
  await emby('GET', `/Users/${userId}/Views`, { token });
  return me;
}
async function lookupUser(token, userId) {
  try {
    const me = await emby('GET', '/Users/Me', { token }).catch(async (e) => {
      // Some Emby versions answer /Users/Me with a 500 for certain tokens (seen with Android TV boxes): ask by id instead.
      if (e.status === 404 || e.status === 400 || e.status >= 500) return userByIdProvingOwnership(token, userId);
      throw e;
    });
    if (me && String(me.Id).toLowerCase() === String(userId).toLowerCase()) return me;
    noteLookupFailure(`Emby answered, but for a different account (${me && me.Id}) than the one asked about (${userId})`);
    return null;
  } catch (e) {
    noteLookupFailure(`Emby refused the token: ${e.message}`);
    return null;
  }
}
// Why a customer's sign-in wasn't recognised, in guard.log (at most once a minute, so it never floods).
let lastLookupNote = 0;
function noteLookupFailure(why) {
  if (Date.now() - lastLookupNote < 60000) return;
  lastLookupNote = Date.now();
  log('Not signed in (/check):', why);
}

// ---------- Enforcement ----------
const windowMs = () => cfg.activeWindowMinutes * 60000;
let lastRun = { at: 0, ok: false, error: '', actions: 0, ms: 0 };
// Could the last every-minute check reach Emby with the configured key? (The public /status page shows this.)
let embyReach = { at: 0, ok: false, error: '' };

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
  let users, sessions;
  try {
    users = await emby('GET', '/Users');
    sessions = await emby('GET', '/Sessions');
    if (!onlyUserId) { embyReach = { at: Date.now(), ok: true, error: '' }; lastSnapshot = { users, sessions }; }
  } catch (e) {
    if (!onlyUserId) embyReach = { at: Date.now(), ok: false, error: e.message };
    throw e;
  }
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
        queueAlert(`${user.Name}: account disabled, expired ${rec.expires}`);
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
          queueAlert(`${user.Name}: signed out ${d.name}${d.client ? ` (${d.client})` : ''}, over the limit of ${limit}`);
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

// ---------- TV provider connections ----------
// The TV provider (restream) account allows a set number of streams at once; past that every channel fails, which
// looks just like buffering. Counted every minute: Aurora's own live player (it notes the channel in the viewer's
// "aurora-watching" preferences, refreshed every minute) plus Emby's own Live TV sessions. The limit and the
// warning level are set in Aurora's Admin → Overview; 0 = not set (counted, but no alerts).
const LIVE_FRESH_MS = 3 * 60000;
let lastSnapshot = null;
let connections = { at: 0, inUse: 0, aurora: 0, emby: 0, streams: [], error: '' };
function connCfg() {
  if (!store.connections) store.connections = { limit: 0, alertAt: 0, peakDay: '', peak: 0, peakAt: 0, warned: false, full: false };
  return store.connections;
}
async function countConnections({ users, sessions }) {
  const names = new Map((Array.isArray(users) ? users : []).map((u) => [u.Id, u.Name]));
  const streams = [];
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (s.NowPlayingItem && s.NowPlayingItem.Type === 'TvChannel') {
      streams.push({ source: 'emby', user: s.UserName || names.get(s.UserId) || '', device: s.DeviceName || '', channel: s.NowPlayingItem.Name || '' });
    }
  }
  // Only accounts with a device active right now can be watching.
  const queue = [...activeByUser(sessions).keys()].filter((id) => names.has(id));
  const worker = async () => {
    while (queue.length) {
      const id = queue.shift();
      let data = null;
      try {
        const prefs = await emby('GET', '/DisplayPreferences/aurora-watching', { query: { userId: id, client: 'aurora' } });
        const raw = prefs && prefs.CustomPrefs && prefs.CustomPrefs.config;
        data = raw ? JSON.parse(raw) : null;
      } catch { continue; }
      for (const e of Object.values((data && data.devices) || {})) {
        if (Date.now() - (e.at || 0) < LIVE_FRESH_MS) streams.push({ source: 'aurora', user: names.get(id), device: e.device || '', channel: [e.num, e.name].filter(Boolean).join(' '), since: e.started || 0 });
      }
    }
  };
  await Promise.all([0, 1, 2, 3].map(worker));
  return streams;
}
async function checkConnections() {
  if (!lastSnapshot) return;
  let streams;
  try { streams = await countConnections(lastSnapshot); } catch (e) { connections.error = e.message; return; }
  const n = streams.length;
  connections = { at: Date.now(), inUse: n, aurora: streams.filter((x) => x.source === 'aurora').length, emby: streams.filter((x) => x.source === 'emby').length, streams, error: '' };
  const c = connCfg(), today = new Date().toDateString();
  let changed = false;
  if (c.peakDay !== today) { c.peakDay = today; c.peak = 0; c.peakAt = 0; changed = true; }
  if (n > c.peak) { c.peak = n; c.peakAt = Date.now(); changed = true; }
  if (c.limit > 0) {
    // Each alert once, until the count has dropped back a little (so it doesn't repeat every minute at the edge).
    if (n >= c.limit && !c.full) {
      c.full = true; changed = true;
      log(`TV provider connections full: ${n} of ${c.limit} in use`);
      sendAlert('Aurora: TV provider connections are full', `${n} of ${c.limit} streams in use. New channels will fail until someone stops watching.`, true);
    } else if (c.full && n < Math.max(1, c.limit - 1)) { c.full = false; changed = true; }
    if (c.alertAt > 0 && n >= c.alertAt && n < c.limit && !c.warned) {
      c.warned = true; changed = true;
      log(`TV provider connections high: ${n} of ${c.limit} in use`);
      sendAlert('Aurora: TV provider connections running high', `${n} of ${c.limit} streams in use (warning level ${c.alertAt}).`, false);
    } else if (c.warned && n < Math.max(1, c.alertAt - 2)) { c.warned = false; changed = true; }
  }
  if (changed) saveStore();
}

let running = false;
async function tick() {
  if (running) return;
  running = true;
  const began = Date.now();
  try {
    const actions = await enforce();
    lastRun = { at: Date.now(), ok: true, error: '', actions, ms: Date.now() - began };
    await checkConnections().catch((e) => log('Counting TV provider connections failed:', e.message));
  } catch (e) {
    lastRun = { at: Date.now(), ok: false, error: e.message, actions: 0, ms: Date.now() - began };
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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '7200', // the browser remembers the permission check, so /check is one round trip
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

// Slow down anyone guessing admin tokens. Only attempts at the admin endpoints count: /check is called by every
// customer's app (many of them behind one shared address, with tokens that expire or get signed out), so its
// failures must never lock anyone out.
const failures = new Map();
const FAILURE_LIMIT = 30;
function tooManyFailures(ip) {
  const f = failures.get(ip);
  return f && f.count >= FAILURE_LIMIT && Date.now() - f.since < 10 * 60000;
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
  // A glance check, no login and nothing sensitive: is the guard answering, and could its last every-minute check
  // reach Emby with the configured key? It reads what the loop already found, so it never makes a call to Emby.
  if (/^\/status\/?$/.test(url.pathname) && (req.method === 'GET' || req.method === 'HEAD')) {
    const stale = Date.now() - embyReach.at > Math.max(180000, cfg.intervalSeconds * 3000);
    const aurora = !embyReach.at ? (process.uptime() < 90 ? 'checking...' : 'offline') : (embyReach.ok && !stale ? 'online' : 'offline');
    // Readable by Aurora on any device (Settings shows "Aurora: Online/Offline" to customers).
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    return res.end(req.method === 'HEAD' ? undefined : `Guard: online\nAurora: ${aurora}\n`);
  }
  const token = String(req.headers['x-emby-token'] || '');

  // Any signed-in user, about their own account only. Aurora uses it to explain a block up front; it is
  // not where limits are enforced, and it never returns the store.
  if (url.pathname === '/check' && req.method === 'GET') {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    if (me.Policy?.IsAdministrator) return send(res, 200, { allowed: true });
    const rec = store.users[me.Id];
    if (isExpired(rec)) return send(res, 200, { allowed: false, reason: 'expired', message: `This account expired on ${rec.expires}. Contact the admin to renew it.` });
    const deviceId = url.searchParams.get('deviceId') || '';
    const phase = url.searchParams.get('phase') === 'play' ? 'play' : 'signin';
    const devices = activeByUser(phase === 'play' ? await sessionsShared() : await emby('GET', '/Sessions')).get(me.Id) || new Map();
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

  // A signed-in customer reporting a channel. Kept (and, if the admin set up the provider, passed on). Repeats of the
  // same channel from the same account within 10 minutes are ignored, and each account gets 30 reports an hour.
  if (url.pathname === '/report' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const me = await userOfToken(token, String(body.userId || ''));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    const channel = String(body.channel || '').slice(0, 120).trim();
    if (!channel) return send(res, 400, { error: 'channel is needed' });
    const channelId = String(body.channelId || '').slice(0, 120);
    const reason = REASONS.includes(body.reason) ? body.reason : 'Other';
    const note = String(body.note || '').slice(0, 300);
    const key = `${me.Id}|${channelId || channel}`;
    if (Date.now() - (reportSeen.get(key) || 0) < 10 * 60000) return send(res, 200, { ok: true, duplicate: true });
    const c = reportCount.get(me.Id);
    if (!c || Date.now() - c.since > 3600000) reportCount.set(me.Id, { n: 1, since: Date.now() });
    else if (++c.n > 30) return send(res, 429, { error: 'Too many reports. Try again later.' });
    reportSeen.set(key, Date.now());
    if (reportSeen.size > 5000) reportSeen.delete(reportSeen.keys().next().value);
    const entry = {
      at: Date.now(), channel, channelId, reason, note, user: me.Name, device: String(body.device || '').slice(0, 80),
      group: String(body.group || '').slice(0, 80), auto: !!body.auto, forwarded: 'off',
    };
    if (provider.enabled && provider.url && provider.key) {
      const r = await sendToProvider({ channel, channelId, reason, note: note || (body.auto ? 'Reported automatically after repeated buffering' : ''), device: entry.device, user: me.Name, group: entry.group, time: new Date().toISOString() });
      entry.forwarded = r.ok ? 'sent' : 'failed';
      entry.providerStatus = r.status;
      if (!r.ok) log('Report to the provider failed:', r.status || '', r.text.slice(0, 120));
    }
    store.reports = [entry, ...(store.reports || [])].slice(0, 1000);
    saveStore();
    return send(res, 200, { ok: true });
  }

  // A signed-in customer's own plan: how many devices at once, how many in use, when access ends, and the state of
  // an extension request. About themselves only; nothing about anyone else.
  if (url.pathname === '/account' && req.method === 'GET') {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    if (me.Policy?.IsAdministrator) return send(res, 200, { admin: true, name: me.Name });
    const rec = store.users[me.Id];
    const devices = activeByUser(await sessionsShared()).get(me.Id);
    const mine = (store.extensions || []).filter((x) => x.userId === me.Id);
    const latest = mine[0] || null;
    const expires = rec?.expires || null;
    return send(res, 200, {
      name: me.Name, limit: limitOf(me.Id), activeDevices: devices ? devices.size : 0,
      expires, expired: isExpired(rec), daysLeft: expires ? daysUntil(expires) : null, disabled: !!me.Policy?.IsDisabled,
      plan: rec?.plan ? { name: rec.plan.name, connections: rec.plan.connections, length: rec.plan.length, unit: rec.plan.unit } : null,
      categories: rec?.categories || null, // the Live TV categories this account may see (null: all of them)
      request: publicRequest(latest),
      canRequest: !!expires && !(latest && latest.status === 'pending')
        && mine.filter((x) => Date.now() - x.at < 30 * 86400000).length < MAX_REQUESTS_PER_MONTH,
    });
  }
  // The plans a customer can ask for (active ones only; name, price, length, connections).
  if (url.pathname === '/plans/public' && req.method === 'GET') {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    return send(res, 200, { plans: (store.plans || []).filter((x) => x.active).map((x) => ({ id: x.id, name: x.name, price: x.price, length: x.length, unit: x.unit, connections: x.connections })) });
  }
  if (url.pathname === '/extension' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const me = await userOfToken(token, String(body.userId || ''));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    if (me.Policy?.IsAdministrator) return send(res, 400, { error: 'Administrator accounts have no expiration.' });
    const rec = store.users[me.Id];
    if (!rec?.expires) return send(res, 400, { error: 'This account has no end date, so there is nothing to extend.' });
    const mine = (store.extensions || []).filter((x) => x.userId === me.Id);
    if (mine[0]?.status === 'pending') return send(res, 409, { error: 'You already have a request waiting.' });
    if (mine.filter((x) => Date.now() - x.at < 30 * 86400000).length >= MAX_REQUESTS_PER_MONTH) return send(res, 429, { error: 'Too many requests this month. Please contact the admin.' });
    const wanted = body.planId ? (store.plans || []).find((x) => x.id === body.planId && x.active) : null;
    const entry = { id: crypto.randomBytes(6).toString('hex'), userId: me.Id, name: me.Name, at: Date.now(), note: String(body.note || '').slice(0, 300).trim(), status: 'pending', expiresAtRequest: rec.expires,
      wantedPlanId: wanted ? wanted.id : null, wantedPlanName: wanted ? `${wanted.name} ($${wanted.price})` : null };
    store.extensions = [entry, ...(store.extensions || [])].slice(0, 500);
    recordAction({ type: 'extensionRequested', userId: me.Id, name: me.Name, why: `asked for an extension (expires ${rec.expires})` });
    saveStore();
    log('Extension requested by', me.Name, `(expires ${rec.expires})`);
    sendAlert('Aurora: extension requested', `${me.Name} asked for more time (access ends ${rec.expires}).${entry.wantedPlanName ? '\nWants: ' + entry.wantedPlanName : ''}${entry.note ? '\n"' + entry.note + '"' : ''}`, false);
    return send(res, 200, { ok: true, request: publicRequest(entry) });
  }

  // Everything else: Emby administrators only.
  if (tooManyFailures(ip)) return send(res, 429, { error: 'Too many failed attempts. Try again in a few minutes.' });
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

  // Live device counts, for Admin → Users. "Managed" accounts are the ones with a saved limit or expiration, plus any
  // account with a device in use right now (the guard enforces those with the default limit). Administrators are never
  // limited, so they aren't listed.
  if (url.pathname === '/status/users' && req.method === 'GET') {
    let users, sessions;
    try { [users, sessions] = await Promise.all([emby('GET', '/Users'), emby('GET', '/Sessions')]); } catch (e) { return send(res, 502, { error: `Can't reach Emby: ${e.message}` }); }
    const active = activeByUser(sessions);
    const list = [];
    for (const u of Array.isArray(users) ? users : []) {
      if (u.Policy?.IsAdministrator) continue;
      const rec = store.users[u.Id], devs = active.get(u.Id);
      if (!rec && !devs) continue;
      const limit = limitOf(u.Id), devices = devs ? [...devs.values()].sort((a, b) => b.at - a.at) : [];
      list.push({
        userId: u.Id, name: u.Name, managed: !!rec, limit, activeDevices: devices.length, over: devices.length > limit,
        disabled: !!u.Policy?.IsDisabled, expires: rec?.expires || null, expired: isExpired(rec),
        devices: devices.map((d) => ({ name: d.name, client: d.client, playing: d.playing, lastActive: new Date(d.at).toISOString() })),
      });
    }
    list.sort((a, b) => (b.over - a.over) || String(a.name).localeCompare(String(b.name)));
    return send(res, 200, {
      version: VERSION, now: new Date().toISOString(), dryRun: !!cfg.dryRun, activeWindowMinutes: cfg.activeWindowMinutes, defaultLimit: cfg.defaultLimit,
      emby: { online: embyReach.ok, checkedAt: embyReach.at ? new Date(embyReach.at).toISOString() : null, error: embyReach.error },
      lastRun, totals: { accounts: list.length, over: list.filter((x) => x.over).length, activeDevices: list.reduce((n, x) => n + x.activeDevices, 0) }, users: list,
    });
  }

  // Subscription plans (admin): the list, the history and what came in this month and last.
  if (url.pathname === '/plans' && req.method === 'GET') {
    return send(res, 200, { plans: store.plans || [], subscriptions: (store.subscriptions || []).slice(0, 100), totals: subscriptionTotals() });
  }
  if (url.pathname === '/plans' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const c = cleanPlan(body, 'p' + crypto.randomBytes(4).toString('hex'));
    if (c.error) return send(res, 400, { error: c.error });
    store.plans = [...(store.plans || []), c.plan];
    recordAction({ type: 'plans', why: `plan added: ${c.plan.name}, $${c.plan.price}` });
    saveStore();
    return send(res, 200, { plan: c.plan });
  }
  const pm = url.pathname.match(/^\/plans\/([\w-]{1,40})$/);
  if (pm && req.method === 'PUT') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const i = (store.plans || []).findIndex((x) => x.id === pm[1]);
    if (i < 0) return send(res, 404, { error: 'No such plan' });
    const c = cleanPlan(body, pm[1]);
    if (c.error) return send(res, 400, { error: c.error });
    store.plans[i] = c.plan;
    recordAction({ type: 'plans', why: `plan changed: ${c.plan.name}` });
    saveStore();
    return send(res, 200, { plan: c.plan });
  }
  if (pm && req.method === 'DELETE') {
    const had = (store.plans || []).find((x) => x.id === pm[1]);
    store.plans = (store.plans || []).filter((x) => x.id !== pm[1]);
    if (had) { recordAction({ type: 'plans', why: `plan deleted: ${had.name}` }); saveStore(); }
    return send(res, 200, { ok: true });
  }
  // Put a plan on an account: { planId, mode: "extend" | "today", price? (a different price than the plan's, for this one) }.
  const lp = url.pathname.match(/^\/limits\/([\w-]{1,64})\/plan$/);
  if (lp && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const plan = (store.plans || []).find((x) => x.id === body.planId);
    if (!plan) return send(res, 404, { error: 'No such plan' });
    if (body.price !== undefined && body.price !== null && body.price !== '' && !(Number(body.price) >= 0 && Number(body.price) <= 100000)) return send(res, 400, { error: 'The price must be a number from 0 up.' });
    let user;
    try { user = await emby('GET', `/Users/${lp[1]}`); } catch (e) { return send(res, e.status === 404 ? 404 : 502, { error: e.status === 404 ? 'No such user' : e.message }); }
    if (user.Policy?.IsAdministrator) return send(res, 400, { error: 'Administrator accounts have no plan.' });
    const { rec, entry } = applyPlan(lp[1], user.Name, plan, body.mode === 'today' ? 'today' : 'extend', body.price);
    saveStore();
    log('Plan', plan.name, 'for', user.Name, 'until', rec.expires);
    let applied = true;
    try { await enforce(lp[1]); } catch (e) { applied = false; log('Applying', user.Name, 'failed:', e.message); }
    return send(res, 200, { ok: true, applied, record: rec, subscription: entry });
  }

  // Extension requests, for Admin -> Users.
  if (url.pathname === '/extensions' && req.method === 'GET') {
    const list = (store.extensions || []).map((x) => ({ ...x, currentExpires: store.users[x.userId]?.expires || null }));
    return send(res, 200, { pending: list.filter((x) => x.status === 'pending').reverse(), decided: list.filter((x) => x.status !== 'pending').slice(0, 30) });
  }
  const ex = url.pathname.match(/^\/extensions\/([\w-]{1,32})$/);
  if (ex && req.method === 'PUT') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const r = (store.extensions || []).find((x) => x.id === ex[1]);
    if (!r) return send(res, 404, { error: 'No such request' });
    if (r.status !== 'pending') return send(res, 409, { error: `Already ${r.status}.` });
    const message = String(body.message || '').slice(0, 200).trim();
    if (body.action === 'deny') {
      r.status = 'denied'; r.decidedAt = Date.now(); r.message = message;
      recordAction({ type: 'extensionDenied', userId: r.userId, name: r.name, why: 'extension denied' });
      saveStore();
      return send(res, 200, { ok: true, request: r });
    }
    if (body.action !== 'approve') return send(res, 400, { error: 'action must be approve or deny' });
    // Approving with a plan (what the customer asked for, or another): it sets their connections, end date and categories.
    const planChosen = body.planId ? (store.plans || []).find((x) => x.id === body.planId) : null;
    if (body.planId && !planChosen) return send(res, 404, { error: 'No such plan' });
    const days = planChosen ? 0 : Number(body.days);
    if (!planChosen && (!Number.isInteger(days) || days < 1 || days > 730)) return send(res, 400, { error: 'days must be a whole number from 1 to 730' });
    let user;
    try { user = await emby('GET', `/Users/${r.userId}`); } catch (e) { return send(res, e.status === 404 ? 404 : 502, { error: e.status === 404 ? 'That account no longer exists' : e.message }); }
    // The admin may have made the account permanent since it asked: approving would put an end date back on it.
    if (!store.users[r.userId]?.expires) {
      r.status = 'denied'; r.decidedAt = Date.now(); r.message = 'This account no longer has an end date.';
      saveStore();
      return send(res, 409, { error: 'This account no longer has an end date, so there is nothing to extend. The request was closed.' });
    }
    const rec = store.users[r.userId];
    const today = localDay(new Date());
    if (planChosen) {
      applyPlan(r.userId, user.Name, planChosen, 'extend', body.price);
      r.status = 'approved'; r.decidedAt = Date.now(); r.days = null; r.message = message; r.newExpires = rec.expires; r.planName = planChosen.name;
    } else {
      const from = rec.expires && rec.expires > today ? rec.expires : today; // time already left is kept, never lost
      rec.expires = addDays(from, days); rec.name = user.Name; rec.updated = Date.now();
      r.status = 'approved'; r.decidedAt = Date.now(); r.days = days; r.message = message; r.newExpires = rec.expires;
      recordAction({ type: 'extended', userId: r.userId, name: r.name, why: `extended ${days} days, now ends ${rec.expires}` });
    }
    saveStore();
    log('Extended', r.name, planChosen ? planChosen.name : days + ' days', 'now ends', rec.expires);
    let applied = true;
    try { await enforce(r.userId); } catch (e) { applied = false; log('Applying', r.name, 'failed:', e.message); }
    return send(res, 200, { ok: true, applied, request: r });
  }

  // TV provider connections in use (counted every minute), today's peak, and the limit and warning level.
  if (url.pathname === '/connections' && req.method === 'GET') {
    const c = connCfg();
    return send(res, 200, { ...connections, checkedAt: connections.at ? new Date(connections.at).toISOString() : null, limit: c.limit, alertAt: c.alertAt, peak: c.peakDay === new Date().toDateString() ? c.peak : 0, peakAt: c.peakAt ? new Date(c.peakAt).toISOString() : null });
  }
  if (url.pathname === '/connections' && req.method === 'PUT') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const limit = Number(body.limit), alertAt = Number(body.alertAt || 0);
    if (!Number.isInteger(limit) || limit < 0 || limit > 1000) return send(res, 400, { error: 'limit must be a whole number from 0 to 1000' });
    if (!Number.isInteger(alertAt) || alertAt < 0 || (limit && alertAt > limit)) return send(res, 400, { error: 'the warning level must be a whole number no higher than the limit' });
    const c = connCfg();
    c.limit = limit; c.alertAt = alertAt; c.warned = false; c.full = false;
    recordAction({ type: 'connections', why: limit ? `provider connections: limit ${limit}, warn at ${alertAt || 'off'}` : 'provider connection limit cleared' });
    saveStore();
    log('TV provider connections: limit', limit || 'not set', '- warn at', alertAt || 'off');
    return send(res, 200, { ok: true, limit, alertAt });
  }

  // The TV provider's reporting API (the key is write-only: never returned).
  if (url.pathname === '/provider' && req.method === 'GET') return send(res, 200, publicProvider());
  if (url.pathname === '/provider' && req.method === 'PUT') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const u = String(body.url || '').trim();
    if (u && !/^https?:\/\//i.test(u)) return send(res, 400, { error: 'The address must start with https:// or http://' });
    if (body.method && !['GET', 'POST'].includes(body.method)) return send(res, 400, { error: 'method must be GET or POST' });
    if (body.keyIn && !['header', 'bearer', 'query'].includes(body.keyIn)) return send(res, 400, { error: 'keyIn must be header, bearer or query' });
    if (body.keyName && !/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,60}$/.test(String(body.keyName).trim())) return send(res, 400, { error: 'The key name can only use letters, numbers and - _ . (no spaces), like X-API-Key.' });
    if (typeof body.key === 'string' && body.key.trim() && !/^[\x21-\x7E]+$/.test(body.key.trim())) return send(res, 400, { error: 'The key has a space or a character that can\'t be sent. Paste it again without spaces or line breaks.' });
    if (body.body && String(body.body).trim()) {
      // A JSON template must still be valid JSON once filled in.
      try { JSON.parse(fillTemplate(body.body, { channel: 'x', channelId: '1', reason: 'r', note: 'n', device: 'd', user: 'u', group: 'g', time: 't' }, 'json')); } catch { return send(res, 400, { error: 'The body is not valid JSON. Check the quotes and commas.' }); }
    }
    provider.url = u;
    if (body.method) provider.method = body.method;
    if (body.keyIn) provider.keyIn = body.keyIn;
    provider.keyName = String(body.keyName || '').trim().slice(0, 60) || provider.keyName;
    provider.body = String(body.body || '').slice(0, 4000);
    provider.enabled = !!body.enabled;
    if (typeof body.key === 'string' && body.key.trim()) provider.key = body.key.trim().slice(0, 500);
    provider.updated = Date.now();
    saveProvider();
    recordAction({ type: 'provider', why: `provider reporting ${provider.enabled ? 'on' : 'off'}${body.key ? ', key changed' : ''}` });
    saveStore();
    log('Provider settings saved (reporting', provider.enabled ? 'on' : 'off', body.key ? ', key changed)' : ')');
    return send(res, 200, publicProvider());
  }
  if (url.pathname === '/provider/key' && req.method === 'DELETE') {
    provider.key = ''; provider.enabled = false; provider.updated = Date.now();
    saveProvider();
    recordAction({ type: 'provider', why: 'provider key removed' });
    saveStore();
    log('Provider key removed');
    return send(res, 200, publicProvider());
  }
  if (url.pathname === '/provider/test' && req.method === 'POST') {
    const r = await sendToProvider({ channel: 'Aurora test channel', channelId: 'test', reason: 'Other', note: 'Test report from Aurora. Please ignore.', device: 'Aurora admin', user: 'admin', group: 'Test', time: new Date().toISOString() });
    return send(res, 200, r);
  }
  if (url.pathname === '/reports' && req.method === 'GET') {
    const list = store.reports || [];
    const byChannel = new Map();
    for (const r of list) {
      const k = r.channelId || r.channel;
      const e = byChannel.get(k) || { channel: r.channel, channelId: r.channelId, count: 0, users: new Set(), last: 0, reasons: {} };
      e.count++; e.users.add(r.user); e.last = Math.max(e.last, r.at); e.reasons[r.reason] = (e.reasons[r.reason] || 0) + 1;
      byChannel.set(k, e);
    }
    const channels = [...byChannel.values()].map((e) => ({ ...e, users: e.users.size })).sort((a, b) => b.count - a.count || b.last - a.last).slice(0, 50);
    return send(res, 200, { reports: list.slice(0, 100), channels, total: list.length });
  }
  if (url.pathname === '/reports' && req.method === 'DELETE') { store.reports = []; saveStore(); return send(res, 200, { ok: true }); }

  const m = url.pathname.match(/^\/limits\/([\w-]{1,64})$/);
  if (m && req.method === 'PUT') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const limit = Number(body.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) return send(res, 400, { error: 'limit must be a whole number from 1 to 50' });
    if (body.expires !== null && body.expires !== undefined && body.expires !== '' && !isDate(body.expires)) return send(res, 400, { error: 'expires must be YYYY-MM-DD or null' });
    let user;
    try { user = await emby('GET', `/Users/${m[1]}`); } catch (e) { return send(res, e.status === 404 ? 404 : 502, { error: e.status === 404 ? 'No such user' : e.message }); }
    // Keep the plan and the Live TV categories it set: changing the limit or the date by hand doesn't remove them.
    store.users[m[1]] = { ...(store.users[m[1]] || {}), limit, expires: body.expires || null, name: user.Name, updated: Date.now() };
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

// ---------- HTTPS certificate ----------
const legacyProviderOn = () => process.execArgv.includes('--openssl-legacy-provider') || /--openssl-legacy-provider/.test(process.env.NODE_OPTIONS || '');

// What went wrong with the certificate, in words that say what to do about it.
function explainCertError(e) {
  const msg = String((e && e.message) || e);
  const file = cfg.pfxPath;
  if (e && e.code === 'ENOENT') return `The certificate file "${file}" doesn't exist. Check "pfxPath" in config.json (in a JSON file every backslash is doubled, like "C:\\\\certs\\\\emby.pfx", or use forward slashes).`;
  if (e && (e.code === 'EACCES' || e.code === 'EPERM')) return `The certificate file "${file}" can't be read by the account the guard runs as (the scheduled task runs as SYSTEM, which can't open files inside a user's own folders). Copy the .pfx into this folder and point "pfxPath" at the copy.`;
  if (e && e.code === 'EISDIR') return `"pfxPath" points at a folder, not at the .pfx file: ${file}`;
  if (/mac verify failure|bad decrypt|invalid password|wrong password|mac check/i.test(msg)) return 'The certificate password is wrong. Check "pfxPassphrase" in config.json.';
  if ((e && e.code === 'ERR_OSSL_EVP_UNSUPPORTED') || /unsupported|digital envelope|PKCS12/i.test(msg)) {
    return legacyProviderOn()
      ? `Node.js can't read this certificate even with the OpenSSL legacy provider switched on (${msg}). Re-export it with modern encryption: openssl pkcs12 -legacy -in old.pfx -nodes -out all.pem, then openssl pkcs12 -export -in all.pem -out new.pfx (OpenSSL comes with Git for Windows).`
      : 'The certificate uses an older encryption (RC2 / 3DES) that Node.js no longer opens by default. Start the guard with --openssl-legacy-provider (install-windows.ps1 does this), or re-export the .pfx with modern encryption.';
  }
  return `The certificate "${file}" couldn't be loaded: ${msg}. Check that it is a .pfx (PKCS#12) file and not damaged.`;
}

// Opens the .pfx the way the https server will, so a certificate problem is found here and explained,
// not as a stack trace from inside Node.
function loadCertificate() {
  try {
    const pfx = fs.readFileSync(cfg.pfxPath);
    require('tls').createSecureContext({ pfx, passphrase: cfg.pfxPassphrase || undefined });
    return { pfx };
  } catch (e) {
    return { error: explainCertError(e) };
  }
}

const isLocalHost = () => ['127.0.0.1', 'localhost', '::1'].includes(cfg.host);

// node aurora-guard.js --check: tries the certificate and the Emby API key, prints what it found and exits
// with 0 (all good), 1 (a problem to fix) or 2 (only a warning: Emby couldn't be reached right now).
async function selfCheck() {
  let problems = 0, warnings = 0;
  console.log(`Aurora Guard ${VERSION}`);
  if (cfg.pfxPath) {
    const cert = loadCertificate();
    if (cert.error) { console.log('PROBLEM: ' + cert.error); problems++; }
    else console.log(`OK: the certificate "${cfg.pfxPath}" loads${legacyProviderOn() ? ' (OpenSSL legacy provider is on)' : ''}.`);
  } else if (!isLocalHost() && !cfg.allowInsecureHttp) {
    console.log('PROBLEM: no certificate is set. Admin tokens must not travel over plain http on the internet: set "pfxPath" (the same .pfx certificate Emby uses for https).');
    problems++;
  }
  try {
    const info = await emby('GET', '/System/Info');
    console.log(`OK: Emby answered at ${cfg.embyUrl} (${(info && info.ServerName) || 'server'} ${(info && info.Version) || ''}), and the API key works.`);
  } catch (e) {
    if (e.status === 401 || e.status === 403) { console.log('PROBLEM: Emby refused the API key. Create one in the Emby dashboard (Advanced → API Keys) and put it in "apiKey" in config.json.'); problems++; }
    else { console.log(`WARNING: couldn't reach Emby at ${cfg.embyUrl}: ${e.message}. Is Emby running, and is "embyUrl" right? The guard will keep trying.`); warnings++; }
  }
  process.exit(problems ? 1 : warnings ? 2 : 0);
}

// ---------- Start ----------
function start() {
  const handler = (req, res) => handle(req, res).catch((e) => { log('Request failed:', e.message); try { send(res, 500, { error: 'Internal error' }); } catch {} });
  let server = null;
  if (cfg.pfxPath) {
    const cert = loadCertificate();
    if (cert.error) {
      // No https endpoint without a certificate, and never plain http instead: admin tokens would cross the
      // internet unencrypted. The every-minute job doesn't need the endpoint, so by default it keeps running
      // with the limits already saved, and says loudly what is wrong.
      log('CERTIFICATE PROBLEM: the https endpoint is NOT running.', cert.error);
      sendAlert('Aurora Guard: certificate problem', `The https endpoint is NOT running, so Aurora's Admin screen can't reach the guard.\n${cert.error}`, true);
      if (cfg.exitOnCertError) { log('Stopping (exitOnCertError is on).'); process.exit(1); }
      log('Aurora cannot reach the guard until this is fixed, so Admin → Users can\'t change limits. The every-minute check carries on with the limits already saved. Fix config.json or the certificate and restart the "Aurora Guard" task.');
      setInterval(() => log('REMINDER: the https endpoint is still NOT running.', cert.error), 10 * 60000).unref();
    } else {
      log(`Certificate loaded${legacyProviderOn() ? ' (OpenSSL legacy provider on)' : ''}.`);
      server = https.createServer({ pfx: cert.pfx, passphrase: cfg.pfxPassphrase || undefined }, handler);
    }
  } else {
    if (!isLocalHost() && !cfg.allowInsecureHttp) {
      console.error('No certificate configured. Admin tokens must not travel over plain http on the internet: set "pfxPath" (the same .pfx certificate Emby uses for https), or "host": "127.0.0.1" for local testing.');
      process.exit(1);
    }
    server = http.createServer(handler);
  }
  if (server) {
    server.on('error', (e) => {
      log(e.code === 'EADDRINUSE'
        ? `Port ${cfg.port} is already in use. Is another copy of the guard already running (Task Manager → node.exe), or another program on that port? Change "port" in config.json, or stop the other one.`
        : e.code === 'EACCES' ? `Not allowed to listen on port ${cfg.port}. Use a port above 1024, or run as Administrator.`
          : `The server stopped: ${e.message}`);
      process.exit(1);
    });
    server.listen(cfg.port, cfg.host, () => {
      log(`Aurora Guard ${VERSION} listening on ${cfg.pfxPath ? 'https' : 'http'}://${cfg.host}:${cfg.port}; Emby at ${cfg.embyUrl};`,
        `checking every ${cfg.intervalSeconds}s${cfg.dryRun ? ' (DRY RUN: nothing is changed, only logged)' : ''}`);
    });
  }
  tick();
  setInterval(tick, cfg.intervalSeconds * 1000);
}

// node aurora-guard.js --test-alert: sends one test message to alertWebhookUrl and says whether it arrived.
async function testAlert() {
  if (!cfg.alertWebhookUrl) { console.log('No "alertWebhookUrl" is set in config.json, so there is nowhere to send an alert.'); process.exit(1); }
  const r = await postAlert('Aurora Guard: test alert', `This is a test from ${os.hostname()} (guard ${VERSION}). If you can read it, alerts work.`, false);
  console.log(r.ok ? `OK: the webhook accepted it (${r.status}).` : `FAILED: ${r.status ? 'the webhook answered ' + r.status : r.error}`);
  process.exit(r.ok ? 0 : 1);
}

if (require.main === module) { if (process.argv.includes('--check')) selfCheck(); else if (process.argv.includes('--test-alert')) testAlert(); else start(); }
module.exports = { enforce, isExpired, activeByUser };
