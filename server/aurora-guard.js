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
const dns = require('dns');
const net = require('net');

// ---------- Keep-alive (guard 1.17.0) ----------
// Run as `node aurora-guard.js`, this process only watches over the real Guard (a child of itself). That lets the Guard restart
// itself after an update, and start again by itself if it ever crashes, whatever the Windows task or Linux service does.
// Anything else (--check, --test-alert, a copy started with AURORA_GUARD_SUPERVISE=0) runs the Guard directly.
const SUPERVISED_CHILD = process.env.AURORA_GUARD_CHILD === '1';
if (require.main === module && !SUPERVISED_CHILD && process.env.AURORA_GUARD_SUPERVISE !== '0' && !process.argv.slice(2).some((a) => /^--(check|test-)/.test(a))) {
  const { fork } = require('child_process');
  let child = null, stopping = false, starts = [];
  const note = (m) => console.log(`${new Date().toISOString()} ${m}`);
  const launch = () => {
    child = fork(__filename, process.argv.slice(2), { env: { ...process.env, AURORA_GUARD_CHILD: '1' }, stdio: 'inherit' });
    child.on('exit', (code) => {
      child = null;
      if (stopping) process.exit(0);
      if (code === 3) { note('Restarting the guard (an update or a restore).'); setTimeout(launch, 500); return; }
      starts = starts.filter((t) => Date.now() - t < 10 * 60000); starts.push(Date.now());
      if (starts.length > 8) { note(`The guard keeps stopping (last code ${code}). Giving up so the problem is easy to see: fix it, then start the guard again.`); process.exit(code || 1); }
      note(`The guard stopped (code ${code}). Starting it again in 5 seconds.`);
      setTimeout(launch, 5000);
    });
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopping = true; if (child) child.kill(sig); else process.exit(0); });
  launch();
  return; // nothing else in this file runs in the watching process
}
if (SUPERVISED_CHILD) {
  // If the watching process is gone (the task was stopped), don't carry on alone holding the port.
  const parent = process.ppid;
  setInterval(() => { try { process.kill(parent, 0); } catch { process.exit(0); } }, 5000).unref();
}

const VERSION = '1.42.0';
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
    // Set to true (and restart the guard) to remove a forgotten Reseller PIN. Then set it back to false.
    resetResellerPin: false,
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
    // SABnzbd downloader page (guard 1.42.0): the website's /sabnzbd/ page (administrators only) talks to your SABnzbd through the Guard, so the address
    // and the API key stay here and never reach a web page. Example: "sabnzbdUrl": "http://192.168.1.20:8080", "sabnzbdApiKey": "..." (SABnzbd -> Config -> General).
    sabnzbdUrl: '',
    sabnzbdApiKey: '',
    signupEnabled: false,
    signupTrialDays: 2,
    signupTrialConnections: 1,
    signupMaxPerDay: 30,      // most new accounts in one day, in total
    signupPerIpPerDay: 3,     // most from one internet address in one day
    // Updates (guard 1.17.0): the Guard looks for a newer version in the Aurora releases once a day and offers it in Admin -> Server.
    // It only ever installs one when an administrator taps Update. "updateCheck": false switches the looking off.
    updateCheck: true,
    updateRepo: 'johnny4091-allstar/johnny4091-allstar',
    // Daily summary (guard 1.18.0): one message each morning to the alert webhook about the day before. On whenever alertWebhookUrl is set;
    // "dailySummary": false turns it off. The hour is the PC's local time. "dailySummaryMoney": false leaves the plans-sold amount out.
    dailySummary: true,
    dailySummaryHour: 8,
    dailySummaryMoney: true,
    updateApi: 'https://api.github.com',
    // Sports scores (Live TV -> Sports): ESPN's public scoreboard feed. It is not an official, documented API and ESPN can change or
    // stop it at any time. Set "scoresEnabled": false to switch it off, or "scoresBase" to point at another server with the same shape.
    scoresEnabled: true,
    scoresBase: 'https://site.api.espn.com',
    defaultLimit: 2,
    dryRun: false,
    // Where to send alerts (Discord webhook, ntfy.sh topic, or any web address that takes JSON). Blank = no alerts.
    alertWebhookUrl: '',
    alertFormat: 'auto', // auto | discord | ntfy | json | telegram
    // Requests (Seerr, guard 1.24.0): every customer added by the admin, a reseller or a sub-reseller is imported into Seerr so they can use
    // Requests at once. Needs Seerr's API key (Seerr -> Settings -> General -> API Key). requestsUrl is optional: blank uses the address
    // set in Admin -> Requests, or aurora-config.json. Blank key = this is switched off.
    requestsUrl: '',
    requestsApiKey: '',
    dataDir: path.join(DIR, 'data'),
    ...raw,
  };
  cfg.alertWebhookUrl = String(cfg.alertWebhookUrl || '').trim();
  cfg.requestsUrl = String(cfg.requestsUrl || '').trim().replace(/\/+$/, '');
  cfg.requestsApiKey = String(cfg.requestsApiKey || '').trim();
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
  try { console.log(line); } catch { /* nowhere to print (the window is gone): the log file below still gets it */ }
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
  if (['discord', 'ntfy', 'json', 'telegram'].includes(f)) return f;
  try {
    const u = new URL(cfg.alertWebhookUrl);
    if (/(^|\.)discord(app)?\.com$/i.test(u.hostname) && /\/api\/webhooks\//.test(u.pathname)) return 'discord';
    if (/(^|\.)ntfy(\.|$)/i.test(u.hostname)) return 'ntfy';
    if (u.hostname === 'api.telegram.org' && /^\/bot[^/]+\/sendMessage$/.test(u.pathname)) return 'telegram';
  } catch { /* fall through */ }
  return 'json';
}
// Resolves {ok, status, error}. Never rejects, never takes longer than 10 s.
function postAlert(title, text, urgent, embed) {
  return new Promise((resolve) => {
    let settled = false, req = null, deadline = null;
    const done = (r) => { if (settled) return; settled = true; clearTimeout(deadline); try { req && req.destroy(); } catch {} resolve(r); };
    try {
      if (!cfg.alertWebhookUrl) return done({ ok: false, status: 0, error: 'no alertWebhookUrl is set' });
      const target = new URL(cfg.alertWebhookUrl), fmt = alertFormat();
      const headers = { 'User-Agent': `AuroraGuard/${VERSION}` };
      let body;
      if (fmt === 'discord' && embed) {
        body = JSON.stringify({ username: 'Aurora Guard', embeds: [embed] });
        headers['Content-Type'] = 'application/json';
      } else if (fmt === 'discord') {
        body = JSON.stringify({ username: 'Aurora Guard', content: `**${title}**\n${text}`.slice(0, 1900) });
        headers['Content-Type'] = 'application/json';
      } else if (fmt === 'telegram') {
        // https://api.telegram.org/bot<TOKEN>/sendMessage?chat_id=<ID>
        body = JSON.stringify({ chat_id: target.searchParams.get('chat_id') || '', text: `${title}\n${text}`.slice(0, 4000), disable_web_page_preview: true });
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
// ---------- Reseller PIN (guard 1.34.0) ----------
// A 4-digit PIN in front of Admin -> Resellers, Users and the credit requests, so another administrator you add can't open them.
// It is tied to each administrator's own sign-in (their Emby token), is asked again after 30 quiet minutes, and 5 wrong tries lock it for 15 minutes.
if (cfg.resetResellerPin && store.resellerPin) { delete store.resellerPin; saveStore(); log('The Reseller PIN was removed (resetResellerPin is on in config.json: set it back to false).'); }
const PIN_IDLE_MS = 30 * 60000, pinUnlocked = new Map(), pinTries = new Map();
const tokenKey = (token) => crypto.createHash('sha256').update(String(token || '')).digest('hex').slice(0, 32);
function pinHash(pin, salt) { return crypto.scryptSync(String(pin), salt, 32).toString('hex'); }
function pinIsUnlocked(token) {
  if (!store.resellerPin) return true;
  const k = tokenKey(token), until = pinUnlocked.get(k);
  if (!until || until < Date.now()) { pinUnlocked.delete(k); return false; }
  pinUnlocked.set(k, Date.now() + PIN_IDLE_MS); // each use keeps it open
  return true;
}
// Checks a PIN with the try limit: 5 wrong tries per sign-in, 10 per internet address and 30 in all, then 15 minutes of waiting
// (signing in again gives a new token, so the address and the overall count matter too). Returns { ok } or { error, wait, wrong }.
function pinCheck(token, pin, ip) {
  const now = Date.now(), keys = [[tokenKey(token), 5], ['ip:' + String(ip || ''), 10], ['all', 30]];
  for (const [k] of keys) { const t = pinTries.get(k); if (t && t.until > now) return { error: `Too many wrong tries. Wait ${Math.ceil((t.until - now) / 60000)} minute${Math.ceil((t.until - now) / 60000) === 1 ? '' : 's'}.`, wait: true }; }
  const rec = store.resellerPin;
  let good = false;
  if (rec && /^\d{4}$/.test(String(pin))) { try { good = crypto.timingSafeEqual(Buffer.from(pinHash(pin, rec.salt), 'hex'), Buffer.from(rec.hash, 'hex')); } catch { good = false; } }
  if (good) { pinTries.delete(tokenKey(token)); return { ok: true }; }
  let lockedNow = false;
  for (const [k, max] of keys) {
    const t = pinTries.get(k) && pinTries.get(k).since > now - 3600000 ? pinTries.get(k) : { n: 0, until: 0, since: now };
    t.n++; if (t.n >= max) { t.until = now + 15 * 60000; t.n = 0; t.since = now; lockedNow = true; }
    pinTries.set(k, t);
  }
  if (pinTries.size > 500) pinTries.delete(pinTries.keys().next().value);
  return { error: lockedNow ? 'Too many wrong tries. Wait 15 minutes.' : 'That PIN is not right.', wrong: true };
}
const PIN_LOCKED_PATH = /^\/(resellers(\/|$)|credit-requests(\/|$)|limits(\/|$)|vod\/all$|remind-default$)/; // Resellers, credit requests, and the Users tab's data

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
// Sub-resellers (guard 1.21.0): a reseller can bring on resellers of their own (one level: a sub-reseller can't add more). The credits they
// get are moved out of the reseller's own balance. A sub-reseller sells only the plans their reseller can still sell.
const subsOf = (r) => Object.values(resellerList()).filter((x) => x.parent === r.id);
const resellerPlanIds = (r) => {
  const own = r.plans || [];
  const up = r.parent ? resellerList()[r.parent] : null;
  return up ? own.filter((id) => (up.plans || []).includes(id)) : own;
};
const MAX_SUBS = 50;
const supportCount = new Map();
const speedCount = new Map();
const cleanUserName = (v) => { const t = String(v || '').trim(); return /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/.test(t) ? t : null; };
const cleanText = (v, n) => String(v || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
function creditEntry(r, delta, why, by, extra) {
  const before = r.credits;
  r.credits = Math.max(0, r.credits + delta);
  const e = { id: crypto.randomBytes(5).toString('hex'), reseller: r.id, at: Date.now(), by: cleanText(by, 40), delta, balance: r.credits, why: cleanText(why, 80), ...(extra || {}) };
  store.creditLog = [e, ...(store.creditLog || [])].slice(0, 3000);
  // Crossing down into "low" tells the reseller once (not on every sale after that).
  if (delta < 0 && before > cfg.resellerLowCredits && r.credits <= cfg.resellerLowCredits) {
    notifyReseller(r, 'lowCredits', 'Aurora: your credits are running low', `You have ${r.credits} credit${r.credits === 1 ? '' : 's'} left. Ask for more before your next sale.`, true);
  }
  return e;
}

// ----- Reseller notifications (guard 1.22.0): Telegram, Discord, ntfy or any web address, chosen by the reseller. -----
// The reseller's token or link is a secret: it is stored here, never sent back to the panel in full, and never written to the log.
// Because a reseller types the address, the guard only talks to the real services (Discord, Telegram, ntfy.sh) or to a public
// https address: anything that points inside a private network is refused, also at the moment of sending (so a name that
// changes its answer later can not get through).
function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::' || l === '::1') return true;
    if (l.startsWith('::ffff:')) { const v4 = l.slice(7); return net.isIPv4(v4) ? isPrivateAddress(v4) : true; }
    return /^f[cd]/.test(l) || /^fe[89ab]/.test(l) || l.startsWith('ff');
  }
  return true;
}
function safeLookup(hostname, options, cb) {
  dns.lookup(hostname, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) return cb(new Error('that address points inside a private network, which is not allowed'));
    if (options && options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}
const NOTIFY_TYPES = ['telegram', 'discord', 'ntfy', 'webhook'];
const NOTIFY_EVENTS = { extension: true, lowCredits: true, ending: false };
const maskTail = (v, n = 4) => (v ? '\u2022\u2022\u2022\u2022' + String(v).slice(-n) : '');
// Checks what a reseller entered and returns where to send: {url, make(title, text, urgent) -> {headers, body}} or {error}.
function notifyTarget(n) {
  if (!n || !NOTIFY_TYPES.includes(n.type)) return { error: 'Choose where to send the alerts.' };
  const title1 = (t) => String(t).replace(/[^\x20-\x7e]/g, '');
  if (n.type === 'telegram') {
    const token = String(n.token || '').trim(), chat = String(n.chat || '').trim();
    if (!/^\d{5,12}:[A-Za-z0-9_-]{30,50}$/.test(token)) return { error: 'That does not look like a Telegram bot token. It looks like 123456789:AAH... (ask @BotFather).' };
    if (!/^(-?\d{5,20}|@[A-Za-z0-9_]{4,32})$/.test(chat)) return { error: 'The chat ID is a number such as 123456789 or -1001234567890 (or @channelname).' };
    return { url: `https://api.telegram.org/bot${token}/sendMessage`, make: (title, text) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chat, text: `${title}\n${text}`.slice(0, 4000), disable_web_page_preview: true }) }) };
  }
  if (n.type === 'discord') {
    let u;
    try { u = new URL(String(n.url || '').trim()); } catch { return { error: 'Paste the whole Discord webhook link.' }; }
    if (u.protocol !== 'https:' || !/^(?:(?:canary|ptb)\.)?discord(?:app)?\.com$/i.test(u.hostname) || !/^\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/.test(u.pathname)) return { error: 'That is not a Discord webhook link. It starts with https://discord.com/api/webhooks/' };
    return { url: u.origin + u.pathname, make: (title, text) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Aurora', content: `**${title}**\n${text}`.slice(0, 1900) }) }) };
  }
  if (n.type === 'ntfy') {
    const topic = String(n.topic || '').trim();
    if (!/^[A-Za-z0-9_-]{4,64}$/.test(topic)) return { error: 'The ntfy topic is 4 to 64 letters, numbers, dashes or underscores. Make it hard to guess.' };
    return { url: `https://ntfy.sh/${topic}`, make: (title, text, urgent) => ({ headers: { 'Content-Type': 'text/plain; charset=utf-8', Title: title1(title), Priority: urgent ? 'high' : 'default', Tags: urgent ? 'warning' : 'bell' }, body: text }) };
  }
  let u;
  try { u = new URL(String(n.url || '').trim()); } catch { return { error: 'Paste the web address (https://...) that should receive the alerts.' }; }
  if (u.protocol !== 'https:' || u.username || u.password || (u.port && u.port !== '443')) return { error: 'The address must start with https:// and use the normal port.' };
  if (net.isIP(u.hostname.replace(/^\[|\]$/g, '')) && isPrivateAddress(u.hostname.replace(/^\[|\]$/g, ''))) return { error: 'That address is not allowed.' };
  return { url: u.toString(), make: (title, text, urgent) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, text: `${title}\n${text}`, content: `**${title}**\n${text}`, message: text, urgent: !!urgent, time: new Date().toISOString() }) }) };
}
// Sends one message; resolves {ok, status, error}. Never rejects, never longer than 10 s, never follows a redirect.
function notifyPost(target, title, text, urgent) {
  return new Promise((resolve) => {
    let settled = false, req = null, deadline = null;
    const done = (r) => { if (settled) return; settled = true; clearTimeout(deadline); try { req && req.destroy(); } catch {} resolve(r); };
    try {
      const u = new URL(target.url), m = target.make(title, text, urgent);
      const headers = { 'User-Agent': `AuroraGuard/${VERSION}`, ...m.headers, 'Content-Length': Buffer.byteLength(m.body) };
      deadline = setTimeout(() => done({ ok: false, status: 0, error: 'timed out' }), 10000);
      // For the tests only: with AURORA_TEST_NOTIFY_SINK set (an address on this machine) the message goes there instead of the real service.
      if (process.env.AURORA_TEST_NOTIFY_SINK) {
        const sink = new URL(process.env.AURORA_TEST_NOTIFY_SINK), payload = JSON.stringify({ url: target.url, headers: m.headers, body: m.body });
        req = http.request(sink, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } }, (r) => { r.resume(); r.on('end', () => done({ ok: r.statusCode < 300, status: r.statusCode, error: '' })); });
        req.on('error', (e) => done({ ok: false, status: 0, error: e.message }));
        return void req.end(payload);
      }
      req = https.request(u, { method: 'POST', headers, timeout: 8000, lookup: safeLookup }, (r) => {
        let seen = '';
        r.on('data', (c) => { if (seen.length < 1000) seen += c.toString('utf8'); });
        r.on('end', () => {
          let error = '';
          if (r.statusCode >= 300) {
            try { error = JSON.parse(seen).description || ''; } catch { /* not JSON */ }
            if (!error) error = `it answered ${r.statusCode}`;
          }
          done({ ok: r.statusCode >= 200 && r.statusCode < 300, status: r.statusCode, error });
        });
        r.on('error', (e) => done({ ok: false, status: 0, error: e.message }));
      });
      req.on('timeout', () => done({ ok: false, status: 0, error: 'timed out' }));
      req.on('error', (e) => done({ ok: false, status: 0, error: e.message }));
      req.end(m.body);
    } catch (e) { done({ ok: false, status: 0, error: String((e && e.message) || e) }); }
  });
}
function friendlyNotifyError(type, out) {
  const why = out.error || (out.status ? `it answered ${out.status}` : 'it did not answer');
  if (type === 'telegram') {
    if (out.status === 401 || out.status === 404) return 'Telegram refused that bot token. Copy it again from @BotFather.';
    if (out.status === 400 || out.status === 403) return `Telegram could not send to that chat (${why}). Add the bot to the chat, send it a message first, and check the chat ID.`;
  }
  if (type === 'discord' && (out.status === 404 || out.status === 401)) return 'Discord says that webhook does not exist any more. Make a new one in the channel settings.';
  return `The message was not delivered (${why}).`;
}
const notifyWindow = new Map();
// Tells a reseller something, if they set a place for it and want that kind of message. Fire and forget; at most 30 an hour each.
function notifyReseller(r, event, title, text, urgent) {
  try {
    const n = r && r.notify;
    if (!n || !n.type || !(n.events ? n.events[event] : NOTIFY_EVENTS[event])) return;
    const target = notifyTarget(n);
    if (target.error) return;
    const now = Date.now(), list = (notifyWindow.get(r.id) || []).filter((t) => now - t < 3600000);
    if (list.length >= 30) return;
    list.push(now); notifyWindow.set(r.id, list);
    notifyPost(target, title, text, urgent).then((x) => { if (!x.ok) log(`Alert for the reseller ${r.name} NOT delivered (${n.type}):`, x.error || x.status); }).catch(() => {});
  } catch { /* an alert must never get in the way */ }
}
// What the panel may see of a reseller's setting: never the secret itself.
function notifyPublic(r) {
  const n = r.notify;
  if (!n || !n.type) return { type: '', events: { ...NOTIFY_EVENTS }, endingDays: cleanDays(n && n.endingDays, 4) || [3] };
  let hint = '';
  if (n.type === 'telegram') hint = `Bot ${maskTail(String(n.token || '').split(':')[0], 3)}:${maskTail(String(n.token || '').split(':')[1] || '')} \u00b7 chat ${n.chat || ''}`;
  else if (n.type === 'discord') { try { hint = 'Discord webhook ' + maskTail(new URL(n.url).pathname.split('/').pop(), 4); } catch { hint = 'Discord webhook'; } }
  else if (n.type === 'ntfy') hint = `ntfy topic ${n.topic}`;
  else { try { hint = 'Webhook at ' + new URL(n.url).host; } catch { hint = 'Webhook'; } }
  return { type: n.type, hint, events: { ...NOTIFY_EVENTS, ...(n.events || {}) }, endingDays: cleanDays(n.endingDays, 4) || [3] };
}
// A reseller's customers whose access ends in three days, once a day after 9 AM, to the resellers who asked for it.
async function endingTick() {
  const now = new Date();
  if (now.getHours() < 9) return;
  const today = localDay(now);
  let changed = false;
  for (const r of Object.values(resellerList())) {
    if (r.status !== 'active' || !r.notify || !r.notify.events || !r.notify.events.ending || r.endingDay === today) continue;
    r.endingDay = today; changed = true;
    for (const n of (cleanDays(r.notify.endingDays, 4) || [3]).slice().sort((x, y) => x - y)) {
    const list = Object.values(store.users).filter((u) => u.reseller === r.id && u.expires === addDays(today, n) && !u.hold);
    const when = n === 1 ? 'tomorrow' : `in ${n} days`;
    if (list.length) notifyReseller(r, 'ending', `Aurora: ${list.length} ${list.length === 1 ? 'customer ends' : 'customers end'} ${when}`, list.slice(0, 15).map((u) => `- ${(u.contact && u.contact.full) || u.name} (${u.name})`).join('\n') + (list.length > 15 ? `\n...and ${list.length - 15} more` : '') + '\nRenew them in your reseller panel.');
    }
  }
  if (changed) saveStore();
}

