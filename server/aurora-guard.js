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

const VERSION = '1.16.1';
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
    // Admin -> Sharing: flag an account seen on this many different networks in a week, or watching from two networks at once.
    sharingNetworks: 4,
    sharingSimultaneousMinutes: 10,
    // Admin -> Server: drives to show free space for (blank = the drive the guard is on), and the free-space level that sends an alert.
    diskPaths: [],
    diskAlertPercent: 10,
    // Resellers: a reseller is warned when their credits are at or under this, and can start this many free 2-day trials a day.
    resellerLowCredits: 3,
    resellerTrialsPerDay: 5,
    // Refer a friend: free days for both people (0 switches it off), and the most friends one customer can bring a year.
    referralDays: 7,
    referralMaxPerYear: 10,
    // Website sign-up (guard 1.16.0): anyone can make a free trial account from the Aurora website. OFF until you set "signupEnabled": true.
    signupEnabled: false,
    signupTrialDays: 2,
    signupTrialConnections: 1,
    signupMaxPerDay: 30,      // most new accounts in one day, in total
    signupPerIpPerDay: 3,     // most from one internet address in one day
    // Sports scores (Live TV -> Sports): ESPN's public scoreboard feed. It is not an official, documented API and ESPN can change or
    // stop it at any time. Set "scoresEnabled": false to switch it off, or "scoresBase" to point at another server with the same shape.
    scoresEnabled: true,
    scoresBase: 'https://site.api.espn.com',
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
function emptyStore() { return { users: {}, disabledByGuard: {}, firstSeen: {}, actions: [], audit: [], usage: {}, sharing: {}, reports: [], extensions: [], plans: STARTER_PLANS.map((p) => ({ ...p })), subscriptions: [], discounts: [], signups: [] }; }
let store = emptyStore();
try { store = { ...emptyStore(), ...JSON.parse(fs.readFileSync(STORE_FILE, 'utf8')) }; } catch (e) {
  if (e.code !== 'ENOENT') { log('Could not read', STORE_FILE, '-', e.message, '(starting with an empty store; the old file is kept as limits.json.bad)'); try { fs.copyFileSync(STORE_FILE, STORE_FILE + '.bad'); } catch {} }
}
function saveStore() {
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 1));
  // Atomic, so a crash never leaves half a file. On Windows an antivirus or backup program can hold the file for a moment, so try again.
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, STORE_FILE); return; } catch (e) {
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(e.code)) throw e;
      const until = Date.now() + 60 * (i + 1); while (Date.now() < until) { /* wait briefly */ }
    }
  }
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


// ---------- Resellers ----------
// A reseller is an Emby account (they sign in to Aurora as usual) that the admin has given credits. Credits pay for the plans they
// create or renew customers on; they can see and change only the customers they made. Every change in credits is written to a ledger.
const planCredits = (p) => (Number.isInteger(p.credits) && p.credits >= 0 ? p.credits : Math.max(1, p.connections * (p.unit === 'day' ? Math.ceil(p.length / 30) : p.length)));
const resellerList = () => store.resellers || (store.resellers = {});
const resellerOfUser = (userId) => Object.values(resellerList()).find((r) => r.userId === userId) || null;
const resellerBusy = new Set();
const supportCount = new Map();
const speedCount = new Map();
const cleanUserName = (v) => { const t = String(v || '').trim(); return /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(t) ? t : null; };
const cleanText = (v, n) => String(v || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
function creditEntry(r, delta, why, by, extra) {
  r.credits = Math.max(0, r.credits + delta);
  const e = { id: crypto.randomBytes(5).toString('hex'), reseller: r.id, at: Date.now(), by: cleanText(by, 40), delta, balance: r.credits, why: cleanText(why, 80), ...(extra || {}) };
  store.creditLog = [e, ...(store.creditLog || [])].slice(0, 3000);
  return e;
}
function publicReseller(r) {
  const customers = Object.values(store.users).filter((u) => u.reseller === r.id).length;
  return { id: r.id, name: r.name, userId: r.userId, userName: r.userName, contact: r.contact || '', credits: r.credits, status: r.status, plans: r.plans || [], customers, created: r.created, low: r.credits <= cfg.resellerLowCredits };
}
function publicCustomer(id, rec, devices) {
  const c = rec.contact || {};
  return { id, name: rec.name, full: c.full || '', email: c.email || '', phone: c.phone || '', note: c.note || '', planId: rec.plan?.id || null, planName: rec.plan ? (rec.trial ? 'Free trial' : rec.plan.name) : '',
    trial: !!rec.trial, hold: !!rec.hold, expires: rec.expires || null, daysLeft: rec.expires ? daysUntil(rec.expires) : null, expired: isExpired(rec), devices: devices ? devices.size : 0, created: rec.created || null,
    discount: rec.discount && !rec.discount.usedAt ? `${rec.discount.code} (${discountLabel(rec.discount)})` : '' };
}
// New accounts start with the same Aurora settings the first administrator has (Live TV source, Requests, update lock, playback).
async function copyAppDefaults(newUserId) {
  try {
    const users = await emby('GET', '/Users');
    const admin = (users || []).find((u) => u.Policy?.IsAdministrator);
    if (!admin) return;
    for (const id of ['aurora-livetv', 'aurora-requests', 'aurora-app', 'aurora-playback']) {
      try {
        const prefs = await emby('GET', `/DisplayPreferences/${id}`, { query: { userId: admin.Id, client: 'aurora' } });
        const raw = prefs?.CustomPrefs?.config;
        if (!raw) continue;
        await emby('POST', `/DisplayPreferences/${id}`, { query: { userId: newUserId, client: 'aurora' }, body: { Id: id, Client: 'aurora', SortBy: 'SortName', SortOrder: 'Ascending', RememberIndexing: false, RememberSorting: false,
          ScrollDirection: 'Horizontal', ShowBackdrop: false, ShowSidebar: false, PrimaryImageHeight: 0, PrimaryImageWidth: 0, CustomPrefs: { config: raw } } });
      } catch { /* that setting is not set up: skip it */ }
    }
  } catch (e) { log('Copying the Aurora settings to a new account failed:', e.message); }
}
async function newEmbyAccount(name, password) {
  const u = await emby('POST', '/Users/New', { body: { Name: name } });
  if (!u?.Id) throw new Error('Emby did not return the new account');
  try {
    await emby('POST', `/Users/${u.Id}/Password`, { body: { Id: u.Id, ResetPassword: true } });
    await emby('POST', `/Users/${u.Id}/Password`, { body: { Id: u.Id, CurrentPw: '', NewPw: password } });
  } catch (e) { await emby('DELETE', `/Users/${u.Id}`).catch(() => {}); throw new Error('Could not set the password: ' + e.message); }
  return u;
}
// A reseller account is for the panel only: nothing to watch, no Live TV, no downloads, even from other Emby apps.
async function limitResellerAccount(userId) {
  const fresh = await emby('GET', `/Users/${userId}`);
  await emby('POST', `/Users/${userId}/Policy`, { body: { ...(fresh.Policy || {}), EnableAllFolders: false, EnabledFolders: [], EnableLiveTvAccess: false, EnableLiveTvManagement: false,
    EnableMediaPlayback: false, EnableAudioPlaybackTranscoding: false, EnableVideoPlaybackTranscoding: false, EnablePlaybackRemuxing: false, EnableContentDownloading: false } });
}
const genPassword = () => { const w = ['Blue', 'Tiger', 'Maple', 'River', 'Cloud', 'Amber', 'Falcon', 'Cedar', 'Pearl', 'Comet']; return w[crypto.randomInt(w.length)] + w[crypto.randomInt(w.length)] + (10 + crypto.randomInt(90)); };

// ---------- Notifications, announcements, support, referrals, stats (guard 1.11.0) ----------
const audienceOk = (a, userId) => {
  const au = a.audience || { type: 'all' }, rec = store.users[userId];
  if (au.type === 'plan') return rec?.plan?.id === au.id;
  if (au.type === 'reseller') return rec?.reseller === au.id || resellerOfUser(userId)?.id === au.id; // that reseller's customers, and the reseller
  if (au.type === 'resellers') return !!resellerOfUser(userId); // every reseller
  return true;
};
let newTitlesCache = { at: 0, text: '', n: 0 };
async function newTitlesNote() {
  if (Date.now() - newTitlesCache.at < 10 * 60000) return newTitlesCache;
  newTitlesCache = { at: Date.now(), text: '', n: 0 };
  try {
    const r = await emby('GET', '/Items', { query: { Recursive: 'true', SortBy: 'DateCreated', SortOrder: 'Descending', IncludeItemTypes: 'Movie,Series', Limit: 30, Fields: 'DateCreated' } });
    const week = Date.now() - 7 * 86400000;
    const fresh = (r?.Items || []).filter((i) => Date.parse(i.DateCreated || 0) > week);
    newTitlesCache = { at: Date.now(), n: fresh.length, text: fresh.slice(0, 3).map((i) => i.Name).join(', '), newest: fresh[0] ? Date.parse(fresh[0].DateCreated) : 0 };
  } catch { /* no list: no notice */ }
  return newTitlesCache;
}
async function inboxFor(me) {
  const now = Date.now(), items = [];
  for (const a of store.announcements || []) {
    if (a.expires && a.expires < now) continue;
    if (!audienceOk(a, me.Id)) continue;
    items.push({ id: 'ann:' + a.id, type: 'announcement', level: a.level, title: a.text, text: 'From your provider', at: a.at });
  }
  const rec = store.users[me.Id];
  if (rec?.expires && !me.Policy?.IsAdministrator) {
    const d = daysUntil(rec.expires), end = new Date(rec.expires + 'T23:59:59').getTime();
    if (d < 0) items.push({ id: `plan:${rec.expires}:x`, type: 'plan', level: 'bad', title: 'Your access has ended', text: 'Ask for more time to keep watching.', at: end, action: 'renew' });
    else { const b = d <= 1 ? 1 : d <= 3 ? 3 : d <= 7 ? 7 : 0; if (b) items.push({ id: `plan:${rec.expires}:${b}`, type: 'plan', level: b <= 3 ? 'warn' : 'info', title: d <= 1 ? 'Your plan ends today or tomorrow' : `Your plan ends in ${d} days`, text: `${rec.plan?.name ? rec.plan.name + ' · ' : ''}ends ${rec.expires}`, at: end - b * 86400000, action: 'renew' }); }
  }
  const isReseller = !!resellerOfUser(me.Id);
  const nt = isReseller ? { n: 0 } : await newTitlesNote();
  if (nt.n) items.push({ id: 'new:' + dayKey(nt.newest), type: 'new', level: 'info', title: `New this week: ${nt.text}${nt.n > 3 ? ` and ${nt.n - 3} more` : ''}`, text: 'Added to Aurora', at: nt.newest || now, action: 'browse' });
  const t = (store.tickets || []).find((x) => x.userId === me.Id && x.status === 'open');
  const lastAdmin = t && [...t.messages].reverse().find((m) => m.from !== 'user');
  if (lastAdmin) items.push({ id: `support:${t.id}:${lastAdmin.at}`, type: 'support', level: 'info', title: 'Reply from support', text: lastAdmin.text.slice(0, 120), at: lastAdmin.at, action: 'help' });
  const read = (store.inboxRead || {})[me.Id] || 0;
  items.sort((a, b) => b.at - a.at);
  for (const i of items) i.unread = i.at > read;
  return { items: items.slice(0, 40), unread: items.filter((i) => i.unread).length, banners: items.filter((i) => i.type === 'announcement').map((i) => ({ id: i.id, level: i.level, text: i.title })) };
}
const ticketPublic = (t) => ({ id: t.id, userId: t.userId, name: t.name, status: t.status, at: t.at, updated: t.updated, diag: t.diag || null, reseller: t.resellerName || '', messages: t.messages });
const cleanDiag = (d) => {
  const o = {}; if (!d || typeof d !== 'object') return o;
  for (const k of ['app', 'device', 'connection', 'playing', 'status', 'errors', 'speed']) if (d[k] !== undefined) o[k] = cleanText(Array.isArray(d[k]) ? d[k].join(' | ') : d[k], 400);
  return o;
};
function statsFor(userId) {
  const now = Date.now(), out = { thisWeek: 0, lastWeek: 0, live: 0, days: 0, top: [] }, titles = {};
  for (let i = 0; i < 14; i++) {
    const u = (store.usage || {})[dayKey(now - i * 86400000)]?.[userId];
    if (!u) continue;
    if (i < 7) { out.thisWeek += u.min; out.days++; for (const [t, m] of Object.entries(u.titles || {})) { if (t.startsWith('Live:')) out.live += m; else titles[t] = (titles[t] || 0) + m; } } else out.lastWeek += u.min;
  }
  out.top = Object.entries(titles).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([title, minutes]) => ({ title, minutes: Math.round(minutes) }));
  out.thisWeek = Math.round(out.thisWeek); out.lastWeek = Math.round(out.lastWeek); out.live = Math.round(out.live);
  return out;
}
function referralCode(userId, name) {
  const rec = store.users[userId] || (store.users[userId] = { limit: cfg.defaultLimit, expires: null, name, updated: Date.now() });
  if (!rec.refCode) {
    const base = String(name).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'FRIEND';
    let code;
    do { code = `${base}-${crypto.randomBytes(2).toString('hex').toUpperCase().slice(0, 3)}`; } while (Object.values(store.users).some((u) => u.refCode === code));
    rec.refCode = code; saveStore();
  }
  return rec.refCode;
}
// Free days for a friend and the person who brought them, taken from today or from the end date if that is later.
function giveDays(userId, days, why) {
  const rec = store.users[userId];
  if (!rec?.expires) return false;
  const today = localDay(new Date()), from = rec.expires > today ? rec.expires : today;
  rec.expires = addDays(from, days); rec.updated = Date.now();
  recordAction({ type: 'extended', userId, name: rec.name, why: `${why}: +${days} days, now ends ${rec.expires}` });
  return true;
}

// ---------- Website sign-up and discount codes (guard 1.16.0) ----------
// Discount codes are made on the website's admin page and live here. A code has a kind ("pct" percent or "usd" dollars), an amount, the
// plans it works on, an optional use limit and end date, and an on/off switch. Customers type one when they sign up; it is remembered
// on their account and used on their first paid plan (see applyPlan).
const discountLabel = (d) => (d.type === 'pct' ? `${d.value}% off` : `$${d.value} off`);
const discountedPrice = (price, d) => Math.max(0, Math.round((d.type === 'pct' ? price * (1 - d.value / 100) : price - d.value) * 100) / 100);
const findDiscount = (code) => (store.discounts || []).find((d) => d.code === String(code || '').trim().toUpperCase());
// null when the code can be used now, otherwise why not (in words a customer can read).
function discountProblem(d) {
  if (!d) return 'That code is not valid.';
  if (!d.on) return 'That code is not valid.';
  if (d.ends && d.ends < localDay(new Date())) return 'That code has expired.';
  if (d.max && d.used >= d.max) return 'That code has been used the most times it can be.';
  return null;
}
function publicDiscount(d) {
  const problem = discountProblem(d);
  return { code: d.code, type: d.type, value: d.value, label: discountLabel(d), planIds: d.planIds || [], max: d.max || null, used: d.used || 0, ends: d.ends || '', on: !!d.on, note: d.note || '', created: d.created || 0,
    status: !d.on ? 'off' : (d.ends && d.ends < localDay(new Date())) ? 'ended' : (d.max && d.used >= d.max) ? 'used' : 'working', problem };
}
const genDiscountCode = () => { const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let c = ''; for (let i = 0; i < 8; i++) c += a[crypto.randomInt(a.length)]; return c; };
const smallLimit = new Map(); // per internet address counters for the public website endpoints
function overLimit(bucket, ip, max, windowMs) {
  const k = bucket + '|' + ip, now = Date.now(), e = smallLimit.get(k);
  if (!e || now - e.since > windowMs) { smallLimit.set(k, { n: 1, since: now }); if (smallLimit.size > 20000) smallLimit.delete(smallLimit.keys().next().value); return false; }
  return ++e.n > max;
}
const emailOk = (v) => /^[^@\s]{1,64}@[^@\s]{1,120}\.[^@\s]{2,30}$/.test(v) && v.length <= 120;

// ---------- Maintenance mode (guard 1.12.0) ----------
// The admin can put parts of Aurora in maintenance: customers get a friendly "taking a short break" page there instead. The admin still
// has full access. (This is the app's doing: another Emby app that talks to the server directly is not stopped by it.)
const MAINT_KEYS = ['movies', 'tv', 'favorites', 'livetv', 'sports', 'requests', 'downloads'];
const maintenancePublic = () => {
  const m = store.maintenance || {};
  const tabs = {};
  for (const k of MAINT_KEYS) if (m.tabs && m.tabs[k]) tabs[k] = true;
  return { tabs, message: m.message || '', back: m.back || '', at: m.at || 0 };
};

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
  // What a reseller pays in credits for this plan (blank = connections x months, so 1 credit is one connection for one month).
  let credits = null;
  if (b.credits !== undefined && b.credits !== null && b.credits !== '') {
    credits = Number(b.credits);
    if (!Number.isInteger(credits) || credits < 0 || credits > 10000) return { error: 'The credit cost must be a whole number from 0 up, or blank.' };
  }
  return { plan: { id, name, price, length, unit, connections, categories, credits, active: b.active !== false } };
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
  let price = priceOverride !== undefined && priceOverride !== null && priceOverride !== '' && Number.isFinite(Number(priceOverride)) ? Math.max(0, Math.round(Number(priceOverride) * 100) / 100) : plan.price;
  // A discount code the customer entered when signing up takes effect on their first paid plan it works on.
  const dc = rec.discount;
  if ((priceOverride === undefined || priceOverride === null || priceOverride === '') && dc && !dc.usedAt && (!dc.planIds || !dc.planIds.length || dc.planIds.includes(plan.id))) {
    price = discountedPrice(plan.price, dc); dc.usedAt = today; dc.paid = price;
    recordAudit('Discount', `${userName}: code ${dc.code} (${discountLabel(dc)}) applied to ${plan.name}: $${plan.price} became $${price}`);
  }
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

// What the Status page shows: how many checks of the Aurora server worked in each of the last 24 hours, and a short list of
// outages ("Aurora server not responding", started / ended). An outage starts after two failed checks in a row, so one
// hiccup isn't reported, and ends at the next good one.
let reachFails = 0;
function statusHours(now) {
  const hours = [];
  for (let i = 23; i >= 0; i--) {
    const b = (store.reach || {})[new Date(now - i * 3600000).toISOString().slice(0, 13)];
    hours.push(!b ? null : b.bad === 0 ? 'ok' : b.ok === 0 ? 'bad' : 'warn');
  }
  return hours;
}
function trackReach(ok) {
  const now = Date.now(), hour = new Date(now).toISOString().slice(0, 13);
  const reach = store.reach || (store.reach = {});
  const b = reach[hour] || (reach[hour] = { ok: 0, bad: 0 });
  if (ok) b.ok++; else b.bad++;
  usageDirtyAt = now; // saved with the usage data, at most every 5 minutes
  for (const k of Object.keys(reach).sort().slice(0, -48)) delete reach[k];
  const list = store.incidents || (store.incidents = []);
  const open = list.find((x) => x.kind === 'server' && !x.end);
  if (ok) {
    reachFails = 0;
    if (open) { open.end = now; usageDirtyAt = now; saveStore(); }
  } else if (++reachFails >= 2 && !open) {
    list.unshift({ kind: 'server', title: 'Aurora server not responding', start: now - cfg.intervalSeconds * 1000, end: 0 });
    store.incidents = list.slice(0, 30);
    saveStore();
  }
}