// ----- Reminder days (guard 1.26.0) -----
// How many days before the end date a customer is reminded in the app. Each account may have its own list; others use the default
// the admin set, else 7, 3 and 1.
const REMIND_FALLBACK = [7, 3, 1];
function cleanDays(v, max = 5) {
  if (!Array.isArray(v)) return null;
  const out = [...new Set(v.map((x) => Math.round(Number(x))).filter((x) => x >= 1 && x <= 60))].sort((a, b) => b - a);
  return out.length && out.length <= max ? out : null;
}
const remindDefault = () => cleanDays(store.remindDefault) || REMIND_FALLBACK;
const remindDaysOf = (rec) => cleanDays(rec && rec.remind) || remindDefault();

function publicReseller(r) {
  const customers = Object.values(store.users).filter((u) => u.reseller === r.id).length;
  const up = r.parent ? resellerList()[r.parent] : null;
  return { id: r.id, name: r.name, userId: r.userId, userName: r.userName, contact: r.contact || '', credits: r.credits, status: r.status, plans: r.plans || [], customers, created: r.created, low: r.credits <= cfg.resellerLowCredits,
    parent: up ? up.id : '', parentName: up ? up.name : '', subs: subsOf(r).length };
}
// The contact details a reseller shows their own customers under Help (guard 1.33.0). A sub-reseller without any shows the one above them.
const phoneOk = (v) => /^[\d+\-() .]{3,30}$/.test(v);
function cleanSupport(b) {
  const out = { name: cleanText(b.name, 40), phone: cleanText(b.phone, 30), whatsapp: cleanText(b.whatsapp, 30), email: cleanText(b.email, 80), note: cleanText(b.note, 120) };
  if (out.phone && !phoneOk(out.phone)) return { error: 'The phone number can only have digits, spaces, + - ( ) and dots.' };
  if (out.whatsapp && !phoneOk(out.whatsapp)) return { error: 'The WhatsApp number can only have digits, spaces, + - ( ) and dots.' };
  if (out.email && !emailOk(out.email)) return { error: 'That email address does not look right.' };
  return Object.values(out).some(Boolean) ? { support: out } : { support: null };
}
function supportOfReseller(id) {
  const all = resellerList();
  for (let r = all[id], hops = 0; r && hops < 3; r = r.parent ? all[r.parent] : null, hops++) if (r.status === 'active' && r.support) return { ...r.support, from: r.name };
  return null;
}
function publicCustomer(id, rec, devices) {
  const c = rec.contact || {};
  return { id, name: rec.name, full: c.full || '', email: c.email || '', phone: c.phone || '', note: c.note || '', planId: rec.plan?.id || null, planName: rec.plan ? (rec.trial ? 'Free trial' : rec.plan.name) : '',
    trial: !!rec.trial, vod: !!rec.vod, adult: !!rec.adult, cats: Array.isArray(rec.categories) ? rec.categories.length : null, catsCustom: !!rec.catsCustom, packs: Array.isArray(rec.packs) ? rec.packs : [], hold: !!rec.hold, expires: rec.expires || null, daysLeft: rec.expires ? daysUntil(rec.expires) : null, expired: isExpired(rec), devices: devices ? devices.size : 0, created: rec.created || null,
    remind: cleanDays(rec.remind), remindDefault: remindDefault(),
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
  kickRequestsSync(); // a customer made here is imported into Seerr a few seconds later
  return u;
}
// ---------- Requests (Seerr) import (guard 1.24.0) ----------
// Seerr only lets people use Requests once they exist in it. Every Emby account is a customer whoever added it (the admin in the
// app, a reseller, a sub-reseller, a sign-up), so the guard looks for accounts Seerr doesn't have yet and imports them, a moment after a
// customer is made here and every couple of minutes for the ones made elsewhere. Reseller accounts (panel only) are left out. The API key
// is only ever sent to Seerr and is never written to the log.
function plainRequest(address, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let settled = false, req = null, timer = null;
    const done = (r) => { if (settled) return; settled = true; clearTimeout(timer); try { req && req.destroy(); } catch {} resolve(r); };
    try {
      const u = new URL(address);
      const data = body === undefined ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      const h = { 'User-Agent': `AuroraGuard/${VERSION}`, Accept: 'application/json', ...headers };
      if (data) { h['Content-Type'] = h['Content-Type'] || 'application/json'; h['Content-Length'] = data.length; }
      timer = setTimeout(() => done({ status: 0, text: '', error: 'timed out' }), timeoutMs);
      req = (u.protocol === 'https:' ? https : http).request(u, { method, headers: h, timeout: timeoutMs - 1000 }, (r) => {
        const chunks = []; let size = 0;
        r.on('data', (c) => { size += c.length; if (size < 8 * 1024 * 1024) chunks.push(c); });
        r.on('end', () => done({ status: r.statusCode, text: Buffer.concat(chunks).toString('utf8'), error: '' }));
        r.on('error', (e) => done({ status: 0, text: '', error: e.message }));
      });
      req.on('timeout', () => done({ status: 0, text: '', error: 'timed out' }));
      req.on('error', (e) => done({ status: 0, text: '', error: e.message }));
      req.end(data || undefined);
    } catch (e) { done({ status: 0, text: '', error: String((e && e.message) || e) }); }
  });
}
let requestsRemote = { at: 0, url: '' };
// Where Seerr is: config.json, else the address the admin set in the app (Admin -> Requests), else aurora-config.json in the repo.
async function requestsBaseUrl() {
  if (cfg.requestsUrl && /^https?:\/\//i.test(cfg.requestsUrl)) return cfg.requestsUrl;
  try {
    const users = await emby('GET', '/Users');
    const admin = (users || []).find((u) => u.Policy && u.Policy.IsAdministrator);
    if (admin) {
      const prefs = await emby('GET', '/DisplayPreferences/aurora-requests', { query: { userId: admin.Id, client: 'aurora' } });
      const c = prefs && prefs.CustomPrefs && prefs.CustomPrefs.config ? JSON.parse(prefs.CustomPrefs.config) : null;
      if (c && /^https?:\/\//i.test(c.server || '')) return String(c.server).replace(/\/+$/, '');
    }
  } catch { /* try the next place */ }
  if (Date.now() - requestsRemote.at < 10 * 60000) return requestsRemote.url;
  requestsRemote = { at: Date.now(), url: '' };
  const r = await plainRequest(`https://raw.githubusercontent.com/${cfg.updateRepo}/main/aurora-config.json`, { timeoutMs: 9000 });
  try { const c = JSON.parse(r.text); if (/^https?:\/\//i.test(c.requestsServer || '')) requestsRemote.url = String(c.requestsServer).replace(/\/+$/, ''); } catch { /* none */ }
  return requestsRemote.url;
}
const seerrCall = (base, method, apiPath, body) => plainRequest(base + '/api/v1' + apiPath, { method, headers: { 'X-Api-Key': cfg.requestsApiKey }, body });
const requestsState = () => store.requestsSync || (store.requestsSync = { done: {}, failed: {}, last: null });
let requestsRunning = false, requestsKickTimer = null;
function kickRequestsSync() {
  if (!cfg.requestsApiKey) return;
  clearTimeout(requestsKickTimer);
  requestsKickTimer = setTimeout(() => syncRequestsUsers().catch(() => {}), 4000);
  if (requestsKickTimer.unref) requestsKickTimer.unref();
}
// Imports the customers Seerr doesn't have yet. Resolves {ok, error, imported, already, failed, pending}. Never throws.
async function syncRequestsUsers(opts = {}) {
  const st = requestsState();
  const finish = (r) => { st.last = { at: Date.now(), ...r }; try { saveStore(); } catch { /* next time */ } return { ...st.last }; };
  if (!cfg.requestsApiKey) return { ok: false, error: 'No "requestsApiKey" in config.json yet, so nothing is imported.', pending: 0 };
  if (requestsRunning) return { ok: false, busy: true, error: 'An import is already running.' };
  requestsRunning = true;
  try {
    const base = await requestsBaseUrl();
    if (!base) return finish({ ok: false, error: 'The guard does not know where Seerr is. Set "requestsUrl" in config.json, or the address in Admin -> Requests.', imported: 0, already: 0, failed: 0, pending: 0 });
    const users = (await emby('GET', '/Users')) || [];
    const wanted = users.filter((u) => !(u.Policy && u.Policy.IsDisabled) && !resellerOfUser(u.Id));
    const retryAfter = opts.force ? 0 : 3600000;
    const todo = wanted.filter((u) => !st.done[u.Id] && !(st.failed[u.Id] && Date.now() - st.failed[u.Id].at < retryAfter));
    if (!todo.length) return finish({ ok: true, error: '', imported: 0, already: 0, failed: Object.keys(st.failed).filter((id) => wanted.some((u) => u.Id === id)).length, pending: 0 });
    // Who Seerr already has.
    const have = new Set();
    for (let skip = 0; skip < 5000; skip += 100) {
      const r = await seerrCall(base, 'GET', `/user?take=100&skip=${skip}`);
      if (r.status === 401 || r.status === 403) return finish({ ok: false, error: 'Seerr refused the API key. Copy it again from Seerr -> Settings -> General.', imported: 0, already: 0, failed: 0, pending: todo.length });
      if (r.status < 200 || r.status >= 300) return finish({ ok: false, error: r.error ? `Could not reach Seerr (${r.error}).` : `Seerr answered ${r.status}.`, imported: 0, already: 0, failed: 0, pending: todo.length });
      let page = [];
      try { page = JSON.parse(r.text).results || []; } catch { /* none */ }
      for (const x of page) if (x.jellyfinUserId) have.add(String(x.jellyfinUserId));
      if (page.length < 100) break;
    }
    let already = 0, imported = 0, failed = 0;
    const need = [];
    for (const u of todo) { if (have.has(u.Id)) { st.done[u.Id] = Date.now(); delete st.failed[u.Id]; already++; } else need.push(u); }
    const importIds = async (list) => {
      const r = await seerrCall(base, 'POST', '/user/import-from-jellyfin', { jellyfinUserIds: list.map((u) => u.Id) });
      if (r.status >= 200 && r.status < 300) { for (const u of list) { st.done[u.Id] = Date.now(); delete st.failed[u.Id]; } imported += list.length; return true; }
      if (list.length === 1) { st.failed[list[0].Id] = { at: Date.now(), error: (r.error || `Seerr answered ${r.status}`).slice(0, 120) }; failed++; return false; }
      for (const u of list) await importIds([u]); // find the one it cannot import
      return false;
    };
    for (let i = 0; i < need.length; i += 20) await importIds(need.slice(i, i + 20));
    if (imported) log('Requests: imported', imported, imported === 1 ? 'customer' : 'customers', 'into Seerr' + (failed ? `, ${failed} failed (will retry)` : ''));
    return finish({ ok: failed === 0, error: failed ? `${failed} could not be imported (Seerr said no). They are tried again in an hour.` : '', imported, already, failed, pending: 0 });
  } catch (e) {
    return finish({ ok: false, error: String((e && e.message) || e).slice(0, 160), imported: 0, already: 0, failed: 0, pending: 0 });
  } finally { requestsRunning = false; }
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
    else {
      // The smallest reminder day that covers today (e.g. with 10, 5 and 2: 8 days left is the 10-day reminder, 4 days the 5-day one).
      const days = remindDaysOf(rec).slice().sort((x, y) => x - y), n = days.find((x) => d <= x) || 0;
      if (n) items.push({ id: `plan:${rec.expires}:${n}`, type: 'plan', level: n <= 3 ? 'warn' : 'info', title: d <= 1 ? 'Your plan ends today or tomorrow' : `Your plan ends in ${d} days`, text: `${rec.plan?.name ? rec.plan.name + ' \u00b7 ' : ''}ends ${rec.expires}`, at: end - n * 86400000, action: 'renew' });
    }
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

// Checks an Emby username and password from a request body. Resolves { r } (Emby's answer) or { error, status } to send back as it is.
async function embyLoginFor(req, ip) {
  if (tooManyFailures(ip)) return { status: 429, error: 'Too many failed attempts. Try again in a few minutes.' };
  let body;
  try { body = await readBody(req); } catch (e) { return { status: 400, error: e.message }; }
  const name = String(body.username || '').trim().slice(0, 64), pw = String(body.password || '').slice(0, 128);
  if (!name || !pw) return { status: 400, error: 'Enter your username and password.' };
  let r;
  try { r = await emby('POST', '/Users/AuthenticateByName', { body: { Username: name, Pw: pw } }); } catch (e) {
    if (e.status === 401 || e.status === 400 || e.status === 403 || e.status === 404) { noteFailure(ip); return { status: 401, error: 'That username or password is not right.' }; }
    return { status: 502, error: `Can't reach Emby: ${e.message}` };
  }
  if (!r?.AccessToken || !r.User?.Id) { noteFailure(ip); return { status: 401, error: 'That username or password is not right.' }; }
  return { r };
}
// One sign-up at a time: its limits (per address, per day, code uses, email, username) are read and then updated around slow calls to Emby,
// so without this many requests sent at once would all pass the checks.
let signupChain = Promise.resolve();
const serialSignup = (fn) => { const run = signupChain.then(fn, fn); signupChain = run.catch(() => {}); return run; };

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
// A request from a reseller's customer goes to that reseller. It comes to the admin only when there is no reseller, or the reseller is suspended.
const needsAdmin = (x) => !x.reseller || !resellerList()[x.reseller] || resellerList()[x.reseller].status !== 'active';
function publicRequest(r) {
  return r && { id: r.id, status: r.status, at: r.at, note: r.note, decidedAt: r.decidedAt || null, days: r.days || null, message: r.message || '', newExpires: r.newExpires || null,
    wantedPlan: r.wantedPlanName || null, to: r.reseller && resellerList()[r.reseller] ? 'reseller' : 'admin' };
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
  return { plan: { id, name, price, length, unit, connections, categories, credits, vod: b.vod === true, active: b.active !== false } };
}
// Puts a plan on an account. mode "extend": time already left is kept and the plan's length added after it; "today": starts now.
function applyPlan(userId, userName, plan, mode, priceOverride) {
  const today = localDay(new Date());
  const rec = store.users[userId] || (store.users[userId] = { limit: plan.connections, expires: null, name: userName, updated: Date.now() });
  const from = mode === 'extend' && rec.expires && rec.expires > today ? rec.expires : today;
  rec.limit = plan.connections;
  rec.expires = addPlanLength(from, plan);
  if (!rec.catsCustom) rec.categories = plan.categories ? [...plan.categories] : null; // a reseller's own choice of categories stays through renewals
  if (plan.price > 0) rec.trial = false; // a paid plan ends a free trial
  if (plan.vod) rec.vod = true; // a plan that includes the provider's movies and TV switches it on (a plan without it leaves a switch you set by hand alone)
  rec.name = userName; rec.updated = Date.now();
  let price = priceOverride !== undefined && priceOverride !== null && priceOverride !== '' && Number.isFinite(Number(priceOverride)) ? Math.max(0, Math.round(Number(priceOverride) * 100) / 100) : plan.price;
  // A discount code the customer entered when signing up takes effect on their first paid plan it works on.
  const dc = rec.discount;
  if ((priceOverride === undefined || priceOverride === null || priceOverride === '') && plan.price > 0 && dc && !dc.usedAt && (!dc.planIds || !dc.planIds.length || dc.planIds.includes(plan.id))) {
    price = discountedPrice(plan.price, dc); dc.usedAt = today; dc.paid = price;
    recordAudit('Discount', `${userName}: code ${dc.code} (${discountLabel(dc)}) applied to ${plan.name}: $${plan.price} became $${price}`);
  }
  rec.plan = { id: plan.id, name: plan.name, price, connections: plan.connections, length: plan.length, unit: plan.unit, categories: plan.categories ? [...plan.categories] : null, since: today }; // the plan's own categories, even when a reseller chose others
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
    if (e.status !== 401 && e.status !== 403) throw e; // Emby unreachable or erroring (5xx): can't tell, so the request fails rather than passing
  }
  adminCache.set(key, { ok, until: Date.now() + 60000 });
  if (adminCache.size > 500) adminCache.delete(adminCache.keys().next().value);
  return ok;
}

// ---------- Channels (guard 1.28.0) ----------
// Your own channels and fixes, kept here and added to the provider's list in every app (like the channel manager in an IPTV panel):
//   cats:  your own categories            { id, name, adult }
//   items: your own channels              { id, cat, name, url, logo, num, epgId, on }
//   edits: fixes to the provider's channels, by key (x<stream id>, or n:<name> for a playlist): { name, logo, num, epgId, url, hidden }
// Anything an admin or moderator changes bumps "v", so apps pick it up within a few minutes.
const CHAN_LIMITS = { cats: 80, items: 4000, edits: 4000 };
const chanStore = () => { if (!store.channels) store.channels = { v: 1, cats: [], items: [], edits: {} }; return store.channels; };
const chanText = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
function chanUrl(v) {
  const t = String(v == null ? '' : v).trim();
  if (!t || t.length > 600 || /\s/.test(t)) return '';
  try { const u = new URL(t); return u.protocol === 'http:' || u.protocol === 'https:' ? t : ''; } catch { return ''; }
}
const chanKeyOk = (k) => typeof k === 'string' && k.length >= 2 && k.length <= 160 && !/[\u0000-\u001f]/.test(k);
const chanNum = (v) => { const t = chanText(v, 8); return /^\d{0,6}$/.test(t) ? t : ''; };
function chanItemFrom(b, old) {
  const o = old || {};
  const pick = (k, f) => (b[k] !== undefined ? f(b[k]) : o[k] || '');
  const item = { id: o.id, cat: o.cat, name: pick('name', (v) => chanText(v, 80)), url: pick('url', chanUrl), logo: pick('logo', (v) => { const t = chanUrl(v); return t; }), num: pick('num', chanNum), epgId: pick('epgId', (v) => chanText(v, 80)), on: b.on !== undefined ? b.on !== false : o.on !== false };
  if (Array.isArray(o.backups) && o.backups.length) item.backups = o.backups; // editing a channel keeps its backups
  return item;
}
const chanBump = () => { const c = chanStore(); c.v = (c.v || 1) + 1; };
// Backups: other stream addresses for the same channel, tried in order when the first one stops working. A backup picked from one of your other
// providers carries that provider's login in its address, so the editor views (admins and moderators) show only its label.
const CHAN_MAX_BACKUPS = 3;
const backupsStripped = (e) => (Array.isArray(e.backups) ? { ...e, backups: e.backups.map((b) => ({ label: b.label || '', ...(b.src ? { src: b.src } : { url: b.url }) })) } : e);
const backupsOf = (x) => (Array.isArray(x && x.backups) ? x.backups : []);
const backupView = (b, all) => (all ? (b.src ? { label: b.label || '', src: b.src } : { label: b.label || '', url: b.url }) : { label: b.label || '', url: b.url });
function chanPublic(all) {
  const c = chanStore();
  const cats = c.cats.map((x) => ({ id: x.id, name: x.name, adult: !!x.adult }));
  const items = (all ? c.items : c.items.filter((i) => i.on !== false)).map((i) => ({ id: i.id, cat: i.cat, name: i.name, url: i.url, logo: i.logo, num: i.num, epgId: i.epgId, on: i.on !== false, backups: backupsOf(i).map((b) => backupView(b, all)) }));
  const edits = {};
  for (const [k, e] of Object.entries(c.edits || {})) edits[k] = Array.isArray(e.backups) ? { ...e, backups: e.backups.map((b) => backupView(b, all)) } : e;
  return { v: c.v || 1, cats, items, edits };
}
// The provider's channels for the fix list on the website: read here, with the Live TV settings an administrator saved, and cached for 10 minutes.
// Only names, numbers, groups and pictures go out (never the provider's address or login).
const providerCache = new Map(); // src -> { key, at, list }
const provWithScheme = (a) => (/^https?:\/\//i.test(a) ? a : 'http://' + a).replace(/\/+$/, '');
// The Live TV settings the administrator saved in the app (the main provider).
async function mainProviderConfig() {
  const users = (await emby('GET', '/Users')) || [];
  const admin = users.find((u) => u.Policy && u.Policy.IsAdministrator);
  if (!admin) throw new Error('No administrator account was found.');
  let prefs;
  try { prefs = await emby('GET', '/DisplayPreferences/aurora-livetv', { query: { userId: admin.Id, client: 'aurora' } }); } catch { prefs = null; }
  let c = null;
  try { c = JSON.parse(prefs && prefs.CustomPrefs && prefs.CustomPrefs.config || 'null'); } catch { c = null; }
  if (!c || !c.type) throw new Error('Live TV is not set up yet (Admin -> Live TV).');
  return c;
}
// Reads one provider's live channels. Each channel: { key, name, num, group, logo, url } (url is for the guard only and never leaves it for the editors).
async function readProviderList(c) {
  const headers = c.userAgent ? { 'User-Agent': String(c.userAgent) } : {};
  let list = [];
  if (c.type === 'm3u') {
    const r = await plainRequest(provWithScheme(String(c.m3uUrl || '')), { headers, timeoutMs: 60000 });
    if (r.status !== 200 || !/#EXT/.test(String(r.text || '').slice(0, 5000))) throw new Error("The provider's playlist did not answer.");
    let name = '', logo = '', group = '', num = '', have = false;
    const attr = (line, k) => { const m = line.match(new RegExp(k + '="([^"]*)"', 'i')); return m ? m[1] : ''; };
    for (const raw of String(r.text).split(/\r?\n/)) {
      const line = raw.trim();
      if (line.startsWith('#EXTINF')) {
        logo = attr(line, 'tvg-logo'); group = attr(line, 'group-title'); num = attr(line, 'tvg-chno');
        let q = false, cut = -1; for (let i = 0; i < line.length; i++) { if (line[i] === '"') q = !q; else if (line[i] === ',' && !q) { cut = i; break; } }
        name = (cut >= 0 ? line.slice(cut + 1) : '').trim() || attr(line, 'tvg-name'); have = true;
      } else if (line && !line.startsWith('#') && have) { list.push({ key: 'n:' + name, name: name || 'Channel', num, group: group || 'Channels', logo, url: line }); have = false; }
    }
  } else {
    const root = provWithScheme(String(c.server || ''));
    const base = root + '/player_api.php?username=' + encodeURIComponent(c.username || '') + '&password=' + encodeURIComponent(c.password || '');
    const [st, cats] = await Promise.all([plainRequest(base + '&action=get_live_streams', { headers, timeoutMs: 60000 }), plainRequest(base + '&action=get_live_categories', { headers, timeoutMs: 30000 })]);
    let streams, cl;
    try { streams = JSON.parse(st.text); cl = JSON.parse(cats.text); } catch { streams = null; }
    if (!Array.isArray(streams)) throw new Error('The provider did not accept the login.');
    const names = new Map((Array.isArray(cl) ? cl : []).map((x) => [String(x.category_id), String(x.category_name || '')]));
    list = streams.map((x) => ({ key: 'x' + x.stream_id, cat: String(x.category_id == null ? '' : x.category_id), name: String(x.name || 'Channel'), num: x.num != null ? String(x.num) : '', group: names.get(String(x.category_id)) || '', logo: String(x.stream_icon || ''),
      url: `${root}/live/${encodeURIComponent(c.username || '')}/${encodeURIComponent(c.password || '')}/${x.stream_id}.m3u8` }));
  }
  return list;
}
// Live TV categories a reseller can give a customer (guard 1.40.0). Only for an Xtream provider (the apps filter by its category numbers).
// Categories marked adult are left out: those stay behind the adult switch.
const ADULT_CAT_NAME = /(adult(?!\s*swim)|xxx|18\s*\+|\+\s*18|porn|erotic|nsfw|hentai|playboy|\bsex\b|\bsexy\b)/i;
async function assignableCategories() {
  const c = await mainProviderConfig();
  if (c.type !== 'xtream') return { supported: false, categories: [] };
  const list = await providerChannels('main'), by = new Map();
  const explicit = Array.isArray(c.adultCats) ? new Set(c.adultCats.map(String)) : null;
  for (const ch of list) {
    if (!ch.cat) continue;
    const e = by.get(ch.cat) || { id: ch.cat, name: ch.group || 'Channels', count: 0 };
    e.count++; by.set(ch.cat, e);
  }
  const out = [...by.values()].filter((e) => !(explicit ? explicit.has(e.id) : ADULT_CAT_NAME.test(e.name)));
  out.sort((x, y) => x.name.localeCompare(y.name));
  return { supported: true, categories: out };
}
// Named packages (guard 1.41.0): an administrator groups Live TV categories under a name (Sports, Kids, 24/7). A reseller gives a customer
// one or more packages; the customer then sees the categories of those packages. Changing a package updates everyone who has it.
const packList = () => { if (!Array.isArray(store.packages)) store.packages = []; return store.packages; };
function syncPacks(rec) {
  const valid = (Array.isArray(rec.packs) ? rec.packs : []).filter((id) => packList().some((x) => x.id === id));
  rec.packs = valid;
  if (valid.length) {
    const set = new Set();
    for (const id of valid) for (const c of packList().find((x) => x.id === id).categories) set.add(c);
    rec.categories = [...set]; rec.catsCustom = true;
  } else if (rec.catsCustom && rec.packsOn) {
    rec.catsCustom = false; rec.categories = rec.plan && Array.isArray(rec.plan.categories) ? [...rec.plan.categories] : null;
  }
  rec.packsOn = valid.length > 0;
  rec.updated = Date.now();
}
function syncAllPacks() { for (const rec of Object.values(store.users)) if (rec.packsOn || (Array.isArray(rec.packs) && rec.packs.length)) syncPacks(rec); }
// SABnzbd (guard 1.42.0)
const sabBase = () => { const u = String(cfg.sabnzbdUrl || '').trim().replace(/\/+$/, ''); return /^https?:\/\/[^\s]+$/i.test(u) && cfg.sabnzbdApiKey ? u : ''; };
async function sabCall(params, opts = {}) {
  const qs = new URLSearchParams({ ...params, output: 'json', apikey: String(cfg.sabnzbdApiKey) });
  const r = await plainRequest(`${sabBase()}/api?${qs}`, { timeoutMs: 20000, ...opts });
  if (!r.status) throw new Error('Could not reach SABnzbd' + (r.error ? ` (${r.error.replace(String(cfg.sabnzbdApiKey), '***')})` : '') + '.');
  let j; try { j = JSON.parse(r.text); } catch { throw new Error('SABnzbd gave an answer Aurora could not read. Check the address.'); }
  if (j && j.error) throw new Error(/api key/i.test(String(j.error)) ? 'SABnzbd refused the API key. Check sabnzbdApiKey in config.json.' : 'SABnzbd said: ' + String(j.error).slice(0, 120));
  return j || {};
}
const backupProviders = () => { const c = chanStore(); if (!Array.isArray(c.providers)) c.providers = []; return c.providers; };
async function providerChannels(src = 'main') {
  let cfgOf, label;
  if (src === 'main') cfgOf = await mainProviderConfig();
  else { cfgOf = backupProviders().find((x) => x.id === src); if (!cfgOf) throw new Error('That provider is not set up.'); }
  label = src;
  const key = JSON.stringify([cfgOf.type, cfgOf.server, cfgOf.username, cfgOf.password, cfgOf.m3uUrl, cfgOf.v]);
  const hit = providerCache.get(label);
  if (hit && hit.key === key && Date.now() - hit.at < 600000) return hit.list;
  const list = await readProviderList(cfgOf);
  providerCache.set(label, { key, at: Date.now(), list });
  return list;
}

// Routes for admins and moderators (called after the sign-in check). Returns true when it answered.
async function chanRoutes(req, url, res, auditBy) {
  const p = url.pathname, m = req.method;
  if (!/^\/channels(?:\/|$)/.test(p)) return false;
  const c = chanStore();
  const readJson = async () => { try { return await readBody(req); } catch (e) { send(res, 400, { error: e.message }); return null; } };
  const done = (extra = {}) => { chanBump(); saveStore(); send(res, 200, { ok: true, v: c.v, ...extra }); return true; };
  if (p === '/channels/all' && m === 'GET') { send(res, 200, chanPublic(true)); return true; }
  if (p === '/channels/provider' && m === 'GET') {
    const q = chanText(url.searchParams.get('q'), 60).toLowerCase(), limit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit'), 10) || 40));
    const src = String(url.searchParams.get('src') || 'main');
    let list;
    try { list = await providerChannels(src); } catch (e) { send(res, 502, { error: e.message }); return true; }
    const hit = q ? list.filter((x) => x.name.toLowerCase().includes(q) || x.num === q || x.group.toLowerCase().includes(q)) : list;
    send(res, 200, { total: list.length, matches: hit.length, items: hit.slice(0, limit).map((x) => ({ key: x.key, name: x.name, num: x.num, group: x.group, logo: x.logo, edit: src === 'main' ? ((c.edits || {})['k' + x.key] ? backupsStripped((c.edits || {})['k' + x.key]) : null) : null })) });
    return true;
  }
  // The providers a backup can come from (names only): the main one, and the other providers the administrator added.
  if (p === '/channels/sources' && m === 'GET') {
    send(res, 200, { sources: [{ id: 'main', name: 'Main provider' }, ...backupProviders().map((x) => ({ id: x.id, name: x.name }))] });
    return true;
  }
  // Other providers (administrators only: they hold a login). Never returned with their password.
  if (p === '/channels/providers' && m === 'GET') {
    send(res, 200, { providers: backupProviders().map((x) => ({ id: x.id, name: x.name, type: x.type, host: (() => { try { return new URL(provWithScheme(x.type === 'm3u' ? x.m3uUrl : x.server)).host; } catch { return ''; } })(), username: x.username || '' })) });
    return true;
  }
  if (p === '/channels/providers' && m === 'POST') {
    const b = await readJson(); if (!b) return true;
    const type = b.type === 'm3u' ? 'm3u' : 'xtream';
    const rec = { id: crypto.randomBytes(5).toString('hex'), name: chanText(b.name, 40), type, server: chanText(b.server, 200), username: chanText(b.username, 80), password: String(b.password || '').slice(0, 120), m3uUrl: chanUrl(b.m3uUrl), userAgent: chanText(b.userAgent, 120), v: 1 };
    if (!rec.name) { send(res, 400, { error: 'Give the provider a name.' }); return true; }
    if (type === 'xtream' && (!rec.server || !rec.username)) { send(res, 400, { error: 'An Xtream provider needs a server address and a username.' }); return true; }
    if (type === 'm3u' && !rec.m3uUrl) { send(res, 400, { error: 'An M3U provider needs the playlist address (http or https).' }); return true; }
    if (type === 'xtream' && rec.server && /\s/.test(rec.server)) { send(res, 400, { error: 'The server address has spaces in it.' }); return true; }
    if (backupProviders().length >= 3) { send(res, 400, { error: 'Aurora keeps up to 3 other providers.' }); return true; }
    let list;
    try { list = await readProviderList(rec); } catch (e) { send(res, 400, { error: `Couldn't read that provider: ${e.message}` }); return true; }
    backupProviders().push(rec); providerCache.set(rec.id, { key: JSON.stringify([rec.type, rec.server, rec.username, rec.password, rec.m3uUrl, rec.v]), at: Date.now(), list });
    saveStore(); send(res, 200, { ok: true, id: rec.id, channels: list.length }); return true;
  }
  let pr;
  if ((pr = p.match(/^\/channels\/providers\/([0-9a-f]{10})$/)) && m === 'DELETE') {
    const id = pr[1];
    c.providers = backupProviders().filter((x) => x.id !== id); providerCache.delete(id);
    const drop = (x) => { if (Array.isArray(x.backups)) { x.backups = x.backups.filter((bk) => bk.src !== id); if (!x.backups.length) delete x.backups; } };
    c.items.forEach(drop);
    for (const k of Object.keys(c.edits || {})) { drop(c.edits[k]); if (!Object.keys(c.edits[k]).length) delete c.edits[k]; }
    return done();
  }
  // Add a backup stream to a channel of yours ({ item: id }) or to a provider channel ({ key: 'x101' }): a pasted link, or a channel found in another provider.
  if (p === '/channels/backup' && m === 'POST') {
    const b = await readJson(); if (!b) return true;
    let target;
    if (b.item) { target = c.items.find((x) => x.id === b.item); if (!target) { send(res, 404, { error: 'No such channel.' }); return true; } }
    else if (chanKeyOk(String(b.key || ''))) { if (!c.edits) c.edits = {}; target = c.edits['k' + b.key] || (c.edits['k' + b.key] = {}); }
    else { send(res, 400, { error: 'Pick a channel.' }); return true; }
    let rec;
    if (b.src && b.ref) {
      let list;
      try { list = await providerChannels(String(b.src)); } catch (e) { send(res, 502, { error: e.message }); return true; }
      const f = list.find((x) => x.key === String(b.ref));
      if (!f) { send(res, 404, { error: 'That channel is not in the provider any more.' }); return true; }
      const srcName = b.src === 'main' ? 'Main provider' : ((backupProviders().find((x) => x.id === b.src) || {}).name || 'Provider');
      rec = { label: chanText(`${srcName}: ${f.name}`, 90), url: f.url, src: String(b.src), ref: f.key };
    } else {
      const u = chanUrl(b.url);
      if (!u) { send(res, 400, { error: 'The backup address must start with http:// or https:// and have no spaces.' }); return true; }
      rec = { label: chanText(b.label, 90) || 'Backup link', url: u };
    }
    const list = Array.isArray(target.backups) ? target.backups : [];
    if (list.length >= CHAN_MAX_BACKUPS) { send(res, 400, { error: `A channel can have up to ${CHAN_MAX_BACKUPS} backups.` }); if (!Object.keys(target).length && b.key) delete c.edits['k' + b.key]; return true; }
    if (list.some((x) => x.url === rec.url)) { send(res, 409, { error: 'That backup is already there.' }); return true; }
    target.backups = [...list, rec];
    return done();
  }
  if (p === '/channels/backup' && m === 'DELETE') {
    const i = parseInt(url.searchParams.get('i'), 10);
    const item = url.searchParams.get('item'), key = url.searchParams.get('key');
    const target = item ? c.items.find((x) => x.id === item) : (chanKeyOk(String(key || '')) ? (c.edits || {})['k' + key] : null);
    if (!target || !Array.isArray(target.backups) || !(i >= 0 && i < target.backups.length)) { send(res, 404, { error: 'No such backup.' }); return true; }
    target.backups.splice(i, 1);
    if (!target.backups.length) delete target.backups;
    if (key && c.edits && !Object.keys(c.edits['k' + key] || {}).length) delete c.edits['k' + key];
    return done();
  }
  let r;
  if (p === '/channels/cats' && m === 'POST') {
    const b = await readJson(); if (!b) return true;
    const name = chanText(b.name, 60);
    if (!name) { send(res, 400, { error: 'Give the category a name.' }); return true; }
    if (c.cats.length >= CHAN_LIMITS.cats) { send(res, 400, { error: 'That is the most categories Aurora can keep.' }); return true; }
    if (c.cats.some((x) => x.name.toLowerCase() === name.toLowerCase())) { send(res, 409, { error: 'There is already a category with that name.' }); return true; }
    const cat = { id: crypto.randomBytes(5).toString('hex'), name, adult: b.adult === true };
    c.cats.push(cat); return done({ cat });
  }
  if ((r = p.match(/^\/channels\/cats\/([0-9a-f]{10})$/))) {
    const cat = c.cats.find((x) => x.id === r[1]);
    if (!cat) { send(res, 404, { error: 'No such category.' }); return true; }
    if (m === 'DELETE') { c.cats = c.cats.filter((x) => x.id !== cat.id); c.items = c.items.filter((i) => i.cat !== cat.id); return done(); }
    if (m === 'PUT') {
      const b = await readJson(); if (!b) return true;
      if (b.name !== undefined) { const name = chanText(b.name, 60); if (!name) { send(res, 400, { error: 'Give the category a name.' }); return true; } if (c.cats.some((x) => x !== cat && x.name.toLowerCase() === name.toLowerCase())) { send(res, 409, { error: 'There is already a category with that name.' }); return true; } cat.name = name; }
      if (b.adult !== undefined) cat.adult = b.adult === true;
      return done({ cat });
    }
  }
  if (p === '/channels/items' && m === 'POST') {
    const b = await readJson(); if (!b) return true;
    const cat = c.cats.find((x) => x.id === b.cat);
    if (!cat) { send(res, 400, { error: 'Pick a category first.' }); return true; }
    const item = chanItemFrom(b); item.id = crypto.randomBytes(5).toString('hex'); item.cat = cat.id;
    if (!item.name) { send(res, 400, { error: 'Give the channel a name.' }); return true; }
    if (!item.url) { send(res, 400, { error: 'The stream address must start with http:// or https:// and have no spaces.' }); return true; }
    if (c.items.length >= CHAN_LIMITS.items) { send(res, 400, { error: 'That is the most channels Aurora can keep.' }); return true; }
    c.items.push(item); return done({ item: { ...item, backups: undefined } });
  }
  if (p === '/channels/items/bulk' && m === 'POST') {
    const b = await readJson(); if (!b) return true;
    const cat = c.cats.find((x) => x.id === b.cat);
    if (!cat) { send(res, 400, { error: 'Pick a category first.' }); return true; }
    const list = (Array.isArray(b.items) ? b.items : []).slice(0, 1000);
    let added = 0, skipped = 0;
    for (const x of list) {
      const item = chanItemFrom(x || {}); item.id = crypto.randomBytes(5).toString('hex'); item.cat = cat.id;
      if (!item.name || !item.url || c.items.length >= CHAN_LIMITS.items) { skipped++; continue; }
      c.items.push(item); added++;
    }
    if (!added) { send(res, 400, { error: 'No usable channels found (each needs a name and an http(s) address).' }); return true; }
    return done({ added, skipped });
  }
  if ((r = p.match(/^\/channels\/items\/([0-9a-f]{10})$/))) {
    const i = c.items.findIndex((x) => x.id === r[1]);
    if (i < 0) { send(res, 404, { error: 'No such channel.' }); return true; }
    if (m === 'DELETE') { c.items.splice(i, 1); return done(); }
    if (m === 'PUT') {
      const b = await readJson(); if (!b) return true;
      const next = chanItemFrom(b, c.items[i]);
      if (b.cat !== undefined) { if (!c.cats.some((x) => x.id === b.cat)) { send(res, 400, { error: 'No such category.' }); return true; } next.cat = b.cat; }
      if (!next.name) { send(res, 400, { error: 'Give the channel a name.' }); return true; }
      if (!next.url) { send(res, 400, { error: 'The stream address must start with http:// or https:// and have no spaces.' }); return true; }
      c.items[i] = next; return done({ item: { ...next, backups: undefined } });
    }
  }
  if (p === '/channels/edit' && m === 'PUT') {
    const b = await readJson(); if (!b) return true;
    const key = String(b.key || '');
    if (!chanKeyOk(key)) { send(res, 400, { error: 'That channel cannot be edited.' }); return true; }
    const k = 'k' + key, old = (c.edits && c.edits[k]) || {};
    const e = { ...old };
    if (Array.isArray(old.backups)) e.backups = old.backups;
    if (b.name !== undefined) { const t = chanText(b.name, 80); if (t) e.name = t; else delete e.name; }
    if (b.logo !== undefined) { const t = chanUrl(b.logo); if (t) e.logo = t; else delete e.logo; }
    if (b.url !== undefined) { const t = chanUrl(b.url); if (t) e.url = t; else delete e.url; }
    if (b.num !== undefined) { const t = chanNum(b.num); if (t) e.num = t; else delete e.num; }
    if (b.epgId !== undefined) { const t = chanText(b.epgId, 80); if (t) e.epgId = t; else delete e.epgId; }
    if (b.hidden !== undefined) { if (b.hidden === true) e.hidden = true; else delete e.hidden; }
    if (!c.edits) c.edits = {};
    if (Object.keys(e).length) { if (!c.edits[k] && Object.keys(c.edits).length >= CHAN_LIMITS.edits) { send(res, 400, { error: 'That is the most fixes Aurora can keep.' }); return true; } c.edits[k] = e; } else delete c.edits[k];
    return done({ edit: c.edits[k] ? backupsStripped(c.edits[k]) : null });
  }
  if (p === '/channels/edit' && m === 'DELETE') {
    const key = String(url.searchParams.get('key') || '');
    if (!chanKeyOk(key)) { send(res, 400, { error: 'That channel cannot be edited.' }); return true; }
    if (c.edits) delete c.edits['k' + key];
    return done();
  }
  send(res, 404, { error: 'Not found' }); return true;
}

// ---------- Moderators (guard 1.27.0) ----------
// A moderator is an ordinary (not Emby administrator) account the admin flagged in Admin -> Users. The guard lets it use only the routes
// listed here: support and messages, content, and read-only monitoring. Nothing about users, resellers, credits, server health, updates,
// plans, the TV provider's login, or the audit log. Because the account is not an Emby administrator, Emby itself refuses everything else.
const MOD_ROUTES = [
  ['GET', /^\/admin-inbox$/],
  ['GET', /^\/support$/], ['GET|POST|PUT', /^\/support\/[\w-]{1,32}(?:\/reply)?$/],
  ['GET|POST', /^\/announcements$/], ['DELETE', /^\/announcements\/[\w-]{1,32}$/], ['GET', /^\/plans$/],
  ['GET', /^\/requests-sync$/],
  ['GET', /^\/reports$/],
  ['GET', /^\/usage$/],
  ['GET', /^\/sharing$/], ['DELETE', /^\/sharing\/[\w-]{1,64}$/],
  ['GET', /^\/sports\/(?:status|aliases)$/], ['PUT', /^\/sports\/(?:settings|aliases)$/], ['POST', /^\/sports\/refresh$/],
  ['POST', /^\/audit$/],
  ['GET|POST', /^\/mod\/emby$/],
  ['GET|POST|PUT|DELETE', /^\/channels\/(?:all|provider|sources|backup|cats|cats\/[0-9a-f]{10}|items|items\/bulk|items\/[0-9a-f]{10}|edit)$/],
];
const modAllowed = (method, pathname) => MOD_ROUTES.some(([m, re]) => m.split('|').includes(method) && re.test(pathname));
async function modOfToken(token, userId) {
  const me = await userOfToken(token, userId);
  if (!me || me.Policy?.IsAdministrator || me.Policy?.IsDisabled) return null;
  const rec = store.users[me.Id];
  return rec && rec.mod && !resellerOfUser(me.Id) ? me : null;
}
const maskIp = (ip) => { const t = String(ip || ''); const v4 = t.match(/^(\d+\.\d+)\.\d+\.\d+$/); return v4 ? v4[1] + '.x.x' : t ? t.slice(0, 4) + '…' : ''; };
// What a moderator may read or write in Emby, through the guard (never the server's settings, users' details or devices).
const MOD_EMBY_PREFS = /^aurora-(?:feedback|problems|playlog)$/;
async function modEmby(req, url, res, body) {
  const path = String(url.searchParams.get('path') || '');
  const userId = String(url.searchParams.get('target') || '');
  let m;
  if (req.method === 'GET' && path === '/Users') {
    const list = (await emby('GET', '/Users')) || [];
    return send(res, 200, (Array.isArray(list) ? list : []).filter((u) => !(u.Policy && u.Policy.IsAdministrator)).map((u) => ({ Id: u.Id, Name: u.Name, Policy: { IsDisabled: !!(u.Policy && u.Policy.IsDisabled) } })));
  }
  if ((m = path.match(/^\/DisplayPreferences\/([\w-]{1,40})$/)) && MOD_EMBY_PREFS.test(m[1]) && /^[\w-]{1,64}$/.test(userId)) {
    if (req.method === 'GET') return send(res, 200, await emby('GET', path, { query: { userId, client: 'aurora' } }));
    if (req.method === 'POST' && m[1] !== 'aurora-playlog') {
      const cfgText = body && body.CustomPrefs && typeof body.CustomPrefs.config === 'string' ? body.CustomPrefs.config : '';
      if (cfgText.length > 400000) return send(res, 400, { error: 'Too large' });
      const clean = { Id: m[1], Client: 'aurora', SortBy: 'SortName', SortOrder: 'Ascending', RememberIndexing: false, RememberSorting: false, ScrollDirection: 'Horizontal', ShowBackdrop: false, ShowSidebar: false,
        PrimaryImageHeight: 0, PrimaryImageWidth: 0, CustomPrefs: { config: cfgText } };
      await emby('POST', path, { query: { userId, client: 'aurora' }, body: clean });
      return send(res, 200, { ok: true });
    }
  }
  if (req.method === 'GET' && path === '/System/ActivityLog/Entries') {
    const start = Math.max(0, parseInt(url.searchParams.get('StartIndex'), 10) || 0), limit = Math.max(1, Math.min(200, parseInt(url.searchParams.get('Limit'), 10) || 100));
    const out = await emby('GET', path, { query: { StartIndex: start, Limit: limit } });
    return send(res, 200, { ...out, Items: ((out && out.Items) || []).map((e) => ({ ...e, Overview: undefined })) });
  }
  if (req.method === 'GET' && path === '/Sessions') {
    const list = (await emby('GET', '/Sessions')) || [];
    return send(res, 200, list.map((x) => ({ ...x, RemoteEndPoint: maskIp(x.RemoteEndPoint) })));
  }
  return send(res, 403, { error: "That isn't available to moderators." });
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

// How a customer's viewing has gone for the last 7 days, next to everyone else's (guard 1.32.0; resellers see their own customers').
async function qualityReport(userId) {
  const sum = (q, from) => {
    const t = { live: { min: 0, stalls: 0, starts: 0, startMs: 0, startMax: 0, slow: 0, failed: 0 }, vod: { min: 0, stalls: 0, stallSec: 0 } };
    for (const [day, d] of Object.entries((q && q.days) || {})) {
      if (day < from) continue;
      for (const k of Object.keys(t.live)) t.live[k] = k === 'startMax' ? Math.max(t.live[k], d.live[k] || 0) : t.live[k] + (d.live[k] || 0);
      for (const k of Object.keys(t.vod)) t.vod[k] += d.vod[k] || 0;
    }
    return t;
  };
  const shape = (t) => ({
    live: { minutes: t.live.min, stalls: t.live.stalls, stallsPerHour: t.live.min >= 5 ? round2(t.live.stalls / (t.live.min / 60)) : null, starts: t.live.starts, avgStartSec: t.live.starts ? round2(t.live.startMs / t.live.starts / 1000) : null, slowStarts: t.live.slow, failed: t.live.failed },
    vod: { minutes: t.vod.min, stalls: t.vod.stalls, bufferingPct: t.vod.min >= 5 ? round2(t.vod.stallSec / (t.vod.min * 60) * 100) : null } });
  const from = dayKey(Date.now() - 6 * 86400000), all = store.quality || {};
  const mine = all[userId], me7 = sum(mine, from), everyone = sum({ days: Object.values(all).reduce((acc, u) => { for (const [day, d] of Object.entries(u.days || {})) { const a = acc[day] || (acc[day] = { live: { min: 0, stalls: 0, starts: 0, startMs: 0, startMax: 0, slow: 0, failed: 0 }, vod: { min: 0, stalls: 0, stallSec: 0 } }); for (const k of Object.keys(a.live)) a.live[k] = k === 'startMax' ? Math.max(a.live[k], d.live[k] || 0) : a.live[k] + (d.live[k] || 0); for (const k of Object.keys(a.vod)) a.vod[k] += d.vod[k] || 0; } return acc; }, {}) }, from);
  const s = shape(me7), ev = shape(everyone), last = (mine && mine.last) || {};
  // Plain words for what to try, from the numbers.
  const hints = [];
  if (s.live.failed > 0) hints.push("Some channels stopped working for them: that points at the TV provider, not at their device or internet.");
  if (s.live.stallsPerHour != null && s.live.stallsPerHour >= 2) {
    if (last.buffer && last.buffer !== 'large') hints.push('They buffer a lot on live channels with the buffer on ' + last.buffer + '. Ask them to set Settings → Playback → Live TV buffer → Large.');
    if (last.kbps && last.kbps < 4000) hints.push('Their stream speed is low (' + (last.kbps / 1000).toFixed(1) + ' Mbit/s). Their internet or Wi-Fi is the likely cause: try a cable or sit closer to the router.');
    else if (ev.live.stallsPerHour != null && ev.live.stallsPerHour < s.live.stallsPerHour / 2) hints.push('Most customers buffer much less than this one, so look at their device, Wi-Fi or router first.');
    else hints.push('Everyone buffers about this much: the TV provider is probably struggling at busy times.');
  }
  if (s.live.avgStartSec != null && s.live.avgStartSec > 8) hints.push('Channels take a long time to start for them (' + s.live.avgStartSec + ' s on average).');
  if (s.vod.bufferingPct != null && s.vod.bufferingPct >= 3) hints.push('Movies and shows buffer (' + s.vod.bufferingPct + '% of the time). Their internet may be too slow for the quality chosen.');
  const days = Object.entries((mine && mine.days) || {}).sort((a, b) => (a[0] < b[0] ? 1 : -1)).map(([day, d]) => ({ day, liveMin: d.live.min, stalls: d.live.stalls, starts: d.live.starts, avgStartSec: d.live.starts ? round2(d.live.startMs / d.live.starts / 1000) : null, vodMin: d.vod.min, vodStalls: d.vod.stalls }));
  let device = '';
  try { const ss = activeByUser(await sessionsShared()).get(userId); if (ss) device = [...ss.values()].sort((a, b) => b.at - a.at).map((x) => `${x.name} (${x.client})`)[0] || ''; } catch { /* Emby didn't answer: no device shown */ }

  return { reported: !!mine && Object.keys(mine.days || {}).length > 0, since: from, you: s, everyone: ev, last: { at: last.at || 0, app: last.app || '', buffer: last.buffer || '', kbps: last.kbps || 0, device }, hints, days };
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
  if (p === '/channels/cats' && m === 'POST') return `Added the channel category ${chanText(b.name, 60)}`;
  if ((r = p.match(/^\/channels\/cats\/[0-9a-f]{10}$/))) return m === 'DELETE' ? 'Deleted a channel category and its channels' : 'Changed a channel category';
  if (p === '/channels/items' && m === 'POST') return `Added the channel ${chanText(b.name, 60)}`;
  if (p === '/channels/items/bulk' && m === 'POST') return `Imported ${(Array.isArray(b.items) ? b.items.length : 0)} channels from a playlist`;
  if ((r = p.match(/^\/channels\/items\/[0-9a-f]{10}$/))) return m === 'DELETE' ? 'Deleted a channel' : `Changed the channel ${chanText(b.name, 60)}`.trim();
  if (p === '/channels/backup') return m === 'DELETE' ? 'Removed a backup stream from a channel' : `Added a backup stream to a channel${b.src ? ' from another provider' : ''}`;
  if (p === '/channels/providers' && m === 'POST') return `Added the backup provider ${chanText(b.name, 40)}`;
  if (/^\/channels\/providers\//.test(p) && m === 'DELETE') return 'Removed a backup provider';
  if (p === '/channels/edit') return m === 'DELETE' ? 'Removed a fix on a provider channel' : (b.hidden === true ? 'Hid a provider channel' : b.hidden === false ? 'Showed a provider channel again' : `Fixed the provider channel ${chanText(b.name, 60)}`.trim());
  if (p === '/update/apply' || p === '/update/rollback' || p === '/update/check' || p === '/summary/send') return '';
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
  const dy = ((store.daily || (store.daily = {}))[dayKey(now)] ||= { peak: 0, live: 0 });
  if (playing > dy.peak) { dy.peak = playing; usageDirtyAt = now; }
  for (const k of Object.keys(store.daily).sort().slice(0, -62)) delete store.daily[k];
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
  const dl = ((store.daily || (store.daily = {}))[dayKey()] ||= { peak: 0, live: 0 });
  if (n > dl.live) { dl.live = n; changed = true; }
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
// Team and league pictures come from ESPN's own image servers only: nothing else is ever passed on to the apps.
function logoUrl(v) {
  try { const u = new URL(String(v || '')); return u.protocol === 'https:' && /(^|\.)espncdn\.com$/i.test(u.hostname) ? u.toString().slice(0, 200) : ''; } catch { return ''; }
}
const leagueLogoOf = (data) => { try { const l = data.leagues && data.leagues[0]; const lg = (l.logos || []).find((x) => x && x.href && !/dark/i.test((x.rel || []).join(' '))) || (l.logos || [])[0]; return logoUrl(lg && lg.href); } catch { return ''; } };
function normalizeSportsEvent(ev, key, lgLogo) {
  const L = SPORTS_LEAGUES[key], comp = (ev.competitions && ev.competitions[0]) || {};
  const cs = Array.isArray(comp.competitors) ? comp.competitors : [];
  const side = (c) => c && {
    id: String((c.team && c.team.id) || c.id || ''),
    name: String((c.team && c.team.displayName) || (c.athlete && c.athlete.displayName) || '').slice(0, 60),
    short: String((c.team && c.team.shortDisplayName) || (c.athlete && c.athlete.shortName) || (c.team && c.team.name) || '').slice(0, 40),
    abbr: String((c.team && c.team.abbreviation) || '').slice(0, 6),
    color: hex6(c.team && c.team.color),
    logo: logoUrl((c.team && c.team.logo) || (c.athlete && c.athlete.flag && c.athlete.flag.href)),
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
    id: key + ':' + String(ev.id || ''), league: key, leagueName: L.name, group: L.group, sport: String(L.path).split('/')[0], lgLogo: lgLogo || '',
    venue: String((comp.venue && comp.venue.fullName) || '').slice(0, 60),
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
    const lgLogo = leagueLogoOf(data);
    rec.games = (Array.isArray(data.events) ? data.events : []).map((ev) => normalizeSportsEvent(ev, key, lgLogo)).filter((g) => g.start);
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
// When the games over the next days start (just times, sport and league), so the day chips can show how many games each day has.
// One call per league for the whole range, kept 15 minutes.
async function sportsStartsLoad(fromStr, days) {
  const c = sportsCfg(), now = Date.now();
  const hit = sportsExtra.starts && sportsExtra.starts[fromStr + ':' + days];
  if (hit && now - hit.at < 15 * 60000) return hit.list;
  const d0 = new Date(Date.UTC(+fromStr.slice(0, 4), +fromStr.slice(4, 6) - 1, +fromStr.slice(6, 8)));
  const d1 = new Date(d0.getTime() + (days - 1) * 86400000);
  const ymd = (d) => `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
  const keys = c.leagues.slice(), out = [];
  const work = async () => {
    while (keys.length) {
      const key = keys.shift(), L = SPORTS_LEAGUES[key];
      try {
        const data = await getJson(`${sportsBase()}/apis/site/v2/sports/${L.path}/scoreboard?dates=${ymd(d0)}-${ymd(d1)}&limit=400`);
        for (const ev of Array.isArray(data.events) ? data.events : []) { const t = Date.parse(ev.date); if (t) out.push([t, String(L.path).split('/')[0], key]); }
      } catch { /* that league has nothing for these days */ }
    }
  };
  await Promise.all([work(), work(), work(), work()]);
  out.sort((a, b) => a[0] - b[0]);
  sportsExtra.starts = sportsExtra.starts || {};
  sportsExtra.starts[fromStr + ':' + days] = { at: now, list: out };
  const old = Object.keys(sportsExtra.starts); if (old.length > 6) delete sportsExtra.starts[old[0]];
  return out;
}
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
        const lgLogo = leagueLogoOf(data);
        for (const ev of Array.isArray(data.events) ? data.events : []) { const g = normalizeSportsEvent(ev, key, lgLogo); if (g.start) out.push(g); }
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

// ---------- Updating the guard (guard 1.17.0) ----------
// Each Aurora release carries aurora-guard.js and aurora-guard.json ({ version, sha256, size }). The guard looks once a day (and when an
// administrator asks), and installs a newer one only when an administrator taps Update in Admin -> Server:
//   download -> compare with the published checksum -> trial start (--check) -> keep a copy of this version -> replace -> restart.
// If any step fails nothing is changed. "Go back" puts the kept copy back. Only https downloads from GitHub's own hosts are used.
const UPDATE_API = String(cfg.updateApi || 'https://api.github.com').replace(/\/+$/, '');
const SCRIPT_FILE = __filename;
const BACKUP_DIR = path.join(DIR, 'backups');
const UPDATE_STEPS = ['Downloading the update', 'Checking it matches the published checksum', 'Testing it starts on this PC', 'Keeping a copy of the current version', 'Restarting'];
let updateInfo = { checkedAt: 0, latest: '', notes: [], tag: '', jsonUrl: '', fileUrl: '', sha256: '', size: 0, error: '' };
let updateRun = { busy: false, kind: '', step: -1, error: '', finishedAt: 0 };
const versionParts = (v) => String(v).split('.').map((n) => parseInt(n, 10) || 0);
function versionGreater(a, b) { const x = versionParts(a), y = versionParts(b); for (let i = 0; i < Math.max(x.length, y.length); i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; }
const testApiHost = (() => { try { const u = new URL(UPDATE_API); return u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname) ? u.host : ''; } catch { return ''; } })();
function downloadAllowed(u) {
  if (u.protocol === 'https:' && (u.hostname === 'api.github.com' || u.hostname === 'github.com' || u.hostname.endsWith('.githubusercontent.com'))) return true;
  return !!testApiHost && u.host === testApiHost; // a copy of GitHub on this PC, only when the config says so (for testing)
}
// GET with a size limit, following up to four redirects, only to allowed hosts. Resolves a Buffer.
function fetchUpdateBytes(address, max, depth = 0) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(address); } catch { return reject(new Error('The update address is not valid.')); }
    if (!downloadAllowed(u)) return reject(new Error(`Updates are only taken from GitHub (not ${u.hostname}).`));
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.get(u, { headers: { 'User-Agent': `AuroraGuard/${VERSION}`, Accept: 'application/octet-stream, application/json' }, timeout: 20000 }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (depth >= 4) return reject(new Error('Too many redirects.'));
        return fetchUpdateBytes(new URL(res.headers.location, u).toString(), max, depth + 1).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`GitHub answered ${res.statusCode}.`)); }
      const chunks = []; let size = 0;
      res.on('data', (c) => { size += c.length; if (size > max) { req.destroy(new Error('The download is larger than expected.')); } else chunks.push(c); });
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('GitHub did not answer in time.')));
    req.on('error', reject);
  });
}
async function checkForUpdate() {
  try {
    // GitHub lists releases by the date of the commit they were tagged on, not by version, so the newest guard is not always first:
    // read the small version file of every release that carries one and take the highest.
    const list = JSON.parse((await fetchUpdateBytes(`${UPDATE_API}/repos/${cfg.updateRepo}/releases?per_page=40`, 4 * 1024 * 1024)).toString('utf8'));
    const cands = (Array.isArray(list) ? list : []).filter((r) => r && !r.draft && (!r.prerelease || String(r.tag_name || '').startsWith('aurora-guard-v')) && (r.assets || []).some((a) => a.name === 'aurora-guard.json') && (r.assets || []).some((a) => a.name === 'aurora-guard.js')).slice(0, 15);
    if (!cands.length) throw new Error('No release carries a guard update yet.');
    let firstErr = null;
    const found = (await Promise.all(cands.map(async (r) => {
      try {
        const ja = r.assets.find((a) => a.name === 'aurora-guard.json'), fa = r.assets.find((a) => a.name === 'aurora-guard.js');
        const m = JSON.parse((await fetchUpdateBytes(ja.browser_download_url, 4096)).toString('utf8'));
        return /^\d+(\.\d+){1,3}$/.test(String(m.version)) ? { rel: r, jsonAsset: ja, fileAsset: fa, meta: m } : null;
      } catch (e) { firstErr = firstErr || e; return null; }
    }))).filter(Boolean);
    if (!found.length) throw new Error(firstErr ? firstErr.message : 'The release information could not be read.');
    const best = found.reduce((x, y) => (versionGreater(y.meta.version, x.meta.version) ? y : x));
    const { rel, jsonAsset, fileAsset, meta } = best;
    if (!/^\d+(\.\d+){1,3}$/.test(String(meta.version)) || !/^[0-9a-f]{64}$/.test(String(meta.sha256))) throw new Error('The release information is not valid.');
    updateInfo = { checkedAt: Date.now(), latest: String(meta.version), tag: rel.tag_name || '', jsonUrl: jsonAsset.browser_download_url, fileUrl: fileAsset.browser_download_url, sha256: String(meta.sha256), size: Number(meta.size) || 0,
      notes: String(rel.body || '').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('- ')).map((l) => l.slice(2).slice(0, 160)).slice(0, 8), error: '' };
    const seen = (store.update || {}).announced;
    if (versionGreater(updateInfo.latest, VERSION) && seen !== updateInfo.latest) {
      store.update = { ...(store.update || {}), announced: updateInfo.latest }; try { saveStore(); } catch { /* announced again next time */ }
      sendAlert('Aurora Guard: update available', `Version ${updateInfo.latest} is available (this one is ${VERSION}). Update it in Admin -> Server.`, false);
    }
  } catch (e) {
    updateInfo = { ...updateInfo, checkedAt: Date.now(), error: e.message };
  }
  return updateInfo;
}
function publicUpdate() {
  const backups = (() => { try { return fs.readdirSync(BACKUP_DIR).filter((f) => /^aurora-guard-[\d.]+\.js$/.test(f)).sort((a, b) => versionGreater(a.replace(/^aurora-guard-|\.js$/g, ''), b.replace(/^aurora-guard-|\.js$/g, '')) ? -1 : 1); } catch { return []; } })();
  // The record of the last update only counts while that update is what is running (a file replaced by hand makes it stale).
  const rec0 = (store.update || {}).lastApplied || null, last = rec0 && rec0.to === VERSION ? rec0 : null;
  return { current: VERSION, latest: updateInfo.latest || '', available: !!updateInfo.latest && versionGreater(updateInfo.latest, VERSION), notes: updateInfo.notes, checkedAt: updateInfo.checkedAt, error: updateInfo.error,
    enabled: cfg.updateCheck !== false, run: { ...updateRun, steps: UPDATE_STEPS }, lastApplied: last, canGoBack: !!(last && last.backup && backups.includes(last.backup)), platform: process.platform };
}
const restartGuard = () => setTimeout(() => { log('Restarting the guard.'); try { saveStore(); } catch { /* saved again after the restart */ } process.exit(3); }, 1500);
async function applyUpdate(by) {
  const stage = SCRIPT_FILE + '.new';
  const fail = (step, message) => { try { fs.unlinkSync(stage); } catch { /* not there */ } updateRun = { busy: false, kind: 'update', step, error: message, finishedAt: Date.now() }; log('Update refused:', message); sendAlert('Aurora Guard: update refused', `Version ${updateInfo.latest} was not installed (nothing was changed): ${message}`, true); };
  updateRun = { busy: true, kind: 'update', step: 0, error: '', finishedAt: 0 };
  try {
    // 1. download
    const bytes = await fetchUpdateBytes(updateInfo.fileUrl, 2 * 1024 * 1024);
    fs.writeFileSync(stage, bytes);
    // 2. checksum, size and the version the file says it is
    updateRun.step = 1;
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    if (sha !== updateInfo.sha256) return fail(1, 'the downloaded file does not match its published checksum.');
    if (updateInfo.size && bytes.length !== updateInfo.size) return fail(1, 'the downloaded file is not the size that was published.');
    const said = (/const VERSION = '([\d.]+)'/.exec(bytes.toString('utf8')) || [])[1];
    if (said !== updateInfo.latest) return fail(1, `the file says it is version ${said || 'unknown'}, not ${updateInfo.latest}.`);
    if (!versionGreater(said, VERSION)) return fail(1, `version ${said} is not newer than this one (${VERSION}).`);
    // 3. a trial start on this PC with this config: the certificate, the Emby key and the code itself all have to load
    updateRun.step = 2;
    const { spawnSync } = require('child_process');
    const trial = spawnSync(process.execPath, [...process.execArgv, stage, '--check'], { cwd: DIR, env: { ...process.env, AURORA_GUARD_CONFIG: CONFIG_FILE, AURORA_GUARD_SUPERVISE: '0' }, timeout: 40000, encoding: 'utf8' });
    if (trial.error || trial.status === null || trial.status === 1 || trial.status > 2) {
      const out = String((trial.stdout || '') + (trial.stderr || '')).split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join(' ');
      return fail(2, `the new version did not start properly on this PC (${trial.error ? trial.error.message : out || 'exit ' + trial.status}).`);
    }
    // 4. keep this version
    updateRun.step = 3;
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const backup = `aurora-guard-${VERSION}.js`;
    fs.copyFileSync(SCRIPT_FILE, path.join(BACKUP_DIR, backup));
    const old = fs.readdirSync(BACKUP_DIR).filter((f) => /^aurora-guard-[\d.]+\.js$/.test(f)).sort((a, b) => (versionGreater(a.replace(/^aurora-guard-|\.js$/g, ''), b.replace(/^aurora-guard-|\.js$/g, '')) ? -1 : 1));
    for (const f of old.slice(6)) { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch { /* keeps one more */ } }
    // 5. replace and restart
    updateRun.step = 4;
    fs.renameSync(stage, SCRIPT_FILE);
    store.update = { ...(store.update || {}), lastApplied: { from: VERSION, to: said, at: Date.now(), by: by || 'an admin', backup } };
    recordAudit(by || 'an admin', `Updated the guard from ${VERSION} to ${said}`);
    saveStore();
    log(`Updated the guard from ${VERSION} to ${said}; restarting.`);
    sendAlert('Aurora Guard: updated', `Updated from ${VERSION} to ${said} by ${by || 'an admin'}. The guard is restarting.`, false);
    updateRun = { busy: true, kind: 'update', step: 4, error: '', finishedAt: 0 };
    restartGuard();
  } catch (e) { fail(Math.max(0, updateRun.step), e.message); }
}
async function rollbackUpdate(by) {
  const rec0 = (store.update || {}).lastApplied, last = rec0 && rec0.to === VERSION ? rec0 : null;
  updateRun = { busy: true, kind: 'rollback', step: 0, error: '', finishedAt: 0 };
  try {
    const src = path.join(BACKUP_DIR, (last && last.backup) || '');
    if (!last || !last.backup || !fs.existsSync(src)) throw new Error('There is no earlier version to go back to.');
    const text = fs.readFileSync(src, 'utf8');
    const said = (/const VERSION = '([\d.]+)'/.exec(text) || [])[1];
    if (!said) throw new Error('The saved copy does not look right.');
    fs.writeFileSync(SCRIPT_FILE + '.new', text); fs.renameSync(SCRIPT_FILE + '.new', SCRIPT_FILE);
    store.update = { ...(store.update || {}), lastApplied: null, announced: '' };
    recordAudit(by || 'an admin', `Went back to guard version ${said}`);
    saveStore();
    log(`Went back to guard version ${said}; restarting.`);
    sendAlert('Aurora Guard: went back', `Went back to version ${said} (from ${VERSION}) by ${by || 'an admin'}. The guard is restarting.`, false);
    updateRun = { busy: true, kind: 'rollback', step: 4, error: '', finishedAt: 0 };
    restartGuard();
  } catch (e) { updateRun = { busy: false, kind: 'rollback', step: 0, error: e.message, finishedAt: Date.now() }; }
}

// ---------- Daily summary (guard 1.18.0) ----------
// One message each morning about the day before, to the same webhook the alerts use (a Discord embed, or plain text for other kinds).
// It is separate from the alerts' 12-an-hour limit. Built only from what the guard already keeps: usage, sign-ups, plans, actions, reports,
// the server checks and the waiting requests.
const plural = (n, one, many) => `${n} ${n === 1 ? one : many || one + 's'}`;
const summaryOn = () => cfg.dailySummary !== false && !!cfg.alertWebhookUrl;
const daysAway = (day) => Math.round((dayBounds(day)[0] - dayBounds(dayKey())[0]) / 86400000); // 0 = today, 1 = tomorrow
function dayBounds(day) { const [Y, M, D] = day.split('-').map(Number); return [new Date(Y, M - 1, D).getTime(), new Date(Y, M - 1, D + 1).getTime()]; }
function buildSummary(day) {
  const [t0, t1] = dayBounds(day), within = (t) => t >= t0 && t < t1;
  const prettyDay = new Date(t0).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const fields = [], attention = [];
  // Watching
  const use = (store.usage || {})[day] || {}, viewers = Object.values(use).filter((u) => u.min > 0);
  const minutes = viewers.reduce((n, u) => n + u.min, 0), titles = new Map();
  for (const u of viewers) for (const [t, m] of Object.entries(u.titles || {})) titles.set(t, (titles.get(t) || 0) + m);
  const top = [...titles.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, m], i) => `${i + 1}. ${t.replace(/^Live: ?(.*)$/, '$1 (Live)')} · ${(m / 60).toFixed(1)} h`);
  const peaks = (store.daily || {})[day] || {};
  if (viewers.length) {
    fields.push(['Watching', `${(minutes / 60).toFixed(1)} hours across ${plural(viewers.length, 'viewer')}\nMost at once: ${plural(Math.max(peaks.peak || 0, peaks.live || 0), 'stream')}${peaks.live ? ` (TV provider peak ${peaks.live}${connCfg().limit ? ` of ${connCfg().limit}` : ''})` : ''}`]);
    if (top.length) fields.push(['Most watched', top.join('\n')]);
  } else fields.push(['Watching', 'Nobody watched anything.']);
  // Customers
  const signups = (store.signups || []).filter((x) => x.day === day), withCode = signups.filter((x) => x.discount).length;
  const subs = (store.subscriptions || []).filter((x) => within(x.at)), money = Math.round(subs.reduce((n, x) => n + (Number(x.price) || 0), 0) * 100) / 100;
  const trials = Object.values(store.users).filter((u) => u.trial && u.created && within(u.created)).length;
  const acts = (store.actions || []).filter((a) => within(a.at)), signedOut = acts.filter((a) => a.type === 'signedOut').length, expired = acts.filter((a) => a.type === 'disabled').length;
  const cust = [];
  if (signups.length) cust.push(`${plural(signups.length, 'new website sign-up')}${withCode ? ` (${withCode} used a discount code)` : ''}`);
  if (subs.length) cust.push(`${plural(subs.length, 'plan')} put on accounts`);
  if (trials) cust.push(`${plural(trials, 'free trial')} started`);
  if (signedOut) cust.push(`${plural(signedOut, 'device')} signed out for going over the limit`);
  if (expired) cust.push(`${plural(expired, 'account')} switched off (expired)`);
  fields.push(['Customers', cust.length ? cust.join('\n') : 'No new sign-ups or renewals']);
  if (subs.length && cfg.dailySummaryMoney !== false) fields.push(['Plans sold', `${plural(subs.length, 'plan')} · $${money}`]);
  // Channels people reported
  const rep = new Map();
  for (const r of store.reports || []) if (within(r.at)) { const k = String(r.channel).toLowerCase(); const e = rep.get(k) || { name: r.channel, users: new Set() }; e.users.add(r.user); rep.set(k, e); }
  if (rep.size) fields.push(['Channels reported', [...rep.values()].sort((a, b) => b.users.size - a.users.size).slice(0, 4).map((e) => `${e.name} (${plural(e.users.size, 'person', 'people')})`).join(' · ')]);
  // Server
  let ok = 0, bad = 0;
  for (let t = t0; t < t1; t += 3600000) { const b = (store.reach || {})[new Date(t).toISOString().slice(0, 13)]; if (b) { ok += b.ok; bad += b.bad; } }
  const outages = (store.incidents || []).filter((x) => x.kind === 'server' && x.start < t1 && (x.end || Date.now()) > t0);
  const downMin = Math.round(bad * cfg.intervalSeconds / 60);
  const disks = diskInfo().filter((d) => !d.error), lowest = disks.sort((a, b) => a.freePct - b.freePct)[0];
  const lowDisk = lowest && cfg.diskAlertPercent > 0 && lowest.freePct < cfg.diskAlertPercent;
  const serverLines = [ok + bad === 0 ? 'No server checks were recorded.' : bad === 0 ? 'Emby reachable all day' : `Emby was unreachable for about ${plural(downMin, 'minute')} (${plural(outages.length || 1, 'outage')})`];
  if (lowest) serverLines.push(`${diskLabel(lowest.path)} ${lowest.freePct}% free${lowDisk ? ' (low)' : ''}`);
  serverLines.push(`Guard ${VERSION}, up for ${Math.max(1, Math.round(process.uptime() / 86400))} ${Math.round(process.uptime() / 86400) <= 1 ? 'day' : 'days'}`);
  fields.push(['Server', serverLines.join('\n')]);
  // Needs attention
  const today = dayKey(), soon = Object.values(store.users).filter((u) => u.expires && !u.hold && u.expires >= today && daysAway(u.expires) <= 7).sort((a, b) => a.expires.localeCompare(b.expires));
  const ending = soon.filter((u) => daysAway(u.expires) <= 1);
  if (ending.length) attention.push(`${plural(ending.length, 'account')} end today or tomorrow: ${ending.slice(0, 4).map((u) => u.name).join(', ')}${ending.length > 4 ? ` and ${ending.length - 4} more` : ''}`);
  if (soon.length - ending.length > 0) attention.push(`${plural(soon.length - ending.length, 'more account')} end within a week`);
  const waiting = { tickets: (store.tickets || []).filter((t) => t.status === 'open' && t.unseen).length, credit: (store.creditRequests || []).filter((x) => x.status === 'pending'), ext: (store.extensions || []).filter((x) => x.status === 'pending' && needsAdmin(x)).length };
  if (waiting.tickets) attention.push(`${plural(waiting.tickets, 'support message')} waiting`);
  if (waiting.credit.length) attention.push(`${plural(waiting.credit.length, 'credit request')} waiting${waiting.credit.length === 1 && store.resellers ? ` (from ${(Object.values(store.resellers).find((r) => r.id === waiting.credit[0].reseller) || {}).name || 'a reseller'})` : ''}`);
  if (waiting.ext) attention.push(`${plural(waiting.ext, 'extension request')} waiting`);
  const lowCredit = Object.values(store.resellers || {}).filter((r) => r.status === 'active' && r.credits <= cfg.resellerLowCredits);
  if (lowCredit.length) attention.push(`Low on credits: ${lowCredit.slice(0, 4).map((r) => `${r.name} (${r.credits})`).join(', ')}`);
  if (lowDisk) attention.push(`Disk space is low on ${diskLabel(lowest.path)}`);
  const problem = bad > 0 || lowDisk || signedOut >= 5;
  const quiet = !attention.length && !problem && minutes < 600 && !signups.length && !subs.length && !trials;
  const desc = attention.length || problem ? 'A few things need you today.' : quiet ? 'A quiet day.' : 'Everything ran normally.';
  const embed = { title: `Aurora daily summary · ${prettyDay}`, description: desc, color: bad > 0 || lowDisk ? 0xe5384f : attention.length ? 0xffd479 : quiet ? 0x46d369 : 0x4f7bff,
    fields: [...(attention.length ? [{ name: 'Needs attention', value: attention.map((a) => '• ' + a).join('\n').slice(0, 1000), inline: false }] : []), ...fields.map(([name, value]) => ({ name, value: value.slice(0, 1000), inline: false }))],
    footer: { text: `Aurora Guard ${VERSION} · covers ${prettyDay}` } };
  const text = [embed.title, desc, ...embed.fields.map((f) => `\n${f.name}\n${f.value}`)].join('\n');
  return { embed, text };
}
const diskLabel = (p) => (/^[A-Za-z]:/.test(p) ? p.slice(0, 2) : (Array.isArray(cfg.diskPaths) && cfg.diskPaths.length ? String(p).replace(/[\\/]+$/, '').slice(-24) : 'Disk'));
let summaryBusy = false;
async function sendSummary(day) {
  const s = buildSummary(day || dayKey(Date.now() - 86400000));
  return postAlert(s.embed.title, s.text, false, s.embed);
}
async function maybeSendSummary() {
  if (!summaryOn() || summaryBusy) return;
  const today = dayKey(), st = store.summary || (store.summary = {});
  if (!st.lastDay) { st.lastDay = today; try { saveStore(); } catch { /* next time */ } return; } // first time: the first message comes tomorrow
  if (st.lastDay === today || new Date().getHours() < Math.min(23, Math.max(0, Number(cfg.dailySummaryHour) || 0))) return;
  if (st.lastTry && Date.now() - st.lastTry < 10 * 60000) return;
  summaryBusy = true;
  try {
    st.lastTry = Date.now();
    const r = await sendSummary();
    if (r.ok) { st.lastDay = today; st.lastTry = 0; log('Sent the daily summary.'); } else log('The daily summary was not delivered:', r.status ? `the webhook answered ${r.status}` : r.error, '(trying again in 10 minutes)');
    saveStore();
  } catch (e) { log('The daily summary failed:', e.message); } finally { summaryBusy = false; }
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

function readBody(req, max = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > max) { if (!req.tooLarge) { req.tooLarge = true; reject(new Error('too large')); } req.resume(); chunks.length = 0; } else if (!req.tooLarge) chunks.push(c); });
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
    if (me.Policy?.IsAdministrator) return send(res, 200, { admin: true, name: me.Name }); // an administrator always sees their own library; the provider's titles are for customers
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
      vod: !!rec?.vod || !!resellerOfUser(me.Id), // the provider's movies and TV shows (resellers always have it)
      mod: !!rec?.mod && !me.Policy?.IsAdministrator, // a moderator (guard 1.27.0)
      support: rec && rec.reseller ? supportOfReseller(rec.reseller) : null, // the reseller's contact details for Help (guard 1.33.0)
      adult: !!rec?.adult, adultReset: rec?.adultReset || 0, // the adult Live TV categories switch (guard 1.23.0); adultReset changes whenever it is switched, which also clears the account's PIN
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
  if (url.pathname === '/sports/starts' && req.method === 'GET') {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    const f = String(url.searchParams.get('from') || ''), n = Math.max(1, Math.min(8, Number(url.searchParams.get('days')) || 7));
    if (!/^20\d{6}$/.test(f)) return send(res, 400, { error: 'Give the date as YYYYMMDD' });
    const diff = (Date.UTC(+f.slice(0, 4), +f.slice(4, 6) - 1, +f.slice(6, 8)) - Date.now()) / 86400000;
    if (diff < -2 || diff > 3) return send(res, 400, { error: 'That start day is out of range' });
    if (!sportsCfg().enabled) return send(res, 200, { enabled: false, starts: [] });
    try { return send(res, 200, { enabled: true, starts: await shared('starts:' + f + ':' + n, () => sportsStartsLoad(f, n)) }); } catch (e) { return send(res, 502, { error: `Can't load the schedule: ${e.message}` }); }
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
  // Customer survey (guard 1.37.0): the website's /survey/ page posts here. No sign-in; limited per internet address and kept small.
  if (url.pathname === '/survey' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    if (body.website) return send(res, 200, { ok: true }); // hidden field only a robot fills in: pretend it worked
    if (overLimit('survey', ip, 6, 86400000)) return send(res, 429, { error: 'Thank you. We already have your answers from this connection today.' });
    const raw = body.answers && typeof body.answers === 'object' ? body.answers : {}, answers = {};
    for (const k of Object.keys(raw).slice(0, 30)) {
      if (!/^q(?:[1-9]|[12]\d|30)$/.test(k)) continue;
      const v = raw[k];
      if (typeof v === 'number' && Number.isFinite(v)) answers[k] = Math.max(0, Math.min(10, Math.round(v)));
      else if (typeof v === 'string' && v.trim()) answers[k] = v.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 1000);
    }
    if (!Object.keys(answers).length) return send(res, 400, { error: 'Please answer at least one question.' });
    const clip = (v, n) => String(v || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, n);
    const who = clip(body.user, 60);
    if (!who) return send(res, 400, { error: 'Please enter your Aurora username first.' });
    store.surveys = [{ id: crypto.randomBytes(5).toString('hex'), at: Date.now(), user: who, answers, reseller: clip(body.reseller, 60), contact: clip(body.contact, 120) }, ...(store.surveys || []).filter((x) => String(x.user || '').toLowerCase() !== who.toLowerCase())].slice(0, 3000); // sending again replaces that person's earlier answers
    saveStore();
    return send(res, 200, { ok: true });
  }
  // Feature requests (guard 1.39.0): the website's /requests/ page posts here. No sign-in; limited per internet address and kept small.
  if (url.pathname === '/feature-request' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    if (body.website) return send(res, 200, { ok: true }); // hidden field only a robot fills in: pretend it worked
    if (overLimit('featreq', ip, 5, 86400000)) return send(res, 429, { error: 'You have sent a few already today. Please try again tomorrow.' });
    const clip = (v, n) => String(v || '').replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').trim().slice(0, n);
    const user = clip(body.user, 60), title = clip(body.title, 100).replace(/\s+/g, ' '), details = clip(body.details, 1500);
    const kind = ['feature', 'channel', 'problem', 'other'].includes(body.kind) ? body.kind : 'feature';
    const device = clip(body.device, 60);
    if (!user) return send(res, 400, { error: 'Please enter your Aurora username.' });
    if (title.length < 4) return send(res, 400, { error: 'Please give your request a short title.' });
    if (!Array.isArray(store.featureRequests)) store.featureRequests = [];
    store.featureRequests = [{ id: crypto.randomBytes(5).toString('hex'), at: Date.now(), user, kind, title, details, device, status: 'new' }, ...store.featureRequests].slice(0, 1000);
    saveStore();
    try { sendAlert('Aurora: new feature request', `${user}: ${title}`, false); } catch { /* alerts are optional */ }
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/discount/check' && req.method === 'GET') {
    if (overLimit('dcheck', ip, 30, 3600000)) return send(res, 429, { error: 'Too many tries. Please wait a while and try again.' });
    const d = findDiscount(url.searchParams.get('code')), problem = discountProblem(d);
    if (problem) return send(res, 200, { valid: false, message: problem });
    return send(res, 200, { valid: true, type: d.type, value: d.value, label: discountLabel(d), planIds: d.planIds || [] });
  }
  // Sign-in for the website: the person's Emby username and password. /admin-login only lets administrators in; /site-login lets anyone in and
  // says whether they are an administrator or a reseller (the reseller page uses it).
  if ((url.pathname === '/admin-login' || url.pathname === '/site-login') && req.method === 'POST') {
    const login = await embyLoginFor(req, ip);
    if (login.error) return send(res, login.status, { error: login.error });
    const u = login.r.User;
    if (url.pathname === '/admin-login') {
      if (!u.Policy?.IsAdministrator) { noteFailure(ip); emby('POST', '/Sessions/Logout', { token: login.r.AccessToken }).catch(() => {}); /* don't leave a session behind for a non-admin */ return send(res, 403, { error: "This account isn't an Aurora administrator. Sign in with your administrator account (the one that shows the Admin menu in the app). If it should be one, open the server dashboard, go to Users, open the account and turn on 'Allow this user to manage the server'." }); }
      return send(res, 200, { token: login.r.AccessToken, userId: u.Id, name: u.Name });
    }
    return send(res, 200, { token: login.r.AccessToken, userId: u.Id, name: u.Name, admin: !!u.Policy?.IsAdministrator, reseller: !!resellerOfUser(u.Id), mod: !u.Policy?.IsAdministrator && !!(store.users[u.Id] && store.users[u.Id].mod) });
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
    return serialSignup(async () => {
      const day = localDay(new Date());
      if (overLimit('signup-try', ip, 40, 3600000)) return send(res, 429, { error: 'Too many tries. Please wait a while and try again.' });
      const made = smallLimit.get('signup|' + ip); // accounts made from this address today (counted only when one is really made)
      if (made && Date.now() - made.since <= 86400000 && made.n >= cfg.signupPerIpPerDay) return send(res, 429, { error: 'Too many accounts were made from this connection today. Please try again tomorrow.' });
      if ((store.signups || []).filter((x) => x.day === day).length >= cfg.signupMaxPerDay) {
        if (store.signupFullDay !== day) { store.signupFullDay = day; sendAlert('Aurora: sign-ups full for today', `${cfg.signupMaxPerDay} accounts were made from the website today, so new sign-ups are paused until tomorrow.`, false); }
        return send(res, 429, { error: 'Sign-ups are full for today. Please try again tomorrow.' });
      }
      if (Object.values(store.users).some((u) => (u.contact?.email || '').toLowerCase() === email) || (store.signups || []).some((x) => x.email === email && Object.values(store.users).some((u) => u.name === x.user))) return send(res, 409, { error: 'That email already has an account.' });
      // Codes are checked before the account is made, so a wrong code never leaves a half-made account behind.
      let dc = null, refId = null;
      if (String(body.discount || '').trim()) { dc = findDiscount(body.discount); const pr = discountProblem(dc); if (pr) return send(res, 400, { error: pr }); }
      if (String(body.referral || '').trim()) {
        if (!(cfg.referralDays > 0)) return send(res, 400, { error: 'Referral codes are not being used right now.' });
        const rc = String(body.referral).trim().toUpperCase();
        refId = Object.keys(store.users).find((id) => store.users[id].refCode === rc);
        if (!refId) return send(res, 400, { error: 'That referral code was not found.' });
        // A friend must be a real customer: free trials can't feed each other, and nobody refers their own email.
        if (store.users[refId].trial) return send(res, 400, { error: 'That referral code can only be used once your friend has a paid plan.' });
        if ((store.users[refId].contact?.email || '').toLowerCase() === email) return send(res, 400, { error: 'You cannot use your own referral code.' });
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
    });
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
    const mine0 = rec.reseller ? resellerList()[rec.reseller] : null;
    const toReseller = mine0 && mine0.status === 'active' ? mine0 : null;
    const entry = { id: crypto.randomBytes(6).toString('hex'), userId: me.Id, name: me.Name, at: Date.now(), note: String(body.note || '').slice(0, 300).trim(), status: 'pending', expiresAtRequest: rec.expires,
      wantedPlanId: wanted ? wanted.id : null, wantedPlanName: wanted ? `${wanted.name} ($${wanted.price})` : null, reseller: toReseller ? toReseller.id : null };
    store.extensions = [entry, ...(store.extensions || [])].slice(0, 500);
    recordAction({ type: 'extensionRequested', userId: me.Id, name: me.Name, why: `asked for an extension (expires ${rec.expires})` });
    saveStore();
    log('Extension requested by', me.Name, `(expires ${rec.expires})`);
    const ask = `${(rec.contact && rec.contact.full) || me.Name}${rec.contact && rec.contact.full ? ` (${me.Name})` : ''} asked for more time (access ends ${rec.expires}).${wanted ? '\nWants: ' + wanted.name : ''}${entry.note ? '\n"' + entry.note + '"' : ''}`;
    // A reseller's customer asks their reseller (who is told where they chose); only other accounts come to the admin.
    if (toReseller) notifyReseller(toReseller, 'extension', 'Aurora: extension request', ask + '\nApprove or deny it in your reseller panel.', false);
    else sendAlert('Aurora: extension requested', ask, false);
    return send(res, 200, { ok: true, request: publicRequest(entry) });
  }

  // ----- Playback quality (guard 1.32.0): the app reports how each viewing went; kept for 14 days per customer -----
  if (url.pathname === '/quality' && req.method === 'POST') {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    if (overLimit('quality', me.Id, 120, 3600000)) return send(res, 429, { error: 'Too many reports.' });
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const n = (v, max) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.max(0, Math.min(max, x)) : 0; };
    const live = body.kind === 'live';
    if (!live && body.kind !== 'vod') return send(res, 400, { error: 'Unknown kind.' });
    const qs = store.quality || (store.quality = {});
    const q = qs[me.Id] || (qs[me.Id] = { days: {}, last: {} });
    const d = q.days[dayKey()] || (q.days[dayKey()] = { live: { min: 0, stalls: 0, starts: 0, startMs: 0, startMax: 0, slow: 0, failed: 0 }, vod: { min: 0, stalls: 0, stallSec: 0 } });
    if (live) {
      const starts = n(body.starts, 500);
      d.live.min += n(body.watchMin, 1440); d.live.stalls += n(body.stalls, 1000); d.live.starts += starts; d.live.startMs += n(body.startAvgMs, 120000) * starts;
      d.live.startMax = Math.max(d.live.startMax, n(body.startMaxMs, 600000)); d.live.slow += n(body.slow, 500); d.live.failed += n(body.failed, 500);
    } else {
      d.vod.min += n(body.watchMin, 1440); d.vod.stalls += n(body.stalls, 1000); d.vod.stallSec += n(body.stallSec, 86400);
    }
    q.last = { at: Date.now(), app: cleanText(body.app, 40) || (q.last && q.last.app) || '', buffer: ['small', 'medium', 'large'].includes(body.buffer) ? body.buffer : (q.last && q.last.buffer) || '', kbps: live && n(body.kbps, 1000000) ? n(body.kbps, 1000000) : (q.last && q.last.kbps) || 0 };
    const keep = dayKey(Date.now() - 13 * 86400000);
    for (const k of Object.keys(q.days)) if (k < keep) delete q.days[k];
    saveStore();
    return send(res, 200, { ok: true });
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
      const up = r.parent ? resellerList()[r.parent] : null;
      const subs = subsOf(r).map((x) => ({ id: x.id, name: x.name, userName: x.userName, contact: x.contact || '', credits: x.credits, status: x.status, created: x.created, low: x.credits <= cfg.resellerLowCredits,
        customers: Object.values(store.users).filter((u) => u.reseller === x.id).length })).sort((a, b) => a.name.localeCompare(b.name));
      return send(res, 200, { reseller: true, name: r.name, credits: r.credits, low: r.credits <= cfg.resellerLowCredits, trialsLeft: Math.max(0, cfg.resellerTrialsPerDay - trialsToday),
        parent: up ? up.name : '', canAddSubs: !r.parent, subs, notify: notifyPublic(r), support: r.support || null,
        extensions: (() => {
          const planName = (id) => ((store.plans || []).find((p) => p.id === id) || {}).name || '';
          const row = (x) => { const c = store.users[x.userId]; return { id: x.id, name: x.name, full: (c && c.contact && c.contact.full) || '', at: x.at, note: x.note || '', wantedPlanId: x.wantedPlanId || null, wantedPlan: planName(x.wantedPlanId),
            expires: c ? c.expires || null : null, daysLeft: c && c.expires ? daysUntil(c.expires) : null, expired: c ? isExpired(c) : false, gone: !c, status: x.status, decidedAt: x.decidedAt || null, message: x.message || '', planName: x.planName || '', newExpires: x.newExpires || null }; };
          const mineX = (store.extensions || []).filter((x) => x.reseller === r.id);
          return { pending: mineX.filter((x) => x.status === 'pending').map(row).reverse(), decided: mineX.filter((x) => x.status !== 'pending').slice(0, 20).map(row) };
        })(),
        plans: (store.plans || []).filter((p) => p.active !== false && resellerPlanIds(r).includes(p.id)).map((p) => ({ id: p.id, name: p.name, connections: p.connections, length: p.length, unit: p.unit, credits: planCredits(p) })),
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
      const sellable = (id) => (store.plans || []).find((p) => p.id === id && p.active !== false && resellerPlanIds(r).includes(p.id));
      const owns = (id) => store.users[id]?.reseller === r.id;
      // ----- Extension requests from this reseller's customers (guard 1.22.0) -----
      const xm = url.pathname.match(/^\/reseller\/extensions\/([\w-]{1,32})\/(approve|deny)$/);
      if (xm && req.method === 'POST') {
        const x = (store.extensions || []).find((e) => e.id === xm[1]);
        if (!x || x.reseller !== r.id) return send(res, 404, { error: 'No such request.' });
        if (x.status !== 'pending') return send(res, 409, { error: `That request was already ${x.status}.` });
        let body;
        try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
        const message = cleanText(body.message, 200);
        if (xm[2] === 'deny') {
          x.status = 'denied'; x.decidedAt = Date.now(); x.message = message; x.decidedBy = r.name;
          recordAction({ type: 'extensionDenied', userId: x.userId, name: x.name, why: `extension denied by ${r.name}` });
          recordAudit(by, `Denied an extension request from ${x.name}`);
          saveStore();
          return send(res, 200, { ok: true });
        }
        const rec = store.users[x.userId];
        if (!rec) { x.status = 'denied'; x.decidedAt = Date.now(); x.message = 'This account no longer exists.'; saveStore(); return send(res, 404, { error: 'That customer no longer exists. The request was closed.' }); }
        const plan = sellable(body.planId || x.wantedPlanId || rec.plan?.id);
        if (!plan) return send(res, 400, { error: 'Choose one of your plans.' });
        const cost = planCredits(plan);
        if (r.credits < cost) return send(res, 402, { error: `Not enough credits: this costs ${cost} and you have ${r.credits}.` });
        applyPlan(x.userId, rec.name, plan, 'extend');
        rec.trial = false;
        creditEntry(r, -cost, 'Renewed ' + plan.name, by, { customer: rec.name });
        x.status = 'approved'; x.decidedAt = Date.now(); x.days = null; x.message = message; x.newExpires = rec.expires; x.planName = plan.name; x.decidedBy = r.name;
        recordAction({ type: 'extended', userId: x.userId, name: x.name, why: `renewed by ${r.name} on ${plan.name}, now ends ${rec.expires}` });
        recordAudit(by, `Approved an extension request from ${rec.name}: renewed on ${plan.name} (${cost} credits)`);
        saveStore();
        try { await enforce(x.userId); } catch (e) { log('Applying', rec.name, 'failed:', e.message); }
        return send(res, 200, { ok: true, credits: r.credits, expires: rec.expires });
      }
      // ----- Packages (guard 1.41.0) -----
      if (url.pathname === '/reseller/packages' && req.method === 'GET') return send(res, 200, { packages: packList().map((x) => ({ id: x.id, name: x.name, count: x.categories.length })) });
      {
        const pk = url.pathname.match(/^\/reseller\/customers\/([\w-]{1,64})\/packages$/);
        if (pk && req.method === 'POST') {
          const cid = pk[1];
          if (!owns(cid)) return send(res, 404, { error: 'No such customer.' });
          let body;
          try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
          const rec = store.users[cid], ids = [...new Set(Array.isArray(body.packs) ? body.packs.map(String) : [])];
          if (ids.some((id) => !packList().some((x) => x.id === id))) return send(res, 400, { error: 'One of those packages no longer exists.' });
          rec.packs = ids; syncPacks(rec);
          const names = ids.map((id) => packList().find((x) => x.id === id).name);
          recordAudit(by, ids.length ? `Gave ${rec.name} the package${ids.length === 1 ? '' : 's'}: ${names.join(', ')}` : `Took the packages off ${rec.name} (back to their plan)`); saveStore();
          return send(res, 200, { ok: true, packs: rec.packs, categories: rec.categories, custom: !!rec.catsCustom });
        }
      }
      // ----- Channel categories for a customer (guard 1.40.0) -----
      if (url.pathname === '/reseller/categories' && req.method === 'GET') {
        try { return send(res, 200, await assignableCategories()); } catch (e) { return send(res, 502, { error: e.message }); }
      }
      {
        const ct = url.pathname.match(/^\/reseller\/customers\/([\w-]{1,64})\/categories$/);
        if (ct && (req.method === 'GET' || req.method === 'POST')) {
          const cid = ct[1];
          if (!owns(cid)) return send(res, 404, { error: 'No such customer.' });
          const rec = store.users[cid];
          if (req.method === 'GET') return send(res, 200, { categories: Array.isArray(rec.categories) ? rec.categories : null, custom: !!rec.catsCustom, planName: rec.plan ? rec.plan.name : '', packs: Array.isArray(rec.packs) ? rec.packs : [] });
          let body;
          try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
          if (body.categories === null || body.categories === undefined) {
            // Back to the customer's plan (all categories, or whatever the plan includes).
            rec.packs = []; rec.packsOn = false; rec.catsCustom = false; rec.categories = rec.plan && Array.isArray(rec.plan.categories) ? [...rec.plan.categories] : null; rec.updated = Date.now();
            recordAudit(by, `Gave ${rec.name} the categories from their plan`); saveStore();
            return send(res, 200, { ok: true, categories: rec.categories, custom: false });
          }
          if (!Array.isArray(body.categories) || body.categories.length > 5000) return send(res, 400, { error: 'The categories are not valid.' });
          let allowed;
          try { allowed = await assignableCategories(); } catch (e) { return send(res, 502, { error: e.message }); }
          if (!allowed.supported) return send(res, 400, { error: 'Your TV provider does not support choosing categories.' });
          const ok = new Set(allowed.categories.map((x) => x.id)), chosen = [...new Set(body.categories.map(String))].filter((x) => ok.has(x));
          if (!chosen.length) return send(res, 400, { error: 'Choose at least one category, or put the customer back on all categories.' });
          rec.packs = []; rec.packsOn = false; rec.categories = chosen; rec.catsCustom = true; rec.updated = Date.now();
          recordAudit(by, `Set ${chosen.length} Live TV categor${chosen.length === 1 ? 'y' : 'ies'} for ${rec.name}`); saveStore();
          return send(res, 200, { ok: true, categories: rec.categories, custom: true });
        }
      }
      // ----- Who is watching right now (guard 1.31.0): this reseller's own customers only -----
      if (url.pathname === '/reseller/watching' && req.method === 'GET') {
        let sessions;
        try { sessions = await sessionsShared(); } catch (e) { return send(res, 502, { error: `Can't reach Emby: ${e.message}` }); }
        const now = Date.now(), out = [], liveSeen = new Set();
        for (const s of Array.isArray(sessions) ? sessions : []) {
          if (!s.UserId || !owns(s.UserId) || !s.NowPlayingItem) continue;
          if (now - (Date.parse(s.LastActivityDate || 0) || 0) > windowMs()) continue;
          const it = s.NowPlayingItem, live = it.Type === 'TvChannel' || it.Type === 'LiveTvChannel';
          const ep = !live && it.SeriesName && it.Name && it.Name !== it.SeriesName ? it.Name : '';
          out.push({ userId: s.UserId, kind: live ? 'live' : (it.SeriesName ? 'show' : 'movie'), title: live ? (it.Name || 'a channel') : String(it.SeriesName || it.Name || 'Unknown').slice(0, 80), episode: String(ep).slice(0, 80),
            device: s.DeviceName || '', client: s.Client || '', paused: !!(s.PlayState && s.PlayState.IsPaused) });
          if (live) liveSeen.add(s.UserId + '|' + (s.DeviceName || ''));
        }
        // Live TV in Aurora's own player is not an Emby session: it comes from the once-a-minute count of TV provider connections.
        for (const x of (connections.streams || [])) {
          if (x.source !== 'aurora' || !x.userId || !owns(x.userId) || liveSeen.has(x.userId + '|' + x.device)) continue;
          out.push({ userId: x.userId, kind: 'live', title: x.channel || 'a channel', episode: '', device: x.device || '', client: 'Aurora', paused: false, since: x.since || 0 });
        }
        return send(res, 200, { at: now, watching: out });
      }
      // ----- Notices to this reseller's own customers (guard 1.33.0): they show in the customers' app like an announcement -----
      if (url.pathname === '/reseller/notices' && req.method === 'GET') {
        const now = Date.now();
        return send(res, 200, { notices: (store.announcements || []).filter((a) => a.audience && a.audience.type === 'reseller' && a.audience.id === r.id && a.byReseller === r.id && (!a.expires || a.expires > now)) });
      }
      if (url.pathname === '/reseller/notices' && req.method === 'POST') {
        let body;
        try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
        const text = cleanText(body.text, 200);
        if (!text) return send(res, 400, { error: 'Write the message.' });
        const level = ['info', 'warn', 'bad'].includes(body.level) ? body.level : 'info';
        const hours = Number(body.hours);
        if (!Number.isFinite(hours) || hours < 1 || hours > 24 * 14) return send(res, 400, { error: 'It must last between 1 hour and 14 days.' });
        const live = (store.announcements || []).filter((a) => a.byReseller === r.id && (!a.expires || a.expires > Date.now()));
        if (live.length >= 5) return send(res, 400, { error: 'You can have 5 notices showing at once. Remove one first.' });
        if (overLimit('notice', r.id, 10, 3600000)) return send(res, 429, { error: 'That is a lot of notices. Try again in a little while.' });
        const a = { id: crypto.randomBytes(5).toString('hex'), text, level, at: Date.now(), expires: Date.now() + hours * 3600000, audience: { type: 'reseller', id: r.id }, by, byReseller: r.id };
        store.announcements = [a, ...(store.announcements || [])].slice(0, 100);
        recordAudit(by, `Sent a notice to their customers: "${text.slice(0, 60)}"`); saveStore();
        return send(res, 200, { ok: true, notice: a });
      }
      const nm = url.pathname.match(/^\/reseller\/notices\/([\w-]{1,32})$/);
      if (nm && req.method === 'DELETE') {
        const a = (store.announcements || []).find((x) => x.id === nm[1]);
        if (!a || a.byReseller !== r.id) return send(res, 404, { error: 'No such notice.' });
        store.announcements = store.announcements.filter((x) => x.id !== nm[1]); saveStore();
        return send(res, 200, { ok: true });
      }
      // ----- The contact details this reseller's customers see under Help (guard 1.33.0) -----
      if (url.pathname === '/reseller/support' && req.method === 'PUT') {
        let body;
        try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
        const c = cleanSupport(body);
        if (c.error) return send(res, 400, { error: c.error });
        if (c.support) r.support = c.support; else delete r.support;
        recordAudit(by, c.support ? 'Updated the contact details their customers see' : 'Removed the contact details their customers see'); saveStore();
        return send(res, 200, { ok: true, support: r.support || null });
      }
      // ----- Where this reseller wants alerts (Telegram, Discord, ntfy or a web address) -----
      if (url.pathname === '/reseller/notify' && req.method === 'PUT') {
        let body;
        try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
        const type = String(body.type || '');
        if (!type || type === 'off') { delete r.notify; saveStore(); return send(res, 200, { ok: true, notify: notifyPublic(r) }); }
        if (!NOTIFY_TYPES.includes(type)) return send(res, 400, { error: 'Choose Telegram, Discord, ntfy or a web address.' });
        const old = r.notify && r.notify.type === type ? r.notify : {};
        const next = { type, token: body.token ? String(body.token).trim() : old.token, chat: body.chat ? String(body.chat).trim() : old.chat, url: body.url ? String(body.url).trim() : old.url, topic: body.topic ? String(body.topic).trim() : old.topic,
          events: { ...NOTIFY_EVENTS, ...(r.notify && r.notify.events || {}) } };
        if (body.events && typeof body.events === 'object') for (const k of Object.keys(NOTIFY_EVENTS)) if (k in body.events) next.events[k] = !!body.events[k];
        next.endingDays = 'endingDays' in body ? cleanDays(body.endingDays, 4) || [3] : (r.notify && r.notify.endingDays) || [3];
        const t = notifyTarget(next);
        if (t.error) return send(res, 400, { error: t.error });
        r.notify = next; saveStore();
        return send(res, 200, { ok: true, notify: notifyPublic(r) });
      }
      if (url.pathname === '/reseller/notify/test' && req.method === 'POST') {
        const t = notifyTarget(r.notify);
        if (t.error) return send(res, 400, { error: r.notify ? t.error : 'Save where to send the alerts first.' });
        const now = Date.now(), list = (notifyWindow.get(r.id) || []).filter((q) => now - q < 3600000);
        if (list.length >= 30) return send(res, 429, { error: 'That is a lot of messages. Try again in a little while.' });
        list.push(now); notifyWindow.set(r.id, list);
        const out = await notifyPost(t, 'Aurora: test message', `This is a test from your Aurora reseller panel (${r.name}). If you can read it, alerts work.`, false);
        if (!out.ok) return send(res, 502, { error: friendlyNotifyError(r.notify.type, out) });
        return send(res, 200, { ok: true });
      }
      // ----- Sub-resellers (guard 1.21.0) -----
      if (url.pathname === '/reseller/subs' && req.method === 'POST') {
        if (r.parent) return send(res, 403, { error: 'Sub-resellers can not add sub-resellers of their own.' });
        let body;
        try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
        const name = cleanText(body.name, 60);
        if (!name) return send(res, 400, { error: 'Give the sub-reseller a name.' });
        const userName = cleanUserName(body.userName);
        if (!userName) return send(res, 400, { error: 'The login name must be 3 to 32 letters, numbers, dots, dashes or underscores.' });
        const send0 = body.credits === undefined || body.credits === '' ? 0 : Number(body.credits);
        if (!Number.isInteger(send0) || send0 < 0 || send0 > 100000) return send(res, 400, { error: 'The credits must be a whole number from 0 up.' });
        if (send0 > r.credits) return send(res, 402, { error: `You have ${r.credits} credits, so you can not send ${send0}.` });
        if (subsOf(r).length >= MAX_SUBS) return send(res, 400, { error: `You can have up to ${MAX_SUBS} sub-resellers.` });
        const password = body.password ? String(body.password) : genPassword();
        if (password.length < 6 || password.length > 64) return send(res, 400, { error: 'The password must be 6 to 64 characters.' });
        const existing = await emby('GET', '/Users');
        if ((existing || []).some((u) => String(u.Name).toLowerCase() === userName.toLowerCase())) return send(res, 409, { error: 'That login name is taken. Try another.' });
        let user;
        try { user = await newEmbyAccount(userName, password); } catch (e) { return send(res, 502, { error: e.message }); }
        const id = crypto.randomBytes(4).toString('hex');
        const sub = { id, userId: user.Id, userName, name, contact: cleanText(body.contact, 100), credits: 0, status: 'active', plans: [...resellerPlanIds(r)], created: Date.now(), parent: r.id };
        resellerList()[id] = sub;
        try { await limitResellerAccount(user.Id); sub.limited = true; } catch (e) { log('Could not limit the sub-reseller account', userName, '-', e.message); }
        if (send0) { creditEntry(r, -send0, `Sent to ${name}`, by, { sub: id }); creditEntry(sub, send0, `From ${r.name}`, by, { from: r.id }); }
        saveStore();
        log('Sub-reseller added by', r.name + ':', name, `(${userName}) with`, send0, 'credits');
        copyAppDefaults(user.Id).catch(() => {});
        return send(res, 200, { ok: true, password, credits: r.credits });
      }
      const sm = url.pathname.match(/^\/reseller\/subs\/([\w-]{1,32})\/(credits|password|status)$/);
      if (sm && req.method === 'POST') {
        const sub = resellerList()[sm[1]];
        if (!sub || sub.parent !== r.id) return send(res, 404, { error: 'No such sub-reseller.' });
        if (resellerBusy.has(sub.id)) return send(res, 409, { error: 'That sub-reseller is busy. Try again in a moment.' });
        resellerBusy.add(sub.id);
        try {
          let body;
          try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
          if (sm[2] === 'credits') {
            const amount = Number(body.amount);
            if (!Number.isInteger(amount) || amount < 1 || amount > 100000) return send(res, 400, { error: 'Send a whole number of credits, 1 or more.' });
            if (amount > r.credits) return send(res, 402, { error: `You have ${r.credits} credits, so you can not send ${amount}.` });
            creditEntry(r, -amount, `Sent to ${sub.name}`, by, { sub: sub.id });
            creditEntry(sub, amount, `From ${r.name}`, by, { from: r.id });
            saveStore();
            log('Credits', r.name, '->', sub.name, amount);
            return send(res, 200, { ok: true, credits: r.credits, subCredits: sub.credits });
          }
          if (sm[2] === 'password') {
            const password = body.password ? String(body.password) : genPassword();
            if (password.length < 6 || password.length > 64) return send(res, 400, { error: 'The password must be 6 to 64 characters.' });
            try {
              await emby('POST', `/Users/${sub.userId}/Password`, { body: { Id: sub.userId, ResetPassword: true } });
              await emby('POST', `/Users/${sub.userId}/Password`, { body: { Id: sub.userId, CurrentPw: '', NewPw: password } });
            } catch (e) { return send(res, 502, { error: 'Could not change the password: ' + e.message }); }
            log('Password reset for sub-reseller', sub.name, 'by', r.name);
            return send(res, 200, { ok: true, password });
          }
          if (body.status !== 'active' && body.status !== 'suspended') return send(res, 400, { error: 'Choose active or suspended.' });
          sub.status = body.status;
          saveStore();
          log('Sub-reseller', sub.name, body.status === 'suspended' ? 'suspended' : 'restored', 'by', r.name);
          return send(res, 200, { ok: true, status: sub.status });
        } finally { resellerBusy.delete(sub.id); }
      }
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
        rec.reseller = r.id; rec.trial = trial; rec.created = Date.now(); if (body.vod === true || plan.vod) rec.vod = true;
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
        if (r.parent) return send(res, 403, { error: `Ask your reseller (${resellerList()[r.parent]?.name || 'the one who added you'}) for credits.` });
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
      const cm = url.pathname.match(/^\/reseller\/customers\/([\w-]{1,64})(?:\/(renew|password|signout|hold|vod|adult|remind|quality|devices|device-remove))?$/);
      if (cm) {
        const id = cm[1], act = cm[2];
        if (!owns(id)) return send(res, 404, { error: 'No such customer.' });
        const rec = store.users[id];
        let body = {};
        if (req.method !== 'GET') { try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); } }
        // How this customer's viewing has been going (guard 1.33.0): the same report an administrator sees.
        if (act === 'quality' && req.method === 'GET') return send(res, 200, await qualityReport(id));
        // The devices this customer is signed in on, and removing just one of them (guard 1.33.0).
        if (act === 'devices' && req.method === 'GET') {
          let list = [];
          try { const d = await emby('GET', '/Devices', { query: { UserId: id } }); list = ((d && d.Items) || []).filter((x) => !x.LastUserId || x.LastUserId === id); } catch (e) { return send(res, 502, { error: "Can't reach Emby: " + e.message }); }
          const live = activeByUser(await sessionsShared()).get(id);
          return send(res, 200, { devices: list.filter((x) => x.Id !== 'aurora-guard').map((x) => ({ id: x.Id, name: x.Name || 'Device', app: x.AppName || '', last: x.DateLastActivity || '', active: !!(live && live.has(x.Id)) })).sort((a, b) => String(b.last).localeCompare(String(a.last))).slice(0, 30) });
        }
        if (act === 'device-remove' && req.method === 'POST') {
          const did = String(body.deviceId || '');
          if (!/^[\w.:-]{1,128}$/.test(did) || did === 'aurora-guard') return send(res, 400, { error: 'Choose a device from the list.' });
          let list = [];
          try { const d = await emby('GET', '/Devices', { query: { UserId: id } }); list = ((d && d.Items) || []).filter((x) => !x.LastUserId || x.LastUserId === id); } catch (e) { return send(res, 502, { error: "Can't reach Emby: " + e.message }); }
          const dev = list.find((x) => x.Id === did);
          if (!dev) return send(res, 404, { error: "That device isn't on this customer's account." });
          const sessions = ((await emby('GET', '/Sessions')) || []).filter((x) => x.DeviceId === did && x.UserId === id).map((x) => x.Id);
          try { await signOutDevice({ Id: id, Name: rec.name }, { name: dev.Name || 'Device', client: dev.AppName || '', deviceId: did, sessions }, 'Signed out by your reseller'); } catch (e) { return send(res, 502, { error: 'Could not remove it: ' + e.message }); }
          recordAudit(by, `Removed the device ${dev.Name || did} from ${rec.name}`); saveStore();
          return send(res, 200, { ok: true });
        }
        // The provider's movies and TV shows for this customer (a reseller can always switch it).
        if (act === 'vod' && req.method === 'POST') {
          rec.vod = body.on === true; rec.updated = Date.now();
          recordAudit(by, `${rec.vod ? 'Switched on' : 'Switched off'} provider movies and TV for ${rec.name}`); saveStore();
          return send(res, 200, { ok: true, vod: rec.vod });
        }
        // When this customer is reminded in the app that their plan is ending (guard 1.26.0).
        if (act === 'remind' && req.method === 'POST') {
          if (body.days === null) delete rec.remind;
          else { const days = cleanDays(body.days); if (!days) return send(res, 400, { error: 'Give 1 to 5 reminder days, each between 1 and 60.' }); rec.remind = days; }
          rec.updated = Date.now();
          recordAudit(by, rec.remind ? `Set reminders for ${rec.name} to ${rec.remind.join(', ')} days before the end` : `Reminders for ${rec.name} follow the default`); saveStore();
          return send(res, 200, { ok: true, remind: rec.remind || null });
        }
        // Adult Live TV categories for this customer (guard 1.23.0). Whoever switches it on vouches that the customer is an adult.
        if (act === 'adult' && req.method === 'POST') {
          const on = body.on === true;
          if (!!rec.adult !== on) rec.adultReset = Date.now();
          rec.adult = on; rec.updated = Date.now();
          recordAudit(by, `${on ? 'Switched on' : 'Switched off'} adult channels for ${rec.name}`); saveStore();
          return send(res, 200, { ok: true, adult: rec.adult });
        }
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
    const mine = store.users[me.Id] || (store.users[me.Id] = { limit: cfg.defaultLimit, expires: null, name: me.Name, updated: Date.now(), created: Date.now() });
    if (mine.trial) return send(res, 400, { error: 'Codes can be used once you have a paid plan.' });
    if (mine.referredBy) return send(res, 409, { error: 'You have already used a code.' });
    const refId = Object.keys(store.users).find((id) => store.users[id].refCode === code);
    if (!refId || refId === me.Id) return send(res, 404, { error: 'That code was not found.' });
    if (store.users[refId].trial) return send(res, 400, { error: 'That code can only be used once your friend has a paid plan.' });
    if (store.users[refId].referredBy === me.Id) return send(res, 409, { error: 'That friend already used your code, so you can\'t use theirs.' });
    if (!mine.created && !Object.keys(store.firstSeen[me.Id] || {}).length) mine.created = Date.now(); // first time we see this account: its 14 days start now
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

  // The channels admins and moderators added or fixed: every signed-in account reads them, so every app can show them (guard 1.28.0).
  if (url.pathname === '/channels' && req.method === 'GET') {
    const me = await userOfToken(token, url.searchParams.get('userId'));
    if (!me) return send(res, 401, { error: 'Not signed in' });
    return send(res, 200, chanPublic(false));
  }

  // Everything else: Emby administrators only.
  if (tooManyFailures(ip)) return send(res, 429, { error: 'Too many failed attempts. Try again in a few minutes.' });
  let admin = false, mod = null;
  try { admin = await isAdminToken(token); } catch (e) { return send(res, 502, { error: `Can't reach Emby to check who you are: ${e.message}` }); }
  if (!admin) {
    try { mod = await modOfToken(token, url.searchParams.get('modUser')); } catch { mod = null; }
    if (!mod) { noteFailure(ip); return send(res, 403, { error: 'Emby administrators only' }); }
    if (!modAllowed(req.method, url.pathname)) return send(res, 403, { error: "That isn't available to moderators." });
  }

  // Who changed what: every change made through the admin endpoints is written down with the admin's name (the app sends it).
  const auditBy = mod ? `${mod.Name} (moderator)`.slice(0, 40) : String(url.searchParams.get('by') || req.headers['x-aurora-user'] || '').replace(/[^\p{L}\p{N} ._'-]/gu, '').trim().slice(0, 40) || 'an admin';
  // Reseller PIN (guard 1.34.0): its own routes, and the lock on the Resellers tab and credit requests.
  if (url.pathname === '/reseller-pin' && req.method === 'GET') return send(res, 200, { set: !!store.resellerPin, unlocked: pinIsUnlocked(token) });
  if (url.pathname === '/reseller-pin/unlock' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    if (!store.resellerPin) return send(res, 200, { ok: true, unlocked: true });
    const c = pinCheck(token, body.pin, ip);
    if (!c.ok) { if (c.wrong) recordAudit(auditBy, 'Entered a wrong Admin PIN'); return send(res, c.wait ? 429 : 403, { error: c.error }); }
    pinUnlocked.set(tokenKey(token), Date.now() + PIN_IDLE_MS);
    return send(res, 200, { ok: true, unlocked: true });
  }
  if (url.pathname === '/reseller-pin/lock' && req.method === 'POST') { pinUnlocked.delete(tokenKey(token)); return send(res, 200, { ok: true }); }
  if (url.pathname === '/reseller-pin' && req.method === 'PUT') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    if (store.resellerPin) { const c = pinCheck(token, body.current, ip); if (!c.ok) return send(res, c.wait ? 429 : 403, { error: c.wrong ? 'The current PIN is not right.' : c.error }); }
    if (body.pin === null) {
      if (!store.resellerPin) return send(res, 200, { ok: true, set: false });
      delete store.resellerPin; pinUnlocked.clear(); recordAudit(auditBy, 'Removed the Admin PIN'); saveStore();
      return send(res, 200, { ok: true, set: false });
    }
    if (!/^\d{4}$/.test(String(body.pin || ''))) return send(res, 400, { error: 'The PIN must be exactly 4 digits.' });
    const had = !!store.resellerPin, salt = crypto.randomBytes(16).toString('hex');
    store.resellerPin = { salt, hash: pinHash(body.pin, salt), at: Date.now(), by: auditBy };
    pinUnlocked.clear(); pinUnlocked.set(tokenKey(token), Date.now() + PIN_IDLE_MS); // whoever sets it is let in
    recordAudit(auditBy, had ? 'Changed the Admin PIN' : 'Set an Admin PIN'); saveStore();
    return send(res, 200, { ok: true, set: true });
  }
  if (!mod && store.resellerPin && PIN_LOCKED_PATH.test(url.pathname) && !pinIsUnlocked(token)) return send(res, 423, { error: 'Enter the Admin PIN to open this.', pinRequired: true });
  if (url.pathname === '/audit' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const text = String(body.text || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!text) return send(res, 400, { error: 'text is required' });
    recordAudit(auditBy, text); saveStore();
    return send(res, 200, { ok: true });
  }
  if (url.pathname === '/mod/emby') {
    let body = null;
    if (req.method === 'POST') { try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); } }
    try { return await modEmby(req, url, res, body); } catch (e) { return send(res, e.status === 404 ? 404 : 502, { error: e.message }); }
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
  if (await chanRoutes(req, url, res, auditBy)) return;
  // Requests (Seerr) import (admin): what is going on, and import now.
  if (url.pathname === '/requests-sync' && req.method === 'GET') {
    const st = requestsState();
    let pending = null;
    try {
      const users = (await emby('GET', '/Users')) || [];
      pending = users.filter((u) => !(u.Policy && u.Policy.IsDisabled) && !resellerOfUser(u.Id) && !st.done[u.Id]).length;
    } catch { /* unknown */ }
    return send(res, 200, { configured: !!cfg.requestsApiKey, imported: Object.keys(st.done).length, pending, failed: Object.keys(st.failed).length, last: st.last });
  }
  if (url.pathname === '/requests-sync/run' && req.method === 'POST') {
    const r = await syncRequestsUsers({ force: true });
    return send(res, 200, r);
  }
  // Daily summary (admin): its settings, and send one now.
  if (url.pathname === '/summary' && req.method === 'GET') return send(res, 200, { enabled: summaryOn(), hour: Math.min(23, Math.max(0, Number(cfg.dailySummaryHour) || 0)), lastDay: (store.summary || {}).lastDay || '', webhook: !!cfg.alertWebhookUrl, off: cfg.dailySummary === false });
  if (url.pathname === '/summary/send' && req.method === 'POST') {
    if (!cfg.alertWebhookUrl) return send(res, 400, { error: 'No alert webhook is set in config.json ("alertWebhookUrl"), so there is nowhere to send it.' });
    const r = await sendSummary();
    return send(res, r.ok ? 200 : 502, r.ok ? { ok: true } : { error: r.status ? `The webhook answered ${r.status}.` : (r.error || 'The webhook did not answer.') });
  }
  // Updating the guard (admin).
  if (url.pathname === '/update' && req.method === 'GET') return send(res, 200, publicUpdate());
  if (url.pathname === '/update/check' && req.method === 'POST') { await checkForUpdate(); return send(res, 200, publicUpdate()); }
  if (url.pathname === '/update/apply' && req.method === 'POST') {
    if (updateRun.busy) return send(res, 409, { error: 'An update is already running.' });
    if (!updateInfo.latest || !versionGreater(updateInfo.latest, VERSION)) return send(res, 409, { error: 'There is no newer version to install. Check again first.' });
    applyUpdate(auditBy); return send(res, 200, { ok: true, ...publicUpdate() });
  }
  if (url.pathname === '/update/rollback' && req.method === 'POST') {
    if (updateRun.busy) return send(res, 409, { error: 'An update is already running.' });
    rollbackUpdate(auditBy); return send(res, 200, { ok: true, ...publicUpdate() });
  }
  // Discount codes for the website (admin).
  // Packages (guard 1.41.0): administrators make, change and remove them.
  if (url.pathname === '/packages' && req.method === 'GET') {
    let cats = { supported: false, categories: [] }, err = '';
    try { cats = await assignableCategories(); } catch (e) { err = e.message; }
    return send(res, 200, { packages: packList(), supported: cats.supported, categories: cats.categories, error: err });
  }
  {
    const pm = url.pathname.match(/^\/packages(?:\/([0-9a-f]{8}))?$/);
    if (pm && (req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE') && (pm[1] ? true : req.method === 'POST')) {
      if (req.method === 'DELETE') {
        const x = packList().find((q) => q.id === pm[1]);
        if (!x) return send(res, 404, { error: 'No such package' });
        store.packages = packList().filter((q) => q.id !== pm[1]); syncAllPacks();
        recordAudit(auditBy, `Deleted the package ${x.name}`); saveStore();
        return send(res, 200, { ok: true });
      }
      let body;
      try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
      const name = String(body.name || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
      if (!name) return send(res, 400, { error: 'Give the package a name.' });
      let cats;
      try { cats = await assignableCategories(); } catch (e) { return send(res, 502, { error: e.message }); }
      if (!cats.supported) return send(res, 400, { error: 'Packages need an Xtream TV provider.' });
      const ok = new Set(cats.categories.map((c) => c.id)), chosen = [...new Set((Array.isArray(body.categories) ? body.categories : []).map(String))].filter((c) => ok.has(c));
      if (!chosen.length) return send(res, 400, { error: 'Choose at least one category.' });
      if (packList().some((q) => q.name.toLowerCase() === name.toLowerCase() && q.id !== pm[1])) return send(res, 400, { error: 'There is already a package with that name.' });
      if (pm[1]) {
        const x = packList().find((q) => q.id === pm[1]);
        if (!x) return send(res, 404, { error: 'No such package' });
        x.name = name; x.categories = chosen; syncAllPacks();
        recordAudit(auditBy, `Changed the package ${name} (${chosen.length} categories)`); saveStore();
        return send(res, 200, { ok: true, package: x });
      }
      if (packList().length >= 30) return send(res, 400, { error: 'That is the most packages Aurora can keep.' });
      const x = { id: crypto.randomBytes(4).toString('hex'), name, categories: chosen };
      store.packages = [...packList(), x];
      recordAudit(auditBy, `Made the package ${name} (${chosen.length} categories)`); saveStore();
      return send(res, 200, { ok: true, package: x });
    }
  }
  // SABnzbd (guard 1.42.0): administrators only. The Guard calls SABnzbd with the API key from config.json.
  if (url.pathname === '/sab/status' && req.method === 'GET') {
    if (!sabBase()) return send(res, 200, { configured: false });
    try {
      const q = (await sabCall({ mode: 'queue' })).queue || {}, h = (await sabCall({ mode: 'history', limit: 15 })).history || {};
      return send(res, 200, { configured: true, paused: !!q.paused, status: q.status || '', speed: q.speed || '', kbpersec: Number(q.kbpersec) || 0, sizeleft: q.sizeleft || '', timeleft: q.timeleft || '',
        queue: (q.slots || []).slice(0, 50).map((x) => ({ id: x.nzo_id, name: x.filename, status: x.status, pct: Number(x.percentage) || 0, size: x.size || '', left: x.sizeleft || '', eta: x.timeleft || '', cat: x.cat || '' })),
        history: (h.slots || []).slice(0, 15).map((x) => ({ id: x.nzo_id, name: x.name, status: x.status, size: x.size || '', at: x.completed || 0, fail: x.fail_message || '' })) });
    } catch (e) { return send(res, 502, { configured: true, error: e.message }); }
  }
  if (url.pathname.startsWith('/sab/') && req.method === 'POST') {
    if (!sabBase()) return send(res, 400, { error: 'SABnzbd is not set up on the Guard yet (sabnzbdUrl and sabnzbdApiKey in config.json).' });
    let body;
    try { body = await readBody(req, 9 * 1024 * 1024); } catch (e) { return send(res, 400, { error: e.message }); }
    try {
      if (url.pathname === '/sab/add') {
        const link = String(body.url || '').trim();
        if (!/^https?:\/\/[^\s]{4,1990}$/i.test(link)) return send(res, 400, { error: 'Paste a link that starts with http:// or https://' });
        const j = await sabCall({ mode: 'addurl', name: link });
        if (j.status === false) return send(res, 400, { error: 'SABnzbd did not accept that link.' });
        recordAudit(auditBy, 'Added a link to SABnzbd'); saveStore();
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/sab/upload') {
        const name = String(body.filename || 'file.nzb').replace(/[^\w .()-]/g, '_').slice(0, 120), raw = Buffer.from(String(body.data || ''), 'base64');
        if (!raw.length || raw.length > 6 * 1024 * 1024) return send(res, 400, { error: 'That file is empty or too big (6 MB at most).' });
        if (!/<nzb[\s>]/i.test(raw.slice(0, 4000).toString('utf8'))) return send(res, 400, { error: 'That does not look like an NZB file.' });
        const boundary = '----aurora' + crypto.randomBytes(8).toString('hex');
        const payload = `--${boundary}\r\nContent-Disposition: form-data; name="name"; filename="${name}"\r\nContent-Type: application/x-nzb\r\n\r\n${raw.toString('utf8')}\r\n--${boundary}--\r\n`;
        const j = await sabCall({ mode: 'addfile' }, { method: 'POST', body: payload, headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary } });
        if (j.status === false) return send(res, 400, { error: 'SABnzbd did not accept that file.' });
        recordAudit(auditBy, `Added the file ${name} to SABnzbd`); saveStore();
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/sab/pause' || url.pathname === '/sab/resume') {
        await sabCall({ mode: url.pathname === '/sab/pause' ? 'pause' : 'resume' });
        return send(res, 200, { ok: true });
      }
      if (url.pathname === '/sab/item') {
        const id = String(body.id || ''), act = String(body.action || ''), kind = body.kind === 'history' ? 'history' : 'queue';
        if (!/^[\w-]{3,80}$/.test(id)) return send(res, 400, { error: 'Not a valid download.' });
        if (!['pause', 'resume', 'delete'].includes(act) || (kind === 'history' && act !== 'delete')) return send(res, 400, { error: 'Not a valid action.' });
        await sabCall({ mode: kind, name: act, value: id, ...(act === 'delete' ? { del_files: '1' } : {}) });
        if (act === 'delete') { recordAudit(auditBy, `Removed a download from SABnzbd${kind === 'history' ? ' history' : ''}`); saveStore(); }
        return send(res, 200, { ok: true });
      }
    } catch (e) { return send(res, 502, { error: e.message }); }
    return send(res, 404, { error: 'Not found' });
  }
  if (url.pathname === '/feature-requests' && req.method === 'GET') return send(res, 200, { requests: store.featureRequests || [] });
  {
    const fr = url.pathname.match(/^\/feature-requests\/([0-9a-f]{10})$/);
    if (fr && (req.method === 'PUT' || req.method === 'DELETE')) {
      const list = store.featureRequests || [], item = list.find((x) => x.id === fr[1]);
      if (!item) return send(res, 404, { error: 'No such request' });
      if (req.method === 'DELETE') { store.featureRequests = list.filter((x) => x.id !== fr[1]); saveStore(); recordAudit(auditBy, 'Deleted a feature request'); return send(res, 200, { ok: true }); }
      let body;
      try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
      if (!['new', 'planned', 'done', 'declined'].includes(body.status)) return send(res, 400, { error: 'Unknown status' });
      item.status = body.status; saveStore();
      return send(res, 200, { ok: true, request: item });
    }
  }
  if (url.pathname === '/survey/results' && req.method === 'GET') return send(res, 200, { responses: store.surveys || [] });
  if (url.pathname === '/survey/results' && req.method === 'DELETE') {
    const id = String(url.searchParams.get('id') || '');
    const before = (store.surveys || []).length; store.surveys = (store.surveys || []).filter((x) => x.id !== id);
    if (store.surveys.length === before) return send(res, 404, { error: 'No such response' });
    saveStore(); recordAudit(auditBy, 'Deleted a survey response'); return send(res, 200, { ok: true });
  }
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
        .sort((a, b) => b.at - a.at).map((v) => ({ ip: mod ? maskIp(v.ip) : v.ip, local: !!v.local, device: v.device || '', last: new Date(v.at).toISOString(), seen: v.n })) };
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
    const pendingExt = (store.extensions || []).filter((e) => e.status === 'pending' && needsAdmin(e)).length;
    const requests = (store.creditRequests || []).filter((x) => x.status === 'pending').length;
    const tickets = (store.tickets || []).filter((t) => t.status === 'open' && t.unseen).length;
    const low = Object.values(resellerList()).filter((r) => r.status === 'active' && r.credits <= cfg.resellerLowCredits).map((r) => ({ id: r.id, name: r.name, credits: r.credits }));
    if (mod) return send(res, 200, { total: tickets, extensions: 0, creditRequests: 0, tickets, lowResellers: [] });
    if (store.resellerPin && !pinIsUnlocked(token)) return send(res, 200, { total: pendingExt + tickets, extensions: pendingExt, creditRequests: 0, tickets, lowResellers: [], locked: true }); // credit requests wait behind the Reseller PIN
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

  // Clean-up of old accounts (guard 1.38.0): customers whose end date is at least N days in the past. Administrators, moderators and
  // resellers are never listed, and an account with no end date never expires, so it is never listed either. The list is a preview;
  // deleting only touches the ids sent, and each one is checked again first. Behind the Admin PIN like the rest of Users.
  if (url.pathname === '/limits/expired' && (req.method === 'GET' || req.method === 'POST')) {
    const expiredFor = async (days) => {
      const cutoff = addDays(localDay(new Date()), -days), users = (await emby('GET', '/Users')) || [], out = [];
      for (const u of users) {
        const rec = store.users[u.Id];
        if (!rec || !rec.expires || rec.expires > cutoff) continue;
        if (u.Policy?.IsAdministrator || rec.mod || resellerOfUser(u.Id)) continue;
        const rs = rec.reseller ? resellerList()[rec.reseller] : null;
        out.push({ id: u.Id, name: u.Name, expires: rec.expires, daysAgo: Math.round((new Date(localDay(new Date()) + 'T12:00:00') - new Date(rec.expires + 'T12:00:00')) / 86400000), trial: !!rec.trial, reseller: rs ? rs.name : null });
      }
      return out.sort((a, b) => a.expires.localeCompare(b.expires));
    };
    if (req.method === 'GET') {
      const days = Math.max(1, Math.min(3650, parseInt(url.searchParams.get('days'), 10) || 30));
      return send(res, 200, { days, users: await expiredFor(days) });
    }
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    const days = Math.max(1, Math.min(3650, parseInt(body.days, 10) || 30)), ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 2000) : [];
    if (!ids.length) return send(res, 400, { error: 'Choose at least one account.' });
    const ok = new Map((await expiredFor(days)).map((x) => [x.id, x])), gone = [], failed = [];
    for (const id of ids) {
      const x = ok.get(id);
      if (!x) { failed.push({ id, error: 'No longer qualifies' }); continue; }
      try { await emby('DELETE', `/Users/${id}`); } catch (e) { if (e.status !== 404) { failed.push({ id, name: x.name, error: e.message }); continue; } }
      delete store.users[id]; delete store.disabledByGuard[id]; delete store.firstSeen[id];
      gone.push(x.name);
    }
    if (gone.length) { recordAudit(auditBy, `Deleted ${gone.length} account${gone.length === 1 ? '' : 's'} that ended ${days}+ days ago: ${gone.join(', ')}`); saveStore(); }
    return send(res, 200, { ok: true, deleted: gone.length, failed });
  }
  if (url.pathname === '/limits' && req.method === 'GET') {
    return send(res, 200, {
      defaultLimit: cfg.defaultLimit, dryRun: !!cfg.dryRun, users: store.users, remindDefault: remindDefault(),
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
    const list = (store.extensions || []).map((x) => ({ ...x, currentExpires: store.users[x.userId]?.expires || null, resellerName: x.reseller && resellerList()[x.reseller] ? resellerList()[x.reseller].name : '', needsAdmin: needsAdmin(x) }));
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
  // The provider's movies and TV shows: one customer, or everyone at once ({ on: true | false }).
  const vm = url.pathname.match(/^\/limits\/([\w-]{1,64})\/vod$/);
  if (vm && req.method === 'PUT') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    let user;
    try { user = await emby('GET', `/Users/${vm[1]}`); } catch (e) { return send(res, e.status === 404 ? 404 : 502, { error: e.status === 404 ? 'No such user' : e.message }); }
    const rec = store.users[vm[1]] || (store.users[vm[1]] = { limit: cfg.defaultLimit, expires: null, name: user.Name, updated: Date.now() });
    rec.vod = body.on === true; rec.updated = Date.now();
    recordAudit(auditBy, `${rec.vod ? 'Switched on' : 'Switched off'} provider movies and TV for ${user.Name}`); saveStore();
    return send(res, 200, { ok: true, vod: rec.vod });
  }
  // Adult Live TV categories for one customer (guard 1.23.0). Switching it either way also clears their PIN (they choose a new one).
  const am = url.pathname.match(/^\/limits\/([\w-]{1,64})\/adult$/);
  if (am && req.method === 'PUT') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    let user;
    try { user = await emby('GET', `/Users/${am[1]}`); } catch (e) { return send(res, e.status === 404 ? 404 : 502, { error: e.status === 404 ? 'No such user' : e.message }); }
    const rec = store.users[am[1]] || (store.users[am[1]] = { limit: cfg.defaultLimit, expires: null, name: user.Name, updated: Date.now() });
    const on = body.on === true;
    if (!!rec.adult !== on) rec.adultReset = Date.now();
    rec.adult = on; rec.updated = Date.now();
    recordAudit(auditBy, `${on ? 'Switched on' : 'Switched off'} adult channels for ${user.Name}`); saveStore();
    return send(res, 200, { ok: true, adult: rec.adult });
  }
  // Make an account a moderator, or take it back (guard 1.27.0). Admins only.
  const modm = url.pathname.match(/^\/limits\/([\w-]{1,64})\/mod$/);
  if (modm && req.method === 'PUT') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    let user;
    try { user = await emby('GET', `/Users/${modm[1]}`); } catch (e) { return send(res, e.status === 404 ? 404 : 502, { error: e.status === 404 ? 'No such user' : e.message }); }
    const on = body.on === true;
    if (on && user.Policy?.IsAdministrator) return send(res, 400, { error: 'That account is already an administrator.' });
    if (on && resellerOfUser(user.Id)) return send(res, 400, { error: 'A reseller can\'t also be a moderator.' });
    const rec = store.users[modm[1]] || (store.users[modm[1]] = { limit: cfg.defaultLimit, expires: null, name: user.Name, updated: Date.now() });
    if (on) rec.mod = true; else delete rec.mod;
    rec.updated = Date.now();
    identityCache.clear();
    recordAudit(auditBy, `${on ? 'Made' : 'Removed'} ${user.Name} ${on ? 'a moderator' : 'as a moderator'}`); saveStore();
    return send(res, 200, { ok: true, mod: !!rec.mod });
  }
  // Make an account an Emby administrator, or take that away (guard 1.35.0). Behind the Reseller PIN when one is set.
  const adm = url.pathname.match(/^\/limits\/([\w-]{1,64})\/admin$/);
  if (adm && req.method === 'PUT') {
    if (mod) return send(res, 403, { error: "That isn't available to moderators." });
    if (store.resellerPin && !pinIsUnlocked(token)) return send(res, 423, { error: 'Enter the Admin PIN to add or remove an administrator.', pinRequired: true });
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    let user, me;
    try { user = await emby('GET', `/Users/${adm[1]}`); } catch (e) { return send(res, e.status === 404 ? 404 : 502, { error: e.status === 404 ? 'No such user' : e.message }); }
    try { me = await emby('GET', '/Users/Me', { token }); } catch { me = null; }
    const on = body.on === true, already = !!user.Policy?.IsAdministrator;
    if (on === already) return send(res, 200, { ok: true, admin: already });
    if (on) {
      if (resellerOfUser(user.Id)) return send(res, 400, { error: "A reseller can't also be an administrator." });
    } else {
      if (me && me.Id === user.Id) return send(res, 400, { error: "You can't remove your own administrator access." });
      const admins = ((await emby('GET', '/Users').catch(() => [])) || []).filter((u) => u.Policy?.IsAdministrator && !u.Policy?.IsDisabled);
      if (admins.filter((u) => u.Id !== user.Id).length < 1) return send(res, 400, { error: 'There has to be at least one administrator.' });
    }
    try { await emby('POST', `/Users/${user.Id}/Policy`, { body: { ...(user.Policy || {}), IsAdministrator: on } }); } catch (e) { return send(res, 502, { error: 'Emby would not change it: ' + e.message }); }
    const rec = store.users[user.Id];
    if (on && rec && rec.mod) { delete rec.mod; rec.updated = Date.now(); } // an administrator needs no moderator flag
    adminCache.clear(); identityCache.clear();
    recordAudit(auditBy, `${on ? 'Made' : 'Removed'} ${user.Name} ${on ? 'an administrator' : 'as an administrator'}`); saveStore();
    return send(res, 200, { ok: true, admin: on });
  }
  // Reminder days for one customer (guard 1.26.0): { days: [10, 5, 2] }, or { days: null } to use the default.
  const rmm = url.pathname.match(/^\/limits\/([\w-]{1,64})\/remind$/);
  if (rmm && req.method === 'PUT') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    let user;
    try { user = await emby('GET', `/Users/${rmm[1]}`); } catch (e) { return send(res, e.status === 404 ? 404 : 502, { error: e.status === 404 ? 'No such user' : e.message }); }
    const rec = store.users[rmm[1]] || (store.users[rmm[1]] = { limit: cfg.defaultLimit, expires: null, name: user.Name, updated: Date.now() });
    if (body.days === null) delete rec.remind;
    else { const days = cleanDays(body.days); if (!days) return send(res, 400, { error: 'Give 1 to 5 reminder days, each between 1 and 60.' }); rec.remind = days; }
    rec.updated = Date.now();
    recordAudit(auditBy, rec.remind ? `Set reminders for ${user.Name} to ${rec.remind.join(', ')} days before the end` : `Reminders for ${user.Name} follow the default`); saveStore();
    return send(res, 200, { ok: true, remind: rec.remind || null, remindDefault: remindDefault() });
  }
  // How this customer's viewing has gone for the last 7 days, next to everyone else's (guard 1.32.0).
  const qm = url.pathname.match(/^\/limits\/([\w-]{1,64})\/quality$/);
  if (qm && req.method === 'GET') return send(res, 200, await qualityReport(qm[1]));
  // The default for everyone who has no list of their own.
  if (url.pathname === '/remind-default' && (req.method === 'PUT' || req.method === 'GET')) {
    if (req.method === 'GET') return send(res, 200, { days: remindDefault() });
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    if (body.days === null) delete store.remindDefault;
    else { const days = cleanDays(body.days); if (!days) return send(res, 400, { error: 'Give 1 to 5 reminder days, each between 1 and 60.' }); store.remindDefault = days; }
    recordAudit(auditBy, `Set the default reminder days to ${remindDefault().join(', ')}`); saveStore();
    return send(res, 200, { ok: true, days: remindDefault() });
  }
  if (url.pathname === '/vod/all' && req.method === 'POST') {
    let body;
    try { body = await readBody(req); } catch (e) { return send(res, 400, { error: e.message }); }
    let users;
    try { users = await emby('GET', '/Users'); } catch (e) { return send(res, 502, { error: e.message }); }
    let n = 0;
    for (const u of users || []) {
      if (u.Policy?.IsAdministrator || resellerOfUser(u.Id)) continue; // administrators and resellers aren't customers here
      if (!store.users[u.Id] && body.on !== true) continue; // nothing to turn off, so no record is made
      const rec = store.users[u.Id] || (store.users[u.Id] = { limit: cfg.defaultLimit, expires: null, name: u.Name, updated: Date.now() });
      if (!!rec.vod !== (body.on === true)) { rec.vod = body.on === true; rec.updated = Date.now(); n++; }
    }
    recordAudit(auditBy, `${body.on === true ? 'Switched on' : 'Switched off'} provider movies and TV for everyone (${n} changed)`); saveStore();
    return send(res, 200, { ok: true, changed: n });
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
  if (cfg.updateCheck !== false) { setTimeout(() => checkForUpdate().catch(() => {}), 6000); setInterval(() => checkForUpdate().catch(() => {}), 24 * 3600000).unref(); }
  setTimeout(() => maybeSendSummary().catch(() => {}), 20000); setInterval(() => maybeSendSummary().catch(() => {}), 60000);
  setTimeout(() => syncRequestsUsers().catch(() => {}), 25000); setInterval(() => syncRequestsUsers().catch(() => {}), 2 * 60000).unref();
  setTimeout(() => endingTick().catch(() => {}), 40000); setInterval(() => endingTick().catch(() => {}), 30 * 60000).unref();
  setTimeout(() => pollSports(false).catch((e) => log('Sports scores failed:', e.message)), 4000);
  setInterval(() => pollSports(false).catch((e) => log('Sports scores failed:', e.message)), 15000);
}

// node aurora-guard.js --test-alert: sends one test message to alertWebhookUrl and says whether it arrived.
// node aurora-guard.js --test-summary: sends yesterday's summary to the webhook now and says whether it arrived.
async function testSummary() {
  if (!cfg.alertWebhookUrl) { console.log('No "alertWebhookUrl" is set in config.json, so there is nowhere to send the summary.'); process.exit(1); }
  const r = await sendSummary();
  console.log(r.ok ? `OK: the webhook accepted it (${r.status}).` : `FAILED: ${r.status ? 'the webhook answered ' + r.status : r.error}`);
  process.exit(r.ok ? 0 : 1);
}
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

if (require.main === module) { if (process.argv.includes('--check')) selfCheck(); else if (process.argv.includes('--test-alert')) testAlert(); else if (process.argv.includes('--test-summary')) testSummary(); else if (process.argv.includes('--test-scores')) testScores(); else start(); }
module.exports = { enforce, isExpired, activeByUser, normalizeSportsEvent };