// One pass. onlyUserId: just that account (after an admin changes it).
async function enforce(onlyUserId) {
  let users, sessions;
  try {
    users = await emby('GET', '/Users');
    sessions = await emby('GET', '/Sessions');
    if (!onlyUserId) {
      embyReach = { at: Date.now(), ok: true, error: '' }; lastSnapshot = { users, sessions };
      try { trackReach(true); } catch (e) { log('Status tracking failed:', e.message); }
      try { samplePass(users, sessions); } catch (e) { log('Usage sampling failed:', e.message); }
    }
  } catch (e) {
    if (!onlyUserId) { embyReach = { at: Date.now(), ok: false, error: e.message }; try { trackReach(false); } catch { /* status history only */ } }
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

// ---------- Usage, sharing, server health and the audit log (1.6.0) ----------
// All of it is worked out from what the every-minute check already reads from Emby (the sessions list), so it adds no
// extra load. Only Emby administrators can read any of it.
const dayKey = (t = Date.now()) => localDay(new Date(t));
const round2 = (n) => Math.round(n * 100) / 100;
let lastSampleAt = 0, usageDirtyAt = 0, lastUsageSave = 0;

// Who changed what (the admin's name comes from the app, which only an Emby administrator can reach).
function recordAudit(by, text) {
  if (!Array.isArray(store.audit)) store.audit = [];
  store.audit.unshift({ at: Date.now(), by: String(by || 'an admin').slice(0, 40), text: String(text || '').slice(0, 240) });
  store.audit = store.audit.slice(0, 500);
}
function describeChange(req, url, subject) {
  const p = url.pathname, m = req.method, b = req.parsedBody || {};
  const plural = (n, w) => `${n} ${w}${Number(n) === 1 ? '' : 's'}`;
  let r;
  if ((r = p.match(/^\/limits\/([\w-]{1,64})$/))) {
    const who = store.users[r[1]]?.name || subject || 'an account';
    if (m === 'PUT') return `Set ${who}: ${plural(b.limit, 'device')}, ${b.expires ? 'ends ' + b.expires : 'no expiration'}`;
    if (m === 'DELETE') return `Removed the limits and end date from ${who}`;
  }
  if ((r = p.match(/^\/limits\/([\w-]{1,64})\/plan$/)) && m === 'POST') {
    const plan = (store.plans || []).find((x) => x.id === b.planId);
    return `Put plan ${plan ? plan.name : 'a plan'} on ${store.users[r[1]]?.name || subject || 'an account'}${b.price !== undefined && b.price !== null && b.price !== '' ? ` (paid $${b.price})` : ''}`;
  }
  if ((r = p.match(/^\/extensions\/([\w-]{1,32})$/)) && m === 'PUT') {
    const x = (store.extensions || []).find((e) => e.id === r[1]);
    return `${b.action === 'deny' ? 'Denied' : 'Approved'} an extension request from ${x ? x.name : 'a customer'}${b.action !== 'deny' && b.days ? ` (${plural(b.days, 'day')})` : ''}`;
  }
  if (p === '/discounts' && m === 'POST') return `Made the discount code ${String(b.code || '').toUpperCase() || '(generated)'} (${b.type === 'usd' ? '$' + b.value : b.value + '%'} off)`;
  if ((r = p.match(/^\/discounts\/([A-Za-z0-9]{3,20})$/))) return m === 'DELETE' ? `Deleted the discount code ${r[1].toUpperCase()}` : `Switched the discount code ${r[1].toUpperCase()} ${b.on ? 'on' : 'off'}`;
  if (p === '/plans' && m === 'POST') return `Added plan ${b.name || ''}`.trim();
  if ((r = p.match(/^\/plans\/([\w-]{1,40})$/))) {
    if (m === 'PUT') return `Changed plan ${b.name || ''}`.trim();
    if (m === 'DELETE') return 'Deleted a plan';
  }
  if (p === '/sports/settings' && m === 'PUT') return `Changed the sports scores settings (${(b.leagues || []).length} leagues${b.enabled === false ? ', switched off' : ''})`;
  if (p === '/sports/aliases' && m === 'PUT') return `Saved ${(b.aliases || []).length} sports name aliases`;
  if (p === '/resellers' && m === 'POST') return `Added the reseller ${b.name || ''}${b.credits ? ` with ${b.credits} credits` : ''}`.trim();
  if ((r = p.match(/^\/resellers\/([\w-]{1,32})$/)) && m === 'PUT') return `Changed the reseller ${(store.resellers || {})[r[1]]?.name || ''}${b.status ? ` (${b.status})` : ''}`.trim();
  if ((r = p.match(/^\/resellers\/([\w-]{1,32})\/credits$/)) && m === 'POST') return `${b.mode === 'remove' ? 'Removed' : b.mode === 'set' ? 'Set to' : 'Added'} ${b.amount} credits for ${(store.resellers || {})[r[1]]?.name || 'a reseller'}${b.why ? ' (' + String(b.why).slice(0, 40) + ')' : ''}`;
  if ((r = p.match(/^\/resellers\/([\w-]{1,32})\/password$/)) && m === 'POST') return `Reset the password of the reseller ${(store.resellers || {})[r[1]]?.name || ''}`.trim();
  if (p === '/announcements' && m === 'POST') return `Sent the announcement "${String(b.text || '').slice(0, 60)}"`;
  if (/^\/announcements\//.test(p) && m === 'DELETE') return 'Removed an announcement';
  if (/^\/credit-requests\//.test(p) && m === 'PUT') return `${b.action === 'approve' ? 'Approved' : 'Declined'} a credit request`;
  if (/^\/support\//.test(p)) return '';
  if (p === '/maintenance' && m === 'PUT') { const on = MAINT_KEYS.filter((k) => b.tabs && b.tabs[k]); return on.length ? `Put in maintenance mode: ${on.join(', ')}` : 'Turned maintenance mode off'; }
  if (p === '/status-note' && m === 'PUT') return b.text ? `Set the Status page message: "${String(b.text).slice(0, 60)}"` : 'Cleared the Status page message';
  if (p === '/sports/refresh') return '';
  if (p === '/connections' && m === 'PUT') return `Set the TV provider connection limit to ${b.limit}${b.alertAt ? `, warn at ${b.alertAt}` : ''}`;
  if (p === '/provider' && m === 'PUT') return 'Changed the TV provider reporting settings';
  if (p === '/provider/key' && m === 'DELETE') return 'Removed the TV provider key';
  if (p === '/reports' && m === 'DELETE') return 'Cleared the channel reports';
  if ((r = p.match(/^\/sharing\/([\w-]{1,64})$/)) && m === 'DELETE') return `Cleared the sharing history for ${subject || 'an account'}`;
  if (p === '/migrated' || /\/manual$/.test(p) || p === '/provider/test') return '';
  return `${m} ${p}`;
}

function itemTitle(it) {
  if (!it) return 'Unknown';
  if (it.Type === 'TvChannel' || it.Type === 'LiveTvChannel') return 'Live: ' + (it.Name || 'channel');
  return String(it.SeriesName || it.Name || 'Unknown').slice(0, 80);
}
function addUsage(userId, name, title, minutes) {
  if (!(minutes > 0)) return;
  if (!store.usage) store.usage = {};
  const day = store.usage[dayKey()] || (store.usage[dayKey()] = {});
  const u = day[userId] || (day[userId] = { name, min: 0, titles: {} });
  u.name = name;
  u.min = round2(u.min + minutes);
  u.titles[title] = round2((u.titles[title] || 0) + minutes);
  const keys = Object.keys(u.titles);
  if (keys.length > 15) { keys.sort((a, b) => u.titles[a] - u.titles[b]); for (const k of keys.slice(0, keys.length - 15)) delete u.titles[k]; }
  usageDirtyAt = Date.now();
}

// A network, not an address: the first three parts of an IPv4 address (a phone's address changes all the time, its
// network mostly doesn't); the first three groups of an IPv6 one. Addresses inside the house count as one "home" network.
function networkOf(raw) {
  let ip = String(raw || '').trim().replace(/^::ffff:/i, '').replace(/%.*$/, '');
  if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(ip)) ip = ip.replace(/:\d+$/, '');
  if (!ip) return null;
  if (/^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) || /^(::1$|fe80:|f[cd][0-9a-f]{2}:)/i.test(ip)) return { key: 'local', ip, local: true };
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return { key: ip.split('.').slice(0, 3).join('.') + '.x', ip, local: false };
  return { key: ip.split(':').slice(0, 3).join(':') + '::/48', ip, local: false };
}

const healthHistory = []; // one point a minute, kept for 24 hours (in memory: a restart starts it again)
let prevCpu = null, health = { cpu: null, memPct: null, playing: 0, transcoding: 0, direct: 0 };
function cpuPercent() {
  const cpus = os.cpus() || [];
  let idle = 0, total = 0;
  for (const c of cpus) { for (const k of Object.keys(c.times)) total += c.times[k]; idle += c.times.idle; }
  const prev = prevCpu;
  prevCpu = { idle, total };
  if (!prev || total <= prev.total) return null;
  return Math.max(0, Math.min(100, Math.round(100 * (1 - (idle - prev.idle) / (total - prev.total)))));
}
const diskWarned = new Map();
function diskInfo() {
  const paths = (Array.isArray(cfg.diskPaths) && cfg.diskPaths.length ? cfg.diskPaths : [DIR]).map(String).slice(0, 8);
  const out = [];
  for (const p of paths) {
    try {
      if (typeof fs.statfsSync !== 'function') { out.push({ path: p, error: 'needs Node 18.15 or newer' }); continue; }
      const s = fs.statfsSync(p), total = Number(s.blocks) * Number(s.bsize), free = Number(s.bavail) * Number(s.bsize);
      out.push({ path: p, total, free, freePct: total ? Math.round(1000 * free / total) / 10 : 0 });
    } catch (e) { out.push({ path: p, error: e.code === 'ENOENT' ? 'not found' : e.message }); }
  }
  return out;
}

// Called by the every-minute check with the users and sessions it just read.
function samplePass(users, sessions) {
  const now = Date.now();
  const interval = cfg.intervalSeconds * 1000;
  const elapsed = lastSampleAt ? Math.min(now - lastSampleAt, interval * 2) : interval;
  lastSampleAt = now;
  const byId = new Map((Array.isArray(users) ? users : []).map((u) => [u.Id, u]));
  let playing = 0, transcoding = 0, direct = 0;
  const watchingNets = new Map(); // userId -> Set of networks with something playing right now
  const store_ = store.sharing || (store.sharing = {});
  for (const s of Array.isArray(sessions) ? sessions : []) {
    const u = byId.get(s.UserId);
    if (!u || s.DeviceId === 'aurora-guard') continue;
    const at = Date.parse(s.LastActivityDate || 0) || 0;
    if (now - at > windowMs()) continue;
    const isPlaying = !!s.NowPlayingItem && !s.PlayState?.IsPaused;
    if (isPlaying) {
      playing++;
      if (s.PlayState?.PlayMethod === 'Transcode' || s.TranscodingInfo) transcoding++; else direct++;
      addUsage(u.Id, u.Name, itemTitle(s.NowPlayingItem), elapsed / 60000);
    }
    if (u.Policy?.IsAdministrator) continue;
    const net = networkOf(s.RemoteEndPoint);
    if (!net) continue;
    const rec = store_[u.Id] || (store_[u.Id] = { name: u.Name, nets: {}, together: [] });
    rec.name = u.Name;
    const n = rec.nets[net.key] || (rec.nets[net.key] = { first: now, n: 0 });
    n.at = now; n.ip = net.ip; n.local = net.local; n.n++;
    n.device = s.DeviceName || n.device || '';
    if (isPlaying && !net.local) { if (!watchingNets.has(u.Id)) watchingNets.set(u.Id, new Set()); watchingNets.get(u.Id).add(net.key); }
    usageDirtyAt = now;
  }
  // Watching from two different networks at the same moment is the strongest sign of a shared login.
  for (const [uid, nets] of watchingNets) if (nets.size >= 2) store_[uid].together.push(now);
  // Forget old data: networks after 14 days, "at the same time" after 7, usage after 62 days.
  for (const [uid, rec] of Object.entries(store_)) {
    for (const [k, v] of Object.entries(rec.nets)) if (now - (v.at || 0) > 14 * 86400000) delete rec.nets[k];
    rec.together = (rec.together || []).filter((t) => now - t < 7 * 86400000).slice(-2000);
    if (!Object.keys(rec.nets).length && !rec.together.length) delete store_[uid];
  }
  const keep = dayKey(now - 62 * 86400000);
  for (const d of Object.keys(store.usage || {})) if (d < keep) delete store.usage[d];
  // Server health.
  const cpu = cpuPercent(), total = os.totalmem(), memPct = total ? Math.round(100 * (1 - os.freemem() / total)) : null;
  health = { cpu, memPct, playing, transcoding, direct };
  healthHistory.push({ t: now, cpu, mem: memPct, playing, transcoding });
  while (healthHistory.length > 1440) healthHistory.shift();
  for (const d of diskInfo()) {
    if (d.error || !(cfg.diskAlertPercent > 0)) continue;
    if (d.freePct < cfg.diskAlertPercent && !diskWarned.get(d.path)) {
      diskWarned.set(d.path, true);
      sendAlert('Aurora: low disk space', `${d.path} has only ${d.freePct}% free (${(d.free / 1073741824).toFixed(1)} GB).`, true);
    } else if (d.freePct >= cfg.diskAlertPercent + 2) diskWarned.delete(d.path);
  }
  // Written at most every 5 minutes (the file grows with the usage history).
  if (usageDirtyAt && now - lastUsageSave > 5 * 60000) { lastUsageSave = now; usageDirtyAt = 0; try { saveStore(); } catch (e) { log('Could not save usage:', e.message); } }
}

function sharingLevel(rec) {
  const now = Date.now(), week = now - 7 * 86400000;
  const nets = Object.entries(rec.nets || {}).filter(([, v]) => !v.local && (v.at || 0) > week);
  const together = (rec.together || []).filter((t) => t > week).length;
  const level = together >= cfg.sharingSimultaneousMinutes ? 'likely' : (nets.length >= cfg.sharingNetworks || together >= 3) ? 'watch' : 'ok';
  return { level, networks: nets.length, together };
}
function usageReport(days) {
  const cutoff = dayKey(Date.now() - (days - 1) * 86400000);
  const perDay = [], users = new Map(), titles = new Map();
  for (const day of Object.keys(store.usage || {}).sort()) {
    if (day < cutoff) continue;
    let sum = 0;
    for (const [uid, u] of Object.entries(store.usage[day])) {
      sum += u.min;
      const r = users.get(uid) || { userId: uid, name: u.name, min: 0, days: 0, titles: {} };
      r.name = u.name; r.min += u.min; r.days++;
      users.set(uid, r);
      for (const [t, m] of Object.entries(u.titles || {})) {
        r.titles[t] = (r.titles[t] || 0) + m;
        const tt = titles.get(t) || { title: t, min: 0, viewers: new Set() };
        tt.min += m; tt.viewers.add(uid); titles.set(t, tt);
      }
    }
    perDay.push({ day, min: round2(sum) });
  }
  return {
    days, since: cutoff,
    totalMin: round2(perDay.reduce((n, d) => n + d.min, 0)),
    perDay,
    users: [...users.values()].map((r) => ({ userId: r.userId, name: r.name, min: round2(r.min), days: r.days,
      top: Object.entries(r.titles).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([title, min]) => ({ title, min: round2(min) })) })).sort((a, b) => b.min - a.min),
    titles: [...titles.values()].sort((a, b) => b.min - a.min).slice(0, 25).map((t) => ({ title: t.title, min: round2(t.min), viewers: t.viewers.size })),
  };
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
        if (Date.now() - (e.at || 0) < LIVE_FRESH_MS) streams.push({ source: 'aurora', userId: id, user: names.get(id), device: e.device || '', channel: [e.num, e.name].filter(Boolean).join(' '), since: e.started || 0 });
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
  for (const x of streams) if (x.source === 'aurora' && x.userId) addUsage(x.userId, x.user || '', 'Live: ' + (x.channel || 'channel'), cfg.intervalSeconds / 60);
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

// ---------- Sports scores, teams and name aliases (1.8.0) ----------
// The Sports tab in Aurora lists games found in the channel guide; this adds live scores, the customers' favourite teams and
// reminders. Games come from ESPN's public scoreboard feed (unofficial: it can change or stop without notice). Each league is
// asked every minute while it has a live game or one about to start, otherwise every ten minutes, and the answers are kept here, so
// every customer's app reads this cache and nobody calls the feed directly.
const SPORTS_LEAGUES = {
  nfl: { path: 'football/nfl', name: 'NFL', group: 'NFL' },
  ncaaf: { path: 'football/college-football', name: 'College Football', group: 'College' },
  nba: { path: 'basketball/nba', name: 'NBA', group: 'NBA' },
  wnba: { path: 'basketball/wnba', name: 'WNBA', group: 'NBA' },
  ncaam: { path: 'basketball/mens-college-basketball', name: 'College Basketball', group: 'College' },
  mlb: { path: 'baseball/mlb', name: 'MLB', group: 'MLB' },
  nhl: { path: 'hockey/nhl', name: 'NHL', group: 'NHL' },
  epl: { path: 'soccer/eng.1', name: 'Premier League', group: 'Soccer' },
  laliga: { path: 'soccer/esp.1', name: 'La Liga', group: 'Soccer' },
  bundesliga: { path: 'soccer/ger.1', name: 'Bundesliga', group: 'Soccer' },
  seriea: { path: 'soccer/ita.1', name: 'Serie A', group: 'Soccer' },
  ligue1: { path: 'soccer/fra.1', name: 'Ligue 1', group: 'Soccer' },
  mls: { path: 'soccer/usa.1', name: 'MLS', group: 'Soccer' },
  ucl: { path: 'soccer/uefa.champions', name: 'Champions League', group: 'Soccer' },
  ufc: { path: 'mma/ufc', name: 'UFC', group: 'UFC & Fights' },
  f1: { path: 'racing/f1', name: 'Formula 1', group: 'Racing' },
};
const SPORTS_DEFAULT_LEAGUES = ['nfl', 'ncaaf', 'nba', 'mlb', 'nhl', 'epl', 'laliga', 'bundesliga', 'seriea', 'ligue1', 'mls', 'ucl', 'ufc', 'f1'];
const sportsState = { leagues: {}, teams: {}, updated: 0 }; // leagues[key] = { games, at, ok, error, nextAt }
function sportsCfg() {
  const c = store.sports || {};
  const keys = Array.isArray(c.leagues) ? c.leagues.filter((k) => SPORTS_LEAGUES[k]) : SPORTS_DEFAULT_LEAGUES;
  return { enabled: cfg.scoresEnabled !== false && c.enabled !== false, leagues: keys, aliases: Array.isArray(c.aliases) ? c.aliases : [] };
}
function getJson(address, timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    const u = new URL(address), lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { timeout: timeoutMs, headers: { Accept: 'application/json', 'User-Agent': 'Aurora-Guard/' + VERSION } }, (res) => {
      if (res.statusCode >= 400) { res.resume(); return reject(new Error(`${u.host} answered ${res.statusCode}`)); }
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > 3 * 1024 * 1024) { req.destroy(new Error('answer too large')); } else chunks.push(c); });
      res.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('not JSON')); } });
    });
    req.on('timeout', () => req.destroy(new Error('no answer in time')));
    req.on('error', reject);
  });
}
const hex6 = (v) => (/^[0-9a-f]{6}$/i.test(String(v || '')) ? '#' + String(v).toLowerCase() : '');
// One ESPN scoreboard event -> the shape the app uses. Written defensively: any missing piece just stays empty.
function normalizeSportsEvent(ev, key) {
  const L = SPORTS_LEAGUES[key], comp = (ev.competitions && ev.competitions[0]) || {};
  const cs = Array.isArray(comp.competitors) ? comp.competitors : [];
  const side = (c) => c && {
    id: String((c.team && c.team.id) || c.id || ''),
    name: String((c.team && c.team.displayName) || (c.athlete && c.athlete.displayName) || '').slice(0, 60),
    short: String((c.team && c.team.shortDisplayName) || (c.athlete && c.athlete.shortName) || (c.team && c.team.name) || '').slice(0, 40),
    abbr: String((c.team && c.team.abbreviation) || '').slice(0, 6),
    color: hex6(c.team && c.team.color),
    score: c.score === undefined || c.score === null ? '' : String(c.score).slice(0, 6),
    record: String((c.records && c.records[0] && c.records[0].summary) || '').slice(0, 12),
    winner: !!c.winner,
  };
  const two = cs.length === 2;
  const home = two ? side(cs.find((c) => c.homeAway === 'home') || cs[1]) : null;
  const away = two ? side(cs.find((c) => c.homeAway === 'away') || cs[0]) : null;
  const st = (ev.status && ev.status.type) || (comp.status && comp.status.type) || {};
  const names = new Set();
  for (const b of Array.isArray(comp.broadcasts) ? comp.broadcasts : []) for (const n of Array.isArray(b.names) ? b.names : []) names.add(String(n).slice(0, 30));
  for (const b of Array.isArray(comp.geoBroadcasts) ? comp.geoBroadcasts : []) if (b && b.media && b.media.shortName) names.add(String(b.media.shortName).slice(0, 30));
  const state = ['pre', 'in', 'post'].includes(st.state) ? st.state : 'pre';
  return {
    id: key + ':' + String(ev.id || ''), league: key, leagueName: L.name, group: L.group,
    name: String(ev.name || '').slice(0, 120), short: String(ev.shortName || '').slice(0, 40),
    start: Date.parse(ev.date) || 0, state,
    detail: String(st.shortDetail || st.detail || '').slice(0, 40), clock: String((ev.status && ev.status.displayClock) || '').slice(0, 10),
    home, away, broadcasts: [...names].slice(0, 6),
  };
}
async function pollSportsLeague(key) {
  const L = SPORTS_LEAGUES[key], rec = sportsState.leagues[key] || (sportsState.leagues[key] = { games: [], at: 0, ok: false, error: '', nextAt: 0 });
  try {
    const data = await getJson(`${cfg.scoresBase.replace(/\/+$/, '')}/apis/site/v2/sports/${L.path}/scoreboard`);
    rec.games = (Array.isArray(data.events) ? data.events : []).map((ev) => normalizeSportsEvent(ev, key)).filter((g) => g.start);
    rec.ok = true; rec.error = ''; rec.at = Date.now();
  } catch (e) { rec.ok = false; rec.error = e.message; }
  const hot = rec.games.some((g) => g.state === 'in' || (g.state === 'pre' && g.start - Date.now() < 30 * 60000 && g.start > Date.now() - 60000));
  rec.nextAt = Date.now() + (rec.ok ? (hot ? 60000 : 10 * 60000) : 5 * 60000);
  sportsState.updated = Date.now();
}
let sportsPolling = false;
async function pollSports(force) {
  const c = sportsCfg();
  if (!c.enabled || sportsPolling) return;
  sportsPolling = true;
  try {
    for (const key of c.leagues) {
      const rec = sportsState.leagues[key];
      if (force || !rec || Date.now() >= rec.nextAt) await pollSportsLeague(key);
    }
  } finally { sportsPolling = false; }
}
function sportsGames() {
  const c = sportsCfg(), now = Date.now(), out = [];
  for (const key of c.leagues) for (const g of (sportsState.leagues[key] && sportsState.leagues[key].games) || []) {
    if (g.start > now - 8 * 3600000 && g.start < now + 36 * 3600000) out.push(g);
  }
  return out.sort((a, b) => a.start - b.start);
}
// Later days (the day strip), one game's detail (stats and plays) and standings: asked on demand and kept briefly, so a busy
// evening is still only a few calls to the feed. All written defensively, since the feed is unofficial.
const sportsExtra = { days: {}, games: {}, standings: {}, inflight: {} };
// Several customers asking for the same thing at once share one call to the feed.
function shared(key, make) {
  if (sportsExtra.inflight[key]) return sportsExtra.inflight[key];
  const p = make().finally(() => { delete sportsExtra.inflight[key]; });
  return (sportsExtra.inflight[key] = p);
}
const sportsBase = () => cfg.scoresBase.replace(/\/+$/, '');
const trim = (v, n) => String(v == null ? '' : v).slice(0, n);
function sportsDay(dateStr) { return shared('day:' + dateStr, () => sportsDayLoad(dateStr)); }
async function sportsDayLoad(dateStr) {
  const c = sportsCfg(), now = Date.now(), out = [];
  const hit = sportsExtra.days[dateStr];
  if (hit && now - hit.at < 10 * 60000) return hit.games;
  const keys = c.leagues.slice();
  const work = async () => {
    while (keys.length) {
      const key = keys.shift(), L = SPORTS_LEAGUES[key];
      try {
        const data = await getJson(`${sportsBase()}/apis/site/v2/sports/${L.path}/scoreboard?dates=${dateStr}`);
        for (const ev of Array.isArray(data.events) ? data.events : []) { const g = normalizeSportsEvent(ev, key); if (g.start) out.push(g); }
      } catch { /* that league has nothing for the day */ }
    }
  };
  await Promise.all([work(), work(), work(), work()]);
  out.sort((a, b) => a.start - b.start);
  sportsExtra.days[dateStr] = { at: now, games: out };
  const old = Object.keys(sportsExtra.days); if (old.length > 14) delete sportsExtra.days[old[0]];
  return out;
}
function sportsGame(key, id) { return shared('game:' + key + ':' + id, () => sportsGameLoad(key, id)); }
async function sportsGameLoad(key, id) {
  const L = SPORTS_LEAGUES[key];
  const ck = key + ':' + id, hit = sportsExtra.games[ck];
  if (hit && Date.now() - hit.at < 25000) return hit.data;
  const raw = await getJson(`${sportsBase()}/apis/site/v2/sports/${L.path}/summary?event=${encodeURIComponent(id)}`);
  const teams = (raw.boxscore && Array.isArray(raw.boxscore.teams)) ? raw.boxscore.teams : [];
  const comp = ((raw.header && raw.header.competitions) || [])[0] || {};
  const homeId = String(((comp.competitors || []).find((x) => x.homeAway === 'home') || {}).id || '');
  const sideOf = (t) => String((t.team && t.team.id) || '');
  const home = teams.find((t) => sideOf(t) === homeId) || teams.find((t) => t.homeAway === 'home') || teams[1];
  const away = teams.find((t) => t !== home) || teams[0];
  const stats = [];
  if (home && away) {
    const hs = Array.isArray(home.statistics) ? home.statistics : [], as = Array.isArray(away.statistics) ? away.statistics : [];
    for (const a of as.slice(0, 14)) {
      const h = hs.find((x) => x.name === a.name);
      if (h && (a.displayValue || a.displayValue === 0) && (h.displayValue || h.displayValue === 0)) stats.push({ label: trim(a.label || a.name, 28), away: trim(a.displayValue, 12), home: trim(h.displayValue, 12) });
    }
  }
  const plays = [];
  const rawPlays = Array.isArray(raw.plays) ? raw.plays : Array.isArray(raw.scoringPlays) ? raw.scoringPlays : [];
  for (const p of rawPlays.slice(-14).reverse()) {
    const txt = trim(p.text || p.shortText, 160); if (!txt) continue;
    plays.push({ time: trim((p.clock && p.clock.displayValue) || (p.period && p.period.displayValue) || (p.period && p.period.number ? 'P' + p.period.number : ''), 10), text: txt, scoring: !!p.scoringPlay });
  }
  const gi = raw.gameInfo || {};
  const data = { id: ck, venue: trim(gi.venue && gi.venue.fullName, 60), city: trim(gi.venue && gi.venue.address && gi.venue.address.city, 40), attendance: gi.attendance || 0, stats, plays };
  sportsExtra.games[ck] = { at: Date.now(), data };
  const old = Object.keys(sportsExtra.games); if (old.length > 60) delete sportsExtra.games[old[0]];
  return data;
}
function sportsStandings(key) { return shared('std:' + key, () => sportsStandingsLoad(key)); }
async function sportsStandingsLoad(key) {
  const L = SPORTS_LEAGUES[key];
  const hit = sportsExtra.standings[key];
  if (hit && Date.now() - hit.at < 15 * 60000) return hit.data;
  const raw = await getJson(`${sportsBase()}/apis/v2/sports/${L.path}/standings`);
  const groups = [];
  const walk = (node, depth) => {
    if (!node || depth > 4) return;
    const entries = node.standings && Array.isArray(node.standings.entries) ? node.standings.entries : null;
    if (entries) {
      const stat = (e, ...names) => { for (const n of names) { const x = (e.stats || []).find((y) => y.name === n || y.abbreviation === n); if (x && x.displayValue != null) return trim(x.displayValue, 8); } return ''; };
      const rows = entries.slice(0, 20).map((e) => ({ id: trim(e.team && e.team.id, 12), name: trim((e.team && (e.team.shortDisplayName || e.team.displayName)) || '', 40), abbr: trim(e.team && e.team.abbreviation, 6),
        w: stat(e, 'wins', 'W'), l: stat(e, 'losses', 'L'), d: stat(e, 'ties', 'draws', 'D'), pct: stat(e, 'winPercent', 'PCT'), pts: stat(e, 'points', 'PTS'), gp: stat(e, 'gamesPlayed', 'GP') }));
      if (rows.length) groups.push({ name: trim(node.name || node.abbreviation || L.name, 40), rows });
    }
    for (const ch of Array.isArray(node.children) ? node.children : []) walk(ch, depth + 1);
  };
  walk(raw, 0);
  const data = { league: key, name: L.name, groups: groups.slice(0, 8) };
  sportsExtra.standings[key] = { at: Date.now(), data };
  return data;
}
async function sportsTeams(key) {
  const L = SPORTS_LEAGUES[key];
  if (!L) return null;
  const hit = sportsState.teams[key];
  if (hit && Date.now() - hit.at < 24 * 3600000) return hit.list;
  const data = await getJson(`${cfg.scoresBase.replace(/\/+$/, '')}/apis/site/v2/sports/${L.path}/teams?limit=100`);
  const raw = [];
  for (const sp of Array.isArray(data.sports) ? data.sports : []) for (const lg of Array.isArray(sp.leagues) ? sp.leagues : []) for (const t of Array.isArray(lg.teams) ? lg.teams : []) raw.push(t.team || t);
  const list = raw.filter((t) => t && t.id && t.displayName).map((t) => ({ id: String(t.id), name: String(t.displayName).slice(0, 60), short: String(t.shortDisplayName || t.name || '').slice(0, 40), abbr: String(t.abbreviation || '').slice(0, 6), color: hex6(t.color) })).sort((a, b) => a.name.localeCompare(b.name));
  sportsState.teams[key] = { at: Date.now(), list };
  return list;
}
// node aurora-guard.js --test-scores: asks the feed once for each league and says what came back (to check it works from this PC).
async function testScores() {
  const keys = sportsCfg().leagues;
  console.log(`Asking ${cfg.scoresBase} for ${keys.length} leagues...`);
  let ok = 0;
  for (const key of keys) {
    await pollSportsLeague(key);
    const r = sportsState.leagues[key];
    console.log(`${(SPORTS_LEAGUES[key].name + ':').padEnd(22)}${r.ok ? `OK, ${r.games.length} games (${r.games.filter((g) => g.state === 'in').length} live)` : 'FAILED: ' + r.error}`);
    if (r.ok) ok++;
  }
  console.log(ok === keys.length ? 'All leagues answered.' : `${ok} of ${keys.length} leagues answered. The feed may have changed or be blocked from this PC.`);
  process.exit(ok ? 0 : 1);
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
    'Access-Control-Allow-Headers': 'X-Emby-Token, X-Aurora-User, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Max-Age': '7200', // the browser remembers the permission check, so /check is one round trip
  });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 64 * 1024) { if (!req.tooLarge) { req.tooLarge = true; reject(new Error('too large')); } req.resume(); chunks.length = 0; } else if (!req.tooLarge) chunks.push(c); });
    req.on('end', () => {
      try {
        let v = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        if (v === null || typeof v !== 'object') v = {}; // a body of "null", a number or a string is not a request: treat it as an empty one instead of failing later
        req.parsedBody = v; resolve(v);
      } catch { reject(new Error('bad JSON')); }
    });
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
  // These names are special on every JavaScript object: as an account or record id they would change how the saved lists behave.
  if (/(^|\/)(__proto__|constructor|prototype)(\/|$)/i.test(decodeURIComponent(url.pathname.replace(/%(?![0-9a-f]{2})/gi, '%25')))) return send(res, 400, { error: 'Not a valid id' });
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
    // A channel that stopped loading for one viewer (an automatic "Channel is down") isn't sent to the TV provider until a
    // second person reports it within the hour: one bad connection must not look like a dead channel.
    const hourAgo = Date.now() - 3600000, sameChannel = (x) => (channelId && x.channelId === channelId) || x.channel.toLowerCase() === channel.toLowerCase();
    const held = body.auto && reason === 'Channel is down' && !(store.reports || []).some((x) => x.at > hourAgo && x.user !== me.Name && sameChannel(x));
    const forwarding = provider.enabled && provider.url && provider.key;
    if (held && forwarding) entry.forwarded = 'held'; // only meaningful when reports are being passed on
    if (!held && forwarding) {
      const r = await sendToProvider({ channel, channelId, reason, note: note || (body.auto ? 'Reported automatically after repeated buffering' : ''), device: entry.device, user: me.Name, group: entry.group, time: new Date().toISOString() });
      entry.forwarded = r.ok ? 'sent' : 'failed';
      entry.providerStatus = r.status;
      if (!r.ok) log('Report to the provider failed:', r.status || '', r.text.slice(0, 120));
    }
    store.reports = [entry, ...(store.reports || [])].slice(0, 1000);
    saveStore();
    return send(res, 200, { ok: true });
  }

  // "Is it just me?": how many other people reported this channel in the last hour (counts only, no names).
  if (url.pathname === '/channel-status' && req.method === 'GET') {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    const channel = String(url.searchParams.get('channel') || '').slice(0, 120).trim().toLowerCase();
    if (!channel) return send(res, 400, { error: 'channel is needed' });
    const since = Date.now() - 3600000, others = new Set();
    let last = 0;
    for (const x of store.reports || []) {
      if (x.at < since || String(x.channel).toLowerCase() !== channel || x.user === me.Name) continue;
      others.add(x.user); last = Math.max(last, x.at);
    }
    return send(res, 200, { others: others.size, lastMinutes: last ? Math.round((Date.now() - last) / 60000) : null, windowMinutes: 60 });
  }

  // The Status page for customers: whether the server answers, what the channel reports say about Live TV, the sports feed,
  // the last 24 hours and the recent outages, plus a message from the admin. Counts only; no names.
  if (url.pathname === '/service-status' && req.method === 'GET') {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    const now = Date.now(), recent = now - 15 * 60000;
    const stale = now - embyReach.at > Math.max(180000, cfg.intervalSeconds * 3000);
    const online = !!embyReach.at && embyReach.ok && !stale;
    // While the server is down nobody can be signed-in-checked (that needs the server), and that is exactly when the page is
    // needed: answer with the outage only (nothing about channels or other viewers).
    if (!me && online) return send(res, 401, { error: 'Not signed in' });
    if (!me) {
      return send(res, 200, { now, server: { online: false, checkedAt: embyReach.at || null }, limited: true, hours: statusHours(now),
        incidents: (store.incidents || []).slice(0, 5).map((x) => ({ title: x.title, start: x.start, end: x.end || null })),
        note: store.statusNote && store.statusNote.text ? { text: store.statusNote.text, at: store.statusNote.at } : null });
    }
    // Live TV: channels several different people reported in the last 15 minutes. Many channels at once means the provider.
    const per = new Map(), people = new Set();
    for (const x of store.reports || []) {
      if (x.at < recent || x.user === me.Name || x.reason === 'Wrong channel' || x.reason === 'Other') continue;
      const k = String(x.channel).toLowerCase();
      const r = per.get(k) || { name: x.channel, users: new Set() };
      r.users.add(x.user); per.set(k, r); people.add(x.user);
    }
    const bad = [...per.values()].filter((r) => r.users.size >= 2).map((r) => ({ name: r.name, reports: r.users.size })).sort((a, b) => b.reports - a.reports);
    const wide = per.size >= 3 && people.size >= 3;
    const live = { state: wide ? 'bad' : bad.length ? 'warn' : 'ok', reporters: people.size, channels: bad.slice(0, 5) };
    const sc = sportsCfg();
    const leagues = sc.leagues.map((k) => sportsState.leagues[k]).filter(Boolean);
    const okLeagues = leagues.filter((r) => r.ok);
    const newest = Math.max(0, ...okLeagues.map((r) => r.at || 0));
    const scores = { enabled: sc.enabled, state: !sc.enabled ? 'na' : okLeagues.length ? 'ok' : leagues.length ? 'bad' : 'na', ageSeconds: newest ? Math.round((now - newest) / 1000) : null };
    const hours = statusHours(now);
    const incidents = (store.incidents || []).slice(0, 5).map((x) => ({ title: x.title, start: x.start, end: x.end || null }));
    const note = store.statusNote && store.statusNote.text ? { text: store.statusNote.text, at: store.statusNote.at } : null;
    return send(res, 200, { now, server: { online, checkedAt: embyReach.at || null }, live, scores, hours, incidents, note });
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
  // Sports (signed-in customers read; counts and names only): scores, a league's teams, and the admin's name aliases.
  if (url.pathname === '/sports/games' && req.method === 'GET') {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    const c = sportsCfg();
    return send(res, 200, { enabled: c.enabled, provider: 'espn', updated: sportsState.updated ? new Date(sportsState.updated).toISOString() : null, leagues: c.leagues, games: c.enabled ? sportsGames() : [] });
  }
  if (url.pathname === '/sports/teams' && req.method === 'GET') {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    const key = String(url.searchParams.get('league') || '');
    if (!SPORTS_LEAGUES[key]) return send(res, 404, { error: 'No such league' });
    try { return send(res, 200, { league: key, name: SPORTS_LEAGUES[key].name, group: SPORTS_LEAGUES[key].group, teams: await sportsTeams(key) }); } catch (e) { return send(res, 502, { error: `Can't load the teams: ${e.message}` }); }
  }
  if (url.pathname === '/sports/day' && req.method === 'GET') {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    const d = String(url.searchParams.get('date') || '');
    if (!/^20\d{6}$/.test(d)) return send(res, 400, { error: 'Give the date as YYYYMMDD' });
    const diff = (Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8)) - Date.now()) / 86400000;
    if (diff < -2 || diff > 10) return send(res, 400, { error: 'That day is out of range' });
    const c = sportsCfg();
    if (!c.enabled) return send(res, 200, { enabled: false, games: [] });
    try { return send(res, 200, { enabled: true, date: d, games: await sportsDay(d) }); } catch (e) { return send(res, 502, { error: `Can't load that day: ${e.message}` }); }
  }
  if (url.pathname === '/sports/game' && req.method === 'GET') {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    const key = String(url.searchParams.get('league') || ''), id = String(url.searchParams.get('id') || '');
    if (!SPORTS_LEAGUES[key] || !/^[\w-]{1,24}$/.test(id)) return send(res, 400, { error: 'Unknown game' });
    if (!sportsCfg().enabled) return send(res, 200, { stats: [], plays: [] });
    try { return send(res, 200, await sportsGame(key, id)); } catch (e) { return send(res, 502, { error: `Can't load the game: ${e.message}` }); }
  }
  if (url.pathname === '/sports/standings' && req.method === 'GET') {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    const key = String(url.searchParams.get('league') || '');
    if (!SPORTS_LEAGUES[key]) return send(res, 404, { error: 'No such league' });
    if (!sportsCfg().enabled) return send(res, 200, { league: key, groups: [] });
    try { return send(res, 200, await sportsStandings(key)); } catch (e) { return send(res, 502, { error: `Can't load the standings: ${e.message}` }); }
  }
  if (url.pathname === '/sports/aliases' && req.method === 'GET') {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    return send(res, 200, { aliases: sportsCfg().aliases });
  }
  // ----- The Aurora website (no sign-in): what to show, discount code check, free-trial sign-up, admin sign-in -----
  if (url.pathname === '/site/info' && req.method === 'GET') {
    return send(res, 200, { signupEnabled: !!cfg.signupEnabled, trialDays: cfg.signupTrialDays, trialConnections: cfg.signupTrialConnections, referralDays: cfg.referralDays > 0 ? cfg.referralDays : 0,
      plans: (store.plans || []).filter((x) => x.active).map((x) => ({ id: x.id, name: x.name, price: x.price, length: x.length, unit: x.unit, connections: x.connections })) });
  }
  if (url.pathname === '/discount/check' && req.method === 'GET') {
    if (overLimit('dcheck', ip, 30, 3600000)) return send(res, 429, { error: 'Too many tries. Please wait a while and try again.' });
    const d = findDiscount(url.searchParams.get('code')), problem = discountProblem(d);
    if (problem) return send(res, 200, { valid: false, message: problem });
    return send(res, 200, { valid: true, type: d.type, value: d.value, label: discountLabel(d), planIds: d.planIds || [] });
  }
  if (url.pathname === '/admin-login' && req.method === 'POST') {
    if (tooManyFailures(ip)) return send(res, 429, { error: 'Too many failed attempts. Try again in a few minutes.' });
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const name = String(body.username || '').trim().slice(0, 64), pw = String(body.password || '').slice(0, 128);
    if (!name || !pw) return send(res, 400, { error: 'Enter your username and password.' });
    let r;
    try { r = await emby('POST', '/Users/AuthenticateByName', { body: { Username: name, Pw: pw } }); } catch (e) {
      if (e.status === 401 || e.status === 400 || e.status === 403 || e.status === 404) { noteFailure(ip); return send(res, 401, { error: 'That username or password is not right.' }); }
      return send(res, 502, { error: `Can't reach Emby: ${e.message}` });
    }
    if (!r?.AccessToken || !r.User?.Policy?.IsAdministrator) { noteFailure(ip); return send(res, 403, { error: 'Only Emby administrators can open this page.' }); }
    return send(res, 200, { token: r.AccessToken, userId: r.User.Id, name: r.User.Name });
  }
  // Sign-in for the website's reseller page: any Emby account, answered with its token and whether it is a reseller (or an administrator).
  if (url.pathname === '/site-login' && req.method === 'POST') {
    if (tooManyFailures(ip)) return send(res, 429, { error: 'Too many failed attempts. Try again in a few minutes.' });
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const name = String(body.username || '').trim().slice(0, 64), pw = String(body.password || '').slice(0, 128);
    if (!name || !pw) return send(res, 400, { error: 'Enter your username and password.' });
    let r;
    try { r = await emby('POST', '/Users/AuthenticateByName', { body: { Username: name, Pw: pw } }); } catch (e) {
      if (e.status === 401 || e.status === 400 || e.status === 403 || e.status === 404) { noteFailure(ip); return send(res, 401, { error: 'That username or password is not right.' }); }
      return send(res, 502, { error: `Can't reach Emby: ${e.message}` });
    }
    if (!r?.AccessToken || !r.User?.Id) { noteFailure(ip); return send(res, 401, { error: 'That username or password is not right.' }); }
    return send(res, 200, { token: r.AccessToken, userId: r.User.Id, name: r.User.Name, admin: !!r.User.Policy?.IsAdministrator, reseller: !!resellerOfUser(r.User.Id) });
  }
  if (url.pathname === '/signup' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    if (!cfg.signupEnabled) return send(res, 403, { error: 'Sign-ups are closed right now. Please try again later.' });
    if (body.website) return send(res, 400, { error: 'Something went wrong. Please try again.' }); // hidden field only a robot fills in
    const username = cleanUserName(body.username), email = String(body.email || '').trim().toLowerCase(), password = String(body.password || '');
    if (!username) return send(res, 400, { error: 'Pick a username of 3 to 32 letters, numbers, dots, dashes or underscores.' });
    if (!emailOk(email)) return send(res, 400, { error: 'Enter a valid email address.' });
    if (password.length < 8 || password.length > 64) return send(res, 400, { error: 'Your password needs 8 to 64 characters.' });
    if (body.agree !== true) return send(res, 400, { error: 'Please agree to not share your login.' });
    const day = localDay(new Date());
    if (overLimit('signup-try', ip, 40, 3600000)) return send(res, 429, { error: 'Too many tries. Please wait a while and try again.' });
    const made = smallLimit.get('signup|' + ip); // accounts made from this address today (counted only when one is really made)
    if (made && Date.now() - made.since <= 86400000 && made.n >= cfg.signupPerIpPerDay) return send(res, 429, { error: 'Too many accounts were made from this connection today. Please try again tomorrow.' });
    if ((store.signups || []).filter((x) => x.day === day).length >= cfg.signupMaxPerDay) {
      if (store.signupFullDay !== day) { store.signupFullDay = day; sendAlert('Aurora: sign-ups full for today', `${cfg.signupMaxPerDay} accounts were made from the website today, so new sign-ups are paused until tomorrow.`, false); }
      return send(res, 429, { error: 'Sign-ups are full for today. Please try again tomorrow.' });
    }
    if (Object.values(store.users).some((u) => (u.contact?.email || '').toLowerCase() === email) || (store.signups || []).some((x) => x.email === email)) return send(res, 409, { error: 'That email already has an account.' });
    // Codes are checked before the account is made, so a wrong code never leaves a half-made account behind.
    let dc = null, refId = null;
    if (String(body.discount || '').trim()) { dc = findDiscount(body.discount); const pr = discountProblem(dc); if (pr) return send(res, 400, { error: pr }); }
    if (String(body.referral || '').trim()) {
      if (!(cfg.referralDays > 0)) return send(res, 400, { error: 'Referral codes are not being used right now.' });
      const rc = String(body.referral).trim().toUpperCase();
      refId = Object.keys(store.users).find((id) => store.users[id].refCode === rc);
      if (!refId) return send(res, 400, { error: 'That referral code was not found.' });
      const yearAgo = Date.now() - 365 * 86400000;
      if (Object.values(store.users).filter((u) => u.referredBy === refId && (u.referredAt || 0) > yearAgo).length >= cfg.referralMaxPerYear) return send(res, 400, { error: 'That referral code has reached its limit.' });
    }
    let existing;
    try { existing = await emby('GET', '/Users'); } catch (e) { return send(res, 502, { error: 'Sign-up is not available right now. Please try again in a few minutes.' }); }
    if ((existing || []).some((u) => String(u.Name).toLowerCase() === username.toLowerCase())) return send(res, 409, { error: 'That username is taken. Try another.' });
    let user;
    try { user = await newEmbyAccount(username, password); } catch (e) { log('Website sign-up could not make the account:', e.message); return send(res, 502, { error: 'Could not make your account. Please try again in a few minutes.' }); }
    if (made && Date.now() - made.since <= 86400000) made.n++; else smallLimit.set('signup|' + ip, { n: 1, since: Date.now() });
    const days = cfg.signupTrialDays, conns = cfg.signupTrialConnections;
    const rec = store.users[user.Id] = { limit: conns, expires: addDays(day, days), categories: null, name: username, updated: Date.now(), trial: true, created: Date.now(), site: true, contact: { full: '', email, phone: '', note: 'Website sign-up' },
      plan: { id: 'trial', name: 'Free trial', price: 0, connections: conns, length: days, unit: 'day', categories: null, since: day } };
    if (dc) { dc.used = (dc.used || 0) + 1; rec.discount = { code: dc.code, type: dc.type, value: dc.value, planIds: dc.planIds || [], at: Date.now() }; }
    let gave = 0;
    if (refId) { rec.referredBy = refId; rec.referredAt = Date.now(); if (giveDays(user.Id, cfg.referralDays, 'referral code')) gave = cfg.referralDays; giveDays(refId, cfg.referralDays, `referral: ${username} joined`); }
    store.signups = [{ at: Date.now(), day, email, user: username, discount: dc ? dc.code : '', referral: !!refId }, ...(store.signups || [])].slice(0, 2000);
    recordAudit('Website', `Sign-up: ${username}${dc ? `, code ${dc.code}` : ''}${refId ? ', referral' : ''}`);
    try { saveStore(); } catch (e) { log('Could not save after a website sign-up:', e.message); }
    queueAlert(`New website sign-up: ${username}${dc ? ` (code ${dc.code})` : ''}`);
    log('Website sign-up:', username);
    copyAppDefaults(user.Id).catch(() => {});
    try { await enforce(user.Id); if (refId) await enforce(refId); } catch (e) { log('Applying', username, 'failed:', e.message); }
    return send(res, 200, { ok: true, username, days: days + gave, expires: rec.expires, connections: conns, discount: dc ? discountLabel(dc) : '' });
  }
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

  if (url.pathname === '/maintenance' && req.method === 'GET') {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    return send(res, 200, maintenancePublic());
  }
  // ----- Resellers (guard 1.10.0): the reseller's own panel. Everything is limited to the signed-in reseller and the customers they made. -----
  if (url.pathname.startsWith('/reseller/')) {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    const r = resellerOfUser(me.Id);
    if (url.pathname === '/reseller/me' && req.method === 'GET') {
      if (!r) return send(res, 200, { reseller: false });
      if (r.status !== 'active') return send(res, 200, { reseller: true, suspended: true, name: r.name });
      const devices = activeByUser(await sessionsShared());
      const mine = Object.entries(store.users).filter(([, u]) => u.reseller === r.id).map(([id, u]) => publicCustomer(id, u, devices.get(id))).sort((a, b) => (a.daysLeft ?? 99999) - (b.daysLeft ?? 99999));
      const today = localDay(new Date());
      const trialsToday = Object.values(store.users).filter((u) => u.reseller === r.id && u.trial && u.created && localDay(new Date(u.created)) === today).length;
      return send(res, 200, { reseller: true, name: r.name, credits: r.credits, low: r.credits <= cfg.resellerLowCredits, trialsLeft: Math.max(0, cfg.resellerTrialsPerDay - trialsToday),
        plans: (store.plans || []).filter((p) => p.active !== false && (r.plans || []).includes(p.id)).map((p) => ({ id: p.id, name: p.name, connections: p.connections, length: p.length, unit: p.unit, credits: planCredits(p) })),
        customers: mine, ledger: (store.creditLog || []).filter((e) => e.reseller === r.id).slice(0, 40),
        request: (store.creditRequests || []).find((x) => x.reseller === r.id && x.status === 'pending') || null,
        report: (() => { const ms = new Date(); ms.setDate(1); ms.setHours(0, 0, 0, 0); const e = (store.creditLog || []).filter((x) => x.reseller === r.id && x.at >= ms.getTime());
          return { month: ms.toLocaleString('en-US', { month: 'long', year: 'numeric' }), added: e.filter((x) => x.customer && x.delta <= 0 && !/^Renewed/.test(x.why)).length, renewed: e.filter((x) => /^Renewed/.test(x.why)).length, used: -e.filter((x) => x.delta < 0).reduce((n, x) => n + x.delta, 0), received: e.filter((x) => x.delta > 0).reduce((n, x) => n + x.delta, 0) }; })() });
    }
    if (!r) return send(res, 403, { error: 'This account is not a reseller.' });
    if (r.status !== 'active') return send(res, 403, { error: 'This reseller account is suspended. Contact your provider.' });
    if (resellerBusy.has(r.id)) return send(res, 409, { error: 'Another change is in progress. Try again in a moment.' });
    resellerBusy.add(r.id);
    try {
      const by = `${r.name} (reseller)`;
      const sellable = (id) => (store.plans || []).find((p) => p.id === id && p.active !== false && (r.plans || []).includes(p.id));
      const owns = (id) => store.users[id]?.reseller === r.id;
      if (url.pathname === '/reseller/customers' && req.method === 'POST') {
        let body;
        try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
        const username = cleanUserName(body.username);
        if (!username) return send(res, 400, { error: 'The username must be 3 to 32 letters, numbers, dots, dashes or underscores, starting with a letter or number.' });
        const password = body.password ? String(body.password) : genPassword();
        if (password.length < 6 || password.length > 64) return send(res, 400, { error: 'The password must be 6 to 64 characters.' });
        const plan = sellable(body.planId);
        if (!plan) return send(res, 400, { error: 'Choose one of your plans.' });
        const trial = !!body.trial, cost = trial ? 0 : planCredits(plan);
        if (r.credits < cost) return send(res, 402, { error: `Not enough credits: this costs ${cost} and you have ${r.credits}.` });
        const today = localDay(new Date());
        if (trial && Object.values(store.users).filter((u) => u.reseller === r.id && u.trial && u.created && localDay(new Date(u.created)) === today).length >= cfg.resellerTrialsPerDay) return send(res, 429, { error: `You can start ${cfg.resellerTrialsPerDay} free trials a day. Try again tomorrow.` });
        const existing = await emby('GET', '/Users');
        if ((existing || []).some((u) => String(u.Name).toLowerCase() === username.toLowerCase())) return send(res, 409, { error: 'That username is taken. Try another.' });
        let user;
        try { user = await newEmbyAccount(username, password); } catch (e) { return send(res, 502, { error: e.message }); }
        if (trial) {
          store.users[user.Id] = { limit: plan.connections, expires: addDays(today, 2), categories: plan.categories ? [...plan.categories] : null, name: username, updated: Date.now(), plan: { id: plan.id, name: plan.name, price: 0, connections: plan.connections, length: 2, unit: 'day', categories: plan.categories || null, since: today } };
        } else applyPlan(user.Id, username, plan, 'today');
        const rec = store.users[user.Id];
        rec.reseller = r.id; rec.trial = trial; rec.created = Date.now();
        rec.contact = { full: cleanText(body.fullName, 60), email: cleanText(body.email, 80), phone: cleanText(body.phone, 30), note: cleanText(body.note, 300) };
        creditEntry(r, -cost, trial ? 'Free trial' : plan.name, by, { customer: username });
        recordAudit(by, `Created the customer ${username} on ${trial ? 'a free trial' : plan.name} (${cost} credits)`);
        saveStore();
        log('Reseller', r.name, 'created', username, trial ? '(trial)' : plan.name, '-', cost, 'credits');
        copyAppDefaults(user.Id).catch(() => {});
        try { await enforce(user.Id); } catch (e) { log('Applying', username, 'failed:', e.message); }
        return send(res, 200, { ok: true, password, credits: r.credits, customer: publicCustomer(user.Id, rec) });
      }
      if (url.pathname === '/reseller/credit-request' && req.method === 'POST') {
        let body;
        try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
        const amount = Number(body.amount);
        if (!Number.isInteger(amount) || amount < 1 || amount > 1000) return send(res, 400, { error: 'Ask for a whole number of credits from 1 to 1000.' });
        if ((store.creditRequests || []).some((x) => x.reseller === r.id && x.status === 'pending')) return send(res, 409, { error: 'You already have a request waiting. Your provider will answer it.' });
        const entry = { id: crypto.randomBytes(5).toString('hex'), reseller: r.id, amount, note: cleanText(body.note, 200), at: Date.now(), status: 'pending' };
        store.creditRequests = [entry, ...(store.creditRequests || [])].slice(0, 300);
        saveStore();
        sendAlert('Aurora: credit request', `${r.name} asked for ${amount} credits.${entry.note ? '\n"' + entry.note + '"' : ''}`, false);
        return send(res, 200, { ok: true, request: entry });
      }
      if (url.pathname === '/reseller/renew-many' && req.method === 'POST') {
        let body;
        try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
        const ids = [...new Set(Array.isArray(body.ids) ? body.ids.map(String) : [])].filter((id) => owns(id)).slice(0, 50);
        if (!ids.length) return send(res, 400, { error: 'Choose at least one of your customers.' });
        const plans = ids.map((id) => ({ id, plan: sellable(body.planId || store.users[id].plan?.id) }));
        const missing = plans.find((x) => !x.plan);
        if (missing) return send(res, 400, { error: `${store.users[missing.id].name} is on a plan you can't sell. Renew them one by one.` });
        const total = plans.reduce((n, x) => n + planCredits(x.plan), 0);
        if (r.credits < total) return send(res, 402, { error: `Not enough credits: this costs ${total} and you have ${r.credits}.` });
        for (const { id, plan } of plans) {
          const rec = store.users[id], cost = planCredits(plan);
          applyPlan(id, rec.name, plan, 'extend'); rec.trial = false;
          creditEntry(r, -cost, 'Renewed ' + plan.name, by, { customer: rec.name });
        }
        recordAudit(by, `Renewed ${ids.length} customers (${total} credits)`);
        saveStore();
        for (const { id } of plans) { try { await enforce(id); } catch (e) { log('Applying', id, 'failed:', e.message); } }
        return send(res, 200, { ok: true, renewed: ids.length, spent: total, credits: r.credits });
      }
      const cm = url.pathname.match(/^\/reseller\/customers\/([\w-]{1,64})(?:\/(renew|password|signout|hold))?$/);
      if (cm) {
        const id = cm[1], act = cm[2];
        if (!owns(id)) return send(res, 404, { error: 'No such customer.' });
        const rec = store.users[id];
        let body = {};
        if (req.method !== 'GET') { try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); } }
        // Put a customer on hold (sign-in is switched off and their devices are signed out; the end date keeps running), or release them.
        if (act === 'hold' && req.method === 'POST') {
          let user;
          try { user = await emby('GET', `/Users/${id}`); } catch (e) { return send(res, e.status === 404 ? 404 : 502, { error: e.status === 404 ? 'That account no longer exists.' : e.message }); }
          if (user.Policy?.IsAdministrator) return send(res, 400, { error: 'That account can\'t be put on hold.' });
          const hold = !!body.hold;
          try { await setDisabled(user, hold); } catch (e) { return send(res, 502, { error: 'Could not change the account: ' + e.message }); }
          if (hold) {
            rec.hold = true; delete store.disabledByGuard[id]; // a renewal must not switch it back on by itself
            const devices = activeByUser(await emby('GET', '/Sessions')).get(id);
            for (const dv of devices ? devices.values() : []) { try { await signOutDevice({ Id: id, Name: rec.name }, dv, 'Your access is on hold. Please contact your reseller.'); } catch { /* next */ } }
          } else delete rec.hold;
          rec.updated = Date.now();
          recordAudit(by, `${hold ? 'Put on hold' : 'Released'} ${rec.name}`); saveStore();
          if (!hold) { try { await enforce(id); } catch { /* applied at the next check */ } }
          return send(res, 200, { ok: true, hold });
        }
        // Delete a customer's account for good (their credits are not refunded).
        if (!act && req.method === 'DELETE') {
          try { await emby('DELETE', `/Users/${id}`); } catch (e) { if (e.status !== 404) return send(res, 502, { error: 'Could not delete the account: ' + e.message }); }
          const name = rec.name;
          delete store.users[id]; delete store.disabledByGuard[id]; delete store.firstSeen[id];
          recordAudit(by, `Deleted the customer ${name}`); saveStore();
          log('Reseller', r.name, 'deleted', name);
          return send(res, 200, { ok: true });
        }
        if (!act && req.method === 'PUT') {
          rec.contact = { full: cleanText(body.fullName, 60), email: cleanText(body.email, 80), phone: cleanText(body.phone, 30), note: cleanText(body.note, 300) };
          rec.updated = Date.now(); saveStore();
          return send(res, 200, { ok: true });
        }
        if (act === 'renew' && req.method === 'POST') {
          const plan = sellable(body.planId || rec.plan?.id);
          if (!plan) return send(res, 400, { error: 'Choose one of your plans.' });
          const cost = planCredits(plan);
          if (r.credits < cost) return send(res, 402, { error: `Not enough credits: this costs ${cost} and you have ${r.credits}.` });
          applyPlan(id, rec.name, plan, 'extend');
          rec.trial = false;
          creditEntry(r, -cost, 'Renewed ' + plan.name, by, { customer: rec.name });
          recordAudit(by, `Renewed ${rec.name} on ${plan.name} (${cost} credits)`);
          saveStore();
          try { await enforce(id); } catch (e) { log('Applying', rec.name, 'failed:', e.message); }
          return send(res, 200, { ok: true, credits: r.credits, expires: rec.expires });
        }
        if (act === 'password' && req.method === 'POST') {
          const password = body.password ? String(body.password) : genPassword();
          if (password.length < 6 || password.length > 64) return send(res, 400, { error: 'The password must be 6 to 64 characters.' });
          try {
            await emby('POST', `/Users/${id}/Password`, { body: { Id: id, ResetPassword: true } });
            await emby('POST', `/Users/${id}/Password`, { body: { Id: id, CurrentPw: '', NewPw: password } });
          } catch (e) { return send(res, 502, { error: 'Could not change the password: ' + e.message }); }
          recordAudit(by, `Reset the password of ${rec.name}`); saveStore();
          return send(res, 200, { ok: true, password });
        }
        if (act === 'signout' && req.method === 'POST') {
          const devices = activeByUser(await emby('GET', '/Sessions')).get(id);
          let n = 0;
          for (const d of devices ? devices.values() : []) { try { await signOutDevice({ Id: id, Name: rec.name }, d, 'Signed out by your reseller'); n++; } catch { /* next */ } }
          return send(res, 200, { ok: true, signedOut: n });
        }
      }
      return send(res, 404, { error: 'Not found' });
    } finally { resellerBusy.delete(r.id); }
  }

  // ----- Speed test, upload half (guard 1.14.0): the app sends a few seconds of data and times it itself. The data is thrown away. -----
  if (url.pathname === '/speedtest/up' && req.method === 'POST') {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    if (!me) { req.resume(); return send(res, 401, { error: 'Not signed in' }); }
    const c = speedCount.get(me.Id);
    if (!c || Date.now() - c.since > 3600000) speedCount.set(me.Id, { n: 1, since: Date.now() });
    else if (++c.n > 12) { req.resume(); return send(res, 429, { error: 'That is a lot of speed tests. Please try again in a little while.' }); }
    let size = 0, done = false;
    const cap = 48 * 1024 * 1024;
    const finish = () => { if (done) return; done = true; send(res, 200, { ok: true, bytes: size }); };
    req.on('data', (chunk) => { size += chunk.length; if (size > cap) { finish(); req.destroy(); } });
    req.on('end', finish);
    req.on('error', () => { /* the app stopped sending: nothing to answer */ });
    return;
  }
  // ----- Notifications, support, referrals and stats: the signed-in customer's own (guard 1.11.0) -----
  if (url.pathname === '/inbox' && req.method === 'GET') {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    return send(res, 200, await inboxFor(me));
  }
  if (url.pathname === '/inbox/read' && req.method === 'POST') {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    (store.inboxRead || (store.inboxRead = {}))[me.Id] = Date.now();
    saveStore();
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/support' && (req.method === 'GET' || req.method === 'POST') && url.searchParams.get('userId')) {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    const mine = (store.tickets || []).filter((x) => x.userId === me.Id);
    if (req.method === 'GET') return send(res, 200, { ticket: mine[0] ? ticketPublic(mine[0]) : null });
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const text = cleanText(body.text, 1000);
    if (!text) return send(res, 400, { error: 'Write a message first.' });
    const c = supportCount.get(me.Id);
    if (!c || Date.now() - c.since > 3600000) supportCount.set(me.Id, { n: 1, since: Date.now() });
    else if (++c.n > 10) return send(res, 429, { error: 'That is a lot of messages. Please wait a little.' });
    let t = mine[0] && mine[0].status === 'open' ? mine[0] : null;
    const rec = store.users[me.Id];
    if (!t) {
      t = { id: crypto.randomBytes(5).toString('hex'), userId: me.Id, name: me.Name, status: 'open', at: Date.now(), messages: [], resellerName: rec?.reseller ? (resellerList()[rec.reseller]?.name || '') : '' };
      store.tickets = [t, ...(store.tickets || [])].slice(0, 500);
    }
    t.messages.push({ from: 'user', text, at: Date.now() });
    if (t.messages.length > 100) t.messages.shift();
    if (body.diag) t.diag = cleanDiag(body.diag);
    t.updated = Date.now(); t.unseen = true;
    saveStore();
    if (t.messages.filter((m) => m.from === 'user').length === 1) sendAlert('Aurora: support message', `${me.Name}: ${text.slice(0, 200)}`, false);
    return send(res, 200, { ok: true, ticket: ticketPublic(t) });
  }
  if (url.pathname === '/referral' && req.method === 'GET') {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    const rec = store.users[me.Id];
    const friends = Object.values(store.users).filter((u) => u.referredBy === me.Id).map((u) => ({ name: u.name, at: u.referredAt || 0 }));
    return send(res, 200, { enabled: cfg.referralDays > 0, days: cfg.referralDays, code: cfg.referralDays > 0 ? referralCode(me.Id, me.Name) : null, friends, earned: friends.length * cfg.referralDays, canRedeem: cfg.referralDays > 0 && !rec?.referredBy && !me.Policy?.IsAdministrator });
  }
  if (url.pathname === '/referral/redeem' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const me = await userOfToken(token, String(body.userId || ''));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    if (!(cfg.referralDays > 0)) return send(res, 400, { error: 'Referrals are switched off.' });
    if (me.Policy?.IsAdministrator) return send(res, 400, { error: 'Administrator accounts cannot use a code.' });
    const code = String(body.code || '').trim().toUpperCase();
    const mine = store.users[me.Id] || (store.users[me.Id] = { limit: cfg.defaultLimit, expires: null, name: me.Name, updated: Date.now() });
    if (mine.referredBy) return send(res, 409, { error: 'You have already used a code.' });
    const refId = Object.keys(store.users).find((id) => store.users[id].refCode === code);
    if (!refId || refId === me.Id) return send(res, 404, { error: 'That code was not found.' });
    if (store.users[refId].referredBy === me.Id) return send(res, 409, { error: 'That friend already used your code, so you can\'t use theirs.' });
    const seen = Math.min(mine.created || Infinity, ...Object.values(store.firstSeen[me.Id] || {}));
    if (Number.isFinite(seen) && Date.now() - seen > 14 * 86400000) return send(res, 409, { error: 'Codes can be used in the first 14 days of an account.' });
    const yearAgo = Date.now() - 365 * 86400000;
    if (Object.values(store.users).filter((u) => u.referredBy === refId && (u.referredAt || 0) > yearAgo).length >= cfg.referralMaxPerYear) return send(res, 409, { error: 'That code has reached its limit.' });
    mine.referredBy = refId; mine.referredAt = Date.now();
    const gotYou = giveDays(me.Id, cfg.referralDays, 'referral code'), gotThem = giveDays(refId, cfg.referralDays, `referral: ${me.Name} joined`);
    recordAudit('Referral', `${me.Name} used the code of ${store.users[refId].name}${gotYou ? ` (+${cfg.referralDays} days each)` : ' (no end date to extend)'}`);
    saveStore();
    try { await enforce(me.Id); if (gotThem) await enforce(refId); } catch { /* applied at the next check */ }
    return send(res, 200, { ok: true, days: gotYou ? cfg.referralDays : 0, expires: mine.expires });
  }
  if (url.pathname === '/stats' && req.method === 'GET') {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    return send(res, 200, statsFor(me.Id));
  }

  // Everything else: Emby administrators only.
  if (tooManyFailures(ip)) return send(res, 429, { error: 'Too many failed attempts. Try again in a few minutes.' });
  let admin = false;
  try { admin = await isAdminToken(token); } catch (e) { return send(res, 502, { error: `Can't reach Emby to check who you are: ${e.message}` }); }
  if (!admin) { noteFailure(ip); return send(res, 403, { error: 'Emby administrators only' }); }

  // Who changed what: every change made through the admin endpoints is written down with the admin's name (the app sends it).
  const auditBy = String(url.searchParams.get('by') || req.headers['x-aurora-user'] || '').replace(/[^\p{L}\p{N} ._'-]/gu, '').trim().slice(0, 40) || 'an admin';
  if (url.pathname === '/audit' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!text) return send(res, 400, { error: 'text is required' });
    recordAudit(auditBy, text); saveStore();
    return send(res, 200, { ok: true });
  }
  if (req.method !== 'GET') {
    const subjectId = (url.pathname.match(/^\/(?:limits|sharing)\/([\w-]{1,64})/) || [])[1];
    const subject = subjectId ? (store.users[subjectId]?.name || store.sharing?.[subjectId]?.name || '') : '';
    res.on('finish', () => {
      if (res.statusCode >= 400) return;
      const text = describeChange(req, url, subject);
      if (text) { recordAudit(auditBy, text); try { saveStore(); } catch (e) { log('Could not save the audit log:', e.message); } }
    });
  }
  // Discount codes for the website (admin).
  if (url.pathname === '/discounts' && req.method === 'GET') return send(res, 200, { discounts: (store.discounts || []).map(publicDiscount), plans: (store.plans || []).filter((x) => x.active).map((x) => ({ id: x.id, name: x.name, price: x.price })) });
  if (url.pathname === '/discounts' && req.method === 'POST') {
    let b;
    try { b = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const code = (String(b.code || '').trim().toUpperCase()) || genDiscountCode();
    if (!/^[A-Z0-9]{3,20}$/.test(code)) return send(res, 400, { error: 'A code can use letters and numbers only, 3 to 20 characters.' });
    if (findDiscount(code)) return send(res, 409, { error: 'That code already exists. Pick another.' });
    const type = b.type === 'usd' ? 'usd' : 'pct', value = Math.round(Number(b.value) * 100) / 100;
    if (!Number.isFinite(value) || value < 1 || (type === 'pct' && value > 100) || value > 100000) return send(res, 400, { error: type === 'pct' ? 'Percent must be between 1 and 100.' : 'Dollars off must be 1 or more.' });
    const activeIds = (store.plans || []).filter((x) => x.active).map((x) => x.id);
    const planIds = Array.isArray(b.planIds) ? [...new Set(b.planIds.map(String))].filter((id) => activeIds.includes(id)) : [];
    if (!planIds.length) return send(res, 400, { error: 'Pick at least one plan.' });
    let max = null;
    if (b.max !== undefined && b.max !== null && b.max !== '') { max = Number(b.max); if (!Number.isInteger(max) || max < 1 || max > 1000000) return send(res, 400, { error: 'Uses must be a whole number from 1 up, or blank for no limit.' }); }
    const ends = String(b.ends || '');
    if (ends && (!/^\d{4}-\d{2}-\d{2}$/.test(ends) || ends < localDay(new Date()))) return send(res, 400, { error: 'The end date must be today or later.' });
    if ((store.discounts || []).length >= 500) return send(res, 400, { error: 'That is a lot of codes. Delete some you no longer need first.' });
    const d = { code, type, value, planIds, max, used: 0, ends, on: true, note: cleanText(b.note, 80), created: Date.now(), by: auditBy };
    store.discounts = [d, ...(store.discounts || [])];
    b.code = code; b.type = type; b.value = value; // so the change log names the real code
    saveStore();
    return send(res, 200, { ok: true, discount: publicDiscount(d) });
  }
  const dm = url.pathname.match(/^\/discounts\/([A-Za-z0-9]{3,20})$/);
  if (dm && req.method === 'PUT') {
    const d = findDiscount(dm[1]);
    if (!d) return send(res, 404, { error: 'That code was not found.' });
    let b;
    try { b = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    d.on = !!b.on; saveStore();
    return send(res, 200, { ok: true, discount: publicDiscount(d) });
  }
  if (dm && req.method === 'DELETE') {
    if (!findDiscount(dm[1])) return send(res, 404, { error: 'That code was not found.' });
    store.discounts = (store.discounts || []).filter((d) => d.code !== dm[1].toUpperCase()); saveStore();
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/audit' && req.method === 'GET') return send(res, 200, { audit: (store.audit || []).slice(0, 300) });

  // Hours watched per account and per title (from Emby's sessions, counted each minute; Aurora's own live player included).
  if (url.pathname === '/usage' && req.method === 'GET') {
    const days = Math.max(1, Math.min(60, parseInt(url.searchParams.get('days'), 10) || 30));
    return send(res, 200, usageReport(days));
  }
  // Possible shared logins: an account seen on many different networks, or playing from two at once.
  if (url.pathname === '/sharing' && req.method === 'GET') {
    const list = Object.entries(store.sharing || {}).map(([userId, rec]) => {
      const lv = sharingLevel(rec), week = Date.now() - 7 * 86400000;
      return { userId, name: rec.name, ...lv, limit: limitOf(userId), places: Object.values(rec.nets || {}).filter((v) => (v.at || 0) > week)
        .sort((a, b) => b.at - a.at).map((v) => ({ ip: v.ip, local: !!v.local, device: v.device || '', last: new Date(v.at).toISOString(), seen: v.n })) };
    }).sort((a, b) => ({ likely: 0, watch: 1, ok: 2 }[a.level] - { likely: 0, watch: 1, ok: 2 }[b.level]) || (b.together - a.together) || (b.networks - a.networks));
    return send(res, 200, { list, networksAt: cfg.sharingNetworks, togetherAt: cfg.sharingSimultaneousMinutes });
  }
  const sh = url.pathname.match(/^\/sharing\/([\w-]{1,64})$/);
  if (sh && req.method === 'DELETE') { if (store.sharing) delete store.sharing[sh[1]]; saveStore(); return send(res, 200, { ok: true }); }
  // The PC the guard runs on (and so Emby): processor, memory, free disk space, streams now, and the last 24 hours.
  if (url.pathname === '/server' && req.method === 'GET') {
    const total = os.totalmem(), step = 5;
    const history = healthHistory.filter((_, i) => (healthHistory.length - 1 - i) % step === 0);
    return send(res, 200, {
      version: VERSION, now: new Date().toISOString(), hostname: os.hostname(), platform: `${os.type()} ${os.release()}`, cores: (os.cpus() || []).length,
      pcUptime: os.uptime(), guardUptime: Math.round(process.uptime()), node: process.version,
      cpu: health.cpu, mem: { pct: health.memPct, used: total - os.freemem(), total },
      streams: { playing: health.playing, transcoding: health.transcoding, direct: health.direct, live: connections.inUse || 0 },
      disks: diskInfo(), emby: { online: embyReach.ok, error: embyReach.error }, history,
    });
  }

  // ----- Announcements, support inbox, credit requests (admin) -----
  if (url.pathname === '/announcements' && req.method === 'GET') {
    const now = Date.now();
    return send(res, 200, { announcements: (store.announcements || []).filter((a) => !a.expires || a.expires > now) });
  }
  if (url.pathname === '/announcements' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const text = cleanText(body.text, 200);
    if (!text) return send(res, 400, { error: 'Write the message.' });
    const level = ['info', 'warn', 'bad'].includes(body.level) ? body.level : 'info';
    const hours = Number(body.hours);
    if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 30) return send(res, 400, { error: 'It must last between 1 hour and 30 days.' });
    let audience = { type: 'all' };
    if (body.audience && body.audience.type && body.audience.type !== 'all') {
      const ok = (body.audience.type === 'plan' && (store.plans || []).some((p) => p.id === body.audience.id)) || (body.audience.type === 'reseller' && resellerList()[body.audience.id]) || body.audience.type === 'resellers';
      if (!ok) return send(res, 400, { error: 'Choose who should get it: everyone, a plan, or a reseller that exists.' });
      audience = { type: body.audience.type, id: body.audience.id };
    }
    const a = { id: crypto.randomBytes(5).toString('hex'), text, level, at: Date.now(), expires: Date.now() + hours * 3600000, audience, by: auditBy };
    store.announcements = [a, ...(store.announcements || [])].slice(0, 100);
    saveStore();
    return send(res, 200, { ok: true, announcement: a });
  }
  const anm = url.pathname.match(/^\/announcements\/([\w-]{1,32})$/);
  if (anm && req.method === 'DELETE') { store.announcements = (store.announcements || []).filter((a) => a.id !== anm[1]); saveStore(); return send(res, 200, { ok: true }); }
  if (url.pathname === '/support' && req.method === 'GET') {
    return send(res, 200, { tickets: (store.tickets || []).slice(0, 100).map(ticketPublic) });
  }
  const spm = url.pathname.match(/^\/support\/([\w-]{1,32})(?:\/(reply))?$/);
  if (spm) {
    const t = (store.tickets || []).find((x) => x.id === spm[1]);
    if (!t) return send(res, 404, { error: 'No such message' });
    let body = {};
    if (req.method !== 'GET') { try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); } }
    if (spm[2] === 'reply' && req.method === 'POST') {
      const text = cleanText(body.text, 1000);
      if (!text) return send(res, 400, { error: 'Write a reply.' });
      t.messages.push({ from: 'admin', by: auditBy, text, at: Date.now() }); t.updated = Date.now(); t.unseen = false; t.status = 'open';
      saveStore();
      return send(res, 200, { ok: true, ticket: ticketPublic(t) });
    }
    if (!spm[2] && req.method === 'PUT') {
      if (body.status === 'open' || body.status === 'solved') { t.status = body.status; t.unseen = false; }
      saveStore();
      return send(res, 200, { ok: true, ticket: ticketPublic(t) });
    }
  }
  if (url.pathname === '/credit-requests' && req.method === 'GET') {
    return send(res, 200, { requests: (store.creditRequests || []).slice(0, 60).map((x) => ({ ...x, resellerName: resellerList()[x.reseller]?.name || '', balance: resellerList()[x.reseller]?.credits ?? null })) });
  }
  const crm = url.pathname.match(/^\/credit-requests\/([\w-]{1,32})$/);
  if (crm && req.method === 'PUT') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const x = (store.creditRequests || []).find((q) => q.id === crm[1]);
    if (!x) return send(res, 404, { error: 'No such request' });
    if (x.status !== 'pending') return send(res, 409, { error: `Already ${x.status}.` });
    const r = resellerList()[x.reseller];
    if (body.action === 'approve') {
      if (!r) return send(res, 404, { error: 'That reseller no longer exists.' });
      const amount = body.amount === undefined ? x.amount : Number(body.amount);
      if (!Number.isInteger(amount) || amount < 1 || amount > 100000) return send(res, 400, { error: 'The credits must be a whole number from 1 up.' });
      creditEntry(r, amount, 'Request approved', auditBy);
      x.status = 'approved'; x.granted = amount;
    } else if (body.action === 'deny') x.status = 'denied';
    else return send(res, 400, { error: 'action must be approve or deny' });
    x.decidedAt = Date.now(); x.by = auditBy;
    saveStore();
    return send(res, 200, { ok: true, request: x });
  }
  // One number for the Admin menu, and what is in it.
  if (url.pathname === '/admin-inbox' && req.method === 'GET') {
    const pendingExt = (store.extensions || []).filter((e) => e.status === 'pending').length;
    const requests = (store.creditRequests || []).filter((x) => x.status === 'pending').length;
    const tickets = (store.tickets || []).filter((t) => t.status === 'open' && t.unseen).length;
    const low = Object.values(resellerList()).filter((r) => r.status === 'active' && r.credits <= cfg.resellerLowCredits).map((r) => ({ id: r.id, name: r.name, credits: r.credits }));
    return send(res, 200, { total: pendingExt + requests + tickets + low.length, extensions: pendingExt, creditRequests: requests, tickets, lowResellers: low });
  }

  // ----- Resellers (admin): add a reseller, change their details and plans, add or remove credits, see the ledger. -----
  if (url.pathname === '/resellers' && req.method === 'GET') {
    for (const r of Object.values(resellerList())) if (!r.limited) { try { await limitResellerAccount(r.userId); r.limited = true; saveStore(); } catch { /* try again next time */ } }
    const list = Object.values(resellerList()).map(publicReseller);
    return send(res, 200, { resellers: list, totalCredits: list.reduce((n, r) => n + r.credits, 0), lowCredits: cfg.resellerLowCredits, log: (store.creditLog || []).slice(0, 40).map((e) => ({ ...e, resellerName: resellerList()[e.reseller]?.name || '' })) });
  }
  if (url.pathname === '/resellers' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const name = cleanText(body.name, 60);
    if (!name) return send(res, 400, { error: 'Give the reseller a name.' });
    const userName = cleanUserName(body.userName);
    if (!userName) return send(res, 400, { error: 'The login name must be 3 to 32 letters, numbers, dots, dashes or underscores.' });
    const credits = body.credits === undefined || body.credits === '' ? 0 : Number(body.credits);
    if (!Number.isInteger(credits) || credits < 0 || credits > 100000) return send(res, 400, { error: 'Starting credits must be a whole number from 0 up.' });
    const planIds = (Array.isArray(body.plans) ? body.plans : []).filter((id) => (store.plans || []).some((p) => p.id === id));
    const password = body.password ? String(body.password) : genPassword();
    if (password.length < 6 || password.length > 64) return send(res, 400, { error: 'The password must be 6 to 64 characters.' });
    const existing = await emby('GET', '/Users');
    if ((existing || []).some((u) => String(u.Name).toLowerCase() === userName.toLowerCase())) return send(res, 409, { error: 'That login name is taken. Try another.' });
    let user;
    try { user = await newEmbyAccount(userName, password); } catch (e) { return send(res, 502, { error: e.message }); }
    const id = crypto.randomBytes(4).toString('hex');
    const r = { id, userId: user.Id, userName, name, contact: cleanText(body.contact, 100), credits: 0, status: 'active', plans: planIds, created: Date.now() };
    resellerList()[id] = r;
    try { await limitResellerAccount(user.Id); r.limited = true; } catch (e) { log('Could not limit the reseller account', userName, '-', e.message); }
    if (credits) creditEntry(r, credits, 'Starting credits', auditBy);
    saveStore();
    log('Reseller added:', name, `(${userName}) with`, credits, 'credits');
    copyAppDefaults(user.Id).catch(() => {});
    return send(res, 200, { ok: true, password, reseller: publicReseller(r) });
  }
  const rm = url.pathname.match(/^\/resellers\/([\w-]{1,32})(?:\/(credits|log|password))?$/);
  if (rm) {
    const r = resellerList()[rm[1]];
    if (!r) return send(res, 404, { error: 'No such reseller' });
    if (rm[2] === 'log' && req.method === 'GET') return send(res, 200, { log: (store.creditLog || []).filter((e) => e.reseller === r.id).slice(0, 200) });
    let body = {};
    if (req.method !== 'GET') { try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); } }
    if (!rm[2] && req.method === 'PUT') {
      if (body.name !== undefined) { const n = cleanText(body.name, 60); if (!n) return send(res, 400, { error: 'Give the reseller a name.' }); r.name = n; }
      if (body.contact !== undefined) r.contact = cleanText(body.contact, 100);
      if (Array.isArray(body.plans)) r.plans = body.plans.filter((id) => (store.plans || []).some((p) => p.id === id));
      if (body.status === 'active' || body.status === 'suspended') r.status = body.status;
      saveStore();
      return send(res, 200, { ok: true, reseller: publicReseller(r) });
    }
    if (rm[2] === 'credits' && req.method === 'POST') {
      const amount = body.amount === undefined || body.amount === null || body.amount === '' ? NaN : Number(body.amount);
      if (!Number.isInteger(amount) || amount < 0 || amount > 100000) return send(res, 400, { error: 'The credits must be a whole number from 0 up.' });
      const mode = body.mode === 'remove' ? 'remove' : body.mode === 'set' ? 'set' : 'add';
      const next = mode === 'add' ? r.credits + amount : mode === 'remove' ? Math.max(0, r.credits - amount) : amount;
      const delta = next - r.credits;
      if (!delta) return send(res, 200, { ok: true, reseller: publicReseller(r) });
      creditEntry(r, delta, body.why || 'Credit change', auditBy);
      saveStore();
      log('Credits for', r.name, (delta > 0 ? '+' : '') + delta, '-> now', r.credits);
      return send(res, 200, { ok: true, reseller: publicReseller(r) });
    }
    if (rm[2] === 'password' && req.method === 'POST') {
      const password = body.password ? String(body.password) : genPassword();
      if (password.length < 6 || password.length > 64) return send(res, 400, { error: 'The password must be 6 to 64 characters.' });
      try {
        await emby('POST', `/Users/${r.userId}/Password`, { body: { Id: r.userId, ResetPassword: true } });
        await emby('POST', `/Users/${r.userId}/Password`, { body: { Id: r.userId, CurrentPw: '', NewPw: password } });
      } catch (e) { return send(res, 502, { error: 'Could not change the password: ' + e.message }); }
      return send(res, 200, { ok: true, password });
    }
  }

  if (url.pathname === '/maintenance' && req.method === 'PUT') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const tabs = {};
    for (const k of MAINT_KEYS) if (body.tabs && body.tabs[k]) tabs[k] = true;
    store.maintenance = { tabs, message: cleanText(body.message, 240), back: cleanText(body.back, 60), at: Date.now(), by: auditBy };
    saveStore();
    log('Maintenance mode:', Object.keys(tabs).join(', ') || 'off');
    return send(res, 200, { ok: true, ...maintenancePublic() });
  }
  // The message at the top of every customer's Status page ("Maintenance tonight 2-3 AM"). Empty clears it.
  if (url.pathname === '/status-note' && req.method === 'PUT') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    store.statusNote = text ? { text, at: Date.now() } : null;
    saveStore();
    return send(res, 200, { ok: true, note: store.statusNote });
  }

  // Sports (admin): what the feed is doing, which leagues are on, and the name aliases.
  if (url.pathname === '/sports/status' && req.method === 'GET') {
    const c = sportsCfg();
    return send(res, 200, {
      enabled: c.enabled, configEnabled: cfg.scoresEnabled !== false, provider: 'ESPN public scoreboard (unofficial)', base: cfg.scoresBase, aliases: c.aliases,
      leagues: Object.entries(SPORTS_LEAGUES).map(([key, L]) => { const r = sportsState.leagues[key]; return { key, name: L.name, group: L.group, on: c.leagues.includes(key), ok: r ? r.ok : null, error: r ? r.error : '', games: r ? r.games.length : 0, live: r ? r.games.filter((g) => g.state === 'in').length : 0, at: r && r.at ? new Date(r.at).toISOString() : null }; }),
    });
  }
  if (url.pathname === '/sports/settings' && req.method === 'PUT') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    store.sports = { ...(store.sports || {}), enabled: body.enabled !== false, leagues: (Array.isArray(body.leagues) ? body.leagues : SPORTS_DEFAULT_LEAGUES).filter((k) => SPORTS_LEAGUES[k]) };
    saveStore();
    pollSports(false).catch(() => {});
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/sports/aliases' && req.method === 'PUT') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const list = (Array.isArray(body.aliases) ? body.aliases : []).map((a) => ({ from: String((a && a.from) || '').trim().slice(0, 40), to: String((a && a.to) || '').trim().slice(0, 40) })).filter((a) => a.from && a.to).slice(0, 200);
    store.sports = { ...(store.sports || {}), aliases: list };
    saveStore();
    return send(res, 200, { ok: true, aliases: list });
  }
  if (url.pathname === '/sports/refresh' && req.method === 'POST') { await pollSports(true); return send(res, 200, { ok: true }); }

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
      server = https.createServer({ pfx: cert.pfx, passphrase: cfg.pfxPassphrase || undefined, connectionsCheckingInterval: 5000 }, handler);
    }
  } else {
    if (!isLocalHost() && !cfg.allowInsecureHttp) {
      console.error('No certificate configured. Admin tokens must not travel over plain http on the internet: set "pfxPath" (the same .pfx certificate Emby uses for https), or "host": "127.0.0.1" for local testing.');
      process.exit(1);
    }
    server = http.createServer({ connectionsCheckingInterval: 5000 }, handler);
  }
  if (server) {
    // Close connections that start a request and never finish it (a slow or broken client must not hold a socket for minutes).
    server.headersTimeout = 15000; server.requestTimeout = 120000; server.keepAliveTimeout = 5000; server.maxHeadersCount = 60;
    server.on('clientError', (e, socket) => { try { socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); } catch { /* already closed */ } });
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
  setTimeout(() => pollSports(false).catch((e) => log('Sports scores failed:', e.message)), 4000);
  setInterval(() => pollSports(false).catch((e) => log('Sports scores failed:', e.message)), 15000);
}

// node aurora-guard.js --test-alert: sends one test message to alertWebhookUrl and says whether it arrived.
async function testAlert() {
  if (!cfg.alertWebhookUrl) { console.log('No "alertWebhookUrl" is set in config.json, so there is nowhere to send an alert.'); process.exit(1); }
  const r = await postAlert('Aurora Guard: test alert', `This is a test from ${os.hostname()} (guard ${VERSION}). If you can read it, alerts work.`, false);
  console.log(r.ok ? `OK: the webhook accepted it (${r.status}).` : `FAILED: ${r.status ? 'the webhook answered ' + r.status : r.error}`);
  process.exit(r.ok ? 0 : 1);
}

// A bug in one timer or request must never stop the service for everyone: log it and carry on.
process.on('uncaughtException', (e) => { try { log('UNEXPECTED ERROR (carrying on):', (e && e.stack) || e); } catch { /* nothing more to do */ } });
process.on('unhandledRejection', (e) => { try { log('UNEXPECTED ERROR in the background (carrying on):', (e && e.stack) || e); } catch { /* nothing more to do */ } });

// Usage and sharing are saved every 5 minutes; save once more when the service is stopped.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { saveStore(); } catch {} process.exit(0); });

if (require.main === module) { if (process.argv.includes('--check')) selfCheck(); else if (process.argv.includes('--test-alert')) testAlert(); else if (process.argv.includes('--test-scores')) testScores(); else start(); }
module.exports = { enforce, isExpired, activeByUser, normalizeSportsEvent };
