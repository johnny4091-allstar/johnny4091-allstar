/* Aurora — a Netflix-style web client for Emby. Plain JS, no build step. */
(() => {
  'use strict';

  const DEFAULT_SERVER = 'https://emby4836.duckdns.org:8920';
  // Requests (Jellyseerr) are switched on and pointed at a server from aurora-config.json in the GitHub repo
  // (see loadRemoteConfig), so both can change without a new APK. Until then the tab says "Coming soon".
  const REMOTE_CONFIG_URLS = ['main', 'ccr-ab072e58-qfaibp']
    .map((branch) => `https://raw.githubusercontent.com/johnny4091-allstar/johnny4091-allstar/${branch}/aurora-config.json`);
  const TICKS_PER_SECOND = 10000000;
  const ITEM_FIELDS = 'Overview,Genres,ProductionYear,OfficialRating,CommunityRating,RunTimeTicks,PrimaryImageAspectRatio,DateCreated';
  const IMAGE_PARAMS = { EnableImageTypes: 'Primary,Backdrop,Thumb,Logo', ImageTypeLimit: 1 };

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ---------- Storage ----------
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  // apiKey holds the signed-in user's access token from /Users/AuthenticateByName.
  const state = { server: DEFAULT_SERVER, requestsServer: '', requestsEnabled: false, apiKey: '', userId: '', user: null, deviceId: '', views: [] };
  const CLIENT = { name: 'Aurora', version: '1.2.0' };
  // Set by the Android wrapper (android/); undefined in a normal browser.
  const nativeApp = window.EmbyFlixAndroid || null;

  // Customers only ever see "Aurora": where the media server's own name (or its web address) would appear in a
  // message, a log line or a release note, it says Aurora (or "the server") instead. Admin screens, which only
  // administrators can open, keep the real names because their instructions refer to the server's dashboard.
  const brand = (t) => String(t ?? '')
    .replace(/https?:\/\/[^\s"')<>]*emby[^\s"')<>]*/gi, 'the server')
    .replace(/\bEmby(?:Flix)?\b/gi, 'Aurora');

  // Errors and warnings go to the admins by themselves (Admin → Feedback → Automatic reports): a few seconds
  // after the first one, in one report with what led up to it. The same problem is reported at most once an
  // hour, reports are at least two minutes apart, and a device sends no more than 20 a day.
  const problems = {
    queue: [], timer: null, sentAt: 0, sending: false,
    WAIT: 20000, GAP: 120000, DAILY: 20, KEEP: 30,
    key: (msg) => String(msg).replace(/\d+/g, '#').slice(0, 120),
    note(e) {
      if (this.sending) return; // problems while sending a report (say, no connection) aren't reported again
      let seen = {};
      try { seen = JSON.parse(localStorage.getItem('ef.problemsSeen') || '{}'); } catch { /* start afresh */ }
      const k = this.key(e.msg);
      if (seen[k] && e.t - seen[k] < 3600000) return;
      if (this.queue.some((q) => this.key(q.msg) === k) || this.queue.length >= 25) return;
      this.queue.push(e);
      this.schedule(this.WAIT);
    },
    schedule(ms) {
      if (this.timer) return;
      this.timer = setTimeout(() => { this.timer = null; this.flush(); }, Math.max(ms, this.sentAt + this.GAP - Date.now()));
    },
  };

  // A small log of errors and notable events on this device, shown in the admin dashboard.
  const appLog = {
    KEY: 'ef.appLog', MAX: 300,
    read() {
      try { return JSON.parse(localStorage.getItem(this.KEY) || '[]').map((e) => ({ ...e, msg: brand(e.msg) })); } catch { return []; }
    },
    add(level, msg) {
      try {
        const list = this.read();
        const entry = { t: Date.now(), level, msg: brand(msg).slice(0, 600) };
        list.push(entry);
        localStorage.setItem(this.KEY, JSON.stringify(list.slice(-this.MAX)));
        if (level === 'error' || level === 'warn') problems.note(entry);
      } catch { /* storage full or blocked */ }
    },
    clear() { try { localStorage.removeItem(this.KEY); } catch { /* ignore */ } },
  };
  // Playback problems for Admin → Playback problems: a video that wouldn't play, one that kept stopping to buffer,
  // a live channel that failed. Kept in the viewer's own Emby display preferences ("aurora-playlog"), so the admin
  // page can read every account's. Written a few seconds after the event, together with any others.
  const deviceLabel = () => nativeApp?.getDeviceName?.() || (/Mobi|Android/i.test(navigator.userAgent) ? 'Mobile browser' : 'Web browser');
  const playLog = {
    PREFS: 'aurora-playlog', KEEP: 60, DAYS: 14, queue: [], timer: null,
    add(e) {
      try {
        this.queue.push({ t: Date.now(), device: deviceLabel(), version: nativeApp?.getVersionName?.() || 'web', ...e });
        if (this.queue.length > 20) this.queue.splice(0, this.queue.length - 20);
        clearTimeout(this.timer);
        this.timer = setTimeout(() => this.flush(), 5000);
      } catch { /* never get in the way of playback */ }
    },
    async flush() {
      this.timer = null;
      if (!this.queue.length) return;
      if (!state.userId || !state.apiKey) { this.timer = setTimeout(() => this.flush(), 60000); return; }
      const items = this.queue.splice(0);
      try {
        // A failed read must not count as "nothing saved yet": writing then would wipe the earlier entries.
        const data = await readAuroraPref(this.PREFS);
        const cutoff = Date.now() - this.DAYS * 86400000;
        const kept = [...items].reverse().concat(data?.items || []).filter((x) => (x.t || 0) > cutoff).slice(0, this.KEEP);
        await writeAuroraPref(this.PREFS, state.userId, { items: kept });
      } catch {
        this.queue = [...items, ...this.queue].slice(-20);
        this.timer = setTimeout(() => this.flush(), 5 * 60000);
      }
    },
  };
  const itemTitle = (it) => (it?.Type === 'Episode' ? `${it.SeriesName || ''} ${episodeLabel(it)}`.trim() : it?.Name || '');

  {
    const describe = (args) => args.map((a) => (a instanceof Error ? a.message : typeof a === 'object' ? (() => { try { return JSON.stringify(a); } catch { return String(a); } })() : String(a))).join(' ');
    const origError = console.error.bind(console), origWarn = console.warn.bind(console);
    console.error = (...args) => { appLog.add('error', describe(args)); origError(...args); };
    console.warn = (...args) => { appLog.add('warn', describe(args)); origWarn(...args); };
    window.addEventListener('error', (e) => appLog.add('error', `${e.message} (${(e.filename || '').split('/').pop()}:${e.lineno})`));
    window.addEventListener('unhandledrejection', (e) => appLog.add('error', 'Unhandled: ' + (e.reason?.message || e.reason)));
  }

  function loadConfig() {
    // Older versions could store an admin API key and a custom server; drop those.
    if (store.get('ef.authMode') === 'key') ['ef.apiKey', 'ef.userId'].forEach(store.del);
    ['ef.authMode', 'ef.server'].forEach(store.del);
    state.apiKey = store.get('ef.apiKey') || '';
    state.requestsServer = store.get('ef.requestsServer') || '';
    state.requestsEnabled = store.get('ef.requestsEnabled') === '1';
    state.userId = store.get('ef.userId') || '';
    let deviceId = store.get('ef.deviceId');
    if (!deviceId) {
      deviceId = 'embyflix-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      store.set('ef.deviceId', deviceId);
    }
    state.deviceId = deviceId;
  }

  // ---------- Helpers ----------
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function formatRuntime(ticks) {
    if (!ticks) return '';
    const mins = Math.round(ticks / TICKS_PER_SECOND / 60);
    const h = Math.floor(mins / 60), m = mins % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
  }

  function episodeLabel(item) {
    const s = item.ParentIndexNumber, e = item.IndexNumber;
    if (s == null && e == null) return item.Name || '';
    return `S${s ?? '?'}:E${e ?? '?'} ${item.Name || ''}`.trim();
  }

  let toastTimer;
  function toast(msg, ms = 3500) {
    const el = $('#toast');
    el.textContent = brand(msg);
    el.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add('hidden'), ms);
  }

  function shuffle(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---------- Emby API ----------
  function apiUrl(path, params = {}) {
    const url = new URL(state.server + '/emby' + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
    }
    if (state.apiKey) url.searchParams.set('api_key', state.apiKey);
    return url.toString();
  }

  // keepalive lets a request finish even if the app is being closed or sent to the background.
  const API_TIMEOUT_MS = 30000;
  async function api(path, { params, method = 'GET', body, keepalive = false } = {}) {
    const opts = { method, keepalive, headers: { Accept: 'application/json', 'X-Emby-Authorization': authHeader() } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    // A server that accepts the connection but never answers must not leave a spinner up for ever.
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), API_TIMEOUT_MS);
    opts.signal = ctrl.signal;
    let res;
    try { res = await fetch(apiUrl(path, params), opts); }
    catch (e) { throw e.name === 'AbortError' ? Object.assign(new Error('The server took too long to answer. Check the connection and try again.'), { path, timeout: true }) : e; }
    finally { clearTimeout(timer); }
    if (!res.ok) {
      const err = new Error(`Aurora returned ${res.status} ${res.statusText}`);
      err.status = res.status;
      err.path = path;
      // This device's sign-in was revoked (an admin signed it out, or the account was disabled).
      if (res.status === 401 && state.userId && !path.startsWith('/Users/AuthenticateByName')) signedOutElsewhere();
      throw err;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  let signingOut = false;
  function signedOutElsewhere() {
    if (signingOut) return;
    signingOut = true;
    const name = state.user?.Name || '';
    appLog.add('warn', 'This device was signed out by the server');
    if (state.userId) removeAccount(state.userId);
    state.apiKey = ''; state.userId = ''; state.user = null;
    store.del('ef.apiKey'); store.del('ef.userId');
    if (isPlayerOpen()) closePlayer().catch(() => {});
    showSetup('This device was signed out. Sign in again to continue.');
    if (name) $('#setup-username').value = name;
    setTimeout(() => { signingOut = false; }, 3000);
  }

  // Header values must be plain ASCII without quotes or commas.
  const hdr = (v) => String(v).replace(/[^\x20-\x7E]|[",\\]/g, ' ').replace(/\s+/g, ' ').trim();

  function authHeader() {
    // The Android app reports its real model and version so they show in the admin dashboard and Emby's.
    const device = nativeApp?.getDeviceName?.() || (/Mobi|Android/i.test(navigator.userAgent) ? 'Mobile Browser' : 'Web Browser');
    const version = nativeApp?.getVersionName?.() || CLIENT.version;
    return `Emby UserId="${state.userId || ''}", Client="${CLIENT.name}", Device="${hdr(device)}", DeviceId="${state.deviceId}", Version="${hdr(version)}"`;
  }

  const userPath = (p) => `/Users/${state.userId}${p}`;

  function getItems(params) {
    return api(userPath('/Items'), { params: { Recursive: true, Fields: ITEM_FIELDS, ...IMAGE_PARAMS, ...params } });
  }

  function getItem(id) {
    return api(userPath(`/Items/${id}`), { params: { Fields: ITEM_FIELDS + ',People,Studios,Taglines,ChildCount,RemoteTrailers' } });
  }

  function imageUrl(id, type, { tag, maxWidth, maxHeight, index } = {}) {
    if (!id) return '';
    const path = `/Items/${id}/Images/${type}` + (index != null ? `/${index}` : '');
    // A little lighter than Emby's 90 (a third smaller files, no visible difference), so rows fill faster.
    return apiUrl(path, { tag, maxWidth, maxHeight, quality: maxWidth && maxWidth <= 600 ? 80 : 85 });
  }
  // Big backgrounds no wider than the screen's real pixels (a phone doesn't need a 1920-wide picture).
  const SCREEN_W = Math.min(1920, Math.max(640, Math.ceil((Math.max(screen.width || 0, screen.height || 0) * (window.devicePixelRatio || 1)) / 320) * 320 || 1920));

  function landscapeImage(item, w = 500) {
    const t = item.ImageTags || {};
    if (t.Thumb) return imageUrl(item.Id, 'Thumb', { tag: t.Thumb, maxWidth: w });
    if (item.Type === 'Episode' && t.Primary) return imageUrl(item.Id, 'Primary', { tag: t.Primary, maxWidth: w });
    if (item.BackdropImageTags?.length) return imageUrl(item.Id, 'Backdrop', { tag: item.BackdropImageTags[0], maxWidth: w, index: 0 });
    if (item.ParentThumbItemId && item.ParentThumbImageTag) return imageUrl(item.ParentThumbItemId, 'Thumb', { tag: item.ParentThumbImageTag, maxWidth: w });
    if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.length) return imageUrl(item.ParentBackdropItemId, 'Backdrop', { tag: item.ParentBackdropImageTags[0], maxWidth: w, index: 0 });
    if (t.Primary) return imageUrl(item.Id, 'Primary', { tag: t.Primary, maxWidth: w });
    if (item.SeriesId && item.SeriesPrimaryImageTag) return imageUrl(item.SeriesId, 'Primary', { tag: item.SeriesPrimaryImageTag, maxWidth: w });
    return '';
  }

  function backdropImage(item, w = SCREEN_W) {
    if (item.BackdropImageTags?.length) return imageUrl(item.Id, 'Backdrop', { tag: item.BackdropImageTags[0], maxWidth: w, index: 0 });
    if (item.ParentBackdropItemId && item.ParentBackdropImageTags?.length) return imageUrl(item.ParentBackdropItemId, 'Backdrop', { tag: item.ParentBackdropImageTags[0], maxWidth: w, index: 0 });
    return landscapeImage(item, w);
  }

  function logoImage(item, w = 600) {
    if (item.ImageTags?.Logo) return imageUrl(item.Id, 'Logo', { tag: item.ImageTags.Logo, maxWidth: w });
    if (item.ParentLogoItemId && item.ParentLogoImageTag) return imageUrl(item.ParentLogoItemId, 'Logo', { tag: item.ParentLogoImageTag, maxWidth: w });
    return '';
  }

  function posterImage(item, w = 360) {
    if (item.ImageTags?.Primary) return imageUrl(item.Id, 'Primary', { tag: item.ImageTags.Primary, maxWidth: w });
    if (item.SeriesId && item.SeriesPrimaryImageTag) return imageUrl(item.SeriesId, 'Primary', { tag: item.SeriesPrimaryImageTag, maxWidth: w });
    return '';
  }

  function avatarInfo(user) {
    const colors = ['#18b6d6', '#4f7bff', '#7a5cff', '#2ad4a0', '#c05cff', '#3a8dde'];
    const name = user.Name || '?';
    return {
      color: colors[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length],
      initial: name[0].toUpperCase(),
      image: user.PrimaryImageTag ? apiUrl(`/Users/${user.Id}/Images/Primary`, { tag: user.PrimaryImageTag, maxWidth: 300 }) : '',
    };
  }

  // ---------- Splash ----------
  // Stays up for 10 seconds while its loading bar fills, then fades into the first screen.
  const SPLASH_MIN = 10000, SPLASH_MAX = 10000;
  let splashDone = false;
  // Android may stop the app's page to free memory while the native live TV player is in front, and the app
  // then loads it again. That's no time for the opening screen: go straight back to where the viewer was.
  const liveReturn = (() => {
    try {
      const r = JSON.parse(store.get('ef.liveReturn') || 'null');
      return r && Date.now() - r.t < 6 * 3600000 ? r : null;
    } catch { return null; }
  })();
  if (liveReturn) {
    splashDone = true;
    $('#splash')?.remove();
  }
  function hideSplash() {
    if (splashDone) return;
    splashDone = true;
    const el = $('#splash');
    if (!el) return;
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => el.remove(), 600);
      if (nav.on && (!document.activeElement || document.activeElement === document.body)) focusInitial();
    }, Math.max(0, SPLASH_MIN - performance.now()));
  }

  // Home is ready once the hero or a row has something in it (or after a few seconds regardless).
  // The intro sound, timed to the splash animation. Android lets it play without a tap; a normal browser may not.
  function playSplashSound() {
    if (store.get('ef.pref.splashSound') === 'off' || document.hidden) return;
    try {
      const audio = new Audio('sounds/aurora-intro.mp3');
      audio.volume = 0.7;
      audio.play().catch(() => { /* blocked until the page is tapped; stay quiet */ });
      // Going straight to another app shouldn't leave it playing.
      document.addEventListener('visibilitychange', () => { if (document.hidden) audio.pause(); }, { once: true });
    } catch { /* no audio support */ }
  }

  function hideSplashWhenHomeReady() {
    const t0 = Date.now();
    const check = () => {
      if (splashDone) return;
      if ($('.hero-content, .hero.empty, .row-track .card, #page .grid > *, #page .empty-msg') || Date.now() - t0 > 4000) hideSplash();
      else setTimeout(check, 100);
    };
    check();
  }

  // ---------- Screens ----------
  function showScreen(name) {
    $('#setup').classList.toggle('hidden', name !== 'setup');
    $('#main').classList.toggle('hidden', name !== 'main');
  }

  function showSetup(errorMsg) {
    closeModal();
    showScreen('setup');
    hideSplash();
    $('#setup-password').value = '';
    const err = $('#setup-error');
    err.textContent = errorMsg || '';
    err.classList.toggle('hidden', !errorMsg);
    renderAccountTiles();
    if (nav.on) focusInitial($('#setup'));
  }

  // Accounts that have signed in on this device, so people can switch without retyping passwords.
  function getAccounts() {
    try { return JSON.parse(store.get('ef.accounts') || '[]'); } catch { return []; }
  }
  function saveAccounts(list) { store.set('ef.accounts', JSON.stringify(list)); }
  function upsertAccount(user, token) {
    const old = getAccounts().find((a) => a.userId === user.Id);
    const list = getAccounts().filter((a) => a.userId !== user.Id);
    list.push({
      userId: user.Id, name: user.Name, imageTag: user.PrimaryImageTag || '', token,
      requestsCookie: old?.requestsCookie || '', loginName: old?.loginName || '', secret: old?.secret || '',
    });
    saveAccounts(list);
  }
  function removeAccount(userId) { saveAccounts(getAccounts().filter((a) => a.userId !== userId)); }

  function renderAccountTiles() {
    const wrap = $('#account-tiles'), accounts = getAccounts();
    wrap.classList.toggle('hidden', !accounts.length);
    $('#setup-title').textContent = accounts.length ? "Who's watching?" : 'Sign In';
    $('#setup-form-title').classList.toggle('hidden', !accounts.length);
    wrap.innerHTML = accounts.map((a, i) => {
      const av = avatarInfo({ Id: a.userId, Name: a.name, PrimaryImageTag: a.imageTag });
      const style = av.image ? `background-image:url('${esc(av.image)}')` : `background:${av.color}`;
      return `<button class="user-tile" data-i="${i}"${i === 0 ? ' data-autofocus' : ''}>
        <span class="avatar" style="${style}">${av.image ? '' : esc(av.initial)}</span>
        <span class="user-name">${esc(a.name)}</span>
      </button>`;
    }).join('');
    $$('.user-tile', wrap).forEach((btn) => btn.addEventListener('click', () => switchToAccount(accounts[btn.dataset.i])));
  }

  async function switchToAccount(account) {
    state.apiKey = account.token;
    state.userId = account.userId;
    try {
      const user = await api(`/Users/${account.userId}`);
      store.set('ef.apiKey', state.apiKey);
      await selectUser(user);
      upsertAccount(user, account.token);
    } catch (e) {
      state.apiKey = ''; state.userId = '';
      if (e.status === 401 || e.status === 403) {
        removeAccount(account.userId);
        showSetup(`Please sign in again as ${account.name}.`);
        $('#setup-username').value = account.name;
      } else {
        showSetup(connectionErrorMessage(e));
      }
    }
  }

  async function signIn(username, password) {
    state.apiKey = '';
    state.userId = '';
    const res = await api('/Users/AuthenticateByName', { method: 'POST', body: { Username: username, Pw: password } });
    if (!res?.AccessToken || !res.User) throw new Error('Unexpected response from server');
    state.apiKey = res.AccessToken;
    store.set('ef.apiKey', state.apiKey);
    store.set('ef.username', username);
    upsertAccount(res.User, res.AccessToken);
    rememberLogin(res.User.Id, username, password);
    // Connect Requests with the same details in the background.
    if (hasRequests()) seerrLogin(username, password, res.User.Id).catch(() => {});
    return res.User;
  }

  // Leaves this account signed in on the device and goes back to the account picker.
  function switchUser() {
    state.apiKey = ''; state.userId = '';
    store.del('ef.apiKey'); store.del('ef.userId');
    $('#setup-username').value = '';
    showSetup();
  }

  async function signOut() {
    if (hasRequests() && requestsCookie()) seerr('/auth/logout', { method: 'POST' }).catch(() => {});
    if (state.apiKey) {
      await api('/Sessions/Logout', { method: 'POST' }).catch(() => {});
      state.apiKey = '';
      store.del('ef.apiKey');
    }
    removeAccount(state.userId);
    state.userId = '';
    store.del('ef.userId');
    showSetup();
  }

  // If the Android app closed unexpectedly last time, it saved the details. Keep them in the app log and send
  // them to Emby's server logs (Admin → Server logs), where the admin can see them from any device.
  (() => {
    let crash = '';
    try { crash = nativeApp?.getLastCrash?.() || ''; } catch { /* older app */ }
    if (crash) {
      appLog.add('error', 'Aurora closed unexpectedly: ' + crash.slice(0, 1500));
      store.set('ef.pendingCrash', crash);
    }
  })();
  function sendCrashReport() {
    const crash = store.get('ef.pendingCrash');
    if (!crash) return;
    fetch(apiUrl('/ClientLog/Document'), {
      method: 'POST',
      headers: { 'X-Emby-Authorization': authHeader(), 'Content-Type': 'text/plain' },
      body: `Aurora crash report · ${state.user?.Name || ''} · ${nativeApp?.getDeviceName?.() || ''}\n${crash}`,
    }).then((res) => { if (res.ok) store.del('ef.pendingCrash'); }).catch(() => {});
  }

  // Device limit and expiry (Admin → Users). Blocked: back to the sign-in screen, where the account's tile
  // stays so it can try again once another device has signed out.
  function blockAccount(user, blocked) {
    appLog.add('info', `Blocked ${user.Name}: ${blocked.message}`);
    if (isPlayerOpen()) closePlayer().catch(() => {});
    state.userId = ''; state.user = null;
    store.del('ef.userId');
    showSetup(blocked.message);
  }

  // fresh: the person just typed their password. Only then does the check hold things up (at most 3 s);
  // reopening the app or switching accounts goes straight to Home and checks in the background, because
  // the guard on the server enforces the limit either way.
  async function selectUser(user, { fresh = false } = {}) {
    state.userId = user.Id;
    state.user = user;
    access.okUntil = 0;
    if (fresh) {
      const blocked = await checkAccess(user, 'signin');
      if (blocked) return blockAccount(user, blocked);
    } else {
      checkAccess(user, 'signin').then((blocked) => { if (blocked && state.userId === user.Id) blockAccount(user, blocked); }).catch(() => {});
    }
    store.set('ef.userId', user.Id);
    const a = avatarInfo(user), btn = $('#profile-btn');
    btn.style.backgroundImage = a.image ? `url("${a.image}")` : '';
    btn.style.backgroundColor = a.image ? '' : a.color;
    btn.textContent = a.image ? '' : a.initial;
    btn.title = user.Name || '';
    // Tell Emby what this device is (it shows in the dashboard like Emby's own apps).
    api('/Sessions/Capabilities/Full', {
      method: 'POST',
      body: { PlayableMediaTypes: ['Video', 'Audio'], SupportedCommands: [], SupportsMediaControl: false, SupportsPersistentIdentifier: true },
    }).catch(() => {});
    sendCrashReport();
    try {
      const views = await api(userPath('/Views'));
      state.views = views?.Items || [];
    } catch { state.views = []; }
    loadIptvConfigLocal();
    $$('[data-route="livetv"]').forEach((a) => a.classList.toggle('hidden', !showLiveLink()));
    refreshRequestsConfig();
    refreshAppConfig();
    refreshIptvConfig().then(() => {
      topUpIptvConfig();
      // Get the TV guide ready in the background (after Home has settled) so the Guide opens quickly, but only
      // for people who've used Live TV lately: reading a big guide is real work for a TV box.
      const usedLive = Date.now() - Number(store.get('ef.iptv.used') || 0) < 14 * 86400000;
      if (iptvOn() && nativeApp?.loadEpg && usedLive) setTimeout(() => { if (iptvOn() && !isPlayerOpen()) loadIptvGuide().catch(() => {}); }, 20000);
      // If the Live TV source changed while the Live TV page or Home was showing, redraw it.
      if (/^#\/(livetv|home)?/.test(location.hash) && $('#page .iptv-page, #page .live-page') && !isPlayerOpen()) route();
    });
    updateRequestsLink();
    $('#profile-dropdown [data-action="admin"]').classList.toggle('hidden', !isAdmin());
    live.channelIds = [];
    // Measure the connection now, in the background, so the first Play doesn't wait for it.
    setTimeout(() => { if (!isPlayerOpen()) playbackBitrate().catch(() => {}); }, 15000);
    showScreen('main');
    if (!location.hash || location.hash === '#' || location.hash === '#/') location.hash = '#/home';
    else route();
  }

  function connectionErrorMessage(e) {
    if (e.status === 401 || e.status === 403) return 'Incorrect username or password, or the account has been disabled.';
    if (e.status) return `Server error: ${e.message}`;
    return 'Could not reach the Aurora server. Check your internet connection and try again.';
  }

  // ---------- Router ----------
  let routeToken = 0;

  let lastRouteAt = Date.now();
  function route() {
    if (!state.userId) return;
    lastRouteAt = Date.now();
    const hash = location.hash.replace(/^#\/?/, '');
    const [path, query] = hash.split('?');
    const params = new URLSearchParams(query || '');
    const name = path || 'home';
    const token = ++routeToken;

    $$('[data-route]').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
    window.scrollTo(0, 0);
    const page = $('#page');
    page.innerHTML = '';

    if (name !== 'search') {
      $('#search-input').value = '';
      $('#search-box').classList.remove('open');
    }

    const isCurrent = () => token === routeToken;
    switch (name) {
      case 'movies': return renderBrowse(page, { type: 'Movie', title: 'Movies', isCurrent });
      case 'tv': return renderBrowse(page, { type: 'Series', title: 'TV Shows', isCurrent });
      case 'mylist': return renderMyList(page, isCurrent);
      case 'search': return renderSearch(page, params.get('q') || '', isCurrent, params.get('person') || '', params.get('name') || '');
      case 'livetv': return iptvOn() ? renderIptvLive(page, params.get('tab') || 'channels', isCurrent) : renderLiveTv(page, params.get('tab') || 'guide', isCurrent);
      case 'settings': return renderSettings(page, isCurrent);
      case 'requests': return renderRequests(page, isCurrent, params.get('tab') || 'discover');
      case 'admin': return renderAdmin(page, params.get('tab') || 'overview', isCurrent);
      default: return renderHome(page, isCurrent);
    }
  }

  // ---------- Hero ----------
  async function renderHero(container, params) {
    const hero = document.createElement('section');
    hero.className = 'hero';
    container.appendChild(hero);
    try {
      const res = await getItems({ SortBy: 'Random', Limit: 1, ImageTypes: 'Backdrop', ...params });
      const item = res?.Items?.[0];
      if (!item) { hero.className = 'hero empty'; return; }
      const logo = logoImage(item);
      hero.innerHTML = `
        <div class="hero-bg" style="background-image:url('${esc(backdropImage(item))}')"></div>
        <div class="hero-content">
          ${logo ? `<img class="hero-logo" src="${esc(logo)}" alt="${esc(item.Name)}">` : `<h1 class="hero-title">${esc(item.Name)}</h1>`}
          <p class="hero-overview">${esc(item.Overview || '')}</p>
          <div class="hero-actions">
            <button class="btn btn-white" data-act="play" data-autofocus>${ICONS.play} Play</button>
            <button class="btn btn-gray" data-act="info">${ICONS.info} More Info</button>
          </div>
        </div>`;
      $('[data-act="play"]', hero).addEventListener('click', () => playItem(item));
      $('[data-act="info"]', hero).addEventListener('click', () => openDetails(item.Id));
      const focused = document.activeElement;
      if (!focused || focused === document.body || !document.contains(focused)) autoFocus($('[data-act="play"]', hero));
    } catch (e) {
      hero.className = 'hero empty';
      console.error(e);
    }
  }

  // ---------- Home ----------
  function renderHome(page, isCurrent) {
    renderHero(page, { IncludeItemTypes: 'Movie,Series' });
    const rows = document.createElement('div');
    rows.className = 'rows';
    page.appendChild(rows);

    const add = (title, loader, opts) => addRow(rows, title, loader, { isCurrent, ...opts });

    add('Continue Watching', async () =>
      (await api(userPath('/Items/Resume'), { params: { Limit: 20, MediaTypes: 'Video', Recursive: true, Fields: ITEM_FIELDS, ...IMAGE_PARAMS } }))?.Items,
      { showProgress: true });
    if (iptvOn()) {
      const recent = iptvRecent();
      if (recent.length) {
        addRow(rows, 'Recently Watched Channels', async () => recent,
          { isCurrent, createItem: (ch) => createIptvTile(ch, () => playIptv(recent, recent.indexOf(ch), 'Recently watched')) });
      }
    } else if (hasLiveTv()) {
      addRow(rows, 'On Now', async () => (await getChannels({ Limit: 20 }))?.Items?.filter((c) => c.CurrentProgram),
        { isCurrent, createItem: createChannelCard });
    }
    add('Next Up', async () =>
      (await api('/Shows/NextUp', { params: { UserId: state.userId, Limit: 20, Fields: ITEM_FIELDS, ...IMAGE_PARAMS } }))?.Items);
    add('My List', async () =>
      (await getItems({ Filters: 'IsFavorite', IncludeItemTypes: 'Movie,Series', SortBy: 'DateCreated', SortOrder: 'Descending', Limit: 20 }))?.Items);

    const videoViews = state.views.filter((v) => ['movies', 'tvshows', 'homevideos', 'musicvideos', undefined, null, ''].includes(v.CollectionType));
    for (const view of videoViews) {
      add(`Recently Added in ${view.Name}`, () => cachedRow(`${state.userId}:latest:${view.Id}`, () =>
        api(userPath('/Items/Latest'), { params: { ParentId: view.Id, Limit: 20, Fields: ITEM_FIELDS, ...IMAGE_PARAMS } })));
    }

    add('Top Rated Movies', () => cachedRow(`${state.userId}:top`, async () =>
      (await getItems({ IncludeItemTypes: 'Movie', SortBy: 'CommunityRating', SortOrder: 'Descending', Limit: 20 }))?.Items));
    add('Popular TV Shows', () => cachedRow(`${state.userId}:popular`, async () =>
      (await getItems({ IncludeItemTypes: 'Series', SortBy: 'CommunityRating', SortOrder: 'Descending', Limit: 20 }))?.Items));

    // A few random genre rows, Netflix-style.
    (async () => {
      try {
        // The same five genres for a few minutes, so Home doesn't reshuffle every time it's opened.
        const picks = await cachedRow(`${state.userId}:genres`, async () => {
          const genres = (await api('/Genres', { params: { UserId: state.userId, IncludeItemTypes: 'Movie,Series', Recursive: true, SortBy: 'SortName' } }))?.Items || [];
          return shuffle(genres).slice(0, 5);
        });
        if (!isCurrent()) return;
        for (const g of picks) {
          add(g.Name, () => cachedRow(`${state.userId}:genre:${g.Id}`, async () =>
            (await getItems({ IncludeItemTypes: 'Movie,Series', GenreIds: g.Id, SortBy: 'Random', Limit: 20 }))?.Items));
        }
      } catch (e) { console.error(e); }
    })();
  }

  // Rows that change rarely (recently added, top rated, genres) are kept for a few minutes, so going back to
  // Home after a film doesn't fetch them all again. Continue Watching, Next Up and My List are always fresh.
  const rowCache = new Map();
  const ROW_TTL = 5 * 60000;
  function cachedRow(key, loader) {
    const hit = rowCache.get(key);
    if (hit && Date.now() - hit.t < ROW_TTL) return hit.p;
    const p = loader();
    rowCache.set(key, { t: Date.now(), p });
    p.catch(() => rowCache.delete(key));
    if (rowCache.size > 60) rowCache.delete(rowCache.keys().next().value);
    return p;
  }

  // ---------- Rows & cards ----------
  function addRow(container, title, loader, { isCurrent, showProgress, createItem } = {}) {
    const row = document.createElement('section');
    row.className = 'row';
    row.innerHTML = `<h2 class="row-title">${esc(title)}</h2>
      <div class="row-skeleton">${'<div></div>'.repeat(6)}</div>`;
    container.appendChild(row);

    loader().then((items) => {
      if (isCurrent && !isCurrent()) return;
      if (!items || !items.length) { row.remove(); return; }
      row.innerHTML = `<h2 class="row-title">${esc(title)}</h2>
        <div class="row-wrap">
          <button class="row-arrow left" tabindex="-1" aria-label="Scroll left">&#8249;</button>
          <div class="row-track"></div>
          <button class="row-arrow right" tabindex="-1" aria-label="Scroll right">&#8250;</button>
        </div>`;
      const track = $('.row-track', row);
      items.forEach((item) => track.appendChild(createItem ? createItem(item) : createCard(item, { showProgress })));
      $('.row-arrow.left', row).addEventListener('click', () => track.scrollBy({ left: -track.clientWidth * 0.9 }));
      $('.row-arrow.right', row).addEventListener('click', () => track.scrollBy({ left: track.clientWidth * 0.9 }));
    }).catch((e) => {
      console.error(title, e);
      row.remove();
    });
  }

  function createCard(item, { showProgress } = {}) {
    const card = document.createElement('div');
    card.className = 'card';
    card.tabIndex = 0;
    const img = landscapeImage(item);
    const isEpisode = item.Type === 'Episode';
    const title = isEpisode ? (item.SeriesName || item.Name) : item.Name;
    const sub = isEpisode ? episodeLabel(item) : [item.ProductionYear, item.Type === 'Series' ? 'Series' : formatRuntime(item.RunTimeTicks)].filter(Boolean).join(' • ');
    const pct = item.UserData?.PlayedPercentage;
    card.innerHTML = `
      ${img ? `<img loading="lazy" src="${esc(img)}" alt="">` : `<div class="card-fallback">${esc(title)}</div>`}
      <div class="card-play" aria-hidden="true">${ICONS.play}</div>
      ${item.UserData?.Played && !showProgress ? '<div class="badge-watched" title="Watched">&#10003;</div>' : ''}
      <div class="card-info"><div>${esc(title)}</div>${sub ? `<div class="sub">${esc(sub)}</div>` : ''}</div>
      ${pct ? `<div class="progress"><span style="width:${Math.min(100, pct)}%"></span></div>` : ''}`;
    $('.card-play', card).tabIndex = -1;
    $('.card-play', card).addEventListener('click', (e) => { e.stopPropagation(); playItem(item); });
    card.addEventListener('click', () => openItem(item));
    return card;
  }

  function createPoster(item) {
    const el = document.createElement('div');
    el.className = 'poster';
    el.tabIndex = 0;
    const img = posterImage(item);
    const isEpisode = item.Type === 'Episode';
    const title = isEpisode ? (item.SeriesName || item.Name) : item.Name;
    const sub = isEpisode ? episodeLabel(item) : (item.ProductionYear || '');
    el.innerHTML = `
      <div class="poster-img">
        ${img ? `<img loading="lazy" src="${esc(img)}" alt="">` : `<div class="card-fallback">${esc(title)}</div>`}
        ${item.UserData?.Played ? '<div class="badge-watched" title="Watched">&#10003;</div>' : ''}
      </div>
      <div class="poster-title">${esc(title)}</div>
      <div class="poster-sub">${esc(sub)}</div>`;
    el.addEventListener('click', () => openItem(item));
    return el;
  }

  function openItem(item) {
    if (item.Type === 'TvChannel') return playItem(item);
    if (item.Type === 'Program') return openProgram(item.Id);
    // hint: what the card showed, so a title that has since been replaced on the server can be found again by name.
    const series = { Name: item.SeriesName, Type: 'Series' };
    if (item.Type === 'Episode' && item.SeriesId) openDetails(item.SeriesId, { focusEpisode: item, hint: series });
    else if (item.Type === 'Season' && item.SeriesId) openDetails(item.SeriesId, { seasonId: item.Id, hint: series });
    else openDetails(item.Id, { hint: { Name: item.Name, Type: item.Type, ProductionYear: item.ProductionYear } });
  }

  // ---------- Browse (Movies / TV) ----------
  async function renderBrowse(page, { type, title, isCurrent }) {
    renderHero(page, { IncludeItemTypes: type });
    const wrap = document.createElement('div');
    wrap.className = 'rows';
    wrap.innerHTML = `
      <div class="page-pad" style="padding-top:0">
        <div class="page-head">
          <h1>${esc(title)}</h1>
          <select data-genre><option value="">All Genres</option></select>
          <select data-sort>
            <option value="DateCreated,Descending">Recently Added</option>
            <option value="SortName,Ascending">A–Z</option>
            <option value="PremiereDate,Descending">Release Date</option>
            <option value="CommunityRating,Descending">Top Rated</option>
            <option value="Random,Ascending">Surprise Me</option>
          </select>
          <select data-filter>
            <option value="">All</option>
            <option value="IsUnplayed">Unwatched</option>
            <option value="IsPlayed">Watched</option>
            <option value="IsFavorite">My List</option>
          </select>
        </div>
        <div class="grid"></div>
        <div class="sentinel"></div>
      </div>`;
    page.appendChild(wrap);

    const grid = $('.grid', wrap), sentinel = $('.sentinel', wrap);
    const genreSel = $('[data-genre]', wrap), sortSel = $('[data-sort]', wrap), filterSel = $('[data-filter]', wrap);

    api('/Genres', { params: { UserId: state.userId, IncludeItemTypes: type, Recursive: true, SortBy: 'SortName' } })
      .then((res) => {
        for (const g of res?.Items || []) {
          const opt = document.createElement('option');
          opt.value = g.Id; opt.textContent = g.Name;
          genreSel.appendChild(opt);
        }
      }).catch(() => {});

    const pager = makePager(grid, sentinel, isCurrent, (start, limit) => {
      const [SortBy, SortOrder] = sortSel.value.split(',');
      return getItems({ IncludeItemTypes: type, StartIndex: start, Limit: limit, SortBy: SortBy + ',SortName', SortOrder, GenreIds: genreSel.value, Filters: filterSel.value });
    });
    [genreSel, sortSel, filterSel].forEach((s) => s.addEventListener('change', pager.reset));
    pager.reset();
  }

  function makePager(grid, sentinel, isCurrent, fetchPage) {
    const LIMIT = 60;
    let start = 0, total = Infinity, loading = false, gen = 0;
    const loadMore = async () => {
      if (loading || start >= total || !isCurrent()) return;
      loading = true;
      const myGen = gen;
      const spinner = document.createElement('div');
      spinner.className = 'spinner';
      grid.after(spinner);
      try {
        const res = await fetchPage(start, LIMIT);
        if (myGen !== gen || !isCurrent()) return;
        total = res?.TotalRecordCount ?? 0;
        (res?.Items || []).forEach((it) => grid.appendChild(createPoster(it)));
        // Arriving on a new page with the remote (whatever was focused is gone): start on the first result.
        const focused = document.activeElement;
        if (start === 0 && (!focused || focused === document.body || !document.contains(focused))) autoFocus(grid.firstElementChild);
        start += LIMIT;
        if (!grid.children.length) grid.innerHTML = '<p class="empty-msg" style="grid-column:1/-1">Nothing here yet.</p>';
      } catch (e) {
        console.error(e);
        toast('Could not load items: ' + e.message);
        total = 0;
      } finally {
        spinner.remove();
        loading = false;
        // Keep filling if the sentinel is still on screen.
        if (myGen === gen && isCurrent() && sentinel.getBoundingClientRect().top < window.innerHeight + 600) loadMore();
      }
    };
    const io = new IntersectionObserver((entries) => {
      if (!isCurrent()) { io.disconnect(); return; }
      if (entries.some((e) => e.isIntersecting)) loadMore();
    }, { rootMargin: '600px' });
    io.observe(sentinel);
    return {
      reset() {
        gen++; start = 0; total = Infinity; loading = false;
        grid.innerHTML = '';
        loadMore();
      },
    };
  }

  // ---------- My List ----------
  function renderMyList(page, isCurrent) {
    page.innerHTML = `<div class="page-pad"><div class="page-head"><h1>My List</h1></div><div class="grid"></div><div class="sentinel"></div></div>`;
    const pager = makePager($('.grid', page), $('.sentinel', page), isCurrent, (start, limit) =>
      getItems({ Filters: 'IsFavorite', IncludeItemTypes: 'Movie,Series,Episode', SortBy: 'SortName', StartIndex: start, Limit: limit }));
    pager.reset();
  }

  // ---------- Search ----------
  function renderSearch(page, q, isCurrent, personId = '', personName = '') {
    // On a TV, typing goes through Aurora's own on-screen keyboard (box keyboards are unreliable).
    if (nav.tv && !personId) return renderTvSearch(page, q, isCurrent);
    $('#search-box').classList.add('open');
    const input = $('#search-input');
    // Don't rewrite the box while someone is typing in it (it would move their cursor).
    if (document.activeElement !== input && input.value !== q) input.value = q;
    page.innerHTML = `<div class="page-pad">
      <div class="page-head"><h1></h1></div>
      <div data-results></div></div>`;
    const title = $('h1', page), results = $('[data-results]', page);
    if (personId) {
      title.textContent = personName ? `Movies and shows with ${personName}` : 'Movies and shows';
      results.innerHTML = '<div class="grid"></div><div class="sentinel"></div>';
      makePager($('.grid', results), $('.sentinel', results), isCurrent, (start, limit) =>
        getItems({ PersonIds: personId, IncludeItemTypes: 'Movie,Series', SortBy: 'ProductionYear,SortName', SortOrder: 'Descending', StartIndex: start, Limit: limit })).reset();
      return;
    }
    title.textContent = q ? `Results for "${q}"` : 'Search';
    renderSearchResults(results, q, isCurrent);
  }

  // Matching people (if any) followed by matching titles.
  function renderSearchResults(container, q, isCurrent) {
    container.innerHTML = '<div class="people-row hidden"></div><div class="grid"></div><div class="sentinel"></div>';
    const grid = $('.grid', container);
    if (!q) {
      grid.innerHTML = '<p class="empty-msg" style="grid-column:1/-1">Type the name of a movie, show or actor.</p>';
      return;
    }
    api('/Persons', { params: { UserId: state.userId, SearchTerm: q, Limit: 12, EnableImageTypes: 'Primary', ImageTypeLimit: 1 } })
      .then((res) => {
        const people = (res?.Items || []).filter((x) => x.Name);
        if (!isCurrent() || !people.length || !container.contains(grid)) return;
        const row = $('.people-row', container);
        row.innerHTML = '<h2 class="row-title flush">People</h2><div class="people-list"></div>';
        const list = $('.people-list', row);
        for (const person of people) {
          const btn = document.createElement('button');
          btn.className = 'person';
          const img = person.ImageTags?.Primary ? imageUrl(person.Id, 'Primary', { tag: person.ImageTags.Primary, maxWidth: 200 }) : '';
          btn.innerHTML = `<span class="person-img">${img ? `<img loading="lazy" src="${esc(img)}" alt="">` : esc(person.Name[0])}</span><span class="person-name">${esc(person.Name)}</span>`;
          btn.addEventListener('click', () => {
            location.hash = `#/search?person=${encodeURIComponent(person.Id)}&name=${encodeURIComponent(person.Name)}`;
          });
          list.appendChild(btn);
        }
        row.classList.remove('hidden');
      }).catch(() => { /* titles still show */ });
    makePager(grid, $('.sentinel', container), isCurrent, (start, limit) =>
      getItems({ SearchTerm: q, IncludeItemTypes: 'Movie,Series,Episode', StartIndex: start, Limit: limit })).reset();
  }

  // TV search: an on-screen keyboard driven by the remote, with results beside it. The address is
  // updated without reloading the page, so the highlighted key stays where it is while you type.
  const TV_KEYS = 'abcdefghijklmnopqrstuvwxyz1234567890'.split('');
  function renderTvSearch(page, q, isCurrent) {
    $('#search-box').classList.remove('open');
    page.innerHTML = `
      <div class="page-pad tv-search">
        <div class="tv-kb">
          <div class="tv-query"><span data-q></span><i class="tv-caret"></i></div>
          <div class="tv-keys">
            ${TV_KEYS.map((k) => `<button class="tv-key" data-key="${k}">${k}</button>`).join('')}
            <button class="tv-key wide" data-key=" ">Space</button>
            <button class="tv-key wide" data-key="del" aria-label="Delete">&#9003; Delete</button>
            <button class="tv-key wide" data-key="clear">Clear</button>
          </div>
          ${nativeApp?.showKeyboard ? '<button class="btn btn-gray tv-device-kb" data-act="device-kb">Use device keyboard or voice</button><input class="tv-hidden-input" type="search" data-device-input autocomplete="off">' : ''}
        </div>
        <div class="tv-results"><h1 class="tv-results-title"></h1><div data-results></div></div>
      </div>`;
    let query = q;
    const qEl = $('[data-q]', page), title = $('.tv-results-title', page), results = $('[data-results]', page);
    let timer, shown = null;
    const show = () => {
      qEl.textContent = query;
      qEl.classList.toggle('placeholder', !query);
      if (!query) qEl.textContent = 'Search movies, shows, actors';
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!isCurrent() || shown === query) return;
        shown = query;
        history.replaceState(null, '', query ? '#/search?q=' + encodeURIComponent(query) : '#/search');
        title.textContent = query ? `Results for "${query}"` : 'Search';
        renderSearchResults(results, query, isCurrent);
      }, 400);
    };
    const type = (key) => {
      if (key === 'del') query = query.slice(0, -1);
      else if (key === 'clear') query = '';
      else if (query.length < 60) query += key;
      show();
    };
    $('.tv-keys', page).addEventListener('click', (e) => {
      const btn = e.target.closest('[data-key]');
      if (btn) type(btn.dataset.key);
    });
    // Remotes with a built-in keyboard, or a keyboard plugged into the box, can type directly.
    const onKey = (e) => {
      if (!isCurrent() || !page.contains($('.tv-keys', page))) { document.removeEventListener('keydown', onKey, true); return; }
      if (isTextInput(document.activeElement) || e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === 'Backspace') { type('del'); e.preventDefault(); }
      else if (e.key.length === 1 && /[\p{L}\p{N} '&:.-]/u.test(e.key)) { type(e.key.toLowerCase()); e.preventDefault(); }
    };
    document.addEventListener('keydown', onKey, true);
    // The box's own keyboard (and voice typing) as an alternative.
    const devInput = $('[data-device-input]', page);
    $('[data-act="device-kb"]', page)?.addEventListener('click', () => {
      devInput.value = query;
      devInput.focus();
      nativeApp.showKeyboard();
    });
    devInput?.addEventListener('input', () => { query = devInput.value.slice(0, 60); show(); });
    devInput?.addEventListener('blur', () => { devInput.value = ''; });
    show();
    autoFocus($('.tv-key', page));
  }

  // ---------- Details modal ----------
  let modalToken = 0;

  const updateRequiredOpen = () => !!$('#modal-content .update-body.required') && !$('#modal').classList.contains('hidden');
  function closeModal() {
    // A required update can't be closed; the app stays locked until it's installed.
    if (updateRequiredOpen()) return;
    modalToken++;
    if (confirmResolve) { const r = confirmResolve; confirmResolve = null; r(false); }
    if ($('#modal').classList.contains('hidden')) return;
    $('#modal').classList.add('hidden');
    document.body.style.overflow = '';
    restoreFocus('modal');
  }

  // A card can point at a title Emby no longer has under that id (removed, replaced by a better file, re-identified,
  // or the list was loaded hours ago). Looks for the same title by name; null if there isn't one.
  async function findReplacement(hint) {
    const type = hint?.Type === 'Series' ? 'Series' : hint?.Type === 'Movie' ? 'Movie' : '';
    if (!hint?.Name || !type) return null;
    const res = await getItems({ SearchTerm: hint.Name, IncludeItemTypes: type, Limit: 12 });
    const same = (res?.Items || []).filter((i) => (i.Name || '').toLowerCase() === hint.Name.toLowerCase());
    const best = same.find((i) => hint.ProductionYear && i.ProductionYear === hint.ProductionYear) || same[0];
    return best ? getItem(best.Id) : null;
  }

  async function openDetails(id, { focusEpisode, seasonId, hint } = {}) {
    const token = ++modalToken;
    const modal = $('#modal'), content = $('#modal-content');
    if (modal.classList.contains('hidden')) rememberFocus('modal');
    content.innerHTML = '<div class="spinner" style="margin:6rem auto"></div>';
    modal.classList.remove('hidden');
    modal.scrollTop = 0;
    document.body.style.overflow = 'hidden';

    let item;
    try { item = await getItem(id); } catch (e) {
      if (e.status === 404) {
        // Not found. First try the same title under its new id, then say so and refresh the lists.
        rowCache.clear();
        try { item = await findReplacement(hint); } catch { /* none */ }
        appLog.add('warn', item
          ? `"${hint.Name}" had moved on the server (old id ${id}); found it again`
          : `Details not found (404) for ${hint?.Type || 'item'} "${hint?.Name || '?'}", id ${id}, after ${state.views.length} libraries loaded`);
      }
      if (!item) {
        if (token !== modalToken) return;
        const gone = e.status === 404;
        content.innerHTML = `<div class="m-body notice-body"><h2>${gone ? 'No longer available' : 'Could not load details'}</h2>
          <p class="overview">${gone ? 'This title is no longer on the server, or has been replaced. Refresh the list to see what is there now.' : esc(e.message)}</p>
          <div class="m-actions"><button class="btn btn-white" data-act="refresh" data-autofocus>${gone ? 'Refresh the list' : 'Close'}</button></div></div>`;
        $('[data-act="refresh"]', content).addEventListener('click', () => { closeModal(); if (gone) route(); });
        autoFocus($('[data-act="refresh"]', content));
        return;
      }
    }
    if (token !== modalToken) return;

    const isSeries = item.Type === 'Series';
    const logo = logoImage(item);
    const people = (item.People || []).filter((p) => p.Type === 'Actor').slice(0, 6).map((p) => p.Name);
    const directors = (item.People || []).filter((p) => p.Type === 'Director').map((p) => p.Name);
    const match = item.CommunityRating ? Math.round(item.CommunityRating * 10) : null;
    const resumeTicks = item.UserData?.PlaybackPositionTicks || 0;

    content.innerHTML = `
      <div class="m-hero" style="background-image:url('${esc(backdropImage(item, Math.min(1280, SCREEN_W)))}')">
        <div class="m-hero-content">
          ${logo ? `<img class="hero-logo" src="${esc(logo)}" alt="${esc(item.Name)}">` : `<h2>${esc(item.Name)}</h2>`}
          <div class="m-actions">
            <button class="btn btn-white" data-act="play">${ICONS.play} <span>${resumeTicks ? 'Resume' : 'Play'}</span></button>
            ${resumeTicks ? `<button class="btn btn-gray" data-act="restart">Start Over</button>` : ''}
            ${hasTrailer(item) ? `<button class="btn btn-gray" data-act="trailer">${ICONS.film} Trailer</button>` : ''}
            <button class="circle-btn" data-act="fav" title="Add to My List"></button>
            <button class="circle-btn" data-act="played" title="Mark as watched"></button>
          </div>
        </div>
      </div>
      <div class="m-body">
        <div class="m-grid">
          <div>
            <div class="meta">
              ${match ? `<span class="match">${match}% Rating</span>` : ''}
              ${item.ProductionYear ? `<span>${item.ProductionYear}</span>` : ''}
              ${item.OfficialRating ? `<span class="rating">${esc(item.OfficialRating)}</span>` : ''}
              ${isSeries ? (item.ChildCount ? `<span>${item.ChildCount} Season${item.ChildCount > 1 ? 's' : ''}</span>` : '') : `<span>${formatRuntime(item.RunTimeTicks)}</span>`}
            </div>
            ${item.Taglines?.[0] ? `<p class="overview" style="font-weight:600;margin-bottom:.6rem">${esc(item.Taglines[0])}</p>` : ''}
            <p class="overview">${esc(item.Overview || '')}</p>
          </div>
          <div class="side-meta">
            ${people.length ? `<div>Cast: <span>${esc(people.join(', '))}</span></div>` : ''}
            ${directors.length ? `<div>Director: <span>${esc(directors.join(', '))}</span></div>` : ''}
            ${item.Genres?.length ? `<div>Genres: <span>${esc(item.Genres.join(', '))}</span></div>` : ''}
            ${item.Studios?.length ? `<div>Studio: <span>${esc(item.Studios.map((s) => s.Name).join(', '))}</span></div>` : ''}
          </div>
        </div>
        <div data-extra></div>
      </div>`;

    // Favorite / watched toggles
    const favBtn = $('[data-act="fav"]', content), playedBtn = $('[data-act="played"]', content);
    const paintToggles = () => {
      favBtn.innerHTML = item.UserData?.IsFavorite ? '&#10003;' : '+';
      favBtn.title = item.UserData?.IsFavorite ? 'Remove from My List' : 'Add to My List';
      favBtn.classList.toggle('active', !!item.UserData?.IsFavorite);
      playedBtn.innerHTML = ICONS.eye;
      playedBtn.style.color = item.UserData?.Played ? 'var(--green)' : '';
      playedBtn.title = item.UserData?.Played ? 'Mark as unwatched' : 'Mark as watched';
    };
    paintToggles();
    favBtn.addEventListener('click', async () => {
      const on = !item.UserData?.IsFavorite;
      try {
        item.UserData = await api(userPath(`/FavoriteItems/${item.Id}`), { method: on ? 'POST' : 'DELETE' });
        paintToggles();
        toast(on ? 'Added to My List' : 'Removed from My List', 1800);
      } catch (e) { toast('Could not update My List: ' + e.message); }
    });
    playedBtn.addEventListener('click', async () => {
      const on = !item.UserData?.Played;
      try {
        item.UserData = await api(userPath(`/PlayedItems/${item.Id}`), { method: on ? 'POST' : 'DELETE' });
        paintToggles();
        toast(on ? 'Marked as watched' : 'Marked as unwatched', 1800);
      } catch (e) { toast('Could not update: ' + e.message); }
    });

    const extra = $('[data-extra]', content);
    const playBtn = $('[data-act="play"]', content);
    autoFocus(playBtn);

    if (isSeries) {
      // Play button targets the focused episode, else next up, else the first episode.
      let target = focusEpisode || null;
      if (!target) {
        try {
          const next = await api('/Shows/NextUp', { params: { SeriesId: item.Id, UserId: state.userId, Limit: 1, Fields: ITEM_FIELDS } });
          target = next?.Items?.[0] || null;
        } catch { /* ignore */ }
      }
      const setTarget = (ep) => {
        target = ep;
        if (ep) $('span', playBtn).textContent = `${ep.UserData?.PlaybackPositionTicks ? 'Resume' : 'Play'} ${episodeLabel(ep).split(' ')[0]}`;
      };
      if (token !== modalToken) return;
      setTarget(target);
      playBtn.addEventListener('click', async () => {
        if (target) return playItem(target);
        playItem(item);
      });
      $('[data-act="restart"]', content)?.remove();
      renderSeasons(extra, item, seasonId || target?.SeasonId, target?.Id, token);
    } else {
      playBtn.addEventListener('click', () => playItem(item));
      $('[data-act="restart"]', content)?.addEventListener('click', () => playItem(item, { startTicks: 0 }));
      renderSimilar(extra, item, token);
    }
    $('[data-act="trailer"]', content)?.addEventListener('click', () => playTrailer(item));

  }

  async function renderSeasons(container, series, selectedSeasonId, currentEpisodeId, token) {
    let seasons;
    try {
      seasons = (await api(`/Shows/${series.Id}/Seasons`, { params: { UserId: state.userId, Fields: 'ItemCounts' } }))?.Items || [];
    } catch (e) { console.error(e); return; }
    if (token !== modalToken || !seasons.length) return;

    const selected = seasons.find((s) => s.Id === selectedSeasonId) || seasons.find((s) => s.IndexNumber > 0) || seasons[0];
    container.innerHTML = `
      <div class="m-section-head">
        <h3>Episodes</h3>
        <button class="btn btn-gray season-watched hidden" data-season-watched></button>
        ${seasons.length > 1
          ? `<select>${seasons.map((s) => `<option value="${esc(s.Id)}"${s.Id === selected.Id ? ' selected' : ''}>${esc(s.Name)}</option>`).join('')}</select>`
          : `<span style="color:var(--muted)">${esc(selected.Name)}</span>`}
      </div>
      <div data-episodes></div>`;
    const list = $('[data-episodes]', container);

    let shownSeason = selected.Id, shownEps = [];
    const seasonBtn = $('[data-season-watched]', container);
    const paintSeasonBtn = () => {
      const all = shownEps.length > 0 && shownEps.every((e) => e.UserData?.Played);
      seasonBtn.classList.toggle('hidden', !shownEps.length);
      seasonBtn.textContent = all ? 'Mark season as unwatched' : 'Mark season as watched';
      seasonBtn.dataset.on = all ? '' : '1';
    };
    seasonBtn.addEventListener('click', async () => {
      const on = !!seasonBtn.dataset.on, todo = shownEps.filter((e) => !!e.UserData?.Played !== on);
      seasonBtn.disabled = true;
      let failed = 0;
      for (let i = 0; i < todo.length; i += 4) {
        await Promise.all(todo.slice(i, i + 4).map((e) => api(userPath(`/PlayedItems/${e.Id}`), { method: on ? 'POST' : 'DELETE' }).catch(() => { failed++; })));
      }
      seasonBtn.disabled = false;
      rowCache.clear();
      toast(failed ? `Could not update ${failed} of ${todo.length} episodes. Try again.` : on ? 'Season marked as watched' : 'Season marked as unwatched', 2500);
      list.__reload();
    });
    list.__reload = () => load(shownSeason, true);
    const load = async (seasonId, quiet) => {
      shownSeason = seasonId;
      if (!quiet) list.innerHTML = '<div class="spinner"></div>';
      try {
        const eps = (await api(`/Shows/${series.Id}/Episodes`, { params: { SeasonId: seasonId, UserId: state.userId, Fields: ITEM_FIELDS, ...IMAGE_PARAMS } }))?.Items || [];
        if (token !== modalToken) return;
        shownEps = eps;
        paintSeasonBtn();
        list.innerHTML = '';
        if (!eps.length) list.innerHTML = '<p class="empty-msg">No episodes.</p>';
        for (const ep of eps) {
          const row = document.createElement('div');
          row.className = 'episode' + (ep.Id === currentEpisodeId ? ' current' : '');
          row.tabIndex = 0;
          const img = landscapeImage(ep, 320);
          const pct = ep.UserData?.PlayedPercentage;
          row.innerHTML = `
            <div class="ep-num">${ep.IndexNumber ?? ''}</div>
            <div class="ep-thumb">
              ${img ? `<img loading="lazy" src="${esc(img)}" alt="">` : ''}
              <div class="card-play" style="opacity:1;width:36px;height:36px">${ICONS.play}</div>
              ${pct ? `<div class="progress"><span style="width:${Math.min(100, pct)}%"></span></div>` : ''}
              ${ep.UserData?.Played ? '<div class="badge-watched">&#10003;</div>' : ''}
            </div>
            <div class="ep-text">
              <div class="ep-head"><span>${esc(ep.Name)}</span><span class="dur">${formatRuntime(ep.RunTimeTicks)}</span></div>
              <p>${esc(ep.Overview || '')}</p>
            </div>`;
          row.addEventListener('click', () => playItem(ep));
          list.appendChild(row);
        }
        // With a remote, focus is on the Play button; keep it on screen instead of jumping to the episode.
        if (!nav.on) $('.episode.current', list)?.scrollIntoView({ block: 'nearest' });
      } catch (e) {
        list.innerHTML = `<p class="empty-msg">Could not load episodes: ${esc(e.message)}</p>`;
      }
    };
    $('select', container)?.addEventListener('change', (e) => load(e.target.value));
    load(selected.Id);
  }

  async function renderSimilar(container, item, token) {
    try {
      const res = await api(`/Items/${item.Id}/Similar`, { params: { UserId: state.userId, Limit: 12, Fields: ITEM_FIELDS, ...IMAGE_PARAMS } });
      const items = res?.Items || [];
      if (token !== modalToken || !items.length) return;
      container.innerHTML = `<div class="m-section-head"><h3>More Like This</h3></div><div class="similar"></div>`;
      const grid = $('.similar', container);
      for (const s of items) {
        const card = document.createElement('div');
        card.className = 'sim-card';
        card.tabIndex = 0;
        const img = landscapeImage(s, 400);
        card.innerHTML = `
          <div class="sim-img">${img ? `<img loading="lazy" src="${esc(img)}" alt="">` : ''}</div>
          <div class="sim-body">
            <strong>${esc(s.Name)}</strong>
            <div class="meta" style="font-size:.8rem;margin-bottom:.4rem">
              ${s.OfficialRating ? `<span class="rating">${esc(s.OfficialRating)}</span>` : ''}
              ${s.ProductionYear ? `<span>${s.ProductionYear}</span>` : ''}
            </div>
            <p>${esc(s.Overview || '')}</p>
          </div>`;
        card.addEventListener('click', () => openDetails(s.Id));
        grid.appendChild(card);
      }
    } catch (e) { console.error(e); }
  }

  // ---------- Live TV from an M3U playlist or Xtream Codes account ----------
  // The admin sets the source in the Admin dashboard. It's saved into every account's Aurora settings on the
  // Emby server (display preferences), so each customer's app picks it up when they sign in.
  const IPTV_PREFS = { id: 'aurora-livetv', client: 'aurora' };
  const iptv = { config: null, lists: new Map(), epg: new Map(), all: null, guide: null, guideLoad: null };
  const iptvOn = (cfg = iptv.config) => !!cfg && ((cfg.type === 'm3u' && cfg.m3uUrl) || (cfg.type === 'xtream' && cfg.server && cfg.username));
  const showLiveLink = () => hasLiveTv() || iptvOn();

  function iptvLocalKey() { return 'ef.iptv.' + state.userId; }
  function loadIptvConfigLocal() {
    try { iptv.config = JSON.parse(store.get(iptvLocalKey()) || 'null'); } catch { iptv.config = null; }
  }
  // Reads this account's copy from Emby; quietly keeps the saved copy if the server can't be reached.
  async function refreshIptvConfig() {
    try {
      const prefs = await api(`/DisplayPreferences/${IPTV_PREFS.id}`, { params: { userId: state.userId, client: IPTV_PREFS.client } });
      const raw = prefs?.CustomPrefs?.config;
      const cfg = raw ? JSON.parse(raw) : null;
      if (JSON.stringify(cfg) !== JSON.stringify(iptv.config)) {
        if ((cfg?.v || 0) !== (iptv.config?.v || 0)) resetIptvCaches();
        iptv.config = cfg;
        if (cfg) store.set(iptvLocalKey(), JSON.stringify(cfg)); else store.del(iptvLocalKey());
      }
    } catch (e) { console.warn('Live TV settings', e); }
    $$('[data-route="livetv"]').forEach((a) => a.classList.toggle('hidden', !showLiveLink()));
  }

  function writeIptvConfigFor(userId, cfg) {
    return api(`/DisplayPreferences/${IPTV_PREFS.id}`, {
      method: 'POST', params: { userId, client: IPTV_PREFS.client },
      body: {
        Id: IPTV_PREFS.id, Client: IPTV_PREFS.client, SortBy: 'SortName', SortOrder: 'Ascending',
        RememberIndexing: false, RememberSorting: false, ScrollDirection: 'Horizontal', ShowBackdrop: false, ShowSidebar: false,
        PrimaryImageHeight: 0, PrimaryImageWidth: 0, CustomPrefs: { config: cfg ? JSON.stringify(cfg) : '' },
      },
    });
  }

  // Puts the admin's Live TV settings on every account that doesn't have the current version yet.
  async function syncIptvConfig(cfg, { force = false } = {}) {
    const users = await api('/Users');
    let saved = 0, failed = 0;
    const queue = (users || []).slice();
    const worker = async () => {
      while (queue.length) {
        const u = queue.shift();
        try {
          if (!force) {
            const prefs = await api(`/DisplayPreferences/${IPTV_PREFS.id}`, { params: { userId: u.Id, client: IPTV_PREFS.client } });
            const have = prefs?.CustomPrefs?.config ? JSON.parse(prefs.CustomPrefs.config) : null;
            if ((have?.v || 0) === (cfg?.v || 0)) { saved++; continue; }
          }
          await writeIptvConfigFor(u.Id, cfg);
          saved++;
        } catch (e) { failed++; console.warn('Live TV settings for', u.Name, e); }
      }
    };
    await Promise.all([0, 1, 2, 3].map(worker));
    return { saved, failed, total: (users || []).length };
  }

  // Accounts created after the admin saved still need the settings; the admin's app tops them up now and then.
  async function topUpIptvConfig() {
    if (!isAdmin() || !iptv.config) return;
    const last = Number(store.get('ef.iptv.sync') || 0);
    if (Date.now() - last < 6 * 3600000) return;
    store.set('ef.iptv.sync', String(Date.now()));
    try { await syncIptvConfig(iptv.config); } catch (e) { console.warn('Live TV settings top-up', e); }
  }

  function resetIptvCaches() {
    iptv.lists.clear(); iptv.all = null; iptv.epg.clear(); iptv.guide = null; iptv.guideLoad = null;
  }

  const withScheme = (u) => (/^https?:\/\//i.test(u) ? u : 'http://' + u).replace(/\/+$/, '');

  // Channel lists go through the Android app (IptvFetcher): it follows the provider's redirects, keeps the last
  // good copy to fall back on when the provider has a hiccup, leaves movies and series out of M3U playlists,
  // and hands the text over in pieces. A draft being tested in Admin never uses a saved copy.
  let iptvFetchSeq = 0;
  const iptvFetchPending = new Map();
  window.auroraIptvDone = (id, r) => { const done = iptvFetchPending.get(id); if (done) { iptvFetchPending.delete(id); done(r); } };
  const LIST_MAX_AGE = 30 * 60000;
  let staleNoticeShown = false;

  async function iptvText(url, cfg = iptv.config, timeoutMs = 60000, { maxAge = 0, liveOnly = false, saved = false } = {}) {
    const headers = cfg?.userAgent ? { 'User-Agent': cfg.userAgent } : {};
    if (saved && nativeApp?.iptvFetch) {
      const useSaved = cfg === iptv.config;
      const r = await new Promise((resolve) => {
        const id = 'f' + (++iptvFetchSeq);
        iptvFetchPending.set(id, resolve);
        nativeApp.iptvFetch(id, url, cfg?.userAgent || '', useSaved ? maxAge : 0, useSaved, liveOnly, timeoutMs);
      });
      if (!r?.status) throw new Error(`Couldn't reach the TV provider${r?.error ? ` (${r.error})` : ''}.`);
      if (r.status >= 400) { const e = new Error(`The TV provider answered ${r.status}.`); e.status = r.status; throw e; }
      if (r.stale && !staleNoticeShown) {
        staleNoticeShown = true;
        console.warn('TV provider not answering, using the saved list:', r.error);
        toast("The TV provider isn't answering right now, so Aurora is showing the last saved channel list.", 5000);
      }
      const handle = nativeApp.iptvOpen(url, liveOnly);
      if (!handle) throw new Error("Couldn't read the channel list.");
      const parts = [];
      try {
        for (;;) { const chunk = nativeApp.iptvRead(handle, 1 << 20); if (!chunk) break; parts.push(chunk); }
      } finally { nativeApp.iptvClose(handle); }
      return parts.join('');
    }
    if (nativeApp?.httpRequest) {
      const r = await nativeHttp('GET', url, headers, null, timeoutMs);
      if (r.status === 0) throw new Error(r.error || "Couldn't reach the TV provider.");
      if (r.status >= 400) { const e = new Error(`The TV provider answered ${r.status}.`); e.status = r.status; throw e; }
      return r.body || '';
    }
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`The TV provider answered ${res.status}.`);
    return res.text();
  }

  // Xtream Codes player API.
  function xtUrl(cfg, params = {}) {
    const q = new URLSearchParams({ username: cfg.username, password: cfg.password || '', ...params });
    return `${withScheme(cfg.server)}/player_api.php?${q}`;
  }
  async function xtJson(cfg, params, opts) {
    const text = await iptvText(xtUrl(cfg, params), cfg, 60000, opts);
    try { return JSON.parse(text); } catch { throw new Error("The TV provider's answer wasn't understood. Check the server address."); }
  }
  function xtChannel(cfg, st) {
    const ext = cfg.format === 'hls' ? 'm3u8' : 'ts';
    return {
      id: 'x' + st.stream_id, streamId: st.stream_id, name: st.name || 'Channel', logo: st.stream_icon || '',
      num: st.num != null ? String(st.num) : '', group: st.category_id, epgId: st.epg_channel_id || '',
      url: `${withScheme(cfg.server)}/live/${encodeURIComponent(cfg.username)}/${encodeURIComponent(cfg.password || '')}/${st.stream_id}.${ext}`,
    };
  }

  // M3U playlist: #EXTINF lines with tvg-* attributes and group-title, each followed by the stream address.
  function parseM3u(text) {
    const groups = new Map(), all = [];
    let info = null, extGroup = '', guideUrl = '';
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('#EXTM3U')) {
        // The playlist may name its guide: url-tvg="…" or x-tvg-url="…" (sometimes several, comma-separated).
        const m = line.match(/(?:url-tvg|x-tvg-url)="([^"]+)"/i);
        if (m) guideUrl = m[1].split(',')[0].trim();
      } else if (line.startsWith('#EXTINF')) {
        const attrs = {};
        line.replace(/([\w-]+)="([^"]*)"/g, (_, k, v) => { attrs[k.toLowerCase()] = v; return ''; });
        // The name follows the first comma that isn't inside quotes.
        let quoted = false, cut = -1;
        for (let i = 0; i < line.length; i++) {
          if (line[i] === '"') quoted = !quoted;
          else if (line[i] === ',' && !quoted) { cut = i; break; }
        }
        info = { attrs, name: (cut >= 0 ? line.slice(cut + 1) : '').trim() };
      } else if (line.startsWith('#EXTGRP:')) {
        extGroup = line.slice(8).trim();
      } else if (!line.startsWith('#') && info) {
        const group = info.attrs['group-title'] || extGroup || 'Channels';
        const ch = {
          id: 'm' + all.length, name: info.name || info.attrs['tvg-name'] || 'Channel', logo: info.attrs['tvg-logo'] || '',
          num: info.attrs['tvg-chno'] || '', group, url: line, epgId: info.attrs['tvg-id'] || '',
        };
        all.push(ch);
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(ch);
        info = null; extGroup = '';
      }
    }
    return { all, groups, guideUrl };
  }

  // One loaded copy of the source per session (M3U playlists can be large).
  // Which categories customers see, as chosen in Admin → Live TV: catsShown lists the ones to show (new ones from
  // the provider stay hidden), catsHidden lists the ones to hide (new ones show). Neither: everything shows.
  function catFilter(cfg) {
    if (Array.isArray(cfg?.catsShown)) { const set = new Set(cfg.catsShown.map(String)); return (id) => set.has(String(id)); }
    if (Array.isArray(cfg?.catsHidden) && cfg.catsHidden.length) { const set = new Set(cfg.catsHidden.map(String)); return (id) => !set.has(String(id)); }
    return null;
  }

  async function iptvSource(cfg = iptv.config) {
    const key = `src:${cfg.type}:${cfg.v || 0}`;
    if (iptv.lists.has(key)) return iptv.lists.get(key);
    const p = (async () => {
      if (cfg.type === 'm3u') {
        const text = await iptvText(withScheme(cfg.m3uUrl), cfg, 120000, { saved: true, liveOnly: true, maxAge: LIST_MAX_AGE });
        if (!/#EXTM3U|#EXTINF/.test(text.slice(0, 5000))) throw new Error("That address didn't return an M3U playlist.");
        const parsed = parseM3u(text);
        const ok = catFilter(cfg);
        const groups = ok ? new Map([...parsed.groups].filter(([name]) => ok(name))) : parsed.groups;
        const all = ok ? parsed.all.filter((ch) => ok(ch.group)) : parsed.all;
        return { categories: [...groups.keys()].map((name) => ({ id: name, name, count: groups.get(name).length })), groups, all, guideUrl: parsed.guideUrl };
      }
      const cats = await xtJson(cfg, { action: 'get_live_categories' }, { saved: true, maxAge: LIST_MAX_AGE });
      if (!Array.isArray(cats)) throw new Error('The Xtream account was not accepted. Check the username and password.');
      const ok = catFilter(cfg);
      return {
        categories: cats.map((c) => ({ id: String(c.category_id), name: c.category_name || 'Channels' })).filter((c) => !ok || ok(c.id)),
        groups: new Map(), all: null,
      };
    })();
    iptv.lists.set(key, p);
    p.catch(() => iptv.lists.delete(key));
    return p;
  }

  async function iptvChannels(catId, cfg = iptv.config) {
    const src = await iptvSource(cfg);
    if (catId === '__all') return iptvAllChannels(cfg);
    if (src.groups.has(catId)) return src.groups.get(catId);
    if (cfg.type === 'xtream') {
      const ok = catFilter(cfg);
      if (ok && !ok(catId)) return [];
      const list = await xtJson(cfg, { action: 'get_live_streams', category_id: catId }, { saved: true, maxAge: LIST_MAX_AGE });
      const chans = (Array.isArray(list) ? list : []).map((st) => xtChannel(cfg, st));
      src.groups.set(catId, chans);
      return chans;
    }
    return [];
  }

  async function iptvAllChannels(cfg = iptv.config) {
    const src = await iptvSource(cfg);
    if (!src.all) {
      const list = await xtJson(cfg, { action: 'get_live_streams' }, { saved: true, maxAge: LIST_MAX_AGE });
      const ok = catFilter(cfg);
      src.all = (Array.isArray(list) ? list : []).filter((st) => !ok || ok(st.category_id)).map((st) => xtChannel(cfg, st));
    }
    return src.all;
  }

  // What's on now (Xtream only), fetched for the channels on screen and kept for 10 minutes.
  const b64 = (s) => { try { return new TextDecoder().decode(Uint8Array.from(atob(s || ''), (c) => c.charCodeAt(0))); } catch { return s || ''; } };
  async function iptvNow(ch) {
    if (iptv.config?.type !== 'xtream' || !ch.streamId) return null;
    const hit = iptv.epg.get(ch.streamId);
    if (hit && Date.now() - hit.t < 600000) return hit.v;
    const v = await xtJson(iptv.config, { action: 'get_short_epg', stream_id: ch.streamId, limit: 2 }).then((r) => {
      const now = Date.now() / 1000;
      const list = (r?.epg_listings || []).map((e) => ({ title: b64(e.title), start: Number(e.start_timestamp), end: Number(e.stop_timestamp) }));
      const cur = list.find((e) => e.start <= now && e.end > now) || list[0];
      return cur ? { title: cur.title, start: cur.start * 1000, end: cur.end * 1000 } : null;
    }).catch(() => null);
    iptv.epg.set(ch.streamId, { t: Date.now(), v });
    return v;
  }
  const iptvNowCached = (ch) => guideNow(ch)?.title || iptv.epg.get(ch.streamId)?.v?.title || '';

  // The next few programmes for one Xtream channel, used by the Guide while the full guide is still loading.
  // A few at a time, kept for 10 minutes.
  const shortGuide = new Map(), shortQueue = [];
  let shortActive = 0;
  function iptvShortGuide(ch) {
    if (iptv.config?.type !== 'xtream' || !ch.streamId) return Promise.resolve(null);
    const hit = shortGuide.get(ch.streamId);
    if (hit && Date.now() - hit.t < 600000) return hit.p;
    const p = new Promise((resolve) => shortQueue.push({ ch, resolve }));
    shortGuide.set(ch.streamId, { t: Date.now(), p });
    pumpShortGuide();
    return p;
  }
  function pumpShortGuide() {
    while (shortActive < 4 && shortQueue.length) {
      const { ch, resolve } = shortQueue.shift();
      shortActive++;
      xtJson(iptv.config, { action: 'get_short_epg', stream_id: ch.streamId, limit: 10 })
        .then((r) => (r?.epg_listings || []).map((e) => ({
          title: b64(e.title), desc: b64(e.description || ''), start: Number(e.start_timestamp) * 1000, end: Number(e.stop_timestamp) * 1000,
        })).filter((e) => e.end > e.start).sort((a, b) => a.start - b.start))
        .catch(() => null)
        .then((list) => { shortActive--; resolve(list); pumpShortGuide(); });
    }
  }

  // ----- TV guide (XMLTV) -----
  // Xtream accounts publish one at xmltv.php; M3U playlists may name one in their header; the admin can set any.
  async function iptvGuideUrl(cfg = iptv.config) {
    if (cfg.epgUrl) return withScheme(cfg.epgUrl);
    if (cfg.type === 'xtream') {
      const q = new URLSearchParams({ username: cfg.username, password: cfg.password || '' });
      return `${withScheme(cfg.server)}/xmltv.php?${q}`;
    }
    return (await iptvSource(cfg)).guideUrl || '';
  }

  const normalName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  let epgSeq = 0;
  const epgPending = new Map();
  window.auroraEpgDone = (id, data) => { const done = epgPending.get(id); if (done) { epgPending.delete(id); done(data); } };

  // Gets the guide ready once per session. The Android app downloads and reads it and keeps it (the page
  // only ever asks it for the channels on screen: see guideFor), so this resolves to a small handle.
  const GUIDE_REFRESH = 3 * 3600000;
  function loadIptvGuide(cfg = iptv.config) {
    // The listings run about 10 hours ahead, so a guide kept for a long session (a TV left on Aurora) is
    // fetched again after a few hours rather than running out of listings.
    if (cfg === iptv.config && iptv.guide && Date.now() - (iptv.guide.at || 0) > GUIDE_REFRESH) { iptv.guide = null; iptv.guideLoad = null; }
    if (cfg === iptv.config && iptv.guideLoad) return iptv.guideLoad;
    const p = (async () => {
      if (!nativeApp?.loadEpg || !nativeApp.epgLookup) return null;
      const url = await iptvGuideUrl(cfg);
      if (!url) return null;
      const data = await new Promise((resolve) => {
        const id = 'e' + (++epgSeq);
        epgPending.set(id, resolve);
        nativeApp.loadEpg(id, url, cfg.userAgent || '');
      });
      if (data?.error) throw new Error(data.error);
      if (!data?.channels) throw new Error("The guide link didn't return a TV guide (XMLTV).");
      return { url, channels: data.channels, programmes: data.programmes, cache: new Map(), at: Date.now() };
    })();
    if (cfg === iptv.config) {
      iptv.guideLoad = p;
      // A failed guide isn't asked for again for 5 minutes: every screen asking at once flooded the log, and hammering
      // a provider that's refusing this connection doesn't help.
      p.then((g) => { iptv.guide = g; }, (e) => {
        console.warn('TV guide', e);
        setTimeout(() => { if (iptv.guideLoad === p) iptv.guideLoad = null; }, 5 * 60000);
      });
    }
    return p;
  }

  // Looks up many channels in one go (a long channel list one at a time would be slow on a TV box).
  function guidePrefetch(chans, g = iptv.guide) {
    if (!g || !chans?.length) return;
    const todo = chans.filter((ch) => ch && !g.cache.has(ch.id || ch.name));
    for (let i = 0; i < todo.length; i += 500) {
      const part = todo.slice(i, i + 500);
      let res = null;
      try { res = JSON.parse(nativeApp.epgLookup(g.url, JSON.stringify(part.map((ch) => ({ id: ch.epgId || '', name: ch.name || '' }))))); } catch { /* none */ }
      part.forEach((ch, k) => {
        const e = res?.[k];
        g.cache.set(ch.id || ch.name, e ? { name: e.n, icon: e.i, progs: e.p.map(([start, end, title, desc]) => ({ start, end, title, desc })) } : null);
      });
    }
  }

  // A channel's guide entry {name, icon, progs: [{start, end, title, desc}]}, asked of the Android app and kept.
  function guideFor(ch, g = iptv.guide) {
    if (!g || !ch) return null;
    const key = ch.id || ch.name;
    if (g.cache.has(key)) return g.cache.get(key);
    let entry = null;
    try {
      const [e] = JSON.parse(nativeApp.epgLookup(g.url, JSON.stringify([{ id: ch.epgId || '', name: ch.name || '' }]))) || [];
      if (e) entry = { name: e.n, icon: e.i, progs: e.p.map(([start, end, title, desc]) => ({ start, end, title, desc })) };
    } catch { /* no entry */ }
    g.cache.set(key, entry);
    return entry;
  }
  function guideNow(ch, at = Date.now()) {
    return guideFor(ch)?.progs.find((p) => p.start <= at && p.end > at) || null;
  }
  const channelLogo = (ch) => ch.logo || guideFor(ch)?.icon || '';

  // Some logo hosts refuse the web view; the Android app can fetch those itself.
  const imgCache = new Map(), imgPending = new Map();
  let imgSeq = 0, imgActive = 0;
  const imgQueue = [];
  window.auroraImageDone = (id, dataUrl) => { const done = imgPending.get(id); if (done) { imgPending.delete(id); done(dataUrl); } };
  function nativeImage(url) {
    if (imgCache.has(url)) return imgCache.get(url);
    // Logos are kept as data, so don't let the list grow without end in a long session.
    if (imgCache.size > 400) [...imgCache.keys()].slice(0, 100).forEach((k) => imgCache.delete(k));
    const p = new Promise((resolve) => imgQueue.push({ url, resolve }));
    imgCache.set(url, p);
    pumpImages();
    return p;
  }
  function pumpImages() {
    while (imgActive < 4 && imgQueue.length) {
      const { url, resolve } = imgQueue.shift();
      imgActive++;
      const id = 'i' + (++imgSeq);
      imgPending.set(id, (d) => { imgActive--; resolve(d || ''); pumpImages(); });
      nativeApp.fetchImage(id, url, iptv.config?.userAgent || '');
    }
  }
  function setLogo(img, url, onDone) {
    if (!url) return;
    img.addEventListener('load', () => onDone(true), { once: true });
    img.addEventListener('error', () => {
      if (!nativeApp?.fetchImage || img.dataset.native) return onDone(false);
      img.dataset.native = '1';
      nativeImage(url).then((d) => { if (d) img.src = d; else onDone(false); });
    }, { once: false });
    img.src = url;
  }

  // Recently watched channels, newest first, for the Live TV page and Home.
  const RECENT_MAX = 30;
  function iptvRecent() {
    try {
      const r = JSON.parse(store.get('ef.iptv.recent.' + state.userId) || '{}');
      return r.v === (iptv.config?.v || 0) ? r.list || [] : [];
    } catch { return []; }
  }
  function rememberChannel(ch) {
    const list = [ch, ...iptvRecent().filter((c) => c.id !== ch.id)].slice(0, RECENT_MAX)
      .map(({ id, streamId, name, logo, num, url, group }) => ({ id, streamId, name, logo, num, url, group }));
    store.set('ef.iptv.recent.' + state.userId, JSON.stringify({ v: iptv.config?.v || 0, list }));
  }

  // A loading error with a Try again button (the provider may just have had a hiccup).
  function liveError(el, text, retry) {
    el.innerHTML = `<div class="live-error"><p class="empty-msg">${text}</p><button class="btn btn-gray" data-retry>Try again</button></div>`;
    $('[data-retry]', el).addEventListener('click', retry);
    if (nav.on && (!document.activeElement || document.activeElement === document.body || !document.contains(document.activeElement))) focusEl($('[data-retry]', el));
  }

  // Opens the native player with the list the channel came from, so up/down flips through it.
  let iptvPlaying = null;
  function playIptv(list, index, groupName) {
    if (!list[index]) return;
    whenAllowed(() => startIptv(list, index, groupName));
  }
  function startIptv(list, index, groupName) {
    const ch = list[index];
    if (!ch) return;
    rememberChannel(ch);
    if (!nativeApp?.playLive) { toast('Live TV channels play in the Aurora app for Android and Android TV.'); return; }
    // Keep the hand-over a sensible size for very long lists.
    let from = 0, to = list.length;
    if (list.length > 3000) { from = Math.max(0, index - 1500); to = Math.min(list.length, from + 3000); }
    const slice = list.slice(from, to);
    // What's on is looked up for the channels around this one only: looking up thousands held up the start
    // of playback for seconds on a TV box.
    const near = (i) => Math.abs(i - (index - from)) <= 150;
    guidePrefetch(slice.filter((c, i) => near(i)));
    iptvPlaying = { list: slice, offset: from, group: groupName };
    store.set('ef.liveReturn', JSON.stringify({ hash: location.hash || '#/home', t: Date.now() }));
    nativeApp.playLive(JSON.stringify(slice.map((c, i) => (near(i)
      ? { name: c.name, url: c.url, logo: channelLogo(c), num: c.num, now: iptvNowCached(c) }
      : { name: c.name, url: c.url, logo: c.logo || '', num: c.num, now: '' }))),
      index - from, groupName || '', iptv.config?.userAgent || '',
      // So the player can tell the Emby server what's on (Admin shows it; the provider's streams bypass Emby).
      JSON.stringify({ base: state.server + '/emby', apiKey: state.apiKey, userId: state.userId, deviceId: state.deviceId,
        device: nativeApp.getDeviceName?.() || 'Android', auth: authHeader(), buffer: getPref('liveBuffer'), stallSeconds: stallSeconds() || undefined }));
  }
  // ----- Reporting a channel -----
  // Reports go to Aurora Guard, which keeps them for Admin → Channel reports and, if the admin set it up, passes them
  // to the TV provider with the provider's API key (kept only on the guard's PC; the app never sees it).
  async function reportChannel(ch, reason, { note = '', auto = false, group = '' } = {}) {
    if (!guardEnabled || !ch || !state.userId) return false;
    try {
      await guard('/report', { method: 'POST', quick: true, body: {
        userId: state.userId, channel: ch.name, channelId: String(ch.id || ''), reason, note, auto, group: group || ch.group || '',
        device: nativeApp?.getDeviceName?.() || 'Browser' } });
      return true;
    } catch (e) { appLog.add('info', `Channel report not sent: ${e.message}`); return false; }
  }
  const REPORT_REASONS = ['Buffering', 'No picture', 'No sound', 'Wrong channel', 'Channel is down', 'Other'];
  function openReportDialog(ch) {
    const modal = $('#modal'), content = $('#modal-content');
    modalToken++;
    if (modal.classList.contains('hidden')) rememberFocus('modal');
    content.innerHTML = `<div class="m-body notice-body"><h2>Report ${esc(ch.name)}</h2>
      <p class="overview">What is wrong with this channel?</p>
      <div class="report-reasons">${REPORT_REASONS.map((r, i) => `<button class="btn btn-gray" data-reason="${esc(r)}"${i === 0 ? ' data-autofocus' : ''}>${esc(r)}</button>`).join('')}</div>
      <div class="m-actions"><button class="btn btn-gray" data-act="cancel">Cancel</button></div></div>`;
    modal.classList.remove('hidden');
    $('[data-act="cancel"]', content).addEventListener('click', closeModal);
    $$('[data-reason]', content).forEach((b) => b.addEventListener('click', async () => {
      closeModal();
      const ok = await reportChannel(ch, b.dataset.reason);
      toast(ok ? 'Thanks, the channel was reported.' : "Couldn't send the report right now. Try again later.", 3000);
    }));
    autoFocus($('[data-reason]', content));
  }

  // The native player closed: remember the channel it ended on and put the focus back on it.
  window.auroraLiveClosed = (index, stats) => {
    store.del('ef.liveReturn');
    const p = iptvPlaying;
    iptvPlaying = null;
    if (!p || index < 0) return;
    const ch = p.list[index];
    // Kept stopping to buffer: note it (it reaches the admins with the automatic reports) and suggest a bigger buffer.
    if (stats?.stalls >= 3) {
      appLog.add('warn', `Live TV kept buffering: ${stats.stalls} times in ${stats.minutes} min (last channel ${ch?.name || '?'}, buffer ${stats.buffer})`);
      if (stats.buffer !== 'large' && !store.get('ef.liveBufferTip')) {
        store.set('ef.liveBufferTip', '1');
        toast('Live TV kept stopping to buffer. A bigger buffer can help: Settings → Playback → Live TV buffer → Large.', 9000);
      }
    }
    if (ch && stats?.stalls >= 3) reportChannel(ch, 'Buffering', { auto: true, group: p.group });
    if (stats?.stalls >= 3) playLog.add({ kind: 'live-stalling', title: ch?.name || '', stalls: stats.stalls, watchedMin: stats.minutes, buffer: stats.buffer });
    if (stats?.failed > 0) {
      playLog.add({ kind: 'live-failed', title: stats.failedName || ch?.name || '', error: stats.failedCode ? `provider answered ${stats.failedCode}` : 'no picture', count: stats.failed });
      appLog.add('warn', `Live TV: ${stats.failed} ${stats.failed === 1 ? 'channel' : 'channels'} stopped working (last ${stats.failedName || '?'}${stats.failedCode ? ', provider answered ' + stats.failedCode : ''})`);
    }
    if (!ch) return;
    rememberChannel(ch);
    const tile = $(`#page .iptv-tile[data-id="${CSS.escape(ch.id)}"]`);
    if (tile) focusEl(tile);
  };

  function createIptvTile(ch, onPlay) {
    const tile = document.createElement('div');
    tile.className = 'card iptv-tile';
    tile.tabIndex = 0;
    tile.dataset.id = ch.id;
    tile.__ch = ch;
    tile.innerHTML = `
      <div class="iptv-logo"><span class="iptv-fallback">${esc(ch.name)}</span></div>
      <div class="card-info"><div>${esc(ch.name)}</div><div class="sub" data-now></div></div>`;
    paintTile(tile);
    tile.addEventListener('click', onPlay);
    // Long-press on a phone, or the Menu button on a TV remote: report a problem with this channel.
    tile.addEventListener('contextmenu', (e) => { e.preventDefault(); openReportDialog(ch); });
    tile.addEventListener('keydown', (e) => { if (e.key === 'ContextMenu') { e.preventDefault(); openReportDialog(ch); } });
    return tile;
  }

  // Fills in the logo and what's on; called again once the guide arrives.
  function paintTile(tile) {
    const ch = tile.__ch;
    const now = iptvNowCached(ch);
    $('[data-now]', tile).textContent = [ch.num, now].filter(Boolean).join(' · ');
    const logo = channelLogo(ch);
    if (logo && !$('img', tile)) {
      const img = document.createElement('img');
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      $('.iptv-logo', tile).prepend(img);
      setLogo(img, logo, (ok) => { if (ok) tile.classList.add('has-logo'); else img.remove(); });
    }
  }
  function repaintTiles() {
    const tiles = $$('#page .iptv-tile');
    guidePrefetch(tiles.map((t) => t.__ch).filter(Boolean));
    tiles.forEach(paintTile);
  }

  // Fetches what's on for tiles as they scroll into view.
  let epgObserver = null;
  function watchNow(tile, ch) {
    if (iptv.config?.type !== 'xtream' || guideNow(ch)) return;
    if (!epgObserver) {
      epgObserver = new IntersectionObserver((entries) => entries.forEach((en) => {
        if (!en.isIntersecting) return;
        epgObserver.unobserve(en.target);
        const c = en.target.__ch;
        iptvNow(c).then((now) => {
          if (now?.title) $('[data-now]', en.target).textContent = [c.num, now.title].filter(Boolean).join(' · ');
        });
      }), { rootMargin: '200px' });
    }
    tile.__ch = ch;
    epgObserver.observe(tile);
  }

  // TV guide in the style of TiviMate: details of the selected show along the top, a compact grid of channels
  // and the next six hours below, and the channel groups in a panel that slides out on the left
  // (Left from the channel column, or the group button).
  async function renderIptvGuide(body, isCurrent) {
    body.innerHTML = '<div class="spinner"></div>';
    let src;
    try { src = await iptvSource(); } catch (e) {
      if (isCurrent()) liveError(body, `Couldn't load the channels: ${esc(e.message)}`, () => route());
      return;
    }
    if (!isCurrent()) return;
    // The grid shows straight away; listings fill in when the full guide is ready (Xtream channels on screen
    // get theirs from the provider one by one in the meantime).
    if (iptv.guide && Date.now() - (iptv.guide.at || 0) > GUIDE_REFRESH) { iptv.guide = null; iptv.guideLoad = null; }
    let guidePending = !iptv.guide;
    const recent = iptvRecent();
    const cats = [
      ...(recent.length ? [{ id: '__recent', name: 'Recently watched', count: recent.length }] : []),
      ...(iptv.config.type === 'xtream' || src.all?.length ? [{ id: '__all', name: 'All channels', count: src.all?.length }] : []),
      ...src.categories,
    ];
    if (!cats.length) { body.innerHTML = '<p class="empty-msg">This source has no channels.</p>'; return; }
    let current = store.get('ef.iptv.group');
    if (!cats.some((c) => c.id === current)) current = cats[0].id;
    const CH_W = nav.tv ? 260 : (window.innerWidth < 600 ? 120 : 220);
    const start = new Date();
    start.setMinutes(start.getMinutes() < 30 ? 0 : 30, 0, 0);
    const end = new Date(start.getTime() + GUIDE_HOURS * 3600000);
    const width = GUIDE_HOURS * 60 * GUIDE_PX_PER_MIN;
    const xOf = (t) => ((t - start) / 60000) * GUIDE_PX_PER_MIN;
    const slots = [];
    for (let t = start.getTime(); t < end.getTime(); t += 1800000) slots.push(new Date(t));
    const dayLabel = (d) => (new Date().toDateString() === d.toDateString() ? 'Today' : d.toLocaleDateString([], { weekday: 'short' }));
    body.innerHTML = `
      <div class="tm-guide" style="--tm-ch:${CH_W}px">
        <section class="tm-info">
          <div class="tm-info-logo"></div>
          <div class="tm-info-text">
            <div class="tm-info-ch"></div>
            <h2 class="tm-info-title"></h2>
            <div class="tm-info-time"><span></span><div class="tm-info-bar"><i></i></div></div>
            <p class="tm-info-desc"></p>
          </div>
          <div class="tm-clock"><strong></strong><span></span></div>
        </section>
        <p class="guide-status hidden"></p>
        <div class="guide tm-grid" tabindex="-1">
          <div class="guide-head">
            <button class="guide-corner tm-group-btn" title="Channel groups"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M3 6h18v2H3V6Zm0 5h18v2H3v-2Zm0 5h18v2H3v-2Z"/></svg><span></span></button>
            <div class="guide-times" style="width:${width}px">
              ${slots.map((t) => `<span style="left:${xOf(t)}px">${t.getMinutes() === 0 && t.getHours() === 0 ? esc(dayLabel(t)) + ' ' : ''}${esc(clock(t))}</span>`).join('')}
            </div>
          </div>
          <div class="tm-body"><div class="guide-rows"></div><div class="tm-now-line"></div></div>
          <div class="sentinel"></div>
        </div>
        <aside class="tm-groups" data-nav-zone aria-label="Channel groups">
          <h3>Groups</h3>
          <div class="tm-groups-list">${cats.map((c) => `<button class="tm-group${c.id === current ? ' active' : ''}" data-cat="${esc(c.id)}"><span>${esc(c.name)}</span>${c.count ? `<small>${c.count}</small>` : ''}</button>`).join('')}</div>
        </aside>
      </div>`;
    const root = $('.tm-guide', body);
    const rows = $('.guide-rows', body), sentinel = $('.sentinel', body), guideEl = $('.guide', body), status = $('.guide-status', body);
    const nowLine = $('.tm-now-line', body), groupsEl = $('.tm-groups', body), groupBtn = $('.tm-group-btn', body);
    const setStatus = (html) => { status.innerHTML = html; status.classList.toggle('hidden', !html); requestAnimationFrame(() => fit()); };
    let list = [], drawn = 0, groupName = '', token = 0;
    const PAGE = 30;

    // ----- Details panel -----
    const info = {
      logo: $('.tm-info-logo', root), ch: $('.tm-info-ch', root), title: $('.tm-info-title', root),
      time: $('.tm-info-time span', root), bar: $('.tm-info-bar', root), fill: $('.tm-info-bar i', root), desc: $('.tm-info-desc', root),
    };
    let shownInfo = null;
    const showInfo = (ch, p) => {
      if (!ch) return;
      shownInfo = { ch, p };
      const logo = channelLogo(ch);
      if (info.logo.dataset.src !== logo) {
        info.logo.dataset.src = logo;
        info.logo.innerHTML = logo ? '<img alt="">' : `<span>${esc(ch.name)}</span>`;
        const img = $('img', info.logo);
        if (img) setLogo(img, logo, (ok) => { if (!ok) info.logo.innerHTML = `<span>${esc(ch.name)}</span>`; });
      }
      info.ch.textContent = [ch.num, ch.name].filter(Boolean).join('  ');
      info.title.textContent = p?.title || ch.name;
      const now = Date.now();
      if (p) {
        const airing = p.start <= now && p.end > now;
        const left = Math.max(0, Math.round((p.end - now) / 60000));
        const day = new Date(p.start).toDateString() === new Date().toDateString() ? '' : new Date(p.start).toLocaleDateString([], { weekday: 'long' }) + ' · ';
        info.time.textContent = `${day}${clock(new Date(p.start))} – ${clock(new Date(p.end))}` + (airing ? ` · ${left} min left` : '');
        info.bar.classList.toggle('hidden', !airing);
        info.fill.style.width = airing ? `${Math.min(100, ((now - p.start) / (p.end - p.start)) * 100)}%` : '0';
      } else {
        info.time.textContent = guidePending ? 'Loading the TV guide…' : 'No listings for this channel';
        info.bar.classList.add('hidden');
      }
      info.desc.textContent = p?.desc || '';
    };
    const progsOf = (el) => el.__guide.progs || [];
    const nowOf = (el) => progsOf(el).find((p) => p.start <= Date.now() && p.end > Date.now()) || null;
    root.addEventListener('focusin', (e) => {
      const el = e.target.closest('.guide-row');
      if (!el) return;
      showInfo(el.__guide.ch, e.target.__prog || nowOf(el));
      markSelection(el, e.target.__prog);
    });
    // Show where the remote is: the whole row, and the stretch of the time bar the programme covers.
    let selRow = null;
    const markSelection = (row, prog) => {
      if (selRow && selRow !== row) selRow.classList.remove('sel');
      row.classList.add('sel');
      selRow = row;
      let band = $('.tm-sel-band', root);
      const times = $('.guide-times', root);
      if (!band && times) { band = document.createElement('i'); band.className = 'tm-sel-band'; times.appendChild(band); }
      if (!band) return;
      if (!prog) { band.style.display = 'none'; return; }
      const l = Math.max(0, xOf(Math.max(prog.start, start.getTime()))), r = Math.min(width, xOf(prog.end));
      band.style.display = r > l ? '' : 'none';
      band.style.left = `${l}px`;
      band.style.width = `${Math.max(0, r - l)}px`;
    };
    // Mouse and touch: hovering a show previews it too.
    root.addEventListener('mouseover', (e) => {
      if (nav.on) return;
      const t = e.target.closest('.guide-prog, .guide-ch, .guide-empty'), el = t?.closest('.guide-row');
      if (el) showInfo(el.__guide.ch, t.__prog || nowOf(el));
    });

    // ----- Clock and the "now" line -----
    const clockEl = $('.tm-clock', root);
    const tick = () => {
      if (!root.isConnected) { clearInterval(timer); return; }
      const d = new Date();
      $('strong', clockEl).textContent = clock(d);
      $('span', clockEl).textContent = d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
      const x = xOf(Date.now());
      nowLine.style.left = `${CH_W + x}px`;
      nowLine.classList.toggle('hidden', x < 0 || x > width);
      $$('.guide-prog.now', rows).forEach((b) => {
        const p = b.__prog;
        if (p.end <= Date.now()) b.classList.remove('now');
        else b.style.setProperty('--done', `${Math.min(100, ((Date.now() - Math.max(p.start, start.getTime())) / (p.end - Math.max(p.start, start.getTime()))) * 100)}%`);
      });
      if (shownInfo) showInfo(shownInfo.ch, shownInfo.p);
    };
    const timer = setInterval(tick, 30000);

    // ----- Rows -----
    // Fills (or refills) one channel's line of programmes.
    const fillLane = (el) => {
      const { ch, play } = el.__guide;
      const lane = $('.guide-progs', el), now = Date.now();
      const logoSlot = $('.tm-ch-logo', el), logo = channelLogo(ch);
      if (logo && !$('img', logoSlot) && !el.__logoTried) {
        el.__logoTried = true;
        const img = document.createElement('img');
        img.alt = '';
        logoSlot.appendChild(img);
        setLogo(img, logo, (ok) => { if (!ok) img.remove(); });
      }
      const all = guideFor(ch)?.progs || el.__shortList || [];
      el.__guide.progs = all;
      const progs = all.filter((p) => p.end > start.getTime() && p.start < end.getTime());
      // Redrawing removes the show the remote is on; put it back on the one at the same spot afterwards.
      const had = lane.contains(document.activeElement) ? document.activeElement.getBoundingClientRect().left : null;
      const refocus = () => {
        if (had == null) return;
        const pick = [...$$('.guide-prog, .guide-empty', lane)].find((b) => b.getBoundingClientRect().right > had + 4) || $('.guide-ch', el);
        pick?.focus({ preventScroll: true });
      };
      lane.innerHTML = '';
      if (!progs.length) {
        const waiting = guidePending; // the full guide may still have this channel
        lane.innerHTML = `<button class="guide-empty${waiting ? ' waiting' : ''}">${waiting ? 'Loading…' : 'No information'}</button>`;
        $('.guide-empty', lane).addEventListener('click', play);
        if (waiting && !el.__short) {
          el.__short = true;
          iptvShortGuide(ch).then((list) => { el.__shortList = list?.length ? list : null; if (el.isConnected) fillLane(el); });
        }
        refocus();
        return;
      }
      for (const p of progs) {
        const left = Math.max(0, xOf(p.start)), right = Math.min(width, xOf(p.end));
        if (right - left < 4) continue;
        const btn = document.createElement('button');
        const airing = p.start <= now && p.end > now;
        btn.className = 'guide-prog' + (airing ? ' now' : '');
        btn.__prog = p;
        btn.style.left = left + 'px';
        btn.style.width = (right - left - 2) + 'px';
        if (airing) btn.style.setProperty('--done', `${Math.min(100, ((now - Math.max(p.start, start.getTime())) / (p.end - Math.max(p.start, start.getTime()))) * 100)}%`);
        btn.innerHTML = `<strong>${esc(p.title)}</strong><span>${esc(clock(new Date(p.start)))} – ${esc(clock(new Date(p.end)))}</span>`;
        btn.addEventListener('click', () => (airing ? play() : showIptvProgram(p, ch, play)));
        lane.appendChild(btn);
      }
      refocus();
      // Keep the details panel current if it's showing this channel.
      if (shownInfo?.ch === ch) showInfo(ch, (el.contains(document.activeElement) && document.activeElement.__prog) || nowOf(el));
    };
    const row = (ch, idx) => {
      const el = document.createElement('div');
      el.className = 'guide-row';
      const logo = channelLogo(ch);
      el.innerHTML = `
        <button class="guide-ch" title="Watch ${esc(ch.name)}">
          <span class="guide-ch-num">${esc(ch.num || '')}</span>
          <span class="tm-ch-logo"></span>
          <span class="guide-ch-name">${esc(ch.name)}</span>
        </button>
        <div class="guide-progs" style="width:${width}px"></div>`;
      const play = () => playIptv(list, idx, groupName);
      el.__guide = { ch, play };
      const chBtn = $('.guide-ch', el);
      chBtn.addEventListener('click', play);
      chBtn.__onLeftEdge = openGroups; // Left from the channel column opens the groups, as in TiviMate
      fillLane(el);
      return el;
    };
    const drawMore = () => {
      const stop = Math.min(list.length, drawn + PAGE);
      guidePrefetch(list.slice(drawn, stop));
      for (let i = drawn; i < stop; i++) rows.appendChild(row(list[i], i));
      drawn = stop;
    };
    new IntersectionObserver((en) => { if (en[0].isIntersecting && drawn < list.length) drawMore(); }, { root: guideEl, rootMargin: '400px' }).observe(sentinel);

    // ----- Groups -----
    function openGroups() {
      groupsEl.classList.add('open');
      root.classList.add('groups-open');
      // Once it's visible (it can't take the focus before that).
      if (nav.on) requestAnimationFrame(() => focusEl($('.tm-group.active', groupsEl) || $('.tm-group', groupsEl)));
    }
    function closeGroups(refocus = true) {
      if (!groupsEl.classList.contains('open')) return false;
      groupsEl.classList.remove('open');
      root.classList.remove('groups-open');
      if (refocus && nav.on) focusEl($('.guide-ch', rows) || groupBtn);
      return true;
    }
    root.__closeGroups = closeGroups;
    // The grid runs to the bottom of the screen, like a full-screen guide.
    function fit() {
      if (!root.isConnected) { window.removeEventListener('resize', fit); return; }
      const top = guideEl.getBoundingClientRect().top + window.scrollY;
      guideEl.style.height = `${Math.max(260, window.innerHeight - top - (nav.tv ? 24 : (window.innerWidth <= 560 ? 76 : 16)))}px`;
    }
    window.addEventListener('resize', fit);
    requestAnimationFrame(fit);
    groupBtn.addEventListener('click', () => (groupsEl.classList.contains('open') ? closeGroups() : openGroups()));
    // Right from the groups goes back to the channels.
    $$('.tm-group', groupsEl).forEach((b) => { b.__onRightEdge = () => closeGroups(); });
    root.addEventListener('click', (e) => { if (groupsEl.classList.contains('open') && !e.target.closest('.tm-groups, .tm-group-btn')) closeGroups(false); });

    const openCat = async (id, focus) => {
      const t = ++token;
      current = id;
      store.set('ef.iptv.group', id);
      $$('.tm-group', groupsEl).forEach((b) => b.classList.toggle('active', b.dataset.cat === id));
      const cat = cats.find((c) => c.id === id);
      $('span', groupBtn).textContent = cat?.name || '';
      rows.innerHTML = '<div class="spinner"></div>';
      try {
        const chans = id === '__recent' ? iptvRecent() : await iptvChannels(id);
        if (t !== token || !isCurrent()) return;
        list = chans; drawn = 0; groupName = cat?.name || '';
        rows.innerHTML = list.length ? '' : '<p class="empty-msg">No channels here.</p>';
        guideEl.scrollTop = 0;
        guideEl.scrollLeft = 0;
        drawMore();
        const first = $('.guide-row', rows);
        if (first) showInfo(first.__guide.ch, nowOf(first));
        if (focus) focusEl($('.guide-prog.now, .guide-empty', rows) || $('.guide-ch', rows));
      } catch (e) { if (t === token) liveError(rows, `Couldn't load these channels: ${esc(e.message)}`, () => openCat(id, nav.on)); }
    };
    $$('.tm-group', groupsEl).forEach((b) => b.addEventListener('click', () => { closeGroups(false); openCat(b.dataset.cat, nav.on); }));

    if (guidePending) {
      setStatus('<span class="spinner"></span> Getting the full TV guide… The first time can take a few minutes.');
      loadIptvGuide().then((g) => {
        if (!isCurrent()) return;
        guidePending = false;
        guidePrefetch($$('.guide-row', rows).map((el) => el.__guide.ch));
        setStatus(g ? '' : nativeApp?.loadEpg
          ? 'No TV guide has been set up for these channels yet.' + (isAdmin() ? ' Add a guide (XMLTV) link in Admin → Live TV.' : '')
          : 'The TV guide is available in the Aurora app for Android and Android TV.');
        $$('.guide-row', rows).forEach((el) => fillLane(el));
      }).catch((e) => {
        if (!isCurrent()) return;
        guidePending = false;
        setStatus(`Couldn't load the full TV guide: ${esc(e.message)} <button class="btn btn-gray btn-small" data-guide-retry>Try again</button>`);
        $('[data-guide-retry]', status)?.addEventListener('click', () => route());
        $$('.guide-row', rows).forEach((el) => fillLane(el));
      });
    }
    await openCat(current);
    tick();
    if (!body.contains(document.activeElement)) autoFocus($('.guide-prog.now, .guide-empty', rows) || $('.guide-ch', rows) || groupBtn);
  }

  function showIptvProgram(p, ch, play) {
    const modal = $('#modal'), content = $('#modal-content');
    modalToken++;
    if (modal.classList.contains('hidden')) rememberFocus('modal');
    const day = new Date(p.start).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    content.innerHTML = `
      <div class="m-body program-body">
        <h2>${esc(p.title)}</h2>
        <div class="meta"><span>${esc([ch.num, ch.name].filter(Boolean).join('  '))}</span><span>${esc(day)}</span>
          <span>${esc(clock(new Date(p.start)))} – ${esc(clock(new Date(p.end)))}</span></div>
        ${p.desc ? `<p class="overview">${esc(p.desc)}</p>` : ''}
        <div class="m-actions"><button class="btn btn-white" data-act="watch">${ICONS.play} Watch ${esc(ch.name)}</button></div>
      </div>`;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    $('[data-act="watch"]', content).addEventListener('click', () => { closeModal(); play(); });
    autoFocus($('[data-act="watch"]', content));
  }

  function renderIptvLive(page, tab, isCurrent) {
    store.set('ef.iptv.used', String(Date.now()));
    const tabs = [['channels', 'Channels'], ['guide', 'Guide'], ...(hasLiveTv() ? [['recordings', 'Recordings']] : [])];
    if (!tabs.some(([id]) => id === tab)) tab = 'channels';
    page.innerHTML = `
      <div class="page-pad live-page iptv-page${tab === 'guide' ? ' guide-tab' : ''}">
        <div class="page-head">
          <h1>Live TV</h1>
          ${tabs.length > 1 ? `<div class="tab-bar">${tabs.map(([id, label]) => `<a href="#/livetv?tab=${id}" class="tab${id === tab ? ' active' : ''}">${label}</a>`).join('')}</div>` : ''}
          ${tab === 'channels' ? '<div class="iptv-search"><input type="search" placeholder="Search channels" autocomplete="off"></div>' : ''}
        </div>
        <div data-live-body><div class="spinner"></div></div>
      </div>`;
    const body = $('[data-live-body]', page);
    if (tab === 'recordings') { renderRecordings(body, isCurrent); autoFocus($('.tab.active', page)); return; }
    if (tab === 'guide') { renderIptvGuide(body, isCurrent); return; }
    renderIptvChannels(page, body, isCurrent);
    // Logos and what's on fill in when the guide arrives.
    loadIptvGuide().then(() => { if (isCurrent()) repaintTiles(); }).catch(() => {});
  }

  async function renderIptvChannels(page, body, isCurrent) {
    let src;
    try { src = await iptvSource(); } catch (e) {
      if (isCurrent()) liveError(body, `Couldn't load the channels: ${esc(e.message)}`, () => route());
      return;
    }
    if (!isCurrent()) return;
    const recent = iptvRecent();
    const cats = [
      ...(recent.length ? [{ id: '__recent', name: 'Recently watched', count: recent.length }] : []),
      ...(iptv.config.type === 'xtream' || src.all?.length ? [{ id: '__all', name: 'All channels', count: src.all?.length }] : []),
      ...src.categories,
    ];
    if (!cats.length) { body.innerHTML = '<p class="empty-msg">This source has no channels.</p>'; return; }
    let current = store.get('ef.iptv.group');
    if (!cats.some((c) => c.id === current)) current = cats[0].id;
    body.innerHTML = `
      <div class="iptv-layout">
        <nav class="iptv-cats" data-nav-zone>${cats.map((c) => `<button class="iptv-cat${c.id === current ? ' active' : ''}" data-cat="${esc(c.id)}">
          <span>${esc(c.name)}</span>${c.count ? `<small>${c.count}</small>` : ''}</button>`).join('')}</nav>
        <section class="iptv-main"><h2 class="iptv-title"></h2><div class="grid iptv-grid"></div><div class="sentinel"></div></section>
      </div>`;
    const grid = $('.iptv-grid', body), title = $('.iptv-title', body), sentinel = $('.sentinel', body);
    let shown = [], drawn = 0, groupName = '', token = 0;
    const PAGE = 90;
    const drawMore = () => {
      const end = Math.min(shown.length, drawn + PAGE);
      guidePrefetch(shown.slice(drawn, end));
      for (let i = drawn; i < end; i++) {
        const ch = shown[i], list = shown, idx = i, g = groupName;
        const tile = createIptvTile(ch, () => playIptv(list, idx, g));
        grid.appendChild(tile);
        watchNow(tile, ch);
      }
      drawn = end;
    };
    new IntersectionObserver((en) => { if (en[0].isIntersecting && drawn < shown.length) drawMore(); }, { rootMargin: '600px' }).observe(sentinel);
    const show = (list, name) => {
      shown = list; drawn = 0; groupName = name;
      grid.innerHTML = '';
      title.textContent = name;
      if (!list.length) { grid.innerHTML = '<p class="empty-msg">No channels here.</p>'; return; }
      drawMore();
    };
    const openCat = async (id, { focus = false } = {}) => {
      const t = ++token;
      current = id;
      store.set('ef.iptv.group', id);
      $$('.iptv-cat', body).forEach((b) => b.classList.toggle('active', b.dataset.cat === id));
      const cat = cats.find((c) => c.id === id);
      grid.innerHTML = '<div class="spinner"></div>';
      try {
        const list = id === '__recent' ? iptvRecent() : await iptvChannels(id);
        if (t !== token || !isCurrent()) return;
        show(list, cat?.name || '');
        if (focus) focusEl($('.iptv-tile', grid));
      } catch (e) {
        if (t === token) liveError(grid, `Couldn't load these channels: ${esc(e.message)}`, () => openCat(id, { focus: nav.on }));
      }
    };
    $$('.iptv-cat', body).forEach((b) => b.addEventListener('click', () => openCat(b.dataset.cat, { focus: nav.on })));
    // Search across every channel.
    const input = $('.iptv-search input', page);
    let timer;
    input?.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim().toLowerCase();
        if (!q) return openCat(current);
        const t = ++token;
        grid.innerHTML = '<div class="spinner"></div>';
        try {
          const all = await iptvAllChannels();
          if (t !== token || !isCurrent()) return;
          show(all.filter((c) => c.name.toLowerCase().includes(q) || c.num === q), `Results for "${input.value.trim()}"`);
        } catch (e) { if (t === token) grid.innerHTML = `<p class="empty-msg">Search failed: ${esc(e.message)}</p>`; }
      }, 300);
    });
    await openCat(current);
    // Only if the remote hasn't already moved somewhere on this page while the channels loaded.
    if (!body.contains(document.activeElement)) autoFocus($('.iptv-cat.active', body));
  }

  // ---------- Live TV ----------
  const GUIDE_HOURS = 6;
  const GUIDE_PX_PER_MIN = 6;
  const live = { channelIds: [], tunedId: null }; // tunedId: the channel being watched or switched to

  const hasLiveTv = () => state.views.some((v) => v.CollectionType === 'livetv');
  // Emby dates can carry 7 fractional digits; trim to milliseconds for Date.parse.
  const parseDate = (s) => (s ? new Date(String(s).replace(/(\.\d{3})\d+/, '$1')) : null);
  const clock = (d) => d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const timeRange = (p) => `${clock(parseDate(p.StartDate))} – ${clock(parseDate(p.EndDate))}`;
  const channelLabel = (ch) => [ch.ChannelNumber || ch.Number, ch.Name].filter(Boolean).join('  ');

  function programProgress(p) {
    const start = parseDate(p?.StartDate), end = parseDate(p?.EndDate);
    if (!start || !end || end <= start) return 0;
    return Math.min(100, Math.max(0, ((Date.now() - start) / (end - start)) * 100));
  }

  function getChannels(params = {}) {
    return api('/LiveTv/Channels', {
      params: {
        UserId: state.userId, EnableImageTypes: 'Primary', ImageTypeLimit: 1, EnableUserData: true,
        AddCurrentProgram: true, EnableFavoriteSorting: true, Fields: 'ChannelInfo', ...params,
      },
    });
  }

  // Ordered channel ids for channel up/down in the player.
  async function ensureChannelList() {
    if (live.channelIds.length) return live.channelIds;
    try {
      const res = await api('/LiveTv/Channels', { params: { UserId: state.userId, EnableImages: false, Limit: 2000 } });
      live.channelIds = (res?.Items || []).map((c) => c.Id);
    } catch { /* channel up/down just won't work */ }
    return live.channelIds;
  }

  function createChannelCard(ch) {
    const card = document.createElement('div');
    card.className = 'card channel-card';
    card.tabIndex = 0;
    const logo = ch.ImageTags?.Primary ? imageUrl(ch.Id, 'Primary', { tag: ch.ImageTags.Primary, maxWidth: 300 }) : '';
    const prog = ch.CurrentProgram;
    card.innerHTML = `
      <div class="channel-logo">${logo ? `<img loading="lazy" src="${esc(logo)}" alt="">` : `<span>${esc(ch.Name)}</span>`}</div>
      ${ch.UserData?.IsFavorite ? '<div class="badge-watched" title="Favorite">&#9733;</div>' : ''}
      <div class="card-info">
        <div>${esc(prog?.Name || ch.Name)}</div>
        <div class="sub">${esc(channelLabel(ch))}${prog ? ' · ' + esc(timeRange(prog)) : ''}</div>
      </div>
      ${prog ? `<div class="progress"><span style="width:${programProgress(prog)}%"></span></div>` : ''}`;
    card.addEventListener('click', () => playItem(ch));
    return card;
  }

  function renderLiveTv(page, tab, isCurrent) {
    const tabs = [['guide', 'Guide'], ['channels', 'Channels'], ['recordings', 'Recordings']];
    if (!tabs.some(([id]) => id === tab)) tab = 'guide';
    page.innerHTML = `
      <div class="page-pad live-page">
        <div class="page-head">
          <h1>Live TV</h1>
          <div class="tab-bar">
            ${tabs.map(([id, label]) => `<a href="#/livetv?tab=${id}" class="tab${id === tab ? ' active' : ''}"${id === tab ? ' data-autofocus' : ''}>${label}</a>`).join('')}
          </div>
        </div>
        <div data-live-body></div>
      </div>`;
    const body = $('[data-live-body]', page);
    if (tab === 'channels') renderChannels(body, isCurrent);
    else if (tab === 'recordings') renderRecordings(body, isCurrent);
    else renderGuide(body, isCurrent);
    autoFocus($('.tab.active', page));
  }

  function renderChannels(body, isCurrent) {
    body.innerHTML = `
      <div class="page-head sub-head">
        <select data-filter>
          <option value="">All channels</option>
          <option value="fav">Favorites</option>
        </select>
      </div>
      <div class="grid channel-grid"></div>
      <div class="sentinel"></div>`;
    const grid = $('.grid', body), filter = $('[data-filter]', body);
    const load = async () => {
      grid.innerHTML = '<div class="spinner" style="grid-column:1/-1"></div>';
      try {
        const res = await getChannels({ IsFavorite: filter.value === 'fav' ? true : undefined, Limit: 500 });
        if (!isCurrent()) return;
        const items = res?.Items || [];
        grid.innerHTML = items.length ? '' : '<p class="empty-msg" style="grid-column:1/-1">No channels found.</p>';
        items.forEach((ch) => grid.appendChild(createChannelCard(ch)));
        if (!filter.value) live.channelIds = items.map((c) => c.Id);
      } catch (e) {
        grid.innerHTML = `<p class="empty-msg" style="grid-column:1/-1">Could not load channels: ${esc(e.message)}</p>`;
      }
    };
    filter.addEventListener('change', load);
    load();
  }

  async function renderGuide(body, isCurrent) {
    const start = new Date();
    start.setMinutes(start.getMinutes() < 30 ? 0 : 30, 0, 0);
    const end = new Date(start.getTime() + GUIDE_HOURS * 3600000);
    const width = GUIDE_HOURS * 60 * GUIDE_PX_PER_MIN;
    const xOf = (d) => ((d - start) / 60000) * GUIDE_PX_PER_MIN;

    const slots = [];
    for (let t = start.getTime(); t < end.getTime(); t += 1800000) slots.push(new Date(t));
    body.innerHTML = `
      <div class="guide" tabindex="-1">
        <div class="guide-head">
          <div class="guide-corner"></div>
          <div class="guide-times" style="width:${width}px">
            ${slots.map((t) => `<span style="left:${xOf(t)}px">${esc(clock(t))}</span>`).join('')}
            <div class="guide-now" style="left:${xOf(new Date())}px"></div>
          </div>
        </div>
        <div class="guide-rows"></div>
        <div class="sentinel"></div>
      </div>`;
    const guide = $('.guide', body), rows = $('.guide-rows', body), sentinel = $('.sentinel', body);

    const PAGE = 40;
    let index = 0, total = Infinity, loading = false;
    const loadMore = async () => {
      if (loading || index >= total || !isCurrent()) return;
      loading = true;
      const spinner = document.createElement('div');
      spinner.className = 'spinner';
      rows.after(spinner);
      try {
        const chRes = await getChannels({ StartIndex: index, Limit: PAGE, AddCurrentProgram: false });
        const channels = chRes?.Items || [];
        total = chRes?.TotalRecordCount ?? 0;
        index += PAGE;
        live.channelIds.push(...channels.map((c) => c.Id).filter((id) => !live.channelIds.includes(id)));
        let programs = [];
        if (channels.length) {
          const pRes = await api('/LiveTv/Programs', {
            params: {
              UserId: state.userId, ChannelIds: channels.map((c) => c.Id).join(','),
              MinEndDate: start.toISOString(), MaxStartDate: end.toISOString(),
              SortBy: 'StartDate', EnableImages: false, Fields: 'Overview',
            },
          });
          programs = pRes?.Items || [];
        }
        if (!isCurrent()) return;
        if (!channels.length && !rows.children.length) rows.innerHTML = '<p class="empty-msg">No channels found.</p>';
        for (const ch of channels) rows.appendChild(guideRow(ch, programs.filter((p) => p.ChannelId === ch.Id)));
      } catch (e) {
        console.error(e);
        total = 0;
        if (!rows.children.length) rows.innerHTML = `<p class="empty-msg">Could not load the guide: ${esc(e.message)}</p>`;
      } finally {
        spinner.remove();
        loading = false;
      }
    };

    function guideRow(ch, programs) {
      const row = document.createElement('div');
      row.className = 'guide-row';
      const logo = ch.ImageTags?.Primary ? imageUrl(ch.Id, 'Primary', { tag: ch.ImageTags.Primary, maxWidth: 160 }) : '';
      row.innerHTML = `
        <button class="guide-ch" title="Watch ${esc(ch.Name)}">
          ${logo ? `<img loading="lazy" src="${esc(logo)}" alt="">` : ''}
          <span class="guide-ch-num">${esc(ch.ChannelNumber || ch.Number || '')}</span>
          ${logo ? '' : `<span class="guide-ch-name">${esc(ch.Name)}</span>`}
        </button>
        <div class="guide-progs" style="width:${width}px"></div>`;
      $('.guide-ch', row).addEventListener('click', () => playItem(ch));
      const lane = $('.guide-progs', row);
      if (!programs.length) lane.innerHTML = `<div class="guide-empty">${esc(ch.Name)}</div>`;
      const now = Date.now();
      for (const p of programs) {
        const ps = parseDate(p.StartDate), pe = parseDate(p.EndDate);
        const left = Math.max(0, xOf(ps)), right = Math.min(width, xOf(pe));
        if (right - left < 4) continue;
        const btn = document.createElement('button');
        const airing = ps <= now && pe > now;
        btn.className = 'guide-prog' + (airing ? ' now' : '') + (p.TimerId ? ' recording' : '');
        btn.style.left = left + 'px';
        btn.style.width = (right - left - 3) + 'px';
        btn.innerHTML = `<strong>${esc(p.Name)}</strong><span>${esc(timeRange(p))}</span>`;
        btn.addEventListener('click', () => openProgram(p.Id, ch));
        lane.appendChild(btn);
      }
      return row;
    }

    new IntersectionObserver((entries, io) => {
      if (!isCurrent()) { io.disconnect(); return; }
      if (entries.some((e) => e.isIntersecting)) loadMore();
    }, { root: guide, rootMargin: '400px' }).observe(sentinel);
    await loadMore();
    // Start the timeline a little before "now".
    guide.scrollLeft = Math.max(0, xOf(new Date()) - 60);
  }

  async function openProgram(programId, channel) {
    const token = ++modalToken;
    const modal = $('#modal'), content = $('#modal-content');
    if (modal.classList.contains('hidden')) rememberFocus('modal');
    content.innerHTML = '<div class="spinner" style="margin:6rem auto"></div>';
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    let p;
    try { p = await api(`/LiveTv/Programs/${programId}`, { params: { UserId: state.userId } }); } catch (e) {
      if (token === modalToken) content.innerHTML = `<p class="empty-msg">Could not load program: ${esc(e.message)}</p>`;
      return;
    }
    if (token !== modalToken) return;
    const start = parseDate(p.StartDate), end = parseDate(p.EndDate), now = Date.now();
    const airing = start <= now && end > now;
    const img = p.ImageTags?.Primary ? imageUrl(p.Id, 'Primary', { tag: p.ImageTags.Primary, maxWidth: 900 })
      : p.ImageTags?.Thumb ? imageUrl(p.Id, 'Thumb', { tag: p.ImageTags.Thumb, maxWidth: 900 }) : '';
    const day = start.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    content.innerHTML = `
      <div class="m-body program-body">
        ${img ? `<div class="program-img" style="background-image:url('${esc(img)}')"></div>` : ''}
        <h2>${esc(p.Name)}</h2>
        ${p.EpisodeTitle ? `<p class="overview" style="font-weight:600">${esc(p.EpisodeTitle)}</p>` : ''}
        <div class="meta">
          ${airing ? '<span class="live-badge">LIVE</span>' : ''}
          <span>${esc(channelLabel(channel || { Name: p.ChannelName }))}</span>
          <span>${esc(day)}, ${esc(timeRange(p))}</span>
          ${p.OfficialRating ? `<span class="rating">${esc(p.OfficialRating)}</span>` : ''}
        </div>
        <p class="overview">${esc(p.Overview || '')}</p>
        <div class="m-actions program-actions">
          ${airing ? `<button class="btn btn-white" data-act="watch">${ICONS.play} Watch Live</button>` : ''}
          <button class="btn btn-gray" data-act="record"></button>
          ${p.IsSeries ? '<button class="btn btn-gray" data-act="series"></button>' : ''}
        </div>
      </div>`;
    const recBtn = $('[data-act="record"]', content), seriesBtn = $('[data-act="series"]', content);
    const paint = () => {
      recBtn.innerHTML = p.TimerId ? '&#9679; Cancel Recording' : '&#9679; Record';
      if (seriesBtn) seriesBtn.textContent = p.SeriesTimerId ? 'Cancel Series Recording' : 'Record Series';
    };
    paint();
    $('[data-act="watch"]', content)?.addEventListener('click', () => playItem(channel || { Id: p.ChannelId, Type: 'TvChannel' }));
    recBtn.addEventListener('click', async () => {
      try {
        if (p.TimerId) {
          await api(`/LiveTv/Timers/${p.TimerId}`, { method: 'DELETE' });
          p.TimerId = null;
          toast('Recording cancelled');
        } else {
          const defaults = await api('/LiveTv/Timers/Defaults', { params: { ProgramId: p.Id } });
          await api('/LiveTv/Timers', { method: 'POST', body: { ...defaults, ProgramId: p.Id } });
          const fresh = await api(`/LiveTv/Programs/${p.Id}`, { params: { UserId: state.userId } });
          p.TimerId = fresh?.TimerId || 'pending';
          toast('Recording scheduled');
        }
        paint();
      } catch (e) { toast(e.status === 403 ? "Your account isn't allowed to record." : 'Could not update recording: ' + e.message); }
    });
    seriesBtn?.addEventListener('click', async () => {
      try {
        if (p.SeriesTimerId) {
          await api(`/LiveTv/SeriesTimers/${p.SeriesTimerId}`, { method: 'DELETE' });
          p.SeriesTimerId = null;
          toast('Series recording cancelled');
        } else {
          const defaults = await api('/LiveTv/Timers/Defaults', { params: { ProgramId: p.Id } });
          await api('/LiveTv/SeriesTimers', { method: 'POST', body: { ...defaults, ProgramId: p.Id } });
          const fresh = await api(`/LiveTv/Programs/${p.Id}`, { params: { UserId: state.userId } });
          p.SeriesTimerId = fresh?.SeriesTimerId || 'pending';
          toast('Series recording scheduled');
        }
        paint();
      } catch (e) { toast(e.status === 403 ? "Your account isn't allowed to record." : 'Could not update recording: ' + e.message); }
    });
    autoFocus($('.program-actions button', content));
  }

  // Newer Emby versions file finished recordings in recording folders (browsed like a library);
  // /LiveTv/Recordings can come back empty there, so read both and merge.
  async function loadRecordings() {
    const fields = ITEM_FIELDS + ',Path';
    const [direct, folders] = await Promise.allSettled([
      api('/LiveTv/Recordings', { params: { UserId: state.userId, Fields: fields, ...IMAGE_PARAMS, Limit: 500 } }),
      api('/LiveTv/Recordings/Folders', { params: { UserId: state.userId } }),
    ]);
    const lists = [];
    if (direct.status === 'fulfilled') lists.push(direct.value?.Items);
    if (folders.status === 'fulfilled') {
      const inFolders = await Promise.allSettled((folders.value?.Items || []).map((f) => getItems({
        ParentId: f.Id, IsFolder: false, MediaTypes: 'Video', Fields: fields,
        SortBy: 'DateCreated', SortOrder: 'Descending', Limit: 500,
      })));
      inFolders.forEach((r) => { if (r.status === 'fulfilled') lists.push(r.value?.Items); });
    }
    if (direct.status === 'rejected' && folders.status === 'rejected') throw direct.reason;
    // The same recording can come back from both sources; match on id or file path.
    const seen = new Set(), out = [];
    for (const it of lists.flat()) {
      if (!it) continue;
      const keys = [it.Id, it.Path].filter(Boolean);
      if (keys.some((k) => seen.has(k))) continue;
      keys.forEach((k) => seen.add(k));
      out.push(it);
    }
    return out.sort((a, b) => (parseDate(b.DateCreated) || 0) - (parseDate(a.DateCreated) || 0));
  }

  async function renderRecordings(body, isCurrent) {
    body.innerHTML = `
      <h2 class="row-title flush">Recordings</h2>
      <div class="grid" data-recordings><div class="spinner" style="grid-column:1/-1"></div></div>
      <h2 class="row-title flush" style="margin-top:2.5rem">Scheduled</h2>
      <div class="timer-list" data-timers><div class="spinner"></div></div>`;
    const grid = $('[data-recordings]', body), timers = $('[data-timers]', body);
    loadRecordings().then((items) => {
      if (!isCurrent()) return;
      grid.innerHTML = items.length ? '' : '<p class="empty-msg" style="grid-column:1/-1">No recordings yet.</p>';
      items.forEach((it) => grid.appendChild(createPoster(it)));
    }).catch((e) => { grid.innerHTML = `<p class="empty-msg" style="grid-column:1/-1">Could not load recordings: ${esc(e.message)}</p>`; });

    const loadTimers = () => api('/LiveTv/Timers', { params: { IsActive: false } }).then((res) => {
      if (!isCurrent()) return;
      const items = (res?.Items || []).sort((a, b) => parseDate(a.StartDate) - parseDate(b.StartDate));
      timers.innerHTML = items.length ? '' : '<p class="empty-msg">Nothing scheduled. Choose a show in the Guide and press Record.</p>';
      for (const t of items) {
        const row = document.createElement('div');
        row.className = 'timer-row';
        const start = parseDate(t.StartDate);
        row.innerHTML = `
          <div class="timer-text">
            <strong>${esc(t.Name)}</strong>
            <span>${esc(t.ChannelName || '')} · ${esc(start.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }))}, ${esc(timeRange(t))}</span>
          </div>
          <button class="btn btn-gray">Cancel</button>`;
        $('button', row).addEventListener('click', async () => {
          try {
            await api(`/LiveTv/Timers/${t.Id}`, { method: 'DELETE' });
            toast('Recording cancelled');
            loadTimers();
          } catch (e) { toast('Could not cancel: ' + e.message); }
        });
        timers.appendChild(row);
      }
    }).catch((e) => { timers.innerHTML = `<p class="empty-msg">Could not load scheduled recordings: ${esc(e.message)}</p>`; });
    loadTimers();
  }

  async function changeChannel(delta) {
    const ids = await ensureChannelList();
    if (!ids.length || !live.tunedId) return;
    const i = ids.indexOf(live.tunedId);
    const next = ids[(Math.max(i, 0) + delta + ids.length) % ids.length];
    // Remember it right away so fast repeated presses keep counting from here.
    live.tunedId = next;
    playItem({ Id: next, Type: 'TvChannel' });
  }

  // ---------- Requests (Jellyseerr) ----------
  // Jellyseerr doesn't allow cross-site calls from a web page, so the Android app makes them natively
  // (EmbyFlixAndroid.httpRequest). Each person signs in to Jellyseerr with their Emby details, so requests
  // are made as them and Jellyseerr's own permissions and limits apply.
  const TMDB_IMG = 'https://image.tmdb.org/t/p/';
  const hasRequests = () => state.requestsEnabled && !!state.requestsServer && !!nativeApp?.httpRequest;
  const MEDIA_STATUS = { 2: 'Requested', 3: 'Requested', 4: 'Partly available', 5: 'Available' };
  const REQUEST_STATUS = { 1: 'Waiting for approval', 2: 'Approved', 3: 'Declined' };

  let httpSeq = 0;
  const httpPending = new Map();
  window.auroraHttpDone = (id, res) => {
    const done = httpPending.get(id);
    if (done) { httpPending.delete(id); done(res); }
  };
  function nativeHttp(method, url, headers, body, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = 'h' + (++httpSeq);
      const timer = setTimeout(() => { httpPending.delete(id); reject(new Error('The server took too long to answer.')); }, timeoutMs);
      httpPending.set(id, (res) => { clearTimeout(timer); resolve(res); });
      nativeApp.httpRequest(id, method, url, JSON.stringify(headers || {}), body == null ? '' : body);
    });
  }

  const requestsCookie = (userId = state.userId) => getAccounts().find((a) => a.userId === userId)?.requestsCookie || '';
  function setRequestsCookie(cookie, userId = state.userId) {
    const list = getAccounts(), acc = list.find((a) => a.userId === userId);
    if (!acc) return;
    acc.requestsCookie = cookie;
    saveAccounts(list);
  }

  async function seerr(path, opts = {}) {
    try {
      return await seerrOnce(path, opts);
    } catch (e) {
      // The Jellyseerr session ran out while browsing: sign in again quietly and retry once.
      if ((e.status === 401 || e.status === 403) && !path.startsWith('/auth/') && !opts.userId && !opts.retried
          && (await silentSeerrLogin())) {
        return seerrOnce(path, { ...opts, retried: true });
      }
      throw e;
    }
  }

  async function seerrOnce(path, { method = 'GET', body, userId } = {}) {
    const headers = { Accept: 'application/json' };
    const cookie = requestsCookie(userId);
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await nativeHttp(method, state.requestsServer + '/api/v1' + path, headers, body === undefined ? null : JSON.stringify(body));
    if (!res || !res.status) throw new Error('Could not reach the request server.');
    let data = null;
    try { data = res.body ? JSON.parse(res.body) : null; } catch { /* not JSON */ }
    if (res.status >= 400) {
      const err = new Error(data?.message || data?.error || `Request server error (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return { data, setCookie: res.setCookie || '' };
  }

  // Signs in to Jellyseerr with the same Emby username and password.
  async function seerrLogin(username, password, userId = state.userId) {
    setRequestsCookie('', userId);
    const { setCookie } = await seerr('/auth/jellyfin', { method: 'POST', body: { username, password }, userId });
    if (!setCookie) throw new Error('The request server did not start a session.');
    setRequestsCookie(setCookie, userId);
  }

  // The Emby password is kept on the device, encrypted with a key held by Android's secure key store
  // (the web version keeps nothing), so Requests can sign people in to Jellyseerr without asking.
  function rememberLogin(userId, username, password) {
    if (!nativeApp?.encrypt) return;
    let secret = '';
    try { secret = nativeApp.encrypt(password) || ''; } catch { return; }
    if (!secret) return;
    const list = getAccounts(), acc = list.find((a) => a.userId === userId);
    if (!acc) return;
    acc.loginName = username;
    acc.secret = secret;
    saveAccounts(list);
  }

  // Signs in to Jellyseerr in the background with the saved details. Returns false if there are none.
  async function silentSeerrLogin() {
    const acc = getAccounts().find((a) => a.userId === state.userId);
    if (!acc?.secret || !nativeApp?.decrypt) return false;
    let password = null;
    try { password = nativeApp.decrypt(acc.secret); } catch { /* treated as no saved password */ }
    if (password == null) return false; // Android reset its key store; nothing to sign in with
    try {
      await seerrLogin(acc.loginName || acc.name, password);
      return true;
    } catch (e) {
      // A changed password: forget the saved one so it isn't retried forever.
      if (e.status === 401 || e.status === 403) {
        const list = getAccounts(), a = list.find((x) => x.userId === state.userId);
        if (a) { a.secret = ''; saveAccounts(list); }
      }
      // The server can't be reached at all: say so, rather than asking the viewer to sign in.
      if (!e.status) throw e;
      return false;
    }
  }

  async function seerrMe() {
    const fetchMe = async () => {
      if (!requestsCookie()) return null;
      try {
        return (await seerr('/auth/me')).data;
      } catch (e) {
        if (e.status === 401 || e.status === 403) { setRequestsCookie(''); return null; }
        throw e;
      }
    };
    // No session yet, or it expired: sign in again quietly before falling back to asking.
    return (await fetchMe()) || ((await silentSeerrLogin()) ? fetchMe() : null);
  }

  const tmdbImage = (path, size) => (path ? TMDB_IMG + size + path : '');
  const seerrTitle = (m) => m.title || m.name || '';
  const seerrYear = (m) => (m.releaseDate || m.firstAirDate || '').slice(0, 4);

  function seerrStatus(m) {
    const req = m.request; // set for cards in the Requested and Available lists
    if (req?.status === 3) return 'Declined';
    if ((m.mediaInfo?.status || 0) >= 4) return MEDIA_STATUS[m.mediaInfo.status];
    if (req) return REQUEST_STATUS[req.status] || 'Requested';
    return MEDIA_STATUS[m.mediaInfo?.status] || '';
  }

  function createSeerrCard(m) {
    const card = document.createElement('div');
    card.className = 'card seerr-card';
    card.tabIndex = 0;
    card.dataset.seerr = `${m.mediaType}:${m.id}`;
    const img = tmdbImage(m.backdropPath, 'w500') || tmdbImage(m.posterPath, 'w342');
    const status = seerrStatus(m);
    const kind = m.mediaType === 'tv' ? 'Series' : 'Movie';
    const req = m.request;
    const who = req ? (req.requestedBy?.id === seerrMeId ? 'you' : req.requestedBy?.displayName || req.requestedBy?.username || '') : '';
    const sub = req ? [who && `Requested by ${who}`, timeAgo(req.createdAt)].filter(Boolean).join(' · ') : [seerrYear(m), kind].filter(Boolean).join(' • ');
    card.innerHTML = `
      ${img ? `<img loading="lazy" src="${esc(img)}" alt=""${m.backdropPath ? '' : ' class="contain"'}>` : `<div class="card-fallback">${esc(seerrTitle(m))}</div>`}
      ${status ? `<span class="seerr-badge s-${esc(status.split(' ')[0].toLowerCase())}">${esc(status)}</span>` : ''}
      <div class="card-info"><div>${esc(seerrTitle(m))}</div><div class="sub">${esc(sub)}</div></div>`;
    card.addEventListener('click', () => openSeerrItem(m.mediaType, m.id));
    return card;
  }

  const onlyMedia = (results) => (results || []).filter((m) => m.mediaType === 'movie' || m.mediaType === 'tv');

  // Requests only carry the TMDB id, so titles and pictures are looked up (and remembered for the session).
  const seerrDetails = new Map();
  let seerrMeId = null;
  function seerrDetail(type, tmdbId) {
    const key = `${type}:${tmdbId}`;
    if (!seerrDetails.has(key)) {
      seerrDetails.set(key, seerr(`/${type}/${tmdbId}`).then(({ data }) => data).catch((e) => { seerrDetails.delete(key); throw e; }));
    }
    return seerrDetails.get(key);
  }

  // Everyone's requests that this account may see (Jellyseerr shows people without request-management rights only
  // their own), one entry per title, newest first, split into still-requested and ready-to-watch.
  async function loadRequestLists() {
    const { data } = await seerr('/request?take=100&skip=0&sort=added&filter=all');
    const byMedia = new Map();
    (data?.results || []).forEach((r) => {
      const type = r.media?.mediaType || r.type;
      const key = `${type}:${r.media?.tmdbId}`;
      if (!r.media?.tmdbId || byMedia.has(key)) return; // the newest request for a title stands for it
      byMedia.set(key, { r, type });
    });
    const requested = [], available = [];
    [...byMedia.values()].forEach((e) => ((e.r.media?.status || 0) >= 4 ? available : requested).push(e));
    // Declined requests go to the end of the requested list.
    requested.sort((a, b) => (a.r.status === 3) - (b.r.status === 3));
    return { requested, available };
  }

  // Fills a grid with request cards, loading a few titles at a time.
  async function fillRequestGrid(grid, entries, isCurrent) {
    let next = 0;
    const slots = entries.map(() => {
      const ph = document.createElement('div');
      ph.className = 'card seerr-card placeholder';
      grid.appendChild(ph);
      return ph;
    });
    const worker = async () => {
      while (next < entries.length && isCurrent()) {
        const i = next++, { r, type } = entries[i];
        try {
          const m = await seerrDetail(type, r.media.tmdbId);
          if (!isCurrent()) return;
          const card = createSeerrCard({ ...m, mediaType: type, request: r, mediaInfo: { ...(m.mediaInfo || {}), status: r.media.status } });
          const hadFocus = slots[i] === document.activeElement;
          slots[i].replaceWith(card);
          if (hadFocus) focusEl(card);
        } catch { slots[i].remove(); }
      }
    };
    await Promise.all([0, 1, 2, 3, 4, 5].map(worker));
  }

  const REQUEST_TABS = [['discover', 'Discover'], ['requested', 'Requested'], ['available', 'Available']];

  async function renderRequests(page, isCurrent, tab = 'discover') {
    if (!REQUEST_TABS.some(([id]) => id === tab)) tab = 'discover';
    if (!hasRequests()) {
      page.innerHTML = `
        <div class="page-pad requests-page">
          <div class="coming-soon">
            <div class="coming-soon-icon">${ICONS.play}</div>
            <span class="coming-soon-tag">Coming soon</span>
            <h1>Request movies and shows</h1>
            <p>Soon you'll be able to ask for any movie or TV show right here in Aurora, and follow your requests until they're ready to watch.</p>
            <a href="#/home" class="btn btn-white" data-autofocus>Back to Home</a>
          </div>
        </div>`;
      autoFocus($('.coming-soon .btn', page));
      return;
    }
    page.innerHTML = `
      <div class="page-pad requests-page">
        <div class="page-head">
          <h1>Requests</h1>
          <div class="tab-bar req-tabs hidden">
            ${REQUEST_TABS.map(([id, label]) => `<a href="#/requests?tab=${id}" class="tab${id === tab ? ' active' : ''}" data-tab="${id}">${label}<span class="tab-count"></span></a>`).join('')}
          </div>
          <div class="req-search hidden"><input type="search" placeholder="Search for a movie or show to request" autocomplete="off"></div>
        </div>
        <div data-req-body><div class="spinner"></div></div>
      </div>`;
    const body = $('[data-req-body]', page);
    let me;
    try { me = await seerrMe(); } catch (e) {
      if (!isCurrent()) return;
      const unreachable = !e.status;
      body.innerHTML = `<div class="req-down">
        <h2>${unreachable ? "Requests can't be reached right now" : 'Requests ran into a problem'}</h2>
        <p class="muted">${unreachable
          ? `Aurora couldn't connect to the request server${isAdmin() ? ` at <strong>${esc(state.requestsServer)}</strong>` : ''}. ${isAdmin()
            ? "If Jellyseerr is running, its address has probably changed (a Cloudflare quick tunnel gets a new address each time it restarts). Put the new one in Admin → Requests."
            : 'Please try again later.'}`
          : esc(e.message)}</p>
        <div class="m-actions"><button class="btn btn-white" data-retry>Try again</button>${isAdmin() ? '<a class="btn btn-gray" href="#/admin?tab=requests">Admin → Requests</a>' : ''}</div>
      </div>`;
      $('[data-retry]', body).addEventListener('click', () => route());
      autoFocus($('[data-retry]', body));
      return;
    }
    if (!isCurrent()) return;
    if (!me) return renderRequestsConnect(page, body, isCurrent);
    seerrMeId = me.id;

    const tabs = $('.req-tabs', page);
    tabs.classList.remove('hidden');
    const lists = loadRequestLists();
    lists.then(({ requested, available }) => {
      if (!isCurrent()) return;
      $('[data-tab="requested"] .tab-count', tabs).textContent = requested.length ? ` ${requested.length}` : '';
      $('[data-tab="available"] .tab-count', tabs).textContent = available.length ? ` ${available.length}` : '';
    }).catch(() => {});

    if (tab !== 'discover') {
      autoFocus($('.tab.active', page));
      let data;
      try { data = await lists; } catch (e) {
        if (isCurrent()) body.innerHTML = `<p class="empty-msg">Couldn't load requests: ${esc(e.message)}</p>`;
        return;
      }
      if (!isCurrent()) return;
      const entries = data[tab];
      if (!entries.length) {
        body.innerHTML = `<p class="empty-msg">${tab === 'requested'
          ? 'Nothing is waiting. Find something in Discover and request it.'
          : "Nothing requested is ready yet. Titles show up here once they're in the library."}</p>`;
        return;
      }
      body.innerHTML = `<p class="req-list-note">${tab === 'requested'
        ? 'Requested titles stay here until they arrive in the library.'
        : 'Requested titles that are now in the library. Open one to watch it in Aurora.'}</p><div class="grid seerr-grid"></div>`;
      fillRequestGrid($('.grid', body), entries, isCurrent);
      return;
    }

    const searchBox = $('.req-search', page), input = $('input', searchBox);
    searchBox.classList.remove('hidden');
    // Anything already requested or in the library lives in its own tab, not in Discover.
    const fresh = (results) => onlyMedia(results).filter((m) => (m.mediaInfo?.status || 1) < 2);
    const showBrowse = () => {
      body.innerHTML = '';
      const rows = document.createElement('div');
      rows.className = 'rows flush-rows';
      body.appendChild(rows);
      const add = (title, loader) => addRow(rows, title, loader, { isCurrent, createItem: createSeerrCard });
      add('Trending', async () => fresh((await seerr('/discover/trending?page=1')).data?.results));
      add('Popular Movies', async () => fresh((await seerr('/discover/movies?page=1')).data?.results));
      add('Popular TV Shows', async () => fresh((await seerr('/discover/tv?page=1')).data?.results));
      add('Coming Soon', async () => fresh((await seerr('/discover/movies/upcoming?page=1')).data?.results));
    };
    let timer, searchToken = 0;
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim(), token = ++searchToken;
        if (!q) return showBrowse();
        body.innerHTML = '<div class="spinner"></div>';
        try {
          const { data } = await seerr(`/search?query=${encodeURIComponent(q)}&page=1`);
          if (token !== searchToken || !isCurrent()) return;
          const results = onlyMedia(data?.results);
          body.innerHTML = results.length ? '<div class="grid seerr-grid"></div>' : `<p class="empty-msg">Nothing found for "${esc(q)}".</p>`;
          results.forEach((m) => $('.grid', body)?.appendChild(createSeerrCard(m)));
        } catch (e) {
          if (token === searchToken) body.innerHTML = `<p class="empty-msg">Search failed: ${esc(e.message)}</p>`;
        }
      }, 450);
    });
    showBrowse();
    autoFocus(input);
  }

  // People who signed in before Requests existed (or whose Jellyseerr session expired) enter their password once.
  function renderRequestsConnect(page, body, isCurrent) {
    body.innerHTML = `
      <form class="req-connect">
        <h2>Request movies and shows</h2>
        <p>Enter your password once to connect your account to requests. Use the same password you sign in with.</p>
        <label>Username<input type="text" value="${esc(state.user?.Name || '')}" readonly></label>
        <label>Password<input type="password" data-pw autocomplete="current-password"></label>
        <p class="error hidden" data-err></p>
        <button class="btn btn-red" type="submit" data-autofocus>Connect</button>
      </form>`;
    const form = $('form', body), err = $('[data-err]', body);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button', form);
      btn.disabled = true; btn.textContent = 'Connecting…';
      try {
        const password = $('[data-pw]', form).value;
        await seerrLogin(state.user?.Name || '', password);
        rememberLogin(state.userId, state.user?.Name || '', password);
        if (isCurrent()) route();
      } catch (ex) {
        err.textContent = ex.status === 401 || ex.status === 403 ? 'That password was not accepted.' : ex.message;
        err.classList.remove('hidden');
        btn.disabled = false; btn.textContent = 'Connect';
      }
    });
    autoFocus($('[data-pw]', form));
  }

  async function openSeerrItem(type, tmdbId) {
    const token = ++modalToken;
    const modal = $('#modal'), content = $('#modal-content');
    if (modal.classList.contains('hidden')) rememberFocus('modal');
    content.innerHTML = '<div class="spinner" style="margin:6rem auto"></div>';
    modal.classList.remove('hidden');
    modal.scrollTop = 0;
    document.body.style.overflow = 'hidden';
    let m;
    try { m = (await seerr(`/${type}/${tmdbId}`)).data; } catch (e) {
      if (token === modalToken) content.innerHTML = `<p class="empty-msg">Could not load details: ${esc(e.message)}</p>`;
      return;
    }
    if (token !== modalToken) return;
    const isTv = type === 'tv';
    const status = m.mediaInfo?.status || 1;
    const seasons = isTv ? (m.seasons || []).filter((s) => s.seasonNumber > 0) : [];
    // Seasons already available or requested can't be requested again.
    const taken = new Map();
    (m.mediaInfo?.seasons || []).forEach((s) => { if (s.status > 1) taken.set(s.seasonNumber, MEDIA_STATUS[s.status] || 'Requested'); });
    (m.mediaInfo?.requests || []).forEach((r) => {
      if (r.status !== 3) (r.seasons || []).forEach((s) => { if (!taken.has(s.seasonNumber)) taken.set(s.seasonNumber, REQUEST_STATUS[r.status] || 'Requested'); });
    });
    const meta = [seerrYear(m), isTv ? `${seasons.length} Season${seasons.length === 1 ? '' : 's'}` : (m.runtime ? formatRuntime(m.runtime * 60 * TICKS_PER_SECOND) : ''),
      (m.genres || []).slice(0, 3).map((g) => g.name).join(', ')].filter(Boolean);
    const backdrop = tmdbImage(m.backdropPath, 'w1280');
    const video = (m.relatedVideos || []).find((v) => v.site === 'YouTube' && v.type === 'Trailer')
      || (m.relatedVideos || []).find((v) => v.site === 'YouTube');
    const trailerUrl = video?.url || (video?.key ? `https://www.youtube.com/watch?v=${video.key}` : '');
    content.innerHTML = `
      <div class="m-hero" style="background-image:url('${esc(backdrop)}')">
        <div class="m-hero-content"><h2>${esc(seerrTitle(m))}</h2></div>
      </div>
      <div class="m-body">
        <div class="meta">${meta.map((t) => `<span>${esc(t)}</span>`).join('')}${MEDIA_STATUS[status] ? `<span class="seerr-badge inline s-${MEDIA_STATUS[status].split(' ')[0].toLowerCase()}">${MEDIA_STATUS[status]}</span>` : ''}</div>
        <p class="overview">${esc(m.overview || '')}</p>
        ${isTv && seasons.length ? `<div class="m-section-head"><h3>Seasons</h3></div><div class="season-picks">${seasons.map((s) => {
          const t = taken.get(s.seasonNumber);
          return `<button class="season-pick${t ? ' taken' : ' on'}" data-season="${s.seasonNumber}"${t ? ' disabled' : ''}>
            <strong>Season ${s.seasonNumber}</strong><span>${t ? esc(t) : `${s.episodeCount || '?'} episodes`}</span></button>`;
        }).join('')}</div>` : ''}
        <p class="error hidden" data-err></p>
        <div class="m-actions seerr-actions"></div>
      </div>`;
    const actions = $('.seerr-actions', content), err = $('[data-err]', content);
    const picks = () => $$('.season-pick.on', content).map((b) => Number(b.dataset.season));
    $$('.season-pick:not(.taken)', content).forEach((b) => b.addEventListener('click', () => { b.classList.toggle('on'); paint(); }));

    function paint() {
      const canRequest = isTv ? seasons.some((s) => !taken.has(s.seasonNumber)) : status < 2;
      const n = picks().length;
      actions.innerHTML = '';
      if (status >= 4) actions.insertAdjacentHTML('beforeend', `<button class="btn btn-white" data-act="watch">${ICONS.play} Watch in Aurora</button>`);
      if (trailerUrl) actions.insertAdjacentHTML('beforeend', `<button class="btn btn-gray" data-act="trailer">${ICONS.film} Trailer</button>`);
      if (canRequest) {
        actions.insertAdjacentHTML('beforeend', isTv
          ? `<button class="btn btn-red" data-act="request"${n ? '' : ' disabled'}>Request ${n} season${n === 1 ? '' : 's'}</button>`
          : '<button class="btn btn-red" data-act="request">Request</button>');
      } else if (status < 4) {
        actions.insertAdjacentHTML('beforeend', `<span class="seerr-done">${esc(MEDIA_STATUS[status] || 'Requested')}</span>`);
      }
      $('[data-act="watch"]', actions)?.addEventListener('click', () => watchInAurora(m, isTv));
      $('[data-act="trailer"]', actions)?.addEventListener('click', () => openYouTube(trailerUrl, seerrTitle(m)));
      $('[data-act="request"]', actions)?.addEventListener('click', submit);
    }

    async function submit(e) {
      e.target.disabled = true;
      err.classList.add('hidden');
      try {
        const body = { mediaType: type, mediaId: Number(tmdbId) };
        if (isTv) body.seasons = picks();
        await seerr('/request', { method: 'POST', body });
        toast(`Requested ${seerrTitle(m)}. It's now in the Requested list.`);
        // It now belongs in the Requested list, so take it out of Discover.
        if (!isTv) $$(`#page .seerr-card[data-seerr="${type}:${tmdbId}"]`).forEach((c) => c.remove());
        const count = $('#page .req-tabs [data-tab="requested"] .tab-count');
        if (count && !isTv) count.textContent = ` ${(Number(count.textContent) || 0) + 1}`;
        if (token === modalToken) openSeerrItem(type, tmdbId);
      } catch (ex) {
        err.textContent = ex.status === 403 ? (ex.message && !/permission/i.test(ex.message) ? ex.message : "Your account isn't allowed to make this request.") : ex.message;
        err.classList.remove('hidden');
        e.target.disabled = false;
      }
    }

    paint();
    autoFocus($('.seerr-actions button', content) || $('.season-pick:not(.taken)', content));
  }

  // Finds the requested title in the Emby library and opens it.
  async function watchInAurora(m, isTv) {
    try {
      const res = await getItems({ SearchTerm: seerrTitle(m), IncludeItemTypes: isTv ? 'Series' : 'Movie', Limit: 10 });
      const items = res?.Items || [];
      const year = Number(seerrYear(m));
      const match = items.find((i) => !year || !i.ProductionYear || Math.abs(i.ProductionYear - year) <= 1) || items[0];
      if (match) openDetails(match.Id);
      else toast("It's not in the library yet. Try again a little later.");
    } catch (e) { toast('Could not search the library: ' + e.message); }
  }

  function updateRequestsLink() {
    // While Requests isn't switched on the tab still shows, with a "Coming soon" page.
    const comingSoon = !state.requestsEnabled || !state.requestsServer;
    $$('[data-route="requests"]').forEach((a) => a.classList.toggle('hidden', !comingSoon && !hasRequests()));
  }

  // The admin can set the Requests address in the app (Admin → Requests). It's kept on the Emby server for
  // every account, like the Live TV settings, and wins over aurora-config.json.
  const REQ_PREFS = { id: 'aurora-requests', client: 'aurora' };
  let requestsOverride = null; // {server, on, t} from Emby, or null to use aurora-config.json

  async function readAuroraPref(prefsId, userId = state.userId) {
    const prefs = await api(`/DisplayPreferences/${prefsId}`, { params: { userId, client: 'aurora' } });
    const raw = prefs?.CustomPrefs?.config;
    return raw ? JSON.parse(raw) : null;
  }
  function writeAuroraPref(prefsId, userId, value) {
    return api(`/DisplayPreferences/${prefsId}`, {
      method: 'POST', params: { userId, client: 'aurora' },
      body: {
        Id: prefsId, Client: 'aurora', SortBy: 'SortName', SortOrder: 'Ascending',
        RememberIndexing: false, RememberSorting: false, ScrollDirection: 'Horizontal', ShowBackdrop: false, ShowSidebar: false,
        PrimaryImageHeight: 0, PrimaryImageWidth: 0, CustomPrefs: { config: value ? JSON.stringify(value) : '' },
      },
    });
  }
  // Puts a setting on every account. Returns {saved, failed, total}.
  async function writeAuroraPrefForAll(prefsId, value) {
    const users = await api('/Users');
    let saved = 0, failed = 0;
    const queue = (users || []).slice();
    const worker = async () => {
      while (queue.length) {
        const u = queue.shift();
        try { await writeAuroraPref(prefsId, u.Id, value); saved++; } catch (e) { failed++; console.warn('Setting for', u.Name, e); }
      }
    };
    await Promise.all([0, 1, 2, 3].map(worker));
    return { saved, failed, total: (users || []).length };
  }

  function applyRequestsServer(value, enabled) {
    if (value === state.requestsServer && enabled === state.requestsEnabled) return;
    state.requestsServer = value;
    state.requestsEnabled = enabled;
    store.set('ef.requestsServer', value);
    store.set('ef.requestsEnabled', enabled ? '1' : '0');
    updateRequestsLink();
    if (/^#\/requests/.test(location.hash)) route();
  }

  // After sign-in: the address the admin set in the app, if any.
  // The update lock set in Admin → Updates (kept in every account's "aurora-app" display preferences) wins over
  // forceUpdateAfter in aurora-config.json. Read at sign-in and before each update check, so a locked device
  // picks up a change by itself.
  const APP_PREFS = 'aurora-app';
  // The Android app asks for the phone's lock when it opens; it needs to know this before the page loads.
  const syncAppLock = () => { try { nativeApp?.setAppLock?.(getPref('appLock') === 'on'); } catch { /* not the Android app */ } };
  async function refreshAppConfig() {
    if (!state.userId || !state.apiKey) return;
    try {
      const cfg = await readAuroraPref(APP_PREFS);
      if (cfg && Number.isFinite(Number(cfg.forceUpdateAfter))) {
        forceUpdateAfter = Math.max(0, Number(cfg.forceUpdateAfter));
        store.set('ef.forceUpdateAfter', String(forceUpdateAfter));
        store.set('ef.forceUpdateFromAdmin', '1');
      } else if (store.get('ef.forceUpdateFromAdmin')) {
        store.del('ef.forceUpdateFromAdmin');
        loadRemoteConfig();
      }
      applyRequiredUpdate();
    } catch { /* keep what's known */ }
    try {
      const pb = await readAuroraPref(PLAYBACK_PREFS);
      playbackCfg = pb && typeof pb === 'object' ? pb : {};
      store.set('ef.playbackCfg', JSON.stringify(playbackCfg));
    } catch { /* keep what's known */ }
    syncAppLock();
  }

  // ----- Account limits: devices per account and an expiry date -----
  // Limits and expiration dates live in Aurora Guard (server/aurora-guard.js), a small service on the Emby
  // server PC that only Emby administrators can read or change, and that enforces them every minute with
  // its own API key: it disables expired accounts and signs out devices over the limit, for every Emby app.
  // Older versions kept them in each account's display preferences, which any account can write; those
  // copies ("aurora-limits") are only read once more, to move them into the guard (see adminUsers).
  const OLD_LIMITS_PREFS = 'aurora-limits';
  const DEFAULT_GUARD_URL = 'https://emby4836.duckdns.org:8922';
  let guardUrl = store.get('ef.guardUrl') || DEFAULT_GUARD_URL;
  // SWITCHED OFF by default: with it off, Aurora never contacts the guard (no checks at sign-in or play start,
  // no delays, nothing in the app log). Turn it on with "guardEnabled": true in aurora-config.json, once the
  // guard service is set up, reachable and tested.
  let guardEnabled = store.get('ef.guardEnabled') === '1';
  // The guard can be slow or unreachable (the PC is off, a customer's network blocks the port). Anything the
  // viewer is waiting on uses a short timeout (quick: true), and after a failure the guard isn't tried again
  // for a few minutes, so a down guard never holds up opening the app or starting a video.
  let guardDownUntil = 0;
  async function guard(path, { method = 'GET', body, params, quick = false } = {}) {
    if (!guardEnabled) throw new Error('Aurora Guard is switched off');
    if (quick && Date.now() < guardDownUntil) throw new Error('Aurora Guard is not answering');
    const url = new URL(guardUrl.replace(/\/+$/, '') + path);
    for (const [k, v] of Object.entries(params || {})) if (v != null) url.searchParams.set(k, v);
    let res;
    try {
      res = await fetch(url, {
        method, cache: 'no-store', signal: AbortSignal.timeout(quick ? 3000 : 15000),
        headers: { 'X-Emby-Token': state.apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {
      if (quick) guardDownUntil = Date.now() + 5 * 60000;
      throw e;
    }
    guardDownUntil = 0;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const e = new Error(data.error || `Aurora Guard answered ${res.status}`); e.status = res.status; throw e; }
    return data;
  }
  const DEFAULT_DEVICE_LIMIT = 2;
  const ACTIVE_WINDOW = 5 * 60000; // a device counts as in use if it talked to Emby this recently
  const expiryEnd = (d) => new Date(`${d}T23:59:59`).getTime(); // the account works until the end of that day
  const isExpired = (lim) => !!lim?.expires && Date.now() > expiryEnd(lim.expires);
  const fmtDay = (d) => new Date(`${d}T12:00:00`).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' });
  const exemptFromLimits = (user) => !!user?.Policy?.IsAdministrator || ADMIN_NAMES.includes((user?.Name || '').toLowerCase());

  // The devices (unique DeviceIds) signed in to an account that talked to Emby in the last few minutes,
  // newest first. Uses Emby's session list.
  async function activeDevices(userId, { within = ACTIVE_WINDOW } = {}) {
    const sessions = await api('/Sessions', { params: { ActiveWithinSeconds: Math.round(within / 1000) } });
    const byDevice = new Map();
    for (const s of Array.isArray(sessions) ? sessions : []) {
      if (s.UserId !== userId || !s.DeviceId) continue;
      const at = Date.parse(s.LastActivityDate || 0) || 0;
      if (Date.now() - at > within) continue;
      const have = byDevice.get(s.DeviceId);
      if (!have || at > have.at || (s.NowPlayingItem && !have.playing)) {
        byDevice.set(s.DeviceId, {
          deviceId: s.DeviceId, sessionId: s.Id, name: s.DeviceName || 'Device', client: s.Client || '', version: s.ApplicationVersion || '',
          at: Math.max(at, have?.at || 0), playing: !!s.NowPlayingItem || !!have?.playing, title: s.NowPlayingItem?.Name || have?.title || '',
        });
      }
    }
    return [...byDevice.values()].sort((a, b) => b.at - a.at);
  }

  // null when this account may carry on, or {message} when it's blocked.
  // NOT A SECURITY BOUNDARY: this is only so people see a clear message up front instead of being signed out
  // a minute later. Anyone can skip it (another Emby app, an old Aurora). The real enforcement is Aurora
  // Guard's job on the server, which signs out devices over the limit and disables expired accounts.
  // phase "signin": every device in use counts; phase "play": the other devices playing right now.
  const access = { okUntil: 0 };
  async function checkAccess(user = state.user, phase = 'signin') {
    if (!guardEnabled || !user || exemptFromLimits(user)) return null;
    if (phase === 'play' && Date.now() < access.okUntil) return null;
    let r;
    try {
      r = await guard('/check', { quick: true, params: { userId: user.Id, deviceId: state.deviceId, phase } });
    } catch (e) {
      // The guard is down or unreachable: don't lock people out over a message. It still enforces when it's back.
      // Not a fault worth reporting: the check is a courtesy message, and the server enforces the limit anyway.
      if (Date.now() - (access.lastNote || 0) > 10 * 60000) {
        access.lastNote = Date.now();
        appLog.add('info', `Device limit check skipped: ${e.status === 401 ? 'the guard did not recognise this sign-in' : e.message}`);
      }
      access.okUntil = Date.now() + 120000;
      return null;
    }
    if (r.allowed === false) {
      return { message: r.reason === 'expired' && /\d{4}-\d{2}-\d{2}/.test(r.message)
        ? r.message.replace(/\d{4}-\d{2}-\d{2}/, (d) => fmtDay(d)) : r.message };
    }
    // Channel surfing doesn't ask every time. Being allowed to sign in also means being allowed to play (playing
    // is only a part of what counts for signing in), so the first video after opening the app doesn't wait.
    access.okUntil = Date.now() + (phase === 'play' ? 120000 : 30000);
    return null;
  }

  // Before anything plays: checks the limits, then runs start() if allowed.
  async function whenAllowed(start) {
    if (!guardEnabled) return start();
    // The message is a courtesy (the guard on the server enforces the limit), so it never holds a video up for
    // more than a moment: no answer in 1.5 s means "go ahead".
    const blocked = await Promise.race([checkAccess(state.user, 'play'), new Promise((r) => setTimeout(() => r(null), 1500))]).catch(() => null);
    if (!blocked) return start();
    appLog.add('info', 'Playback blocked: ' + blocked.message);
    showNotice('Can\'t play right now', blocked.message);
  }

  // A plain message with an OK button.
  function showNotice(title, text) {
    const modal = $('#modal'), content = $('#modal-content');
    modalToken++;
    if (modal.classList.contains('hidden')) rememberFocus('modal');
    content.innerHTML = `<div class="m-body notice-body"><h2>${esc(title)}</h2><p class="overview">${esc(text)}</p>
      <div class="m-actions"><button class="btn btn-white" data-act="ok" data-autofocus>OK</button></div></div>`;
    modal.classList.remove('hidden');
    $('[data-act="ok"]', content).addEventListener('click', closeModal);
    autoFocus($('[data-act="ok"]', content));
  }

  // Asks before something that can't be undone. Resolves true for the confirm button, false otherwise.
  let confirmResolve = null;
  function confirmAction(title, text, okLabel = 'Confirm') {
    return new Promise((resolve) => {
      const modal = $('#modal'), content = $('#modal-content');
      if (confirmResolve) confirmResolve(false);
      confirmResolve = resolve;
      modalToken++;
      if (modal.classList.contains('hidden')) rememberFocus('modal');
      content.innerHTML = `<div class="m-body notice-body"><h2>${esc(title)}</h2><p class="overview">${esc(text)}</p>
        <div class="m-actions"><button class="btn btn-red" data-act="yes">${esc(okLabel)}</button>
        <button class="btn btn-gray" data-act="no" data-autofocus>Cancel</button></div></div>`;
      modal.classList.remove('hidden');
      const done = (v) => { const r = confirmResolve; confirmResolve = null; closeModal(); r?.(v); };
      $('[data-act="yes"]', content).addEventListener('click', () => done(true));
      $('[data-act="no"]', content).addEventListener('click', () => done(false));
      autoFocus($('[data-act="no"]', content));
    });
  }

  async function refreshRequestsConfig() {
    try {
      const cfg = await readAuroraPref(REQ_PREFS.id);
      requestsOverride = cfg?.server ? cfg : null;
      if (requestsOverride) applyRequestsServer(requestsOverride.server, requestsOverride.on !== false);
      else loadRemoteConfig();
    } catch (e) { console.warn('Requests settings', e); }
  }

  // Reads the current Requests address from aurora-config.json in the repo, so a changed address
  // (a restarted Cloudflare quick tunnel, say) reaches every installed app without an update.
  async function loadRemoteConfig() {
    const hasOverride = !!requestsOverride; // the Requests address set in Admin wins over the file
    for (const url of REMOTE_CONFIG_URLS) {
      try {
        const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) continue;
        const cfg = await res.json();
        if (typeof cfg.guardEnabled === 'boolean') { guardEnabled = cfg.guardEnabled; store.set('ef.guardEnabled', guardEnabled ? '1' : '0'); }
        if (typeof cfg.guardUrl === 'string' && /^https?:\/\//.test(cfg.guardUrl)) { guardUrl = cfg.guardUrl.trim(); store.set('ef.guardUrl', guardUrl); }
        if (hasOverride) return;
        if (!store.get('ef.forceUpdateFromAdmin') && cfg.forceUpdateAfter !== undefined && Number.isFinite(Number(cfg.forceUpdateAfter))) {
          forceUpdateAfter = Math.max(0, Number(cfg.forceUpdateAfter));
          store.set('ef.forceUpdateAfter', String(forceUpdateAfter));
          applyRequiredUpdate();
        }
        const value = typeof cfg.requestsServer === 'string' ? cfg.requestsServer.trim().replace(/\/+$/, '') : '';
        if (value && !/^https?:\/\//.test(value)) return;
        if (requestsOverride) return;
        applyRequestsServer(value, cfg.requestsEnabled === true && !!value);
        return;
      } catch { /* try the next location */ }
    }
  }

  // ---------- Trailers ----------
  // Emby has two kinds: trailer files in the library (played in Aurora's player) and online trailers
  // (YouTube links, opened in the YouTube app, which handles a TV remote properly).
  const youTubeTrailers = (item) => (item.RemoteTrailers || []).map((t) => t.Url).filter((u) => youTubeId(u));
  const hasTrailer = (item) => (item.LocalTrailerCount || 0) > 0 || youTubeTrailers(item).length > 0;

  function youTubeId(url) {
    const m = String(url || '').match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{11})/);
    return m ? m[1] : '';
  }

  async function playTrailer(item) {
    if ((item.LocalTrailerCount || 0) > 0) {
      try {
        const local = await api(userPath(`/Items/${item.Id}/LocalTrailers`));
        if (local?.length) return playItem(local[0], { startTicks: 0 });
      } catch { /* fall back to an online trailer */ }
    }
    const url = youTubeTrailers(item)[0];
    if (url) openYouTube(url, item.Name);
    else toast('No trailer available.');
  }

  function openYouTube(url, title) {
    const id = youTubeId(url);
    if (!id) return toast('No trailer available.');
    // The Android app hands it to the YouTube app; without one (or in a browser) it plays in a window here.
    if (nativeApp?.openYouTube?.(id)) return;
    showTrailerWindow(id, title);
  }

  function showTrailerWindow(id, title) {
    rememberFocus('trailer');
    const box = $('#trailer');
    box.innerHTML = `
      <div class="trailer-frame">
        <div class="trailer-head">
          <strong>${title ? `${esc(title)} · Trailer` : 'Trailer'}</strong>
          <button class="btn btn-gray" data-act="close-trailer" data-autofocus>Close</button>
        </div>
        <iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(id)}?autoplay=1&rel=0&playsinline=1"
          allow="autoplay; encrypted-media; fullscreen; picture-in-picture" allowfullscreen title="Trailer"></iframe>
      </div>`;
    box.classList.remove('hidden');
    $('[data-act="close-trailer"]', box).addEventListener('click', closeTrailerWindow);
    box.addEventListener('click', (e) => { if (e.target === box) closeTrailerWindow(); }, { once: true });
    if (nav.on) focusEl($('[data-act="close-trailer"]', box));
  }

  const trailerOpen = () => !$('#trailer').classList.contains('hidden');
  function closeTrailerWindow() {
    const box = $('#trailer');
    if (box.classList.contains('hidden')) return;
    box.classList.add('hidden');
    box.innerHTML = ''; // stops the video
    restoreFocus('trailer');
  }

  // ---------- Settings ----------
  // Device settings live in this browser/app; language and subtitle choices are saved to the Emby account.
  const PREF_DEFAULTS = { splashSound: 'on', autoplay: 'on', stillWatching: 'on', subSize: 'm', subBg: 'semi', player: 'aurora', liveBuffer: 'medium', appLock: 'off' };
  // Playback settings the admin set for everyone (Admin → Playback). A value set there wins over the viewer's own.
  const PLAYBACK_PREFS = 'aurora-playback';
  let playbackCfg = (() => { try { return JSON.parse(store.get('ef.playbackCfg') || '{}') || {}; } catch { return {}; } })();
  // Playback settings apply on phones, TVs and in a browser. (The app lock is phones only: see the Android app.)
  const lockedPref = (key) => (key === 'liveBuffer' || key === 'player' || key === 'appLock') && playbackCfg[key] ? playbackCfg[key] : '';
  const stallSeconds = () => Number(playbackCfg.stallSeconds) || 0; // 0 = the player's own default
  const getPref = (key) => lockedPref(key) || store.get('ef.pref.' + key) || PREF_DEFAULTS[key];
  const setPref = (key, value) => store.set('ef.pref.' + key, value);

  const SUB_SIZES = { s: ['Small', '1.2rem'], m: ['Medium', '1.6rem'], l: ['Large', '2.2rem'], xl: ['Extra large', '2.8rem'] };
  const SUB_BACKGROUNDS = { none: ['None', 'transparent'], semi: ['See-through', 'rgba(0,0,0,.6)'], solid: ['Solid', '#000'] };
  const SUBTITLE_MODES = [
    ['Smart', 'Only when the audio is in another language'], ['Always', 'Always on'],
    ['OnlyForced', 'Only forced subtitles (signs and foreign dialogue)'], ['None', 'Off'], ['Default', "Use the file's default"],
  ];
  const LANGUAGES = [
    ['', 'Default'], ['eng', 'English'], ['spa', 'Spanish'], ['fre', 'French'], ['ger', 'German'], ['ita', 'Italian'],
    ['por', 'Portuguese'], ['dut', 'Dutch'], ['swe', 'Swedish'], ['nor', 'Norwegian'], ['dan', 'Danish'], ['fin', 'Finnish'],
    ['pol', 'Polish'], ['rus', 'Russian'], ['ukr', 'Ukrainian'], ['tur', 'Turkish'], ['gre', 'Greek'], ['ara', 'Arabic'],
    ['heb', 'Hebrew'], ['hin', 'Hindi'], ['jpn', 'Japanese'], ['kor', 'Korean'], ['chi', 'Chinese'], ['tha', 'Thai'], ['vie', 'Vietnamese'],
  ];

  function applySubtitleStyle() {
    const root = document.documentElement.style;
    root.setProperty('--cue-size', (SUB_SIZES[getPref('subSize')] || SUB_SIZES.m)[1]);
    root.setProperty('--cue-bg', (SUB_BACKGROUNDS[getPref('subBg')] || SUB_BACKGROUNDS.semi)[1]);
  }

  const selectHtml = (name, options, value, disabled = false) =>
    `<select data-setting="${name}"${disabled ? ' disabled' : ''}>${options.map(([v, label]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  const settingRow = (label, help, control) =>
    `<div class="setting-row"><div class="setting-label"><strong>${esc(label)}</strong>${help ? `<span>${esc(help)}</span>` : ''}</div>${control}</div>`;

  // "Aurora: Online / Offline" for customers (Settings). Aurora Guard's public /status page says whether the server
  // answers; if the guard can't be reached (it's off, or an older one the app can't read), ask the server itself.
  async function serviceOnline() {
    if (guardEnabled) {
      try {
        const res = await fetch(guardUrl.replace(/\/+$/, '') + '/status', { cache: 'no-store', signal: AbortSignal.timeout(6000) });
        const m = res.ok ? (await res.text()).match(/Aurora:\s*(online|offline)/i) : null;
        if (m) return m[1].toLowerCase() === 'online';
      } catch { /* ask the server instead */ }
    }
    try {
      const res = await fetch(state.server + '/emby/System/Info/Public', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
      return res.ok;
    } catch { return false; }
  }
  function showServiceStatus(el, isCurrent) {
    const update = async () => {
      const online = await serviceOnline();
      if (!isCurrent() || !el.isConnected) return;
      el.className = 'service-status ' + (online ? 'online' : 'offline');
      el.lastElementChild.textContent = online ? 'Aurora: Online' : 'Aurora: Offline';
    };
    update();
    const timer = setInterval(() => { if (!isCurrent() || !el.isConnected) clearInterval(timer); else update(); }, 60000);
  }

  // "My account": the plan (how many devices at once, how many in use), the date access ends, and a way to ask for more
  // time. Comes from Aurora Guard (GET /account, about this account only); the admin approves in Admin -> Users.
  async function showAccountInfo(section, isCurrent) {
    const box = $('[data-account-body]', section);
    if (!guardEnabled) { section.remove(); return; }
    const draw = async () => {
      let a;
      try { a = await guard('/account', { params: { userId: state.userId } }); }
      catch (e) {
        if (!isCurrent() || !section.isConnected) return;
        box.innerHTML = '<p class="setting-desc">Your plan details can\'t be shown right now. Try again in a moment.</p>';
        return;
      }
      if (!isCurrent() || !section.isConnected) return;
      if (a.admin) { box.innerHTML = settingRow('Account', 'Administrator: no device limit and no end date.', '<span class="setting-value">Administrator</span>'); return; }
      const n = a.limit, devWord = n === 1 ? 'device' : 'devices';
      const soon = a.daysLeft != null && a.daysLeft <= 7;
      const endText = a.expires ? `${fmtDay(a.expires)}${a.expired ? '' : ` · ${a.daysLeft <= 0 ? 'ends today' : a.daysLeft === 1 ? '1 day left' : a.daysLeft + ' days left'}`}` : 'No end date';
      const r = a.request;
      let reqHtml = '';
      if (r?.status === 'pending') reqHtml = `<p class="account-note">Extension requested ${esc(timeAgo(r.at))}. The admin will review it.</p>`;
      else if (r?.status === 'approved' && Date.now() - (r.decidedAt || 0) < 14 * 86400000) reqHtml = `<p class="account-note good">Your extension was approved${r.newExpires ? `: access now runs until ${esc(fmtDay(r.newExpires))}` : ''}.${r.message ? ' ' + esc(r.message) : ''}</p>`;
      else if (r?.status === 'denied' && Date.now() - (r.decidedAt || 0) < 14 * 86400000) reqHtml = `<p class="account-note bad">Your last request wasn't approved.${r.message ? ' ' + esc(r.message) : ' Please contact the admin.'}</p>`;
      box.innerHTML = `
        ${settingRow('Plan', 'How many devices can be signed in and in use at the same time.', `<span class="setting-value">Up to ${n} ${devWord}</span>`)}
        ${settingRow('In use right now', null, `<span class="setting-value">${a.activeDevices} of ${n}</span>`)}
        ${settingRow('Access until', soon && !a.expired ? 'Your access ends soon. You can ask for more time below.' : null, `<span class="setting-value${soon ? ' account-soon' : ''}">${esc(endText)}</span>`)}
        ${reqHtml}
        ${a.canRequest ? `<div class="account-request">
          ${nav.tv ? '' : '<input type="text" class="account-note-input" data-ext-note maxlength="200" placeholder="Add a note for the admin (optional)" autocomplete="off">'}
          <button class="btn btn-white" data-ext-send>Request an extension</button></div>` : ''}`;
      // While a request waits, look again every 30 s so the answer appears without leaving the page.
      if (r?.status === 'pending') setTimeout(() => { if (isCurrent() && section.isConnected) draw(); }, 30000);
      $('[data-ext-send]', box)?.addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Sending…';
        try {
          await guard('/extension', { method: 'POST', body: { userId: state.userId, note: $('[data-ext-note]', box)?.value.trim() || '' } });
          toast('Request sent to the admin', 3000);
        } catch (err) { toast(err.message || "Couldn't send the request. Try again in a moment.", 5000); }
        draw();
      });
    };
    draw();
  }

  async function renderSettings(page, isCurrent) {
    page.innerHTML = `<div class="page-pad settings-page"><div class="page-head"><h1>Settings</h1></div><div class="spinner"></div></div>`;
    let user = state.user;
    try { user = await api(`/Users/${state.userId}`); state.user = user; } catch { /* fall back to what we have */ }
    if (!isCurrent()) return;
    const cfg = user?.Configuration || {};
    const langs = (value) => (value && !LANGUAGES.some(([v]) => v === value) ? [...LANGUAGES, [value, value]] : LANGUAGES);
    const version = nativeApp?.getVersionName ? `Aurora ${nativeApp.getVersionName()} for Android` : 'Aurora (web)';

    $('.settings-page', page).innerHTML = `
      <div class="page-head"><h1>Settings</h1>
        <div class="service-status" data-service-status role="status"><span class="service-dot"></span><span>Aurora: Checking…</span></div></div>
      <section class="settings-section account-section" data-account><h2>My account</h2><div data-account-body><p class="setting-desc">Loading…</p></div></section>
      <section class="settings-section">
        <h2>Language &amp; subtitles <small>Saved to ${user?.Name ? esc(user.Name) + "'s" : 'your'} account</small></h2>
        ${settingRow('Audio language', 'Pick this language when a title has more than one.', selectHtml('audioLang', langs(cfg.AudioLanguagePreference), cfg.AudioLanguagePreference || ''))}
        ${settingRow('Subtitles', 'When subtitles turn on by themselves.', selectHtml('subMode', SUBTITLE_MODES.map(([v, l]) => [v, l]), cfg.SubtitleMode || 'Default'))}
        ${settingRow('Subtitle language', null, selectHtml('subLang', langs(cfg.SubtitleLanguagePreference), cfg.SubtitleLanguagePreference || ''))}
      </section>
      <section class="settings-section">
        <h2>Subtitle appearance <small>This device</small></h2>
        ${settingRow('Size', null, selectHtml('subSize', Object.entries(SUB_SIZES).map(([k, v]) => [k, v[0]]), getPref('subSize')))}
        ${settingRow('Background', null, selectHtml('subBg', Object.entries(SUB_BACKGROUNDS).map(([k, v]) => [k, v[0]]), getPref('subBg')))}
        <div class="subtitle-preview"><span>This is how subtitles will look.</span></div>
      </section>
      <section class="settings-section">
        <h2>Playback <small>This device</small></h2>
        ${settingRow('Sound when Aurora opens', 'Play the Aurora intro sound with the opening animation.', selectHtml('splashSound', [['on', 'On'], ['off', 'Off']], getPref('splashSound')))}
        ${settingRow('Auto-play next episode', 'Count down and start the next episode when the credits roll.', selectHtml('autoplay', [['on', 'On'], ['off', 'Off']], getPref('autoplay')))}
        ${settingRow('"Are you still watching?"', 'Pause after 3 episodes, or 4 hours of Live TV, with no button pressed.', selectHtml('stillWatching', [['on', 'On'], ['off', 'Off']], getPref('stillWatching')))}
        ${nativeApp?.playVod ? settingRow('Video player', lockedPref('player') ? 'Set by Aurora for everyone.' : 'Aurora player plays most files as they are, with no converting. Switch to Basic only if a video won\'t play.', selectHtml('player', [['aurora', 'Aurora player (smoothest)'], ['web', 'Basic']], getPref('player'), !!lockedPref('player'))) : ''}
        ${nativeApp?.playLive ? settingRow('Live TV buffer', lockedPref('liveBuffer') ? 'Set by Aurora for everyone.' : 'How much of a channel is loaded before it plays. Bigger rides out slow internet better but changes channel more slowly.', selectHtml('liveBuffer', [['small', 'Small (fastest channel changes)'], ['medium', 'Medium (recommended)'], ['large', 'Large (smoothest, for slow internet)']], getPref('liveBuffer'), !!lockedPref('liveBuffer'))) : ''}
        ${nativeApp?.setAppLock && !nativeApp.isTv?.() ? settingRow('Lock Aurora', !nativeApp.canAppLock?.() ? "Set a screen lock on your phone first (phone Settings → Security), then you can turn this on." : lockedPref('appLock') ? 'Set by Aurora for everyone.' : "Asks for your phone's PIN, pattern or fingerprint when Aurora opens, and when you come back after a minute away.", selectHtml('appLock', [['off', 'Off'], ['on', 'On']], getPref('appLock'), !!lockedPref('appLock') || !nativeApp.canAppLock?.())) : ''}
        ${settingRow('Streaming quality', qualityCap() ? `Auto measures your connection. Aurora limits quality to ${QUALITY_OPTIONS.find((q) => q.bitrate === qualityCap())?.label || (qualityCap() / 1e6) + ' Mbps'} at most.` : 'Auto measures your connection. Lower it if videos keep buffering.', selectHtml('quality', qualityChoices().map((q) => [q.bitrate, q.label]), shownQuality()))}
      </section>
      <section class="settings-section feedback-section">
        <h2>Help &amp; feedback <small>This device</small></h2>
        <p class="setting-desc">Something not working? Say what happened and send it. The admins get your note with this device's app log, so they can see what went wrong. Errors are also reported to them automatically.</p>
        <textarea class="feedback-text" data-feedback rows="3" maxlength="1000"${nav.tv ? ' tabindex="-1"' : ''} placeholder="What happened? For example: the film stopped halfway through.${nav.tv ? ' Press Back when you\'re done typing.' : ''}"></textarea>
        <div class="feedback-actions">
          ${nav.tv ? '<button class="btn btn-white" data-write-feedback>Write a note</button>' : ''}
          <button class="btn ${nav.tv ? 'btn-gray' : 'btn-white'}" data-send-feedback>Send to admin</button>
          <button class="btn btn-gray" data-show-log>Show app log</button>
          <span class="setting-value" data-feedback-status></span>
        </div>
        <div class="feedback-log hidden" data-app-log></div>
      </section>
      <section class="settings-section">
        <h2>About</h2>
        ${settingRow('Version', null, `<span class="setting-value">${esc(version)}</span>`)}
        ${settingRow('Signed in as', null, `<span class="setting-value">${esc(user?.Name || '')}</span>`)}
        ${nativeApp?.getVersionCode ? settingRow('Updates', null, '<div class="update-check"><span class="setting-value" data-update-status></span><button class="btn btn-gray" data-check-update>Check for updates</button></div>') : ''}
      </section>`;
    applySubtitleStyle();
    showServiceStatus($('[data-service-status]', page), isCurrent);
    showAccountInfo($('[data-account]', page), isCurrent);

    // Saves run one at a time so quick changes don't overwrite each other.
    let saving = Promise.resolve();
    const saveAccount = (changes) => { saving = saving.then(() => doSaveAccount(changes)); };
    const doSaveAccount = async (changes) => {
      try {
        const fresh = await api(`/Users/${state.userId}`);
        const config = { ...(fresh.Configuration || {}), ...changes };
        await api(`/Users/${state.userId}/Configuration`, { method: 'POST', body: config });
        state.user = { ...fresh, Configuration: config };
        toast('Saved', 1500);
      } catch (e) {
        toast(e.status === 403 ? "Your account isn't allowed to change these settings." : 'Could not save: ' + e.message);
      }
    };
    $('.settings-page', page).addEventListener('change', (e) => {
      const sel = e.target.closest('[data-setting]');
      if (!sel) return;
      const v = sel.value;
      switch (sel.dataset.setting) {
        case 'audioLang': saveAccount({ AudioLanguagePreference: v }); break;
        case 'subMode': saveAccount({ SubtitleMode: v }); break;
        case 'subLang': saveAccount({ SubtitleLanguagePreference: v }); break;
        case 'quality': store.set('ef.maxBitrate', v); toast('Saved', 1500); break;
        default: setPref(sel.dataset.setting, v); applySubtitleStyle(); if (sel.dataset.setting === 'appLock') syncAppLock(); toast('Saved', 1500);
      }
    });
    setupFeedback(page);
    $('[data-check-update]', page)?.addEventListener('click', async () => {
      const status = $('[data-update-status]', page);
      status.textContent = 'Checking…';
      const result = await checkForUpdate();
      if (result.status === 'available') { status.textContent = `${result.version} available`; showUpdatePrompt(result); }
      else status.textContent = result.status === 'current' ? "You're up to date." : "Couldn't check for updates. Try again later.";
    });
  }

  // ---------- Admin dashboard ----------
  // Only the owner's account sees it. Emby itself also refuses these admin calls for anyone who
  // isn't a server administrator, so the name check only decides who sees the menu item.
  const ADMIN_NAMES = ['johnny4091', 'countryboy89']; // lower case
  const isAdmin = () => ADMIN_NAMES.includes((state.user?.Name || '').toLowerCase());
  // ----- Feedback -----
  // A viewer's note plus this device's app log, kept in their Emby display preferences ("aurora-feedback")
  // where the admin's Feedback tab reads it, and also sent to the server's client log as a copy.
  const FEEDBACK_KEEP = 10;
  const logLineHtml = (e) => `<div class="admin-row" tabindex="-1">
    <div class="admin-row-main">${e.level === 'error' ? '<span class="pill bad">Error</span> ' : e.level === 'warn' ? '<span class="pill warn">Warning</span> ' : ''}${esc(e.msg)}</div>
    <div class="admin-row-time">${esc(fmtDateTime(e.t))}</div></div>`;

  function setupFeedback(page) {
    const box = $('[data-feedback]', page), status = $('[data-feedback-status]', page), logEl = $('[data-app-log]', page);
    const showBtn = $('[data-show-log]', page), sendBtn = $('[data-send-feedback]', page);
    // TV: the remote never moves into the text box by itself. On some TVs a text box takes the remote's Up and Down
    // for the keyboard system, which left the remote stuck there (and the rest of Settings out of reach). "Write a
    // note" opens it with the keyboard; Back (or Down, where the TV allows it) comes out again.
    const writeBtn = $('[data-write-feedback]', page);
    writeBtn?.addEventListener('click', () => {
      box.tabIndex = 0;
      focusEl(box);
      nativeApp?.showKeyboard();
    });
    if (writeBtn) {
      box.addEventListener('blur', () => { box.tabIndex = -1; });
      box.__onBack = () => { focusEl(box.value.trim() ? sendBtn : writeBtn); };
    }
    showBtn.addEventListener('click', () => {
      const open = logEl.classList.toggle('hidden') === false;
      showBtn.textContent = open ? 'Hide app log' : 'Show app log';
      if (open) {
        const entries = appLog.read().slice(-100).reverse();
        logEl.innerHTML = `<div class="admin-list">${entries.map(logLineHtml).join('') || '<p class="muted">Nothing recorded yet.</p>'}</div>`;
      }
    });
    sendBtn.addEventListener('click', async () => {
      const text = box.value.trim();
      if (!text) { status.textContent = 'Write what happened first.'; focusEl(box); return; }
      sendBtn.disabled = true;
      status.textContent = 'Sending…';
      try {
        await sendFeedback(text);
        box.value = '';
        status.textContent = 'Sent. Thank you!';
        toast('Feedback sent to the admins', 2500);
      } catch (e) {
        status.textContent = "Couldn't send it: " + (e.message || 'no connection') + '. Try again in a moment.';
      } finally {
        sendBtn.disabled = false;
      }
    });
  }

  async function sendFeedback(text) {
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), t: Date.now(), text,
      user: state.user?.Name || '', device: nativeApp?.getDeviceName?.() || (/Mobi|Android/i.test(navigator.userAgent) ? 'Mobile browser' : 'Web browser'),
      version: nativeApp?.getVersionName?.() || 'web', screen: location.hash || '#/home',
      log: appLog.read().slice(-80).map((e) => ({ t: e.t, level: e.level, msg: String(e.msg).slice(0, 300) })),
    };
    const data = await readAuroraPref('aurora-feedback'); // a failed read would otherwise wipe earlier feedback
    const items = [entry, ...(data?.items || [])].slice(0, FEEDBACK_KEEP);
    await writeAuroraPref('aurora-feedback', state.userId, { items });
    // A copy in the server's own logs.
    fetch(apiUrl('/ClientLog/Document'), {
      method: 'POST', headers: { 'X-Emby-Authorization': authHeader(), 'Content-Type': 'text/plain' },
      body: `Aurora feedback · ${entry.user} · ${entry.device} · Aurora ${entry.version}\n${text}\n\n`
        + entry.log.map((e) => `${new Date(e.t).toISOString()} ${e.level} ${e.msg}`).join('\n'),
    }).catch(() => {});
    appLog.add('info', 'Feedback sent: ' + text.slice(0, 120));
  }

  problems.flush = async function flush() {
    if (!this.queue.length) return;
    // Not signed in yet (or the app is still starting): try again shortly.
    if (!state.userId || !state.apiKey || typeof readAuroraPref !== 'function') { this.schedule(60000); return; }
    const day = new Date().toDateString();
    let count = { day, n: 0 };
    try { const c = JSON.parse(store.get('ef.problemsDay') || 'null'); if (c?.day === day) count = c; } catch { /* new day */ }
    if (count.n >= this.DAILY) { this.queue = []; return; }
    const items = this.queue.splice(0);
    const errors = items.filter((e) => e.level === 'error').length, warnings = items.length - errors;
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), t: Date.now(), auto: true,
      text: [errors && `${errors} ${errors === 1 ? 'error' : 'errors'}`, warnings && `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`].filter(Boolean).join(', '),
      problems: items.map((e) => ({ t: e.t, level: e.level, msg: String(e.msg).slice(0, 300) })),
      user: state.user?.Name || '', device: nativeApp?.getDeviceName?.() || (/Mobi|Android/i.test(navigator.userAgent) ? 'Mobile browser' : 'Web browser'),
      version: nativeApp?.getVersionName?.() || 'web', screen: location.hash || '#/home',
      log: appLog.read().slice(-40).map((e) => ({ t: e.t, level: e.level, msg: String(e.msg).slice(0, 300) })),
    };
    this.sending = true;
    try {
      // A failed read must not count as "nothing saved yet": writing then would wipe the earlier reports.
      const data = await readAuroraPref('aurora-problems');
      await writeAuroraPref('aurora-problems', state.userId, { items: [entry, ...(data?.items || [])].slice(0, this.KEEP) });
      this.sentAt = Date.now();
      store.set('ef.problemsDay', JSON.stringify({ day, n: count.n + 1 }));
      let seen = {};
      try { seen = JSON.parse(store.get('ef.problemsSeen') || '{}'); } catch { /* start afresh */ }
      for (const [k, t] of Object.entries(seen)) if (Date.now() - t > 3600000) delete seen[k];
      items.forEach((e) => { seen[this.key(e.msg)] = e.t; });
      store.set('ef.problemsSeen', JSON.stringify(seen));
    } catch {
      // No connection or the server is down: keep them for the next try.
      this.queue = [...items, ...this.queue].slice(0, 25);
      this.schedule(5 * 60000);
    } finally {
      this.sending = false;
    }
  };

  async function allFeedback(users, prefsId = 'aurora-feedback') {
    const out = [];
    const queue = ((Array.isArray(users) ? users : users?.Items) || []).slice();
    const worker = async () => {
      while (queue.length) {
        const u = queue.shift();
        try {
          const data = await readAuroraPref(prefsId, u.Id);
          (data?.items || []).forEach((f) => out.push({ ...f, user: f.user || u.Name, userId: u.Id, prefsId }));
        } catch { /* no feedback from this user */ }
      }
    };
    await Promise.all([0, 1, 2, 3].map(worker));
    return out.sort((a, b) => (b.t || 0) - (a.t || 0));
  }

  async function adminFeedback(body, isCurrent) {
    let notes, reports;
    try {
      const users = await api('/Users');
      [notes, reports] = await Promise.all([allFeedback(users), allFeedback(users, 'aurora-problems')]);
    } catch (e) { if (isCurrent()) body.innerHTML = `<p class="empty-msg">${esc(adminError(e))}</p>`; return; }
    if (!isCurrent()) return;
    const problemHtml = (list) => `<div class="admin-list feedback-problems">${list.map(logLineHtml).join('')}</div>`;
    const itemHtml = (f) => `<div class="feedback-item" data-id="${esc(f.id)}" data-user="${esc(f.userId)}" data-prefs="${esc(f.prefsId)}">
      <div class="feedback-head"><strong>${esc(f.user || 'Someone')}</strong> <span class="muted">· ${esc(f.device || '')} · Aurora ${esc(f.version || '')} · ${esc(fmtDateTime(f.t))}</span></div>
      ${f.auto ? `<p class="feedback-note">${esc(f.text)} <span class="muted">on ${esc((f.screen || '').replace(/^#\//, '') || 'home')}</span></p>${problemHtml(f.problems || [])}` : `<p class="feedback-note">${esc(f.text)}</p>`}
      <div class="feedback-actions">
        <button class="btn btn-gray" data-log-toggle>Show app log (${(f.log || []).length})</button>
        <button class="btn btn-gray" data-done>Done, remove</button>
      </div>
      <div class="feedback-log hidden"><div class="admin-list">${(f.log || []).slice().reverse().map(logLineHtml).join('') || '<p class="muted">The log was empty.</p>'}</div></div>
    </div>`;
    body.innerHTML = `
      <section class="admin-card">
        <h2>Notes from viewers <small>${notes.length}</small></h2>
        <p class="muted">Sent from Settings → Help &amp; feedback, with the app log of the device it came from. Up to ${FEEDBACK_KEEP} are kept per person.</p>
        <div class="admin-list">${notes.map(itemHtml).join('') || '<p class="muted">No notes yet.</p>'}</div>
      </section>
      <section class="admin-card">
        <h2>Automatic problem reports <small>${reports.length}</small></h2>
        <div class="log-tools"><p class="muted">Sent by the app on its own when something goes wrong: errors and warnings, with what happened just before. The same problem is sent at most once an hour per device.</p>
          <span class="osd-spacer"></span>${reports.length ? '<button class="btn btn-gray" data-clear-reports>Remove all</button>' : ''}</div>
        <div class="admin-list">${reports.map(itemHtml).join('') || '<p class="muted">No problems reported.</p>'}</div>
      </section>`;
    $$('.feedback-item', body).forEach((el) => {
      const btn = $('[data-log-toggle]', el), log = $('.feedback-log', el);
      const count = $$('.admin-row', log).length;
      btn.addEventListener('click', () => {
        const open = log.classList.toggle('hidden') === false;
        btn.textContent = open ? 'Hide app log' : `Show app log (${count})`;
      });
      $('[data-done]', el).addEventListener('click', async () => {
        try {
          const data = await readAuroraPref(el.dataset.prefs, el.dataset.user);
          await writeAuroraPref(el.dataset.prefs, el.dataset.user, { items: (data?.items || []).filter((f) => f.id !== el.dataset.id) });
          const next = el.nextElementSibling || el.previousElementSibling;
          el.remove();
          if (next) focusEl($('button', next));
          toast('Removed', 1500);
        } catch (e) { toast("Couldn't remove it: " + adminError(e)); }
      });
    });
    $('[data-clear-reports]', body)?.addEventListener('click', async () => {
      const users = [...new Set(reports.map((r) => r.userId))];
      try {
        await Promise.all(users.map((u) => writeAuroraPref('aurora-problems', u, { items: [] })));
        toast('All automatic reports removed', 2000);
        adminFeedback(body, isCurrent);
      } catch (e) { toast("Couldn't remove them: " + adminError(e)); }
    });
  }

  const ADMIN_TABS = [['overview', 'Overview'], ['problems', 'Playback problems'], ['feedback', 'Feedback'], ['livetv', 'Live TV'], ['requests', 'Requests'], ['users', 'Users'], ['reports', 'Channel reports'], ['playback', 'Playback'], ['updates', 'Updates'], ['activity', 'Activity'], ['devices', 'Devices & users'], ['logs', 'Server logs'], ['applog', 'App log']];
  const DAY = 86400000;

  function timeAgo(date) {
    const t = new Date(date).getTime();
    if (!t) return '';
    const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)} min ago`;
    if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
    if (s < 86400 * 30) { const d = Math.floor(s / 86400); return d === 1 ? 'yesterday' : `${d} days ago`; }
    return new Date(t).toLocaleDateString();
  }
  const fmtDateTime = (d) => (d ? new Date(d).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
  const fmtSize = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round((b || 0) / 1024))} KB`);
  const adminError = (e) => (e.status === 401 || e.status === 403
    ? 'Emby refused this. Make sure this account is an administrator on the Emby server (Emby dashboard → Users → Johnny4091 → "Allow this user to manage the server").'
    : `Couldn't load this: ${e.message}`);

  // Text responses (log files) rather than JSON.
  async function apiText(path, params) {
    const res = await fetch(apiUrl(path, params), { headers: { 'X-Emby-Authorization': authHeader() } });
    if (!res.ok) { const err = new Error(`Emby returned ${res.status}`); err.status = res.status; throw err; }
    return res.text();
  }

  function renderAdmin(page, tab, isCurrent) {
    if (!isAdmin()) { location.replace('#/home'); return; }
    if (!ADMIN_TABS.some(([id]) => id === tab)) tab = 'overview';
    page.innerHTML = `
      <div class="page-pad admin-page">
        <div class="page-head">
          <h1>Admin</h1>
          <div class="tab-bar">
            ${ADMIN_TABS.map(([id, label]) => `<a href="#/admin?tab=${id}" class="tab${id === tab ? ' active' : ''}">${label}</a>`).join('')}
          </div>
          <button class="btn btn-gray admin-refresh" data-admin-refresh>Refresh</button>
        </div>
        <div data-admin-body><div class="spinner"></div></div>
      </div>`;
    const body = $('[data-admin-body]', page);
    $('[data-admin-refresh]', page).addEventListener('click', () => route());
    ({ overview: adminOverview, livetv: adminLiveTv, requests: adminRequests, activity: adminActivity, devices: adminDevices, logs: adminLogs, applog: adminAppLog, feedback: adminFeedback, updates: adminUpdates, users: adminUsers, playback: adminPlayback, reports: adminReports, problems: adminProblems })[tab](body, isCurrent);
    autoFocus($('.tab.active', page));
    // The page is drawn again for each tab, which put the tab bar back at its start: scroll to the chosen tab.
    const bar = $('.tab-bar', page), active = $('.tab.active', bar);
    if (bar && active) bar.scrollLeft = Math.max(0, active.offsetLeft - (bar.clientWidth - active.offsetWidth) / 2);
  }

  const statTile = (label, value, note = '', cls = '') =>
    `<div class="stat-tile ${cls}"><div class="stat-label">${esc(label)}</div><div class="stat-value">${esc(String(value))}</div>${note ? `<div class="stat-note">${note}</div>` : ''}</div>`;

  async function latestAuroraRelease() {
    try {
      const res = await fetch('https://api.github.com/repos/johnny4091-allstar/johnny4091-allstar/releases/latest',
        { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const rel = await res.json();
      return { name: rel.name || rel.tag_name, code: Number((rel.tag_name || '').match(/(\d+)$/)?.[1] || 0), date: rel.published_at, notes: releaseNotes(rel.body) };
    } catch { return null; }
  }

  function watchingHtml(active, liveNow) {
    return active.length || liveNow.length
      ? `<div class="admin-list">${liveNow.map(liveRow).join('')}${active.map(sessionRow).join('')}</div>`
      : '<p class="muted">Nobody is watching right now.</p>';
  }
  // Keeps the "Watching now" list current while the Overview is open.
  function refreshWatching(body, isCurrent, users) {
    const timer = setInterval(async () => {
      const el = $('[data-watching]', body);
      if (!isCurrent() || !el) { clearInterval(timer); return; }
      try {
        const [sessions, live] = await Promise.all([api('/Sessions'), liveWatching(users)]);
        if (!isCurrent() || !el.isConnected) return;
        el.innerHTML = watchingHtml((Array.isArray(sessions) ? sessions : []).filter((s) => s.NowPlayingItem), live.now);
      } catch { /* keep what's shown */ }
    }, 30000);
  }

  // ----- Playback problems (Admin → Playback problems) -----
  // Every device notes what wouldn't play, what kept buffering and which live channels failed ("aurora-playlog",
  // see playLog). Read here from every account, so a problem shows up before a customer calls.
  const PROBLEM_KINDS = {
    failed: ['Would not play', 'bad'], converted: ['Had to convert', 'warn'], stalling: ['Kept buffering', 'warn'],
    'live-failed': ['Live channel failed', 'bad'], 'live-stalling': ['Live TV kept buffering', 'warn'],
  };
  async function playProblems(users, days) {
    const since = Date.now() - days * DAY;
    // Customers can write their own preferences, so only well-formed entries are shown.
    return (await allFeedback(users, 'aurora-playlog'))
      .filter((e) => typeof e.kind === 'string' && Object.prototype.hasOwnProperty.call(PROBLEM_KINDS, e.kind) && Number(e.t) > since);
  }
  function problemDetail(e) {
    const mbps = e.bitrate ? `limit ${Math.round(e.bitrate / 1e6)} Mbps` : '';
    if (e.kind === 'stalling') return [`${e.stalls} stalls, ${e.stalledSec} s buffering (${e.pct}%) in ${e.watchedMin} min`, e.method, mbps].filter(Boolean).join(' · ');
    if (e.kind === 'live-stalling') return `${e.stalls} stalls in ${e.watchedMin} min · buffer ${e.buffer || 'normal'}`;
    const err = String(e.error || '');
    const why = /StartTimeout/.test(err) ? 'never started (the server sent nothing)'
      : err.startsWith('unplayable:') ? `this device couldn't play the file as it is (${err.slice(11)}), so the server converted it`
        : err.startsWith('failed:') ? `stopped and couldn't reconnect (${err.slice(7)})` : err;
    return [why, e.method, e.atSec ? `at ${Math.floor(e.atSec / 60)} min` : '', mbps].filter(Boolean).join(' · ');
  }
  function problemRow(e) {
    const [label, cls] = PROBLEM_KINDS[e.kind];
    return `<div class="admin-row"><div class="admin-row-main"><strong>${esc(e.user || '')}</strong> · ${esc(e.title || 'Unknown')} <span class="pill ${cls}">${label}</span>
      <div class="muted">${esc(problemDetail(e))}</div>
      <div class="muted">${esc(e.device || '')}${e.version ? ' · Aurora ' + esc(e.version) : ''}</div></div>
      <div class="admin-row-time">${esc(timeAgo(e.t))}</div></div>`;
  }
  function groupProblems(events, key) {
    const m = new Map();
    for (const e of events) {
      const k = key(e);
      if (!k) continue;
      const g = m.get(k) || { key: k, n: 0, users: new Set(), titles: new Set(), devices: new Set(), kinds: {}, last: 0 };
      g.n++; g.users.add(e.user); g.titles.add(e.title); g.devices.add(e.device); g.kinds[e.kind] = (g.kinds[e.kind] || 0) + 1; g.last = Math.max(g.last, e.t || 0);
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.n - a.n || b.last - a.last);
  }
  const kindsText = (g) => Object.entries(g.kinds).map(([k, n]) => `${n} ${PROBLEM_KINDS[k][0].toLowerCase()}`).join(', ');

  async function adminProblems(body, isCurrent) {
    const days = [1, 7, 14].includes(Number(new URLSearchParams(location.hash.split('?')[1] || '').get('days'))) ? Number(new URLSearchParams(location.hash.split('?')[1] || '').get('days')) : 7;
    let users, events;
    try { users = await api('/Users'); events = await playProblems(users, days); } catch (e) { if (isCurrent()) body.innerHTML = `<p class="empty-msg">${esc(adminError(e))}</p>`; return; }
    if (!isCurrent()) return;
    const n = (...kinds) => events.filter((e) => kinds.includes(e.kind)).length;
    const titles = groupProblems(events, (e) => e.title).filter((g) => g.n >= 2);
    const people = groupProblems(events, (e) => e.user).filter((g) => g.n >= 3);
    const vod = events.filter((e) => !e.kind.startsWith('live'));
    const transcoded = vod.filter((e) => e.method === 'Transcode').length;
    const range = (d, label) => `<a href="#/admin?tab=problems&days=${d}" class="tab${d === days ? ' active' : ''}">${label}</a>`;
    body.innerHTML = `
      <div class="tab-bar admin-subtabs">${range(1, 'Last 24 hours')}${range(7, 'Last 7 days')}${range(14, 'Last 14 days')}</div>
      <div class="stat-grid">
        ${statTile('Problems', events.length, events.length ? `${new Set(events.map((e) => e.user)).size} customers affected` : 'Nothing went wrong', events.length ? '' : 'good')}
        ${statTile('Would not play', n('failed'), n('converted') ? `${n('converted')} more played after converting` : '')}
        ${statTile('Kept buffering', n('stalling'), vod.length ? `${transcoded} of ${vod.length} on-demand problems were converting (transcode)` : '')}
        ${statTile('Live TV', n('live-failed', 'live-stalling'), `${n('live-failed')} channel failures · ${n('live-stalling')} buffering`)}
      </div>
      ${titles.length || people.length ? `<section class="admin-card">
        <h2>Repeat problems <small>Worth a look</small></h2>
        <div class="admin-list">
          ${titles.map((g) => `<div class="admin-row"><div class="admin-row-main"><strong>${esc(g.key)}</strong> <span class="pill ${g.kinds.failed || g.kinds['live-failed'] ? 'bad' : 'warn'}">${g.n} times</span>
            <div class="muted">${esc(kindsText(g))} · ${g.users.size} ${g.users.size === 1 ? 'customer' : 'customers'}</div>
            <div class="muted">${g.users.size > 1 ? 'Several customers: most likely the file itself, the server, or the channel at the provider.' : 'One customer: most likely their connection or device. See them below.'}</div></div>
            <div class="admin-row-time">${esc(timeAgo(g.last))}</div></div>`).join('')}
          ${people.map((g) => `<div class="admin-row"><div class="admin-row-main"><strong>${esc(g.key)}</strong> <span class="pill warn">${g.n} problems</span>
            <div class="muted">${esc(kindsText(g))} · on ${g.titles.size} ${g.titles.size === 1 ? 'title' : 'different titles'} · ${esc([...g.devices].join(', '))}</div>
            <div class="muted">${g.titles.size > 2 ? 'Problems on many titles: most likely this customer\'s internet or device. A lower Streaming quality or the Large Live TV buffer can help.' : 'Problems on the same few titles: check those files.'}</div></div>
            <div class="admin-row-time">${esc(timeAgo(g.last))}</div></div>`).join('')}
        </div></section>` : ''}
      <section class="admin-card">
        <h2>Everything <small>Newest first</small></h2>
        ${events.length ? `<div class="admin-list">${events.slice(0, 200).map(problemRow).join('')}</div>
          <button class="btn btn-gray" data-clear-problems>Clear all</button>` : '<p class="muted">No playback problems in this period. Every device sends its problems here by itself, once it has this update.</p>'}
      </section>`;
    $('[data-clear-problems]', body)?.addEventListener('click', async () => {
      if (!await confirmAction('Clear playback problems?', 'This removes the list for every customer. New problems still come in.', 'Clear')) return;
      try {
        // Everyone with anything saved, not only those in the period shown.
        const ids = [...new Set((await allFeedback(users, 'aurora-playlog')).map((e) => e.userId))];
        await Promise.all(ids.map((u) => writeAuroraPref('aurora-playlog', u, { items: [] })));
        toast('Cleared', 1500);
        adminProblems(body, isCurrent);
      } catch (e) { toast("Couldn't clear them: " + adminError(e)); }
    });
  }

  // ----- TV provider connections (Admin → Overview) -----
  // Aurora Guard 1.3.0 counts them every minute and sends the alerts; with an older guard the page counts by itself.
  // An Xtream account also says how many connections the provider itself sees in use.
  let providerCache = null;
  async function providerAccount({ fresh = false } = {}) {
    const cfg = iptv.config;
    if (!cfg || cfg.type !== 'xtream' || !iptvOn(cfg)) return null;
    // Asked at most every 2 minutes (the Overview refreshes every 30 s); the health check asks fresh.
    if (!fresh && providerCache && Date.now() - providerCache.t < 120000) return providerCache.r;
    const r = await providerAccountNow(cfg);
    providerCache = { t: Date.now(), r };
    return r;
  }
  async function providerAccountNow(cfg) {
    try {
      const r = await xtJson(cfg, {});
      const u = r?.user_info;
      if (!u) return { error: 'The provider did not send account details.' };
      return { active: Number(u.active_cons) || 0, max: Number(u.max_connections) || 0, status: u.status || '', expires: Number(u.exp_date) ? new Date(Number(u.exp_date) * 1000) : null };
    } catch (e) { return { error: e.message }; }
  }
  async function connectionStatus(users) {
    let g = null;
    if (guardEnabled) { try { g = await guard('/connections'); } catch (e) { g = { error: e, old: e.status === 404 }; } }
    const out = { fromGuard: !!(g && !g.error), guardOld: !!g?.old, limit: 0, alertAt: 0, peak: 0, streams: [] };
    if (out.fromGuard) Object.assign(out, { limit: g.limit, alertAt: g.alertAt, peak: g.peak, streams: g.streams || [], checkedAt: g.checkedAt });
    else {
      const [sessions, live] = await Promise.all([api('/Sessions').catch(() => []), liveWatching(users)]);
      out.streams = [
        ...live.now.map((e) => ({ source: 'aurora', user: e.user, device: e.device, channel: [e.num, e.name].filter(Boolean).join(' ') })),
        ...(Array.isArray(sessions) ? sessions : []).filter((s) => s.NowPlayingItem?.Type === 'TvChannel').map((s) => ({ source: 'emby', user: s.UserName, device: s.DeviceName, channel: s.NowPlayingItem.Name })),
      ];
      try { const c = JSON.parse(store.get('ef.connLimit') || 'null'); if (c) { out.limit = c.limit || 0; out.alertAt = c.alertAt || 0; } } catch { /* not set */ }
    }
    out.inUse = out.streams.length;
    return out;
  }
  function connectionsHtml(c, acct) {
    const limit = c.limit || acct?.max || 0;
    const pct = limit ? Math.min(100, Math.round((c.inUse / limit) * 100)) : 0;
    const level = !limit ? '' : c.inUse >= limit ? 'bad' : (c.alertAt && c.inUse >= c.alertAt) || pct >= 85 ? 'warn' : 'ok';
    return `
      <div class="conn-meter"><div class="conn-count"><strong>${c.inUse}</strong>${limit ? ` of ${limit}` : ''} in use</div>
        ${limit ? `<div class="conn-bar"><span class="${level}" style="width:${pct}%"></span></div>` : ''}</div>
      <dl class="admin-dl">
        ${acct && !acct.error ? `<dt>The provider says</dt><dd>${acct.active} of ${acct.max || '?'} in use${acct.status && acct.status !== 'Active' ? ` · <span class="pill bad">${esc(acct.status)}</span>` : ''}${acct.expires ? ` · account ends ${esc(acct.expires.toLocaleDateString())}` : ''}</dd>` : ''}
        ${acct?.error ? `<dt>The provider says</dt><dd class="muted">${esc(acct.error)}</dd>` : ''}
        ${c.fromGuard ? `<dt>Peak today</dt><dd>${c.peak}</dd>` : ''}
        <dt>Alerts</dt><dd>${c.fromGuard ? (c.limit ? `Aurora Guard alerts at ${c.alertAt ? c.alertAt + ' and ' : ''}${c.limit} (full)` : 'Set the limit below to get alerts') : c.guardOld ? '<span class="pill warn">Update Aurora Guard to 1.3.0</span> for alerts and today\'s peak' : 'Aurora Guard is off: no alerts'}</dd>
      </dl>
      ${c.streams.length ? `<details class="conn-list"><summary>Who is using them</summary><div class="admin-list">${c.streams.map((s) => `<div class="admin-row"><div class="admin-row-main"><strong>${esc(s.user || '')}</strong> · ${esc(s.channel || '')}<div class="muted">${esc(s.device || '')} · ${s.source === 'emby' ? 'Emby Live TV' : 'Aurora live player'}</div></div></div>`).join('')}</div></details>` : ''}
      <div class="conn-form">
        <label class="admin-field"><span>Connections on the account</span><input type="number" min="0" max="1000" inputmode="numeric" data-conn-limit value="${c.limit || acct?.max || ''}" placeholder="60"></label>
        <label class="admin-field"><span>Warn me at</span><input type="number" min="0" max="1000" inputmode="numeric" data-conn-alert value="${c.alertAt || ''}" placeholder="50"></label>
        <button class="btn btn-gray" data-conn-save>Save</button>
      </div>`;
  }
  async function renderConnections(el, isCurrent, users) {
    const [c, acct] = await Promise.all([connectionStatus(users), providerAccount()]);
    if (!isCurrent() || !el.isConnected) return null;
    // Nothing changed, or the admin is using the section (typing, or the remote's focus is in it): leave it as it is.
    const html = connectionsHtml(c, acct);
    if (html === el.__html || (el.__html && el.contains(document.activeElement))) return c;
    const open = !!$('details[open]', el);
    el.innerHTML = html;
    el.__html = html;
    if (open) $('details', el)?.setAttribute('open', '');
    $('[data-conn-save]', el).addEventListener('click', async () => {
      const limit = Math.max(0, Math.round(Number($('[data-conn-limit]', el).value) || 0));
      const alertAt = Math.max(0, Math.round(Number($('[data-conn-alert]', el).value) || 0));
      if (limit && alertAt > limit) { toast('"Warn me at" must be no higher than the number of connections.'); return; }
      store.set('ef.connLimit', JSON.stringify({ limit, alertAt }));
      try {
        if (!guardEnabled) throw Object.assign(new Error('off'), { off: true });
        await guard('/connections', { method: 'PUT', body: { limit, alertAt } });
        toast('Saved. Aurora Guard will alert you.', 2500);
      } catch (e) {
        toast(e.off ? 'Saved on this device. Aurora Guard is off, so there are no alerts.' : e.status === 404 ? 'Saved on this device. Update Aurora Guard to 1.3.0 to get alerts.' : `Saved on this device, but Aurora Guard said: ${e.message}`, 6000);
      }
      el.__html = '';
      document.activeElement?.blur?.();
      renderConnections(el, isCurrent, users);
    });
    return c;
  }

  // ----- Check everything (Admin → Overview) -----
  // One line per part of the service, green, amber or red, with what to do about anything that isn't right.
  async function runHealthCheck(el, users) {
    const lines = [];
    const draw = () => {
      el.innerHTML = `<div class="health-list">${lines.map((l) => `<div class="health-row ${l.level}"><span class="health-dot"></span>
        <div><strong>${esc(l.name)}</strong> <span class="health-state">${l.level === 'ok' ? 'OK' : l.level === 'warn' ? 'Check' : l.level === 'bad' ? 'Problem' : 'Checking…'}</span>
        <div class="muted">${l.html ?? esc(l.text || '')}</div></div></div>`).join('')}</div>`;
    };
    const check = (name, fn) => {
      const line = { name, level: 'wait', text: '' };
      lines.push(line);
      return (async () => {
        try { Object.assign(line, await fn()); } catch (e) { Object.assign(line, { level: 'bad', text: e.message || String(e) }); }
        draw();
      })();
    };
    const ok = (text) => ({ level: 'ok', text }), warn = (text) => ({ level: 'warn', text }), bad = (text) => ({ level: 'bad', text });
    const guardOn = guardEnabled;
    const jobs = [
      check('Emby server', async () => {
        const t0 = performance.now();
        const info = await api('/System/Info');
        const ms = Math.round(performance.now() - t0);
        const extra = [info.HasPendingRestart && 'it needs a restart', info.HasUpdateAvailable && 'an Emby update is available'].filter(Boolean).join(', ');
        if (ms > 2500) return warn(`Answered, but slowly (${ms} ms). The server PC may be busy.${extra ? ' Also ' + extra + '.' : ''}`);
        return extra ? warn(`Answered in ${ms} ms, but ${extra}.`) : ok(`Answered in ${ms} ms (${info.ServerName || ''} ${info.Version || ''})`);
      }),
      check('Server tasks', async () => {
        const tasks = await api('/ScheduledTasks');
        const failed = (tasks || []).filter((t) => t.LastExecutionResult?.Status === 'Failed');
        return failed.length ? warn(`Failed last time: ${failed.map((t) => t.Name).join(', ')}`) : ok('All scheduled tasks finished normally');
      }),
      check('Speed from this device', async () => {
        const r = await measureBitrate(6000000, 8000);
        const mbps = r.bps / 1e6;
        const t = `${mbps.toFixed(1)} Mbps from the server to this device${r.complete ? '' : ' (the test didn\'t finish in time)'}. Customers' speeds depend on their own internet.`;
        return mbps < 4 ? bad(t + ' Too slow for HD: check the server PC\'s upload speed.') : mbps < 10 ? warn(t) : ok(t);
      }),
      check('Aurora Guard', async () => {
        if (!guardOn) return warn('Switched off ("guardEnabled" in aurora-config.json), so device limits and expiry dates are not enforced.');
        const s = await guard('/status/users');
        const ver = String(s.version || '0'), age = s.lastRun?.at ? Date.now() - s.lastRun.at : Infinity;
        if (!s.emby?.online) return bad(`Running (${ver}) but can't reach Emby: ${s.emby?.error || 'no answer'}. Check "embyUrl" and "apiKey" in its config.json.`);
        if (!s.lastRun?.ok || age > 5 * 60000) return bad(`Running (${ver}) but its every-minute check ${s.lastRun?.error ? 'failed: ' + s.lastRun.error : 'has not run lately'}.`);
        if (s.dryRun) return warn(`Running (${ver}) in DRY RUN: it only logs, nobody is signed out or switched off. Set "dryRun": false in config.json.`);
        const over = s.totals?.over || 0;
        const old = ver.localeCompare('1.3.0', undefined, { numeric: true }) < 0;
        const t = `Running ${ver}, enforcing. ${s.totals?.activeDevices || 0} ${s.totals?.activeDevices === 1 ? 'device' : 'devices'} in use${over ? `, ${over} ${over === 1 ? 'account' : 'accounts'} over the limit right now` : ''}.`;
        return old ? warn(t + ' Update it to 1.3.0 for the connection alerts (copy the new aurora-guard.js and restart the task).') : over ? warn(t) : ok(t);
      }),
      check('Live TV source', async () => {
        const cfg = iptv.config;
        if (!iptvOn(cfg)) return hasLiveTv() ? ok('Emby\'s own Live TV') : warn('No Live TV source is set up (Admin → Live TV).');
        if (cfg.type === 'xtream') {
          const a = await providerAccount({ fresh: true });
          if (a?.error) return bad(`The provider didn't answer properly: ${a.error}`);
          const days = a.expires ? Math.ceil((a.expires - Date.now()) / DAY) : null;
          const t = `Xtream account ${a.status || 'answered'} · ${a.active} of ${a.max || '?'} connections in use${days != null ? ` · ends in ${days} days` : ''}`;
          if (a.status && a.status !== 'Active') return bad(t);
          return (days != null && days <= 7) || (a.max && a.active >= a.max) ? warn(t) : ok(t);
        }
        const text = await iptvText(withScheme(cfg.m3uUrl), cfg, 30000);
        if (!/#EXTM3U|#EXTINF/.test(text.slice(0, 5000))) return bad("The playlist address didn't return an M3U playlist.");
        return ok(`The M3U playlist loads (${fmtSize(text.length)})`);
      }),
      check('TV provider connections', async () => {
        const c = await connectionStatus(users);
        if (!c.limit) return warn(`${c.inUse} in use. Set the number of connections on your account below to get warnings.`);
        const t = `${c.inUse} of ${c.limit} in use`;
        return c.inUse >= c.limit ? bad(t + ': full, new channels will fail.') : c.alertAt && c.inUse >= c.alertAt ? warn(t) : ok(t);
      }),
      check('Channel reports to the provider', async () => {
        if (!guardOn) return warn('Needs Aurora Guard.');
        const [p, r] = await Promise.all([guard('/provider'), guard('/reports').catch(() => null)]);
        if (!p.enabled || !p.keySet) return warn('Off: customers\' reports are kept in Admin → Channel reports but not sent to the provider.');
        const recent = (r?.reports || []).filter((x) => Date.now() - x.at < DAY);
        const failed = recent.filter((x) => x.forwarded === 'failed').length;
        return failed ? bad(`${failed} of ${recent.length} reports today couldn't be sent. Check the key in Admin → Channel reports.`) : ok(`On${recent.length ? `, ${recent.length} sent today` : ''}`);
      }),
      check('Playback problems (24 hours)', async () => {
        const ev = await playProblems(users, 1);
        if (!ev.length) return ok('None reported');
        const rep = groupProblems(ev, (e) => e.title).filter((g) => g.users.size >= 2);
        const html = `${ev.length} from ${new Set(ev.map((e) => e.user)).size} customers${rep.length ? `, ${esc(rep.map((g) => g.key).slice(0, 3).join(', '))} for several people` : ''} · <a href="#/admin?tab=problems&days=1">See them</a>`;
        return { level: ev.length >= 5 || rep.length ? 'bad' : 'warn', html };
      }),
      check('App updates', async () => {
        const rel = await latestAuroraRelease();
        if (!rel) return bad("Couldn't read the releases on GitHub, so apps can't find updates right now.");
        const devices = await api('/Devices').catch(() => null);
        const list = (Array.isArray(devices) ? devices : devices?.Items || []).filter((d) => /aurora|embyflix/i.test(d.AppName || '') && Date.now() - new Date(d.DateLastActivity).getTime() < 30 * DAY);
        const oldKey = list.filter((d) => auroraVersionCode(d.AppVersion) && auroraVersionCode(d.AppVersion) < 166);
        const behind = list.filter((d) => auroraVersionCode(d.AppVersion) && auroraVersionCode(d.AppVersion) < rel.code);
        const t = `Latest is ${rel.name} · ${behind.length} of ${list.length} devices behind`;
        return oldKey.length ? warn(`${t}. ${oldKey.length} still on the old signing key (1.2.165 or older): they must uninstall and reinstall once (${oldKey.map((d) => d.Name).slice(0, 5).join(', ')}).`) : ok(t);
      }),
      check('App settings file', async () => {
        for (const url of REMOTE_CONFIG_URLS) {
          try { const r = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store', signal: AbortSignal.timeout(8000) }); if (r.ok) { await r.json(); return ok('aurora-config.json loads'); } } catch { /* next */ }
        }
        return bad("aurora-config.json couldn't be read, so apps keep their last settings (guard address, Requests).");
      }),
    ];
    draw();
    await Promise.all(jobs);
    const bads = lines.filter((l) => l.level === 'bad').length, warns = lines.filter((l) => l.level === 'warn').length;
    return { bads, warns };
  }

  async function adminOverview(body, isCurrent) {
    const since = new Date(Date.now() - 14 * DAY);
    const safe = (p) => p.catch((e) => ({ error: e }));
    const [info, sessions, users, counts, devices, activity, tasks, release] = await Promise.all([
      safe(api('/System/Info')), safe(api('/Sessions')), safe(api('/Users')), safe(api('/Items/Counts')),
      safe(api('/Devices')), safe(api('/System/ActivityLog/Entries', { params: { MinDate: since.toISOString(), Limit: 2000 } })),
      safe(api('/ScheduledTasks')), latestAuroraRelease(),
    ]);
    if (!isCurrent()) return;
    if (info?.error && sessions?.error) { body.innerHTML = `<p class="empty-msg">${esc(adminError(info.error))}</p>`; return; }
    const live = users?.error ? { now: [], history: [] } : await liveWatching(users);
    if (!isCurrent()) return;

    const list = (x) => (Array.isArray(x) ? x : x?.Items || []);
    const active = list(sessions).filter((s) => s.NowPlayingItem);
    const recent = list(sessions).filter((s) => Date.now() - new Date(s.LastActivityDate).getTime() < 10 * 60000);
    const transcoding = active.filter((s) => (s.PlayState?.PlayMethod || '') === 'Transcode').length;
    const aurora = list(devices).filter((d) => /aurora|embyflix/i.test(d.AppName || ''));
    const auroraActive30 = aurora.filter((d) => Date.now() - new Date(d.DateLastActivity).getTime() < 30 * DAY);
    const outdated = release?.code ? auroraActive30.filter((d) => auroraVersionCode(d.AppVersion) && auroraVersionCode(d.AppVersion) < release.code) : [];
    const plays = list(activity).filter((a) => a.Type === 'VideoPlayback');
    const failedTasks = list(tasks).filter((t) => t.LastExecutionResult?.Status === 'Failed');
    const errors = list(activity).filter((a) => /error|fatal/i.test(a.Severity || '') || /failed/i.test(a.Type || ''));

    // Waiting extension requests (Aurora Guard 1.4.0+), up top where the admin looks first.
    let waiting = 0;
    if (guardEnabled) { try { waiting = (await guard('/extensions', { quick: true })).pending.length; } catch { /* older or unreachable guard */ } }
    if (!isCurrent()) return;
    body.innerHTML = `
      ${waiting ? `<a class="admin-card ext-banner" href="#/admin?tab=users"><strong>${waiting} extension ${waiting === 1 ? 'request' : 'requests'} waiting</strong> <span class="muted">Tap to review and approve</span></a>` : ''}
      <div class="stat-grid">
        ${statTile('Watching now', active.length + live.now.length, active.length + live.now.length
          ? `${live.now.length} live TV · ${transcoding} converting (transcode), ${active.length - transcoding} direct` : 'Nobody is watching')}
        ${statTile('Online now', recent.length, 'Active in the last 10 minutes')}
        ${statTile('Plays (14 days)', plays.length, plays.length ? `About ${Math.round(plays.length / 14 * 10) / 10} a day` : '')}
        ${statTile('Users', list(users).length, `${list(users).filter((u) => Date.now() - new Date(u.LastActivityDate).getTime() < 7 * DAY).length} active this week`)}
        ${statTile('Aurora devices', auroraActive30.length, 'Used in the last 30 days')}
        ${statTile('Library', counts?.error ? '—' : (counts.MovieCount || 0) + (counts.SeriesCount || 0),
          counts?.error ? '' : `${counts.MovieCount || 0} movies · ${counts.SeriesCount || 0} shows · ${counts.EpisodeCount || 0} episodes`)}
      </div>

      <section class="admin-card">
        <h2>Health check <small>Every part of the service</small></h2>
        <div data-health><p class="muted">Checks the Emby server, Aurora Guard, the Live TV source and provider connections, channel reporting, app updates and the last day's playback problems.</p></div>
        <button class="btn btn-white" data-health-run>Check everything</button>
      </section>

      <section class="admin-card">
        <h2>TV provider connections <small>Updates every 30 seconds</small></h2>
        <div data-conn><div class="spinner"></div></div>
      </section>

      <section class="admin-card">
        <h2>Watching now <small data-watch-updated>Updates every 30 seconds</small></h2>
        <div data-watching>${watchingHtml(active, live.now)}</div>
      </section>

      <section class="admin-card">
        <h2>Plays per day <small>Last 14 days</small></h2>
        ${playsChart(plays)}
      </section>

      <div class="admin-cols">
        <section class="admin-card">
          <h2>Most watched <small>Last 14 days</small></h2>
          ${topList(plays.map((a) => parsePlayback(a).title))}
        </section>
        <section class="admin-card">
          <h2>Most active viewers <small>Last 14 days</small></h2>
          ${topList(plays.map((a) => parsePlayback(a).user))}
        </section>
      </div>

      <div class="admin-cols">
        <section class="admin-card">
          <h2>Server</h2>
          ${info?.error ? `<p class="muted">${esc(adminError(info.error))}</p>` : `
          <dl class="admin-dl">
            <dt>Name</dt><dd>${esc(info.ServerName || '')}</dd>
            <dt>Emby version</dt><dd>${esc(info.Version || '')}${info.HasUpdateAvailable ? ' <span class="pill warn">Update available</span>' : ''}</dd>
            <dt>System</dt><dd>${esc(info.OperatingSystemDisplayName || info.OperatingSystem || '')}</dd>
            <dt>Restart needed</dt><dd>${info.HasPendingRestart ? '<span class="pill warn">Yes</span>' : 'No'}</dd>
            <dt>Scheduled tasks</dt><dd>${failedTasks.length ? `<span class="pill bad">${failedTasks.length} failed</span> ${esc(failedTasks.map((t) => t.Name).join(', '))}` : 'All OK'}</dd>
            <dt>Problems (14 days)</dt><dd>${errors.length ? `<a href="#/admin?tab=activity&filter=errors">${errors.length} in the activity log</a>` : 'None'}</dd>
          </dl>
          <button class="btn btn-gray" data-scan>Scan all libraries</button>`}
        </section>
        <section class="admin-card">
          <h2>Aurora app</h2>
          <dl class="admin-dl">
            <dt>Latest version</dt><dd>${release ? `${esc(release.name)} <span class="muted">(${esc(timeAgo(release.date))})</span>` : "Couldn't check GitHub"}</dd>
            <dt>This device</dt><dd>${esc(nativeApp?.getVersionName ? 'Aurora ' + nativeApp.getVersionName() : 'Web browser')}</dd>
            <dt>Devices behind</dt><dd>${outdated.length ? `<a href="#/admin?tab=devices">${outdated.length} on an older version</a>` : 'None'}</dd>
            <dt>Requests tab</dt><dd>${state.requestsEnabled && state.requestsServer ? `On · ${esc(state.requestsServer)}` : 'Coming soon (off)'}</dd>
          </dl>
          ${release?.notes?.length ? `<h3 class="admin-sub">In the latest version</h3><ul class="admin-notes">${release.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        </section>
      </div>`;

    $('[data-scan]', body)?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try { await api('/Library/Refresh', { method: 'POST' }); toast('Library scan started'); } catch (err) { toast(adminError(err)); }
      e.target.disabled = false;
    });
    if (!users?.error) refreshWatching(body, isCurrent, users);
    const userList = users?.error ? [] : list(users);
    $('[data-health-run]', body).addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Checking…';
      try {
        const r = await runHealthCheck($('[data-health]', body), userList);
        btn.textContent = r.bads ? `${r.bads} ${r.bads === 1 ? 'problem' : 'problems'} · check again` : r.warns ? `${r.warns} to check · check again` : 'All good · check again';
      } catch (err) { btn.textContent = 'Check everything'; toast("Couldn't finish the check: " + err.message); }
      btn.disabled = false;
    });
    const connEl = $('[data-conn]', body);
    renderConnections(connEl, isCurrent, userList).catch((e) => { connEl.innerHTML = `<p class="muted">${esc(adminError(e))}</p>`; });
    const connTimer = setInterval(() => {
      if (!isCurrent() || !connEl.isConnected) { clearInterval(connTimer); return; }
      renderConnections(connEl, isCurrent, userList).catch(() => {});
    }, 30000);
  }

  // Live TV source: Emby's own Live TV, an M3U playlist, or an Xtream Codes account. Saved for every account.
  async function adminRequests(body, isCurrent) {
    await refreshRequestsConfig();
    if (!isCurrent()) return;
    const fromApp = !!requestsOverride;
    body.innerHTML = `
      <section class="admin-card req-admin">
        <h2>Request server (Jellyseerr)</h2>
        <p class="muted">The address everyone's Requests tab connects to. Saving applies it to every account; apps pick it up the next time they open.</p>
        <dl class="admin-dl">
          <dt>In use now</dt><dd>${state.requestsServer ? esc(state.requestsServer) : 'None'} <span class="pill">${fromApp ? 'set here' : 'from the app settings file'}</span></dd>
        </dl>
        <label class="admin-field"><span>Jellyseerr address</span>
          <input type="url" data-f="server" value="${esc(state.requestsServer)}" autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="https://….trycloudflare.com">
          <small>Using a Cloudflare quick tunnel? It gets a new address every time cloudflared restarts. Find the new one in cloudflared's output,
            on the line "Your quick Tunnel has been created! Visit it at https://….trycloudflare.com", and paste it here.</small></label>
        <label class="admin-check"><input type="checkbox" data-f="on"${state.requestsEnabled || !fromApp ? ' checked' : ''}> Show the Requests tab</label>
        <div class="m-actions">
          <button class="btn btn-gray" data-test>Test</button>
          <button class="btn btn-red" data-save>Save for everyone</button>
          ${fromApp ? '<button class="btn btn-gray" data-reset>Use the settings file instead</button>' : ''}
        </div>
        <div class="live-result" data-result></div>
      </section>
      <section class="admin-card">
        <h2>A steadier address</h2>
        <p class="muted">Quick tunnels change address whenever they restart, which is why Requests can suddenly stop working. A permanent address avoids that:
          a free <strong>named</strong> Cloudflare Tunnel (with a Cloudflare account) keeps the same address, or Jellyseerr can be reached on your DuckDNS name
          the same way Emby is (for example https://emby4836.duckdns.org:5055, with that port forwarded on your router).</p>
      </section>`;
    const input = $('[data-f="server"]', body), on = $('[data-f="on"]', body), result = $('[data-result]', body);
    const say = (html, cls = '') => { result.className = 'live-result' + (cls ? ' ' + cls : ''); result.innerHTML = html; };
    const value = () => { let v = input.value.trim().replace(/\/+$/, ''); if (v && !/^https?:\/\//i.test(v)) v = 'https://' + v; return v; };
    const test = async (v) => {
      if (!v) throw new Error('Enter the Jellyseerr address first.');
      if (!nativeApp?.httpRequest) throw new Error('Testing works in the Aurora app for Android.');
      const r = await nativeHttp('GET', v + '/api/v1/status', { Accept: 'application/json' }, null, 20000).catch((e) => ({ status: 0, error: e.message }));
      if (!r.status) throw new Error(`Couldn't connect to ${esc(v)}. ${r.error ? esc(r.error) + '. ' : ''}Check the address, and that Jellyseerr and its tunnel are running.`);
      let data = null; try { data = JSON.parse(r.body); } catch { /* not JSON */ }
      if (r.status >= 400 || !data?.version) throw new Error(`${esc(v)} answered, but it doesn't look like Jellyseerr (status ${r.status}).`);
      return `<strong>It works.</strong> Jellyseerr ${esc(data.version)}${data.updateAvailable ? ' (an update is available)' : ''}.`;
    };
    $('[data-test]', body).addEventListener('click', async () => {
      say('<div class="spinner"></div>');
      try { say(await test(value()), 'good'); } catch (e) { say(e.message, 'bad'); }
    });
    let confirmUnreachable = false;
    $('[data-save]', body).addEventListener('click', async () => {
      const v = value();
      say('<div class="spinner"></div> Checking the address…');
      let note = '';
      try { note = await test(v); } catch (e) {
        if (!v || !confirmUnreachable) {
          confirmUnreachable = !!v;
          return say(`${e.message}${v ? '<br>Press <strong>Save for everyone</strong> again to save it anyway.' : ''}`, 'bad');
        }
      }
      confirmUnreachable = false;
      say('<div class="spinner"></div> Saving for every account…');
      try {
        const cfg = { server: v, on: on.checked, t: Date.now() };
        const r = await writeAuroraPrefForAll(REQ_PREFS.id, cfg);
        requestsOverride = cfg;
        applyRequestsServer(v, on.checked);
        $('.req-admin dd', body).innerHTML = `${esc(v)} <span class="pill">set here</span>`;
        say(`${note ? note + '<br>' : ''}Saved for ${r.saved} of ${r.total} accounts.${r.failed ? ` ${r.failed} couldn't be updated.` : ''} Everyone's app uses it the next time it opens.`, r.failed ? 'bad' : 'good');
      } catch (e) { say(`Couldn't save: ${esc(e.message)}`, 'bad'); }
    });
    $('[data-reset]', body)?.addEventListener('click', async () => {
      say('<div class="spinner"></div> Saving for every account…');
      try {
        await writeAuroraPrefForAll(REQ_PREFS.id, null);
        requestsOverride = null;
        await loadRemoteConfig();
        adminRequests(body, isCurrent);
      } catch (e) { say(`Couldn't save: ${esc(e.message)}`, 'bad'); }
    });
    autoFocus(input);
  }

  async function adminLiveTv(body, isCurrent) {
    await refreshIptvConfig();
    if (!isCurrent()) return;
    const cfg = iptv.config || { type: 'emby' };
    const field = (label, name, value, type = 'text', hint = '') => `
      <label class="admin-field"><span>${label}</span>
        <input type="${type}" data-f="${name}" value="${esc(value || '')}" autocomplete="off" autocapitalize="none" spellcheck="false">
        ${hint ? `<small>${hint}</small>` : ''}</label>`;
    body.innerHTML = `
      <section class="admin-card" data-live-watch><h2>Watching live TV now</h2><div class="spinner"></div></section>
      <section class="admin-card live-source">
        <h2>Live TV source</h2>
        <p class="muted">Pick where Live TV comes from. Saving applies it to every account, and each customer's app switches over the next time it opens.
          M3U and Xtream channels play in Aurora's own TV player straight from your provider, without going through Emby.</p>
        <div class="chip-row source-pick">
          <button class="chip${cfg.type === 'emby' || !cfg.type ? ' active' : ''}" data-type="emby">Emby Live TV</button>
          <button class="chip${cfg.type === 'm3u' ? ' active' : ''}" data-type="m3u">M3U playlist</button>
          <button class="chip${cfg.type === 'xtream' ? ' active' : ''}" data-type="xtream">Xtream Codes</button>
        </div>
        <div class="source-fields" data-for="emby"><p class="muted">Uses the channels and guide set up in Emby (Emby dashboard → Live TV).</p></div>
        <div class="source-fields" data-for="m3u">
          ${field('Playlist address (M3U link)', 'm3uUrl', cfg.m3uUrl, 'url', 'For example http://provider.com:8080/get.php?username=…&password=…&type=m3u_plus')}
        </div>
        <div class="source-fields" data-for="xtream">
          ${field('Server address', 'server', cfg.server, 'url', 'For example http://provider.com:8080')}
          ${field('Username', 'username', cfg.username)}
          ${field('Password', 'password', cfg.password, 'password')}
          <label class="admin-field"><span>Stream type</span>
            <select data-f="format">
              <option value="ts"${cfg.format !== 'hls' ? ' selected' : ''}>MPEG-TS (recommended)</option>
              <option value="hls"${cfg.format === 'hls' ? ' selected' : ''}>HLS (m3u8)</option>
            </select><small>Try HLS if channels won't start with MPEG-TS.</small></label>
        </div>
        <div class="source-fields" data-for="m3u xtream">
          ${field('TV guide link (XMLTV, optional)', 'epgUrl', cfg.epgUrl, 'url', 'Leave empty to use the guide from your provider: Xtream accounts have one built in, and many M3U playlists name theirs. .xml and .xml.gz both work.')}
          ${field('User agent (optional)', 'userAgent', cfg.userAgent, 'text', 'Only if your provider asks for a particular player name.')}
          <div class="cat-pick-wrap">
            <div class="cat-pick-head">
              <div><strong>Categories shown to customers</strong><div class="muted" data-cat-summary></div></div>
              <button class="btn btn-gray" data-cat-load>Choose categories</button>
            </div>
            <div class="cat-pick hidden">
              <div class="cat-pick-tools">
                <input type="search" data-cat-filter placeholder="Find a category" autocomplete="off">
                <button class="btn btn-gray" data-cat-all>Show all</button>
                <button class="btn btn-gray" data-cat-none>Hide all</button>
              </div>
              <label class="admin-check"><input type="checkbox" data-cat-auto> Show new categories automatically when the provider adds them</label>
              <div class="cat-list"></div>
            </div>
          </div>
        </div>
        <div class="m-actions">
          <button class="btn btn-gray" data-test>Test</button>
          <button class="btn btn-red" data-save>Save for everyone</button>
        </div>
        <div class="live-result" data-result></div>
      </section>`;
    // Who's watching which channel, and what was watched lately.
    (async () => {
      const box = $('[data-live-watch]', body);
      const paint = async () => {
        try {
          const live = await liveWatching(await api('/Users'));
          if (!isCurrent() || !box.isConnected) return false;
          box.innerHTML = `<h2>Watching live TV now <small>${live.now.length ? `${live.now.length} watching · ` : ''}updates every 30 seconds</small></h2>
            ${live.now.length ? `<div class="admin-list">${live.now.map(liveRow).join('')}</div>` : '<p class="muted">Nobody is watching live TV right now.</p>'}
            <h3 class="admin-sub">Recently watched</h3>
            ${live.history.length ? `<div class="admin-list">${live.history.slice(0, 25).map(liveHistoryRow).join('')}</div>` : '<p class="muted">Nothing yet. Channels watched for a minute or more show up here.</p>'}`;
        } catch (e) {
          if (isCurrent() && box.isConnected) box.innerHTML = `<h2>Watching live TV now</h2><p class="muted">${esc(adminError(e))}</p>`;
        }
        return isCurrent() && box.isConnected;
      };
      if (!(await paint())) return;
      const timer = setInterval(async () => { if (!(await paint())) clearInterval(timer); }, 30000);
    })();

    let type = cfg.type || 'emby';
    const showFields = () => {
      $$('.source-pick .chip', body).forEach((c) => c.classList.toggle('active', c.dataset.type === type));
      $$('.source-fields', body).forEach((f) => f.classList.toggle('hidden', !f.dataset.for.split(' ').includes(type)));
      $('[data-test]', body).classList.toggle('hidden', type === 'emby');
    };
    $$('.source-pick .chip', body).forEach((c) => c.addEventListener('click', () => { type = c.dataset.type; showFields(); }));
    showFields();
    const result = $('[data-result]', body);

    // ----- Category picker -----
    // hidden: ids switched off; cats: the provider's full list once loaded (null until then).
    let cats = null, catsFor = '', hidden = new Set((cfg.catsHidden || []).map(String)), autoNew = Array.isArray(cfg.catsHidden);
    const pickEl = $('.cat-pick', body), listEl = $('.cat-list', body), summary = $('[data-cat-summary]', body);
    const sourceOf = (c) => (c.type === 'm3u' ? c.m3uUrl : `${c.server}|${c.username}`);
    const sameSource = () => { const d = rawDraft(); return d.type === cfg.type && sourceOf(d) === sourceOf(cfg); };
    const showSummary = () => {
      if (!cats || catsFor !== sourceOf(rawDraft())) {
        const n = cfg.catsShown?.length, h = cfg.catsHidden?.length;
        summary.textContent = !sameSource() ? 'All categories (choose after testing the new source)'
          : Array.isArray(cfg.catsShown) ? `${n} chosen categor${n === 1 ? 'y' : 'ies'} shown` : h ? `All except ${h} hidden` : 'All categories';
        return;
      }
      const on = cats.length - cats.filter((c) => hidden.has(c.id)).length;
      summary.textContent = on === cats.length ? `All ${cats.length} categories` : `${on} of ${cats.length} categories shown`;
    };
    const paintCats = () => {
      const q = $('[data-cat-filter]', body).value.trim().toLowerCase();
      listEl.innerHTML = cats.filter((c) => !q || c.name.toLowerCase().includes(q)).map((c) => `
        <label class="cat-row"><input type="checkbox" data-id="${esc(c.id)}"${hidden.has(c.id) ? '' : ' checked'}>
          <span>${esc(c.name)}</span>${c.count ? `<small>${c.count}</small>` : ''}</label>`).join('') || '<p class="muted">No categories match.</p>';
      $$('input[data-id]', listEl).forEach((cb) => cb.addEventListener('change', () => {
        if (cb.checked) hidden.delete(cb.dataset.id); else hidden.add(cb.dataset.id);
        showSummary();
      }));
    };
    $('[data-cat-load]', body).addEventListener('click', async (e) => {
      const d = rawDraft(), problem = check(d);
      if (problem) return say(esc(problem), 'bad');
      e.target.disabled = true;
      listEl.innerHTML = '<div class="spinner"></div>';
      pickEl.classList.remove('hidden');
      try {
        const src = await iptvSource(d);
        const fresh = src.categories.map((c) => ({ id: String(c.id), name: c.name, count: c.count }));
        // Carry over the current choice when it's the same provider; a new one starts with everything shown.
        if (!cats && sameSource() && Array.isArray(cfg.catsShown)) {
          const shown = new Set(cfg.catsShown.map(String));
          hidden = new Set(fresh.filter((c) => !shown.has(c.id)).map((c) => c.id));
        } else if (!cats && !sameSource()) hidden = new Set();
        cats = fresh;
        catsFor = sourceOf(d);
        $('[data-cat-auto]', body).checked = autoNew;
        paintCats();
        showSummary();
        if (nav.on) focusEl($('[data-cat-filter]', body));
      } catch (err) { listEl.innerHTML = `<p class="muted">Couldn't load the categories: ${esc(err.message)}</p>`; }
      e.target.disabled = false;
    });
    $('[data-cat-filter]', body).addEventListener('input', () => cats && paintCats());
    $('[data-cat-all]', body).addEventListener('click', () => { hidden.clear(); paintCats(); showSummary(); });
    $('[data-cat-none]', body).addEventListener('click', () => { cats.forEach((c) => hidden.add(c.id)); paintCats(); showSummary(); });
    $('[data-cat-auto]', body).addEventListener('change', (e) => { autoNew = e.target.checked; });
    body.addEventListener('input', (e) => { if (e.target.matches('[data-f]')) showSummary(); });

    const rawDraft = () => {
      const v = (n) => ($(`[data-f="${n}"]`, body)?.value || '').trim();
      if (type === 'emby') return { type: 'emby', v: Date.now() };
      const d = { type, userAgent: v('userAgent'), epgUrl: v('epgUrl'), v: Date.now() };
      if (type === 'm3u') d.m3uUrl = v('m3uUrl');
      else Object.assign(d, { server: v('server'), username: v('username'), password: v('password'), format: v('format') || 'ts' });
      return d;
    };
    // The settings to save: the source plus the category choice.
    const draft = () => {
      const d = rawDraft();
      if (d.type === 'emby') return d;
      if (cats && catsFor === sourceOf(d)) {
        if (hidden.size && autoNew) d.catsHidden = [...hidden];
        else if (hidden.size) d.catsShown = cats.filter((c) => !hidden.has(c.id)).map((c) => c.id);
      } else if (sameSource()) {
        // Not opened this time: keep the choice already saved.
        if (cfg.catsShown) d.catsShown = cfg.catsShown;
        if (cfg.catsHidden) d.catsHidden = cfg.catsHidden;
      }
      return d;
    };
    const check = (d) => {
      if (d.type === 'm3u' && !d.m3uUrl) return 'Enter the playlist address.';
      if (d.type === 'xtream' && (!d.server || !d.username)) return 'Enter the server address, username and password.';
      return '';
    };
    const say = (html, cls = '') => { result.className = 'live-result ' + cls; result.innerHTML = html; };
    showSummary();

    async function test(d) {
      say('<div class="spinner"></div>');
      let account = '';
      if (d.type === 'xtream') {
        const info = await xtJson(d, {});
        const u = info?.user_info;
        if (!u || Number(u.auth) === 0) throw new Error('The Xtream account was not accepted. Check the username and password.');
        const exp = u.exp_date ? new Date(Number(u.exp_date) * 1000).toLocaleDateString() : 'never';
        account = `Account ${esc(u.status || 'active')} · expires ${esc(exp)} · ${esc(u.active_cons ?? 0)} of ${esc(u.max_connections ?? '?')} connections in use`;
      }
      const src = await iptvSource(d);
      const count = d.type === 'm3u' ? src.all.length : null;
      let guideNote = '';
      if (nativeApp?.loadEpg) {
        say('<div class="spinner"></div> Channels found. Checking the TV guide…');
        try {
          const g = await loadIptvGuide(d);
          if (!g) guideNote = 'No TV guide found. Add a guide link above to get one.';
          else {
            const chans = d.type === 'xtream' ? await iptvAllChannels(d) : src.all;
            let matched = 0, logos = chans.filter((c) => c.logo).length;
            for (let i = 0; i < chans.length; i += 2000) {
              const part = chans.slice(i, i + 2000);
              const c = JSON.parse(nativeApp.epgCount(g.url, JSON.stringify(part.map((ch) => ({ id: ch.epgId || '', name: ch.name || '' })))));
              matched += c.listings;
              // Logos: from the playlist, or else from the guide.
              const noLogo = part.filter((ch) => !ch.logo);
              if (noLogo.length) logos += JSON.parse(nativeApp.epgCount(g.url, JSON.stringify(noLogo.map((ch) => ({ id: ch.epgId || '', name: ch.name || '' }))))).logos;
            }
            guideNote = `TV guide: ${Number(g.channels).toLocaleString()} channels in the guide · listings for ${matched} of ${chans.length} of your channels · logos for ${logos}.`;
            // The test made this guide the app's current one; switch back to the saved settings' guide.
            iptv.guideLoad = null; iptv.guide = null;
          }
        } catch (e) { guideNote = `TV guide: ${esc(e.message)}`; }
      }
      return `<strong>It works.</strong> ${src.categories.length} categor${src.categories.length === 1 ? 'y' : 'ies'}${count != null ? `, ${count} channels` : ''}.${account ? `<br>${account}` : ''}${guideNote ? `<br>${guideNote}` : ''}`;
    }

    $('[data-test]', body).addEventListener('click', async () => {
      const d = draft(), problem = check(d);
      if (problem) return say(esc(problem), 'bad');
      try { say(await test(d), 'good'); } catch (e) { say(esc(e.message), 'bad'); }
    });
    $('[data-save]', body).addEventListener('click', async (e) => {
      const d = draft(), problem = check(d);
      if (problem) return say(esc(problem), 'bad');
      e.target.disabled = true;
      try {
        let tested = '';
        if (d.type !== 'emby') {
          try { tested = await test(d); } catch (err) {
            say(`${esc(err.message)}<br>Not saved. Fix the details above, or press Save again to save anyway.`, 'bad');
            e.target.disabled = false;
            if (e.target.dataset.force !== '1') { e.target.dataset.force = '1'; return; }
          }
        }
        say('<div class="spinner"></div> Saving for every account…');
        const cfgToSave = d.type === 'emby' ? null : d;
        const res = await syncIptvConfig(cfgToSave, { force: true });
        iptv.config = cfgToSave;
        if (cfgToSave) store.set(iptvLocalKey(), JSON.stringify(cfgToSave)); else store.del(iptvLocalKey());
        resetIptvCaches();
        store.set('ef.iptv.sync', String(Date.now()));
        $$('[data-route="livetv"]').forEach((a) => a.classList.toggle('hidden', !showLiveLink()));
        say(`${tested ? tested + '<br>' : ''}<strong>Saved for ${res.saved} of ${res.total} accounts.</strong>${res.failed ? ` ${res.failed} couldn't be updated; they'll be retried later.` : ''}
          Customers' apps switch over the next time they open Aurora.`, res.failed ? 'warn' : 'good');
        e.target.dataset.force = '';
      } catch (err) {
        say(esc(adminError(err)), 'bad');
      }
      e.target.disabled = false;
    });
  }

  // ----- Live TV viewing (M3U / Xtream) -----
  // Aurora's live player records what it's playing in each viewer's Emby display preferences ("aurora-watching");
  // an entry not refreshed for three minutes counts as stopped.
  const WATCHING_FRESH = 3 * 60000;
  // The Overview asks for this twice every 30 s (Watching now and the connection meter): share one reading.
  let watchingCache = null;
  function liveWatching(users) {
    const key = ((Array.isArray(users) ? users : users?.Items) || []).map((u) => u.Id).join();
    if (watchingCache && watchingCache.key === key && Date.now() - watchingCache.t < 15000) return watchingCache.p;
    const p = liveWatchingNow(users);
    watchingCache = { key, t: Date.now(), p };
    p.catch(() => { watchingCache = null; });
    return p;
  }
  async function liveWatchingNow(users) {
    const out = { now: [], history: [] };
    const list = (Array.isArray(users) ? users : users?.Items) || [];
    const queue = list.slice();
    const worker = async () => {
      while (queue.length) {
        const u = queue.shift();
        let data = null;
        try { data = await readAuroraPref('aurora-watching', u.Id); } catch { continue; }
        for (const [deviceId, e] of Object.entries(data?.devices || {})) {
          if (Date.now() - (e.at || 0) < WATCHING_FRESH) out.now.push({ ...e, deviceId, user: u.Name });
        }
        (data?.history || []).forEach((h) => out.history.push({ ...h, user: u.Name }));
      }
    };
    await Promise.all([0, 1, 2, 3].map(worker));
    out.now.sort((a, b) => (a.user || '').localeCompare(b.user || ''));
    out.history.sort((a, b) => (b.ended || 0) - (a.ended || 0));
    return out;
  }
  const minutes = (ms) => { const m = Math.max(1, Math.round(ms / 60000)); return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`; };
  function liveRow(e) {
    const ch = [e.num, e.name].filter(Boolean).join('  ');
    return `<div class="admin-row session-row live-row">
      ${e.logo ? `<img class="live-row-logo" src="${esc(e.logo)}" alt="" referrerpolicy="no-referrer" onerror="this.remove()">` : ''}
      <div class="admin-row-main"><strong>${esc(e.user || 'Someone')}</strong> · ${esc(ch)} <span class="pill live">Live TV</span>
        <div class="muted">${e.now ? esc(e.now) + ' · ' : ''}${esc(e.device || '')} · watching for ${minutes(Date.now() - (e.started || Date.now()))}${e.group ? ' · ' + esc(e.group) : ''}</div>
      </div></div>`;
  }
  function liveHistoryRow(h) {
    return `<div class="admin-row"><div class="admin-row-main"><strong>${esc(h.user || '')}</strong> · ${esc([h.num, h.name].filter(Boolean).join('  '))}
      <div class="muted">${esc(h.device || '')} · ${minutes((h.ended || 0) - (h.started || 0))} · ${esc(timeAgo(h.ended))}</div></div></div>`;
  }

  // Aurora reports its version as 1.2.<build>; the build number orders versions.
  const auroraVersionCode = (v) => Number(String(v || '').match(/^\d+\.\d+\.(\d+)$/)?.[1] || 0);

  function sessionRow(s) {
    const it = s.NowPlayingItem, ps = s.PlayState || {};
    const title = it.SeriesName ? `${it.SeriesName} · ${episodeLabel(it)}` : it.Name;
    const pct = it.RunTimeTicks ? Math.min(100, (ps.PositionTicks || 0) / it.RunTimeTicks * 100) : 0;
    const method = ps.PlayMethod === 'Transcode' ? 'Converting' : ps.PlayMethod ? 'Direct' : '';
    return `<div class="admin-row session-row">
      <div class="admin-row-main"><strong>${esc(s.UserName || 'Someone')}</strong> · ${esc(title || '')}${ps.IsPaused ? ' <span class="pill">Paused</span>' : ''}
        <div class="muted">${esc(s.DeviceName || '')} · ${esc(s.Client || '')} ${esc(s.ApplicationVersion || '')}${method ? ' · ' + method : ''}${s.TranscodingInfo?.TranscodeReasons?.length ? ' (' + esc(s.TranscodingInfo.TranscodeReasons.join(', ')) + ')' : ''}</div>
        ${pct ? `<div class="session-bar"><span style="width:${pct.toFixed(1)}%"></span></div>` : ''}
      </div></div>`;
  }

  // "Johnny is playing Movie on Living Room TV" → who and what.
  function parsePlayback(a) {
    const m = (a.Name || '').match(/^(.+?) (?:is playing|has finished playing|started playing) (.+?)(?: on (.+))?$/i);
    return m ? { user: m[1], title: m[2], device: m[3] || '' } : { user: '', title: a.Name || '', device: '' };
  }

  function topList(names) {
    const counts = new Map();
    names.filter(Boolean).forEach((n) => counts.set(n, (counts.get(n) || 0) + 1));
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (!top.length) return '<p class="muted">No plays yet.</p>';
    const max = top[0][1];
    return `<ol class="top-list">${top.map(([n, c]) => `<li><span class="top-name">${esc(n)}</span><span class="top-bar"><span style="width:${(c / max * 100).toFixed(1)}%"></span></span><span class="top-count">${c}</span></li>`).join('')}</ol>`;
  }

  function playsChart(plays) {
    const days = [];
    const today = new Date(); today.setHours(0, 0, 0, 0);
    for (let i = 13; i >= 0; i--) days.push({ date: new Date(today.getTime() - i * DAY), count: 0 });
    plays.forEach((a) => {
      const d = new Date(a.Date); d.setHours(0, 0, 0, 0);
      const slot = days.find((x) => x.date.getTime() === d.getTime());
      if (slot) slot.count++;
    });
    const max = Math.max(1, ...days.map((d) => d.count));
    const label = (d) => d.date.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
    return `<div class="plays-chart" role="img" aria-label="Plays per day for the last 14 days">
      ${days.map((d, i) => `<div class="pc-col" title="${esc(label(d))}: ${d.count} play${d.count === 1 ? '' : 's'}">
        <span class="pc-val">${d.count || ''}</span>
        <span class="pc-bar" style="height:${Math.round(d.count / max * 130)}px"></span>
        <span class="pc-day">${i % 2 === 1 || days.length < 8 ? esc(d.date.toLocaleDateString([], { month: 'numeric', day: 'numeric' })) : ''}</span>
      </div>`).join('')}
    </div>`;
  }

  const ACTIVITY_FILTERS = [['all', 'All'], ['playback', 'Playback'], ['signin', 'Sign-ins'], ['errors', 'Problems']];
  function activityMatches(a, filter) {
    if (filter === 'playback') return /playback/i.test(a.Type || '');
    if (filter === 'signin') return /authentication|session|login|user/i.test(a.Type || '');
    if (filter === 'errors') return /error|fatal|warn/i.test(a.Severity || '') || /fail/i.test(a.Type || '');
    return true;
  }

  async function adminActivity(body, isCurrent) {
    const filter = new URLSearchParams(location.hash.split('?')[1] || '').get('filter') || 'all';
    body.innerHTML = `
      <div class="chip-row">${ACTIVITY_FILTERS.map(([id, l]) => `<a class="chip${id === filter ? ' active' : ''}" href="#/admin?tab=activity&filter=${id}">${l}</a>`).join('')}</div>
      <div class="admin-card"><div class="admin-list" data-list><div class="spinner"></div></div>
      <button class="btn btn-gray hidden" data-more>Show more</button></div>`;
    const listEl = $('[data-list]', body), more = $('[data-more]', body);
    let start = 0, shown = 0;
    const load = async () => {
      more.classList.add('hidden');
      try {
        const res = await api('/System/ActivityLog/Entries', { params: { StartIndex: start, Limit: 200 } });
        if (!isCurrent()) return;
        if (start === 0) listEl.innerHTML = '';
        const items = (res?.Items || []).filter((a) => activityMatches(a, filter));
        start += res?.Items?.length || 0;
        listEl.insertAdjacentHTML('beforeend', items.map((a) => {
          const sev = /error|fatal/i.test(a.Severity || '') ? 'bad' : /warn/i.test(a.Severity || '') ? 'warn' : '';
          return `<div class="admin-row" tabindex="-1">
            <div class="admin-row-main">${sev ? `<span class="pill ${sev}">${esc(a.Severity)}</span> ` : ''}${esc(a.Name || '')}
              ${a.ShortOverview || a.Overview ? `<div class="muted">${esc(a.ShortOverview || a.Overview)}</div>` : ''}</div>
            <div class="admin-row-time" title="${esc(new Date(a.Date).toLocaleString())}">${esc(fmtDateTime(a.Date))}</div>
          </div>`;
        }).join(''));
        shown += items.length;
        if (!shown && start >= (res?.TotalRecordCount || 0)) listEl.innerHTML = '<p class="muted">Nothing here.</p>';
        if (start < (res?.TotalRecordCount || 0)) more.classList.remove('hidden');
      } catch (e) { if (isCurrent()) listEl.innerHTML = `<p class="muted">${esc(adminError(e))}</p>`; }
    };
    more.addEventListener('click', load);
    await load();
  }

  // ----- Users (device limits, expiry, accounts) -----
  async function setDisabled(userId, disabled) {
    const user = await api(`/Users/${userId}`);
    await api(`/Users/${userId}/Policy`, { method: 'POST', body: { ...(user.Policy || {}), IsDisabled: !!disabled } });
  }

  // Limits saved by older versions in each account's (user-writable) display preferences: moved into the
  // guard once, then cleared, so nothing reads them again.
  async function moveOldLimits(users, guardUsers) {
    const moved = [];
    const queue = users.filter((u) => !guardUsers[u.Id]);
    const worker = async () => {
      while (queue.length) {
        const u = queue.shift();
        let old = null;
        try { old = await readAuroraPref(OLD_LIMITS_PREFS, u.Id); } catch { continue; }
        if (!old || (!old.limit && !old.expires)) continue;
        try {
          const r = await guard(`/limits/${u.Id}`, { method: 'PUT', body: { limit: Math.max(1, Number(old.limit) || DEFAULT_DEVICE_LIMIT), expires: old.expires || null } });
          guardUsers[u.Id] = r.record;
          await writeAuroraPref(OLD_LIMITS_PREFS, u.Id, null);
          moved.push(u.Name);
        } catch (e) { console.warn('Moving limits for', u.Name, e); }
      }
    };
    await Promise.all([0, 1, 2].map(worker));
    return moved;
  }

  // User management needs a real Emby administrator (not just one of Aurora's admin names): Emby and the
  // guard both refuse anyone else, and the page doesn't show controls that would fail.
  async function embyAdminCheck(body) {
    try {
      const me = await api(`/Users/${state.userId}`);
      if (me?.Policy?.IsAdministrator) return true;
    } catch { /* fall through */ }
    body.innerHTML = '<p class="empty-msg">User management needs an Emby administrator account. Make this account an administrator in the Emby dashboard (Users → this user → "Allow this user to manage the server"), then sign in again.</p>';
    return false;
  }

  const guardHelp = (e) => `<section class="admin-card"><h2>Aurora Guard isn't answering</h2>
    <p class="live-result bad">${esc(e.message)}${e.status ? '' : ` (${esc(guardUrl)})`}</p>
    <p class="muted">Device limits and expiration dates are kept and enforced by Aurora Guard on the Emby server PC. Check that it is running
      (Task Scheduler → "Aurora Guard"; its log is in the guard's data folder) and that port ${esc(new URL(guardUrl).port || '443')} is forwarded to that PC.
      Accounts can still be enabled, disabled or deleted below.</p></section>`;

  const userStatus = (u, lim) => (isExpired(lim) ? 'expired' : u.Policy?.IsDisabled ? 'disabled' : 'active');
  const statusPill = (st) => `<span class="pill ${st === 'active' ? 'good' : st === 'expired' ? 'bad' : 'warn'}">${st === 'active' ? 'Active' : st === 'expired' ? 'Expired' : 'Disabled'}</span>`;

  // ----- Extension requests (Admin -> Users) -----
  const EXT_DAYS = [[7, '7 days'], [14, '14 days'], [30, '30 days'], [60, '60 days'], [90, '90 days'], [180, '6 months'], [365, '1 year']];
  function extensionsCardHtml(ext) {
    if (!ext || (!ext.pending?.length && !ext.decided?.length)) return '';
    const row = (x) => `<div class="admin-row ext-row" data-ext="${esc(x.id)}"><div class="admin-row-main">
        <strong>${esc(x.name)}</strong> <span class="pill warn">Asked for more time</span>
        <div class="muted">${x.currentExpires ? `Ends ${esc(fmtDay(x.currentExpires))}${isExpired({ expires: x.currentExpires }) ? ' (expired)' : ''}` : 'No end date set'} · asked ${esc(timeAgo(x.at))}</div>
        ${x.note ? `<div class="ext-note">"${esc(x.note)}"</div>` : ''}
        <div class="ext-actions">
          <select data-ext-days aria-label="Extend by">${EXT_DAYS.map(([d, l]) => `<option value="${d}"${d === 30 ? ' selected' : ''}>${l}</option>`).join('')}</select>
          <button class="btn btn-white" data-ext-approve>Approve</button>
          <button class="btn btn-gray" data-ext-deny>Deny</button>
        </div></div></div>`;
    const done = (x) => `<div class="admin-row"><div class="admin-row-main"><strong>${esc(x.name)}</strong> ${x.status === 'approved' ? `<span class="pill">Approved</span> ${x.days} days, ends ${esc(fmtDay(x.newExpires))}` : '<span class="pill bad">Denied</span>'}</div>
        <div class="admin-row-time">${esc(timeAgo(x.decidedAt))}</div></div>`;
    return `<section class="admin-card ext-card">
      <h2>Extension requests <small>${ext.pending.length ? `${ext.pending.length} waiting` : 'None waiting'}</small></h2>
      <div class="admin-list">${ext.pending.map(row).join('') || '<p class="muted">Nobody is waiting for an answer.</p>'}</div>
      ${ext.decided.length ? `<details class="conn-list"><summary>Recent decisions</summary><div class="admin-list">${ext.decided.slice(0, 10).map(done).join('')}</div></details>` : ''}
    </section>`;
  }
  function bindExtensions(body, isCurrent) {
    $$('[data-ext]', body).forEach((rowEl) => {
      const id = rowEl.dataset.ext;
      const decide = async (action, btn) => {
        $$('button', rowEl).forEach((b) => { b.disabled = true; });
        try {
          const days = Number($('[data-ext-days]', rowEl).value);
          const r = await guard(`/extensions/${encodeURIComponent(id)}`, { method: 'PUT', body: { action, days } });
          toast(action === 'approve' ? `Approved: now ends ${fmtDay(r.request.newExpires)}` : 'Denied', 3000);
        } catch (e) { toast(e.status === 404 ? 'Update Aurora Guard to 1.4.0 first.' : e.message, 5000); }
        if (isCurrent()) adminUsers(body, isCurrent);
      };
      $('[data-ext-approve]', rowEl).addEventListener('click', (e) => decide('approve', e.currentTarget));
      $('[data-ext-deny]', rowEl).addEventListener('click', (e) => decide('deny', e.currentTarget));
    });
  }

  async function adminUsers(body, isCurrent) {
    const params = new URLSearchParams(location.hash.split('?')[1] || '');
    if (params.get('user') === 'new') return adminUserNew(body, isCurrent);
    if (params.get('user')) return adminUserDetail(body, isCurrent, params.get('user'));
    if (!(await embyAdminCheck(body)) || !isCurrent()) return;
    let users, sessions, g = null, guardError = null;
    try {
      [users, sessions] = await Promise.all([api('/Users'), api('/Sessions', { params: { ActiveWithinSeconds: ACTIVE_WINDOW / 1000 } }).catch(() => [])]);
      users = users || [];
    } catch (e) { if (isCurrent()) body.innerHTML = `<p class="empty-msg">${esc(adminError(e))}</p>`; return; }
    if (guardEnabled) { try { g = await guard('/limits'); } catch (e) { guardError = e; } }
    const ext = g ? await guard('/extensions').catch(() => null) : null;
    if (!isCurrent()) return;
    // Once only (the guard remembers): any account can write its own display preferences, so values found
    // there later must not be trusted.
    let moved = [];
    if (g && !g.migrated) {
      moved = await moveOldLimits(users, g.users).catch(() => []);
      await guard('/migrated', { method: 'PUT' }).catch(() => {});
    }
    if (!isCurrent()) return;
    const limits = new Map(users.map((u) => [u.Id, g?.users?.[u.Id] || null]));
    // Live device counts straight from the guard (GET /status/users, guard 1.2.0+): the same count it enforces with,
    // and it names the devices. An older or unreachable guard just means the count is worked out here from Emby.
    let live = null;
    if (g) live = await guard('/status/users').catch(() => null);
    const actions = g ? (await guard('/actions').catch(() => ({ actions: [] }))).actions : [];
    if (!isCurrent()) return;
    const inUse = new Map();
    for (const se of Array.isArray(sessions) ? sessions : []) {
      if (!se.UserId || !se.DeviceId || Date.now() - Date.parse(se.LastActivityDate || 0) > ACTIVE_WINDOW) continue;
      if (!inUse.has(se.UserId)) inUse.set(se.UserId, new Set());
      inUse.get(se.UserId).add(se.DeviceId);
    }
    const liveOf = (data, id) => (data ? (data.users || []).find((x) => x.userId === id) || { activeDevices: 0, over: false, devices: [], limit: undefined } : null);
    const rows = users.map((u) => {
      const lim = limits.get(u.Id), st = userStatus(u, lim), exempt = exemptFromLimits(u);
      return { u, lim, st, exempt, devices: inUse.get(u.Id)?.size || 0, live: exempt ? null : liveOf(live, u.Id), search: (u.Name || '').toLowerCase() };
    }).sort((a, b) => (a.u.Name || '').localeCompare(b.u.Name || ''));
    // What a row says about devices. With the guard's live data: "2 of 2 devices in use · Pixel, TV", and a red
    // "Over limit" when there are more than allowed.
    const liveHtml = (r) => {
      const n = r.live ? r.live.activeDevices : r.devices, word = n === 1 ? 'device' : 'devices';
      if (r.exempt || !guardEnabled) return `${n} ${word} in use`;
      const limit = r.live?.limit || r.lim?.limit || g?.defaultLimit || DEFAULT_DEVICE_LIMIT;
      const names = r.live?.devices?.length ? ' · ' + esc(r.live.devices.map((d) => d.name + (d.playing ? ' (playing)' : '')).join(', ')) : '';
      return `${n} of ${limit} devices in use${r.live?.over ? ' <span class="pill bad">Over limit</span>' : ''}${names}`;
    };
    const summaryText = (data) => {
      if (!data) return '';
      const t = data.totals || {};
      return `Live from Aurora Guard: ${t.activeDevices || 0} ${t.activeDevices === 1 ? 'device' : 'devices'} in use across ${t.accounts || 0} ${t.accounts === 1 ? 'account' : 'accounts'}`
        + `${t.over ? ` · ${t.over} over the limit` : ' · none over the limit'} · updated ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`;
    };
    const counts = { all: rows.length, active: 0, disabled: 0, expired: 0 };
    rows.forEach((r) => { counts[r.st]++; });
    const filters = guardEnabled ? ['all', 'active', 'disabled', 'expired'] : ['all', 'active', 'disabled'];
    let filter = store.get('ef.usersFilter') || 'all', query = '';
    if (!filters.includes(filter)) filter = 'all';
    body.innerHTML = `
      ${extensionsCardHtml(ext)}
      <section class="admin-card">
        <div class="users-head">
          <h2>Users <small>${rows.length}</small></h2>
          <span class="osd-spacer"></span>
          <a class="btn btn-red" href="#/admin?tab=users&user=new">Add user</a>
        </div>
        ${moved.length ? `<p class="live-result good">Moved the limits saved by the older version into Aurora Guard (once only) for: ${esc(moved.join(', '))}. Check they look right: any account could edit its own old copy.</p>` : ''}
        ${g?.dryRun ? '<p class="live-result bad">Aurora Guard is in dry-run mode: it only logs what it would do. Set "dryRun": false in its config.json to enforce.</p>' : ''}
        <div class="users-tools">
          <input type="search" class="users-search" placeholder="Search users" autocomplete="off" spellcheck="false">
          <div class="chip-row">${filters.map((f) => `<button class="chip${f === filter ? ' active' : ''}" data-filter="${f}">${f[0].toUpperCase() + f.slice(1)} · ${counts[f]}</button>`).join('')}</div>
        </div>
        <p class="muted users-live" data-live-summary>${esc(summaryText(live))}</p>
        <div class="admin-list users-list"></div>
        <p class="muted">Devices: how many are in use now (active in the last ${ACTIVE_WINDOW / 60000} minutes)${guardEnabled ? " out of the account's limit. Admin accounts have no limits." : '.'}</p>
      </section>
      ${!guardEnabled ? `<section class="admin-card"><h2>Device limits and expiration are switched off</h2>
        <p class="muted">Aurora Guard is disabled, so accounts have no device limit or expiration date. Everything else on this page still works.
          To turn it back on, set "guardEnabled": true in aurora-config.json once the guard service is running (see server/README.md).</p></section>` : guardError ? guardHelp(guardError) : `<section class="admin-card">
        <h2>Enforcement <small>Aurora Guard · checks every ${g.intervalSeconds} s</small></h2>
        <p class="muted">Last check ${g.lastRun?.at ? esc(timeAgo(new Date(g.lastRun.at))) : 'not yet'}${g.lastRun?.at && !g.lastRun.ok ? ` · <span class="pill bad">Failed</span> ${esc(g.lastRun.error)}` : ''}.
          The guard signs out devices over an account's limit and switches off expired accounts, in every Emby app.</p>
        <div class="admin-list">${actions.slice(0, 15).map((a) => `<div class="admin-row"><div class="admin-row-main"><strong>${esc(a.name || '')}</strong> · ${esc(
          a.type === 'signedOut' ? `signed out ${a.device || 'a device'}${a.client ? ' (' + a.client + ')' : ''}, ${a.why}`
            : a.type === 'disabled' ? `disabled, ${a.why}` : a.type === 'enabled' ? `enabled again, ${a.why}` : a.why || a.type)}</div>
          <div class="admin-row-time">${esc(timeAgo(new Date(a.at)))}</div></div>`).join('') || '<p class="muted">Nothing done yet.</p>'}</div>
      </section>`}`;
    bindExtensions(body, isCurrent);
    const list = $('.users-list', body);
    const draw = () => {
      const shown = rows.filter((r) => (filter === 'all' || r.st === filter) && (!query || r.search.includes(query)));
      list.innerHTML = shown.map((r) => `<a class="admin-row user-row${r.st !== 'active' ? ' dim' : ''}" href="#/admin?tab=users&user=${esc(r.u.Id)}">
        <div class="admin-row-main"><strong>${esc(r.u.Name)}</strong> ${statusPill(r.st)}${r.exempt ? ' <span class="pill">Admin</span>' : ''}
          <div class="muted"><span data-live="${esc(r.u.Id)}">${liveHtml(r)}</span>
            ${guardEnabled ? `· ${r.lim?.expires ? `${isExpired(r.lim) ? 'expired' : 'expires'} ${esc(fmtDay(r.lim.expires))}` : 'no expiration'}` : ''}</div></div>
        <div class="admin-row-time">${r.u.LastActivityDate ? esc(timeAgo(r.u.LastActivityDate)) : 'never'}</div></a>`).join('') || '<p class="muted">No users match.</p>';
    };
    draw();
    // Keep the counts live while this page is open: ask the guard every 10 s and change just the device text
    // in place (so a row the remote is on keeps its focus). Stops when the page is left.
    if (live) {
      let failures = 0;
      const timer = setInterval(async () => {
        if (!isCurrent() || !body.isConnected) { clearInterval(timer); return; }
        if (document.hidden) return;
        try {
          const fresh = await guard('/status/users');
          failures = 0;
          for (const r of rows) { if (!r.exempt) r.live = liveOf(fresh, r.u.Id); }
          for (const r of rows) { const el = $(`[data-live="${CSS.escape(r.u.Id)}"]`, body); if (el) el.innerHTML = liveHtml(r); }
          const sum = $('[data-live-summary]', body);
          if (sum) sum.textContent = summaryText(fresh);
        } catch {
          if (++failures >= 3) { const sum = $('[data-live-summary]', body); if (sum) sum.textContent = 'Live counts paused: Aurora Guard is not answering.'; }
        }
      }, 10000);
    }
    $('.users-search', body).addEventListener('input', (e) => { query = e.target.value.trim().toLowerCase(); draw(); });
    $$('[data-filter]', body).forEach((b) => b.addEventListener('click', () => {
      filter = b.dataset.filter;
      store.set('ef.usersFilter', filter);
      $$('[data-filter]', body).forEach((x) => x.classList.toggle('active', x === b));
      draw();
    }));
  }

  // Device limit choices: 1-10.
  const limitOptions = (cur) => Array.from({ length: 10 }, (_, i) => i + 1)
    .map((n) => `<option value="${n}"${n === cur ? ' selected' : ''}>${n} ${n === 1 ? 'device' : 'devices'}</option>`).join('');
  const expiryFields = (expires) => `
    <label class="admin-field"><span>Expiration date</span>
      <input type="date" data-f="expires" value="${esc(expires || '')}"${expires ? '' : ' disabled'}></label>
    <label class="admin-check"><input type="checkbox" data-f="noexpiry"${expires ? '' : ' checked'}> No expiration</label>`;
  const wireExpiry = (root) => {
    const box = $('[data-f="noexpiry"]', root), date = $('[data-f="expires"]', root);
    box.addEventListener('change', () => {
      date.disabled = box.checked;
      if (!box.checked && !date.value) {
        const d = new Date(Date.now() + 30 * DAY);
        date.value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      }
    });
    return () => (box.checked ? null : (date.value || null));
  };
  // Sets a password without showing or keeping it: clear it, then set the new one.
  async function setUserPassword(userId, pw) {
    await api(`/Users/${userId}/Password`, { method: 'POST', body: { Id: userId, ResetPassword: true } });
    await api(`/Users/${userId}/Password`, { method: 'POST', body: { Id: userId, CurrentPw: '', NewPw: pw } });
  }
  const passwordFields = () => `
    <label class="admin-field"><span>New password</span><input type="password" data-f="pw" autocomplete="new-password"></label>
    <label class="admin-field"><span>Type it again</span><input type="password" data-f="pw2" autocomplete="new-password"></label>`;
  const readPassword = (root) => {
    const a = $('[data-f="pw"]', root), b = $('[data-f="pw2"]', root);
    const v = a.value, w = b.value;
    a.value = ''; b.value = ''; // never left on screen
    if (!v) throw new Error('Enter a password.');
    if (v !== w) throw new Error("The two passwords don't match.");
    return v;
  };

  async function adminUserDetail(body, isCurrent, userId) {
    if (!(await embyAdminCheck(body)) || !isCurrent()) return;
    let user, lim = null, devices = [], g = null, guardError = null;
    try {
      user = await api(`/Users/${userId}`);
      devices = await activeDevices(userId).catch(() => []);
    } catch (e) { if (isCurrent()) body.innerHTML = `<p class="empty-msg">${esc(adminError(e))} <a href="#/admin?tab=users">Back to users</a></p>`; return; }
    if (guardEnabled) { try { g = await guard('/limits'); lim = g.users?.[userId] || null; } catch (e) { guardError = e; } }
    if (!isCurrent()) return;
    const self = userId === state.userId, exempt = exemptFromLimits(user);
    const st = userStatus(user, lim);
    body.innerHTML = `
      <a class="btn btn-gray users-back" href="#/admin?tab=users">‹ All users</a>
      <section class="admin-card">
        <h2>${esc(user.Name)} ${statusPill(st)}${exempt ? ' <span class="pill">Admin</span>' : ''}${self ? ' <span class="pill">You</span>' : ''}</h2>
        <p class="muted">Last active ${user.LastActivityDate ? esc(timeAgo(user.LastActivityDate)) : 'never'}${exempt ? ' · Admin accounts have no device limit or expiration.' : ''}</p>
        ${!guardEnabled ? '<p class="muted">Device limits and expiration are switched off (Aurora Guard is disabled).</p>' : guardError ? `<p class="live-result bad">Device limit and expiration can't be changed: Aurora Guard isn't answering (${esc(guardError.message)}).</p>` : `
        <label class="admin-field"><span>Device limit</span><select data-f="limit">${limitOptions(Number(lim?.limit) || g?.defaultLimit || DEFAULT_DEVICE_LIMIT)}</select></label>
        ${expiryFields(lim?.expires)}
        <div class="m-actions"><button class="btn btn-red" data-save-limits>Save</button></div>
        <p class="muted">Saved in Aurora Guard and applied straight away: an account past its date is switched off in Emby, and extending the date switches it back on.</p>
        <div class="live-result" data-limits-result></div>`}
      </section>
      <section class="admin-card">
        <h2>Devices in use <small>active in the last ${ACTIVE_WINDOW / 60000} minutes</small></h2>
        <div class="admin-list">${devices.map((d) => `<div class="admin-row">
          <div class="admin-row-main"><strong>${esc(d.name)}</strong>${d.deviceId === state.deviceId ? ' <span class="pill">This device</span>' : ''}${d.playing ? ' <span class="pill live">Playing</span>' : ''}
            <div class="muted">${esc([d.client, d.version].filter(Boolean).join(' '))}${d.title ? ' · ' + esc(d.title) : ''} · ${esc(timeAgo(new Date(d.at)))}</div></div>
          ${d.deviceId === state.deviceId ? '' : `<button class="btn btn-gray" data-signout="${esc(d.deviceId)}" data-session="${esc(d.sessionId)}" data-name="${esc(d.name)}">Sign out device</button>`}
        </div>`).join('') || '<p class="muted">No devices in use right now.</p>'}</div>
      </section>
      <section class="admin-card">
        <h2>Account</h2>
        <div class="m-actions">
          ${self ? '<p class="muted">You can\'t disable or delete your own account.</p>' : `
          <button class="btn btn-gray" data-toggle>${user.Policy?.IsDisabled ? 'Enable account' : 'Disable account'}</button>
          <button class="btn btn-gray" data-delete>Delete user</button>`}
        </div>
        <h3 class="users-sub">Reset password</h3>
        ${passwordFields()}
        <div class="m-actions"><button class="btn btn-gray" data-reset-pw>Set new password</button></div>
        <div class="live-result" data-account-result></div>
      </section>`;
    const getExpiry = !guardEnabled || guardError ? null : wireExpiry(body);
    const say = (sel, html, cls = '') => { const el = $(sel, body); el.className = 'live-result' + (cls ? ' ' + cls : ''); el.innerHTML = html; };
    const reload = () => { if (isCurrent()) adminUserDetail(body, isCurrent, userId); };

    $('[data-save-limits]', body)?.addEventListener('click', async () => {
      const next = { limit: Number($('[data-f="limit"]', body).value), expires: getExpiry() };
      if (isExpired(next) && !user.Policy?.IsDisabled && !self && !exempt
        && !(await confirmAction('Disable this account?', `That date has passed, so ${user.Name}'s account will be switched off in Emby.`, 'Save and disable'))) return;
      say('[data-limits-result]', '<div class="spinner"></div>');
      try {
        const r = await guard(`/limits/${userId}`, { method: 'PUT', body: next });
        const was = !!user.Policy?.IsDisabled;
        const note = !r.applied ? ' It will be applied at the guard\'s next check.'
          : r.disabled && !was ? ' The date has passed, so the account is now disabled.'
            : !r.disabled && was ? ' The account is enabled again.' : '';
        say('[data-limits-result]', 'Saved.' + note, 'good');
        setTimeout(reload, 1200);
      } catch (e) { say('[data-limits-result]', "Couldn't save: " + esc(e.message), 'bad'); }
    });

    $$('[data-signout]', body).forEach((b) => b.addEventListener('click', async () => {
      if (!(await confirmAction('Sign out this device?', `${b.dataset.name} will be signed out of ${user.Name}'s account and has to sign in again. This frees a device slot.`, 'Sign out'))) return;
      try {
        api(`/Sessions/${encodeURIComponent(b.dataset.session)}/Playing/Stop`, { method: 'POST' }).catch(() => {});
        await api('/Devices', { method: 'DELETE', params: { Id: b.dataset.signout } });
        toast(`${b.dataset.name} signed out`, 2500);
        reload();
      } catch (e) { toast("Couldn't sign it out: " + adminError(e)); }
    }));

    $('[data-toggle]', body)?.addEventListener('click', async () => {
      const disabling = !user.Policy?.IsDisabled;
      if (disabling && !(await confirmAction('Disable this account?', `${user.Name} won't be able to sign in or watch anything until the account is enabled again.`, 'Disable'))) return;
      if (!disabling && isExpired(lim)) return say('[data-account-result]', 'This account has expired. Set a later expiration date (or No expiration) above and Save; that enables it again.', 'bad');
      try {
        await setDisabled(userId, disabling);
        // A hand-made choice: the guard no longer switches this account back on by itself.
        await guard(`/limits/${userId}/manual`, { method: 'PUT' }).catch(() => {});
        toast(disabling ? 'Account disabled' : 'Account enabled', 2000);
        reload();
      } catch (e) { say('[data-account-result]', "Couldn't change it: " + esc(adminError(e)), 'bad'); }
    });

    $('[data-delete]', body)?.addEventListener('click', async () => {
      if (!(await confirmAction(`Delete ${user.Name}?`, 'The account, its watch history and its settings are removed from Emby for good. This can\'t be undone.', 'Delete user'))) return;
      try {
        await api(`/Users/${userId}`, { method: 'DELETE' });
        await guard(`/limits/${userId}`, { method: 'DELETE' }).catch(() => {});
        toast(`${user.Name} deleted`, 2500);
        location.hash = '#/admin?tab=users';
      } catch (e) { say('[data-account-result]', "Couldn't delete it: " + esc(adminError(e)), 'bad'); }
    });

    $('[data-reset-pw]', body).addEventListener('click', async () => {
      let pw;
      try { pw = readPassword(body); } catch (e) { return say('[data-account-result]', esc(e.message), 'bad'); }
      if (!(await confirmAction('Set a new password?', `${user.Name}'s current password stops working straight away.`, 'Set password'))) return;
      try {
        await setUserPassword(userId, pw);
        say('[data-account-result]', 'New password set.', 'good');
      } catch (e) { say('[data-account-result]', "Couldn't set it: " + esc(adminError(e)), 'bad'); }
    });
  }

  async function adminUserNew(body, isCurrent) {
    if (!(await embyAdminCheck(body)) || !isCurrent()) return;
    body.innerHTML = `
      <a class="btn btn-gray users-back" href="#/admin?tab=users">‹ All users</a>
      <section class="admin-card">
        <h2>Add user</h2>
        <label class="admin-field"><span>Name (used to sign in)</span><input type="text" data-f="name" autocomplete="off" autocapitalize="none" spellcheck="false"></label>
        ${passwordFields()}
        ${guardEnabled ? `<label class="admin-field"><span>Device limit</span><select data-f="limit">${limitOptions(DEFAULT_DEVICE_LIMIT)}</select></label>
        ${expiryFields(null)}` : ''}
        <div class="m-actions"><button class="btn btn-red" data-create>Create user</button></div>
        <div class="live-result" data-result></div>
      </section>`;
    const getExpiry = guardEnabled ? wireExpiry(body) : null;
    const result = $('[data-result]', body);
    const say = (html, cls = '') => { result.className = 'live-result' + (cls ? ' ' + cls : ''); result.innerHTML = html; };
    $('[data-create]', body).addEventListener('click', async () => {
      const name = $('[data-f="name"]', body).value.trim();
      if (!name) return say('Enter a name.', 'bad');
      let pw;
      try { pw = readPassword(body); } catch (e) { return say(esc(e.message), 'bad'); }
      say('<div class="spinner"></div> Creating the account…');
      let user;
      try {
        user = await api('/Users/New', { method: 'POST', body: { Name: name } });
        if (!user?.Id) throw new Error('Emby did not return the new account');
      } catch (e) { return say("Couldn't create it: " + esc(adminError(e)) + (e.status === 400 ? ' (is the name already taken?)' : ''), 'bad'); }
      const problems = [];
      try { await setUserPassword(user.Id, pw); } catch (e) { problems.push('the password (' + adminError(e) + ')'); }
      if (guardEnabled) {
        try { await guard(`/limits/${user.Id}`, { method: 'PUT', body: { limit: Number($('[data-f="limit"]', body).value), expires: getExpiry() } }); } catch (e) { problems.push(`the device limit and expiration (Aurora Guard: ${e.message})`); }
      }
      // The settings saved "for everyone" (Live TV, Requests, the update lock) only reached accounts that existed then.
      try { if (iptv.config) await writeIptvConfigFor(user.Id, iptv.config); } catch { problems.push('the Live TV settings'); }
      for (const id of [REQ_PREFS.id, APP_PREFS, PLAYBACK_PREFS]) {
        try { const v = await readAuroraPref(id); if (v) await writeAuroraPref(id, user.Id, v); } catch { /* not set */ }
      }
      if (problems.length) {
        say(`Created ${esc(name)}, but couldn't set ${esc(problems.join(', '))}. Open the account to try again.`, 'bad');
        setTimeout(() => { if (isCurrent()) location.hash = `#/admin?tab=users&user=${user.Id}`; }, 3000);
      } else {
        toast(`${name} created`, 2500);
        location.hash = `#/admin?tab=users&user=${user.Id}`;
      }
    });
  }

  async function auroraReleaseCodes() {
    try {
      const res = await fetch(RELEASES_URL, { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store', signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      return (await res.json()).filter((r) => !r.draft && !r.prerelease && /^aurora-v/.test(r.tag_name || ''))
        .map((r) => Number(r.tag_name.match(/(\d+)$/)?.[1] || 0)).filter(Boolean).sort((a, b) => b - a);
    } catch { return null; }
  }

  async function adminUpdates(body, isCurrent) {
    const [cfg, devices, codes] = await Promise.all([
      readAuroraPref(APP_PREFS).catch(() => null), api('/Devices').catch((e) => ({ error: e })), auroraReleaseCodes(),
    ]);
    if (!isCurrent()) return;
    const fromAdmin = cfg && Number.isFinite(Number(cfg.forceUpdateAfter));
    const current = fromAdmin ? Number(cfg.forceUpdateAfter) : forceUpdateAfter;
    const latest = codes?.[0] || 0;
    const behindBy = (code) => (codes ? codes.filter((c) => c > code).length : 0);
    const aurora = (devices?.error ? [] : (devices.Items || devices || []))
      .filter((d) => /aurora|embyflix/i.test(d.AppName || '') && Date.now() - new Date(d.DateLastActivity).getTime() < 30 * DAY)
      .map((d) => ({ d, code: auroraVersionCode(d.AppVersion) }))
      .filter((x) => x.code && latest && x.code < latest)
      .sort((a, b) => a.code - b.code);
    const choices = [[0, 'Off: never lock'], [1, '1 update behind'], [2, '2 updates behind'], [3, '3 updates behind'], [5, '5 updates behind'], [10, '10 updates behind']];
    if (!choices.some(([v]) => v === current)) choices.push([current, `${current} updates behind`]);
    const row = ({ d, code }) => {
      const n = behindBy(code), tooOld = code < 139, locked = !tooOld && current && n >= current;
      return `<div class="admin-row" tabindex="-1">
        <div class="admin-row-main"><strong>${esc(d.Name || 'Device')}</strong> · ${esc(d.LastUserName || '')}
          <div class="muted">Aurora ${esc(d.AppVersion || '')} · ${n} ${n === 1 ? 'update' : 'updates'} behind
          ${tooOld ? ' <span class="pill warn">Too old to lock: needs updating by hand</span>' : locked ? ' <span class="pill bad">Locked until updated</span>' : current && n === current - 1 ? ' <span class="pill warn">Locks at the next update</span>' : ''}</div></div>
        <div class="admin-row-time">${esc(timeAgo(d.DateLastActivity))}</div></div>`;
    };
    body.innerHTML = `
      <section class="admin-card">
        <h2>Required updates</h2>
        <p class="muted">Aurora stops working on a device that falls this many updates behind, until it's updated (the update screen can't be dismissed).
          Changes reach every device the next time it opens Aurora or checks for updates, and locked devices unlock by themselves.
          Only Aurora 1.2.139 and newer can be locked.</p>
        <dl class="admin-dl"><dt>In use now</dt><dd>${current ? `Lock at ${current} ${current === 1 ? 'update' : 'updates'} behind` : 'Off'}
          <span class="pill">${fromAdmin ? 'set here' : 'from the app settings file'}</span></dd></dl>
        <label class="admin-field"><span>Lock the app when it is</span>
          <select data-lock>${choices.map(([v, l]) => `<option value="${v}"${v === current ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
        <div class="m-actions">
          <button class="btn btn-red" data-save>Save for everyone</button>
          ${fromAdmin ? '<button class="btn btn-gray" data-reset>Use the settings file instead</button>' : ''}
        </div>
        <div class="live-result" data-result></div>
      </section>
      <section class="admin-card">
        <h2>Devices behind <small>used in the last 30 days${latest ? ` · latest is 1.2.${latest}` : ''}</small></h2>
        ${codes ? '' : '<p class="muted">Couldn\'t reach GitHub to count releases.</p>'}
        <div class="admin-list">${aurora.map(row).join('') || '<p class="muted">Every device is up to date.</p>'}</div>
      </section>`;
    const result = $('[data-result]', body);
    const say = (html, cls = '') => { result.className = 'live-result' + (cls ? ' ' + cls : ''); result.innerHTML = html; };
    const save = async (value, done) => {
      say('<div class="spinner"></div> Saving for every account…');
      try {
        const r = await writeAuroraPrefForAll(APP_PREFS, value);
        await refreshAppConfig();
        if (!isCurrent()) return;
        say(`${done} Saved for ${r.saved} of ${r.total} accounts${r.failed ? ` (${r.failed} failed; try again)` : ''}.`, r.failed ? 'bad' : 'good');
        setTimeout(() => { if (isCurrent()) adminUpdates(body, isCurrent); }, 1500);
      } catch (e) { say("Couldn't save: " + esc(adminError(e)), 'bad'); }
    };
    $('[data-save]', body).addEventListener('click', () => {
      const n = Number($('[data-lock]', body).value);
      save({ forceUpdateAfter: n, t: Date.now() }, n ? `The app now locks at ${n} ${n === 1 ? 'update' : 'updates'} behind.` : 'The update lock is off.');
    });
    $('[data-reset]', body)?.addEventListener('click', () => save(null, 'Using the settings file again.'));
  }


  // ----- Admin → Channel reports: the provider's API key, and what customers reported -----
  async function adminReports(body, isCurrent) {
    if (!guardEnabled) {
      body.innerHTML = '<section class="admin-card"><h2>Channel reports</h2><p class="muted">Aurora Guard is switched off, and it is what keeps the provider key and the reports. Switch it on (see server/README.md), then come back.</p></section>';
      return;
    }
    let prov, rep;
    try { [prov, rep] = await Promise.all([guard('/provider'), guard('/reports')]); } catch (e) {
      body.innerHTML = `<section class="admin-card"><h2>Channel reports</h2><p class="empty-msg">Couldn't reach Aurora Guard: ${esc(e.message)}. Channel reports need guard version 1.1.0 or newer on the server PC.</p></section>`;
      return;
    }
    if (!isCurrent()) return;
    const sel = (id, label, options, value) => `<label class="admin-field"><span>${esc(label)}</span><select data-pv="${id}">${options.map(([v, l]) => `<option value="${esc(v)}"${v === value ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select></label>`;
    const chRow = (c) => `<div class="admin-row" tabindex="-1"><div class="admin-row-main"><strong>${esc(c.channel)}</strong>
      <div class="muted">${esc(Object.entries(c.reasons).map(([k, v]) => `${k} ×${v}`).join(' · '))} · ${c.users} ${c.users === 1 ? 'customer' : 'customers'}</div></div>
      <div class="admin-row-time">${c.count} ${c.count === 1 ? 'report' : 'reports'} · ${esc(timeAgo(c.last))}</div></div>`;
    const recRow = (r) => `<div class="admin-row" tabindex="-1"><div class="admin-row-main"><strong>${esc(r.channel)}</strong> · ${esc(r.reason)}${r.auto ? ' <span class="pill">automatic</span>' : ''}
      <div class="muted">${esc(r.user)} · ${esc(r.device)}${r.note ? ' · ' + esc(r.note) : ''} · ${r.forwarded === 'sent' ? 'sent to the provider' : r.forwarded === 'failed' ? '<span class="pill bad">the provider did not accept it</span>' : 'kept here only'}</div></div>
      <div class="admin-row-time">${esc(timeAgo(r.at))}</div></div>`;
    body.innerHTML = `
      <section class="admin-card">
        <h2>TV provider reporting</h2>
        <p class="muted">When a customer reports a channel (long-press it, or press Menu on the remote), or a channel keeps buffering, Aurora can pass the report to your TV provider's system. The API key is typed here once and kept only on the server PC (Aurora Guard): it is never sent to phones or TVs, and it is never shown again, only its last 4 characters.</p>
        <label class="admin-check"><input type="checkbox" data-pv="enabled"${prov.enabled ? ' checked' : ''}> Send reports to the provider</label>
        <label class="admin-field"><span>Provider address (web address for reports)</span>
          <input type="url" data-pv="url" value="${esc(prov.url)}" placeholder="https://provider.example.com/api/report" autocomplete="off"></label>
        ${sel('method', 'Send as', [['POST', 'POST (with a body)'], ['GET', 'GET (details in the address)']], prov.method)}
        ${sel('keyIn', 'The key goes in', [['header', 'A header'], ['bearer', 'Authorization: Bearer'], ['query', 'The address (?name=key)']], prov.keyIn)}
        <label class="admin-field"><span>Name of the header or address field</span>
          <input type="text" data-pv="keyName" value="${esc(prov.keyName)}" placeholder="X-API-Key" autocomplete="off"></label>
        <label class="admin-field"><span>API key ${prov.keySet ? `<span class="pill">set · ends …${esc(prov.keyLast4)}</span>` : '<span class="pill warn">not set</span>'}</span>
          <input type="password" data-pv="key" value="" placeholder="${prov.keySet ? 'Leave empty to keep the current key' : 'Paste the key here'}" autocomplete="new-password"></label>
        <details><summary>Body of the report (advanced)</summary>
          <p class="muted">For POST. JSON with these pieces filled in: {{channel}} {{channelId}} {{reason}} {{note}} {{device}} {{user}} {{group}} {{time}}. For GET, put them in the address instead, like ?ch={{channelId}}. Leave empty for the standard layout.</p>
          <textarea data-pv="body" rows="6" placeholder="${esc(prov.defaultBody)}" spellcheck="false">${esc(prov.body)}</textarea></details>
        <div class="m-actions">
          <button class="btn btn-red" data-save>Save</button>
          <button class="btn btn-gray" data-test>Send a test report</button>
          ${prov.keySet ? '<button class="btn btn-gray" data-removekey>Remove the key</button>' : ''}
        </div>
        <div class="live-result" data-result></div>
      </section>
      <section class="admin-card">
        <h2>Reported channels <small>${rep.total} ${rep.total === 1 ? 'report' : 'reports'} kept</small></h2>
        <div class="admin-list">${rep.channels.map(chRow).join('') || '<p class="muted">No reports yet.</p>'}</div>
        ${rep.total ? '<div class="m-actions"><button class="btn btn-gray" data-clear>Clear the list</button></div>' : ''}
      </section>
      <section class="admin-card">
        <h2>Latest reports</h2>
        <div class="admin-list">${rep.reports.slice(0, 30).map(recRow).join('') || '<p class="muted">Nothing yet.</p>'}</div>
      </section>`;
    const result = $('[data-result]', body);
    const say = (html, cls = '') => { result.className = 'live-result' + (cls ? ' ' + cls : ''); result.innerHTML = html; };
    const val = (id) => $(`[data-pv="${id}"]`, body);
    const reload = () => setTimeout(() => { if (isCurrent()) adminReports(body, isCurrent); }, 1200);
    $('[data-save]', body).addEventListener('click', async () => {
      say('<div class="spinner"></div> Saving…');
      try {
        const payload = { enabled: val('enabled').checked, url: val('url').value.trim(), method: val('method').value, keyIn: val('keyIn').value, keyName: val('keyName').value.trim(), body: val('body').value };
        const key = val('key').value.trim();
        if (key) payload.key = key;
        await guard('/provider', { method: 'PUT', body: payload });
        val('key').value = '';
        say(key ? 'Saved, with the new key.' : 'Saved.', 'good');
        reload();
      } catch (e) { say("Couldn't save: " + esc(e.message), 'bad'); }
    });
    $('[data-test]', body).addEventListener('click', async () => {
      say('<div class="spinner"></div> Sending a test report… (save first if you changed anything)');
      try {
        const r = await guard('/provider/test', { method: 'POST' });
        say(r.ok ? `The provider accepted it (status ${esc(r.status)}). ${esc(r.text || '')}` : `The provider did not accept it${r.status ? ` (status ${esc(r.status)})` : ''}: ${esc(r.text || '')}`, r.ok ? 'good' : 'bad');
      } catch (e) { say("Couldn't send: " + esc(e.message), 'bad'); }
    });
    $('[data-removekey]', body)?.addEventListener('click', async () => {
      if (!await confirmAction('Remove the provider key?', 'Reports will stop going to the provider until you enter a key again.', 'Remove key')) { adminReports(body, isCurrent); return; }
      try { await guard('/provider/key', { method: 'DELETE' }); toast('Key removed', 2000); } catch (e) { toast("Couldn't remove it: " + e.message); }
      adminReports(body, isCurrent);
    });
    $('[data-clear]', body)?.addEventListener('click', async () => {
      try { await guard('/reports', { method: 'DELETE' }); } catch (e) { say("Couldn't clear: " + esc(e.message), 'bad'); return; }
      adminReports(body, isCurrent);
    });
  }

  // ----- Admin → Playback: settings for every customer -----
  // Stored in each account's "aurora-playback" display preferences (the same way as the update lock) and read at
  // sign-in. A value set here replaces the viewer's own choice in Settings; "Customer's choice" leaves it to them.
  async function adminPlayback(body, isCurrent) {
    const cfg = (await readAuroraPref(PLAYBACK_PREFS).catch(() => null)) || {};
    if (!isCurrent()) return;
    const sel = (id, label, help, options, value) => `<label class="admin-field"><span>${esc(label)}</span>
      <select data-pb="${id}">${options.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(value ?? '') ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <small class="muted">${esc(help)}</small></label>`;
    body.innerHTML = `
      <section class="admin-card">
        <h2>Playback for everyone</h2>
        <p class="muted"><strong>These apply on phones and TVs.</strong> What you choose here replaces the customer's own choice in Settings (the setting is greyed out for them).
          "Customer's choice" leaves it to them. It reaches each device the next time Aurora opens or checks for updates.
          Aurora plays Live TV straight from your provider, and Emby converts movies and shows, so these are the settings that matter for smoothness.</p>
        ${sel('liveBuffer', 'Live TV buffer', 'How much of a channel loads before it plays, in the Android app and TV app. Large rides out slow internet and bursts best; Small changes channel fastest.',
          [['', "Customer's choice"], ['small', 'Small (fastest channel changes)'], ['medium', 'Medium (recommended)'], ['large', 'Large (smoothest)']], cfg.liveBuffer)}
        ${sel('maxQuality', 'Streaming quality limit', 'The highest quality movies and shows may use, whatever the customer picks. Lowering it saves your server and upload bandwidth.',
          [[0, 'No limit'], ...QUALITY_OPTIONS.slice(1).map((q) => [q.bitrate, q.label])], Number(cfg.maxQuality) || 0)}
        ${sel('stallSeconds', 'Reconnect a stalled stream after', 'If a movie, show or channel sits buffering this long without recovering, the player reconnects at the same spot. Shorter recovers faster from a dead connection but may cut in on a slow one. Normal is 30 seconds for movies and shows, 25 for Live TV.',
          [[0, 'Normal'], [10, '10 seconds'], [15, '15 seconds'], [20, '20 seconds'], [30, '30 seconds'], [45, '45 seconds'], [60, '60 seconds']], Number(cfg.stallSeconds) || 0)}
        ${sel('appLock', 'Lock Aurora with the phone\'s PIN or fingerprint', "Phones only (never on TVs). With 'Required', Aurora asks for the phone's screen lock when it opens and after a minute away. Phones with no screen lock set are not affected.",
          [['', "Customer's choice"], ['on', 'Required']], cfg.appLock)}
        ${sel('player', 'Video player', "Aurora player plays most files as they are with no converting (smoothest). Basic is the older player; use it for everyone only if the Aurora player has a problem.",
          [['', "Customer's choice"], ['aurora', 'Aurora player (smoothest)'], ['web', 'Basic']], cfg.player)}
        <div class="m-actions">
          <button class="btn btn-red" data-save>Save for everyone</button>
          <button class="btn btn-gray" data-reset>Back to customer's choice</button>
        </div>
        <div class="live-result" data-result></div>
      </section>`;
    const result = $('[data-result]', body);
    const say = (html, cls = '') => { result.className = 'live-result' + (cls ? ' ' + cls : ''); result.innerHTML = html; };
    const save = async (value, done) => {
      say('<div class="spinner"></div> Saving for every account…');
      try {
        const r = await writeAuroraPrefForAll(PLAYBACK_PREFS, value);
        await refreshAppConfig();
        if (!isCurrent()) return;
        say(`${done} Saved for ${r.saved} of ${r.total} accounts${r.failed ? ` (${r.failed} failed; try again)` : ''}.`, r.failed ? 'bad' : 'good');
        setTimeout(() => { if (isCurrent()) adminPlayback(body, isCurrent); }, 1500);
      } catch (e) { say("Couldn't save: " + esc(adminError(e)), 'bad'); }
    };
    const pick = (id) => $(`[data-pb="${id}"]`, body).value;
    $('[data-save]', body).addEventListener('click', () => {
      const value = { liveBuffer: pick('liveBuffer'), maxQuality: Number(pick('maxQuality')) || 0, stallSeconds: Number(pick('stallSeconds')) || 0, appLock: pick('appLock'), player: pick('player'), t: Date.now() };
      save(value, 'Playback settings saved.');
    });
    $('[data-reset]', body).addEventListener('click', () => save(null, 'Customers choose again.'));
  }

  async function adminDevices(body, isCurrent) {
    const [devices, users, release] = await Promise.all([
      api('/Devices').catch((e) => ({ error: e })), api('/Users').catch((e) => ({ error: e })), latestAuroraRelease(),
    ]);
    if (!isCurrent()) return;
    if (devices?.error) { body.innerHTML = `<p class="empty-msg">${esc(adminError(devices.error))}</p>`; return; }
    const all = (devices.Items || devices || []).slice().sort((a, b) => new Date(b.DateLastActivity) - new Date(a.DateLastActivity));
    const isAurora = (d) => /aurora|embyflix/i.test(d.AppName || '');
    const aurora = all.filter(isAurora);
    const versions = new Map();
    aurora.forEach((d) => versions.set(d.AppVersion || '?', (versions.get(d.AppVersion || '?') || 0) + 1));
    const deviceRow = (d) => {
      const code = auroraVersionCode(d.AppVersion);
      const behind = isAurora(d) && release?.code && code && code < release.code;
      return `<div class="admin-row" tabindex="-1">
        <div class="admin-row-main"><strong>${esc(d.Name || 'Device')}</strong> · ${esc(d.LastUserName || '')}
          <div class="muted">${esc(d.AppName || '')} ${esc(d.AppVersion || '')}${behind ? ' <span class="pill warn">Needs update</span>' : ''}</div></div>
        <div class="admin-row-time">${esc(timeAgo(d.DateLastActivity))}</div>
      </div>`;
    };
    const userList = users?.error ? [] : (users || []).slice().sort((a, b) => new Date(b.LastActivityDate || 0) - new Date(a.LastActivityDate || 0));
    body.innerHTML = `
      <section class="admin-card">
        <h2>Aurora versions in use</h2>
        ${versions.size ? `<div class="chip-row static">${[...versions.entries()].sort().reverse().map(([v, c]) => `<span class="chip${release && auroraVersionCode(v) >= release.code ? ' active' : ''}">${esc(v)} · ${c} device${c === 1 ? '' : 's'}</span>`).join('')}</div>` : '<p class="muted">No Aurora devices yet.</p>'}
        ${release ? `<p class="muted">Latest is ${esc(release.name)}. Older copies are offered the update when they open.</p>` : ''}
      </section>
      <div class="admin-cols">
        <section class="admin-card">
          <h2>Devices <small>${all.length}</small></h2>
          <div class="admin-list">${all.map(deviceRow).join('') || '<p class="muted">No devices.</p>'}</div>
        </section>
        <section class="admin-card">
          <h2>Users <small>${userList.length}</small></h2>
          <div class="admin-list">${userList.map((u) => `<div class="admin-row" tabindex="-1">
            <div class="admin-row-main"><strong>${esc(u.Name)}</strong>${u.Policy?.IsAdministrator ? ' <span class="pill">Admin</span>' : ''}${u.Policy?.IsDisabled ? ' <span class="pill bad">Disabled</span>' : ''}
              <div class="muted">${u.LastLoginDate ? 'Last signed in ' + esc(timeAgo(u.LastLoginDate)) : 'Never signed in'}</div></div>
            <div class="admin-row-time">${u.LastActivityDate ? 'Active ' + esc(timeAgo(u.LastActivityDate)) : ''}</div>
          </div>`).join('') || `<p class="muted">${users?.error ? esc(adminError(users.error)) : 'No users.'}</p>`}</div>
        </section>
      </div>`;
  }

  async function adminLogs(body, isCurrent) {
    let files;
    try {
      const res = await api('/System/Logs/Query').catch(() => api('/System/Logs'));
      files = (Array.isArray(res) ? res : res?.Items || []).sort((a, b) => new Date(b.DateModified) - new Date(a.DateModified));
    } catch (e) { if (isCurrent()) body.innerHTML = `<p class="empty-msg">${esc(adminError(e))}</p>`; return; }
    if (!isCurrent()) return;
    body.innerHTML = `
      <div class="admin-logs">
        <section class="admin-card log-files">
          <h2>Log files</h2>
          <div class="admin-list">${files.map((f) => `<button class="log-file" data-name="${esc(f.Name)}">
            <span>${esc(f.Name)}</span><span class="muted">${esc(fmtSize(f.Size))} · ${esc(timeAgo(f.DateModified))}</span></button>`).join('') || '<p class="muted">No log files.</p>'}</div>
        </section>
        <section class="admin-card log-view" data-view><p class="muted">Pick a log file to read it.</p></section>
      </div>`;
    const view = $('[data-view]', body);
    $$('.log-file', body).forEach((btn) => btn.addEventListener('click', () => {
      $$('.log-file', body).forEach((b) => b.classList.toggle('active', b === btn));
      showLog(view, btn.dataset.name, isCurrent);
    }));
  }

  const LOG_PAGE = 150;
  async function showLog(view, name, isCurrent) {
    view.innerHTML = `<h2>${esc(name)}</h2><div class="spinner"></div>`;
    let lines;
    try {
      const text = await apiText(`/System/Logs/${encodeURIComponent(name)}`).catch(() => apiText('/System/Logs/Log', { name }));
      lines = text.split(/\r?\n/).filter((l) => l.length);
    } catch (e) { if (isCurrent()) view.innerHTML = `<h2>${esc(name)}</h2><p class="muted">${esc(adminError(e))}</p>`; return; }
    if (!isCurrent()) return;
    let only = 'all', end = lines.length; // newest lines are at the end; show the last page first
    const draw = () => {
      const pool = only === 'problems' ? lines.filter((l) => /\b(error|warn|exception|fatal)\b/i.test(l)) : lines;
      end = Math.min(end, pool.length);
      const startAt = Math.max(0, end - LOG_PAGE);
      view.innerHTML = `
        <h2>${esc(name)} <small>${pool.length} lines</small></h2>
        <div class="log-tools">
          <button class="chip${only === 'all' ? ' active' : ''}" data-only="all">All lines</button>
          <button class="chip${only === 'problems' ? ' active' : ''}" data-only="problems">Errors &amp; warnings</button>
          <span class="osd-spacer"></span>
          <button class="btn btn-gray" data-older ${startAt === 0 ? 'disabled' : ''}>Older</button>
          <button class="btn btn-gray" data-newer ${end >= pool.length ? 'disabled' : ''}>Newer</button>
        </div>
        <pre class="log-text">${pool.slice(startAt, end).map((l) => {
          const cls = /\b(error|exception|fatal)\b/i.test(l) ? 'bad' : /\bwarn/i.test(l) ? 'warn' : '';
          return cls ? `<span class="${cls}">${esc(l)}</span>` : esc(l);
        }).join('\n') || 'Nothing to show.'}</pre>`;
      const pre = $('.log-text', view);
      pre.scrollTop = pre.scrollHeight;
      $$('[data-only]', view).forEach((b) => b.addEventListener('click', () => { only = b.dataset.only; end = Infinity; draw(); focusEl($(`[data-only="${only}"]`, view)); }));
      $('[data-older]', view).addEventListener('click', () => { end = Math.max(LOG_PAGE, startAt); draw(); focusEl($('[data-older]:not([disabled])', view) || $('[data-newer]', view)); });
      $('[data-newer]', view).addEventListener('click', () => { end += LOG_PAGE; draw(); focusEl($('[data-newer]:not([disabled])', view) || $('[data-older]', view)); });
    };
    draw();
  }

  function adminAppLog(body) {
    const entries = appLog.read().slice().reverse();
    body.innerHTML = `
      <section class="admin-card">
        <h2>App log <small>Aurora on this device · ${esc(nativeApp?.getVersionName ? 'Aurora ' + nativeApp.getVersionName() : 'web')}</small></h2>
        <p class="muted">Errors and events Aurora recorded on this device: playback problems, failed requests, updates and crashes. Each device keeps its own.</p>
        <div class="log-tools"><span class="osd-spacer"></span><button class="btn btn-gray" data-clear-log>Clear</button></div>
        <div class="admin-list">${entries.map((e) => `<div class="admin-row" tabindex="-1">
          <div class="admin-row-main">${e.level === 'error' ? '<span class="pill bad">Error</span> ' : e.level === 'warn' ? '<span class="pill warn">Warning</span> ' : ''}${esc(e.msg)}</div>
          <div class="admin-row-time">${esc(fmtDateTime(e.t))}</div></div>`).join('') || '<p class="muted">Nothing recorded yet.</p>'}</div>
      </section>`;
    $('[data-clear-log]', body).addEventListener('click', () => { appLog.clear(); adminAppLog(body); toast('App log cleared', 1500); });
  }

  // ---------- App updates (Android app only) ----------
  // Customers install the APK by hand, so the app checks GitHub Releases for a newer build itself.
  // Recent releases, so the update prompt can list what changed in every version the person missed.
  const RELEASES_URL = 'https://api.github.com/repos/johnny4091-allstar/johnny4091-allstar/releases?per_page=30';
  const RECHECK_AFTER = 15 * 60000; // when coming back to the app
  const updates = { checking: null, lastCheck: 0, dismissedCode: 0, waiting: null };
  // How many releases behind before the app stops working until it's updated. Set by forceUpdateAfter in
  // aurora-config.json (0 turns it off), so it can change without a new APK.
  let forceUpdateAfter = Number(store.get('ef.forceUpdateAfter') ?? 3);
  if (!Number.isFinite(forceUpdateAfter)) forceUpdateAfter = 3;

  // The build puts the lines of aurora/whats-new.md between these markers in each release's notes.
  function releaseNotes(body) {
    const m = (body || '').match(/<!-- notes -->([\s\S]*?)<!-- \/notes -->/);
    if (!m) return [];
    // A line ending in two invisible characters is only for copies older than 1.2.166, which have the old signing key
    // and need telling to reinstall. Newer copies don't show it (older ones just see it as a normal line).
    const OLD_KEY_NOTE = '\u200b\u200c', oldKeyCopy = (nativeApp?.getVersionCode?.() || 999) < 166;
    return m[1].split('\n').map((l) => l.trim()).filter((l) => /^[-*] /.test(l))
      .filter((l) => oldKeyCopy || !l.endsWith(OLD_KEY_NOTE))
      .map((l) => brand(l.slice(2).replace(OLD_KEY_NOTE, '').trim())).filter(Boolean);
  }

  async function checkForUpdate() {
    if (!nativeApp?.getVersionCode) return { status: 'web' };
    try {
      // Always ask GitHub fresh, and give up after 8 seconds rather than hanging on a slow connection.
      const res = await fetch(RELEASES_URL, {
        headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store', signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(res.status);
      const installed = nativeApp.getVersionCode();
      const newer = (await res.json())
        .filter((rel) => !rel.draft && !rel.prerelease && /^aurora-v/.test(rel.tag_name || ''))
        .map((rel) => ({ rel, code: Number(rel.tag_name.match(/(\d+)$/)?.[1] || 0) }))
        .filter((r) => r.code > installed)
        .sort((a, b) => b.code - a.code);
      const latest = newer[0];
      const apk = latest && (latest.rel.assets || []).find((a) => /\.apk$/i.test(a.name));
      if (!apk) return { status: 'current' };
      // Newest first, without repeating a line that appears in more than one version.
      const notes = [...new Set(newer.flatMap((r) => releaseNotes(r.rel.body)))].slice(0, 12);
      return { status: 'available', code: latest.code, version: latest.rel.name || latest.rel.tag_name, url: apk.browser_download_url, notes, behind: newer.length };
    } catch {
      return { status: 'error' };
    }
  }

  // Runs as soon as the app opens, and again when it comes back to the front after a while.
  async function autoCheckForUpdate() {
    if (!nativeApp?.getVersionCode || updates.checking) return;
    updates.lastCheck = Date.now();
    await refreshAppConfig();
    if (updates.checking) return;
    updates.checking = checkForUpdate();
    const result = await updates.checking;
    updates.checking = null;
    // Remember how far behind this device is, so the lock still applies when GitHub can't be reached.
    if (result.status === 'available') store.set('ef.updateBehind', JSON.stringify(result));
    else if (result.status === 'current') store.del('ef.updateBehind');
    if (applyRequiredUpdate()) return;
    if (result.status !== 'available' || result.code === updates.dismissedCode) return;
    if (!$('#modal').classList.contains('hidden') && $('#modal .update-body')) return; // already asking
    // Don't interrupt a video; ask as soon as the player closes.
    if (isPlayerOpen()) { updates.waiting = result; return; }
    showUpdatePrompt(result);
  }

  // Too many releases behind: lock the app behind the update prompt. Returns true if it did.
  function applyRequiredUpdate() {
    if (!nativeApp?.getVersionCode) return false;
    let u = null;
    try { u = JSON.parse(store.get('ef.updateBehind') || 'null'); } catch { /* none */ }
    const locked = !!forceUpdateAfter && !!u && u.code > nativeApp.getVersionCode() && (u.behind || 0) >= forceUpdateAfter;
    if (!locked) {
      // The limit was raised or turned off since the lock went up: let the viewer back in.
      if (updateRequiredOpen()) {
        $('#modal-content .update-body').classList.remove('required');
        $('#modal').classList.remove('update-required');
        closeModal();
      }
      return false;
    }
    if (updateRequiredOpen()) return true;
    if (isPlayerOpen()) closePlayer();
    showUpdatePrompt(u, { required: true });
    return true;
  }

  function showWaitingUpdate() {
    const result = updates.waiting;
    updates.waiting = null;
    if (result && result.code !== updates.dismissedCode && !($('#modal .update-body') && !$('#modal').classList.contains('hidden'))) showUpdatePrompt(result);
  }

  function showUpdatePrompt(update, { required = false } = {}) {
    const modal = $('#modal'), content = $('#modal-content');
    modalToken++;
    if (modal.classList.contains('hidden')) rememberFocus('modal');
    modal.classList.toggle('update-required', required);
    content.innerHTML = `
      <div class="m-body update-body${required ? ' required' : ''}">
        <h2>${required ? 'Update required' : 'Update available'}</h2>
        <p class="overview">${required
          ? `This version of Aurora is ${update.behind} updates behind and has stopped working. Install ${esc(update.version)} to keep watching. It keeps you signed in.`
          : `${esc(update.version)} is ready to install. It keeps you signed in.`}</p>
        ${update.notes?.length ? `<h3 class="update-notes-title">What's new</h3>
        <ul class="update-notes">${update.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
        <div class="update-progress hidden"><div class="update-bar"><span></span></div><p class="update-msg"></p></div>
        <div class="m-actions update-actions">
          <button class="btn btn-red" data-act="install" data-autofocus>Update now</button>
          ${required ? '' : '<button class="btn btn-gray" data-act="later">Later</button>'}
        </div>
      </div>`;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    const msg = $('.update-msg', content), bar = $('.update-bar span', content), progress = $('.update-progress', content);
    // "Later" skips this version until the app is next opened.
    $('[data-act="later"]', content)?.addEventListener('click', () => {
      updates.dismissedCode = update.code;
      closeModal();
    });
    $('[data-act="install"]', content).addEventListener('click', (e) => {
      e.target.disabled = true;
      progress.classList.remove('hidden');
      msg.textContent = 'Downloading…';
      appLog.add('info', `Installing update ${update.version}`);
      nativeApp.installUpdate(update.url);
    });
    // Progress and results reported by the Android app.
    window.auroraUpdate = (u) => {
      if (u.state === 'progress') { bar.style.width = u.pct + '%'; msg.textContent = `Downloading… ${u.pct}%`; }
      else if (u.state === 'permission') msg.textContent = 'Allow Aurora to install apps in the screen that just opened, then come back. The update continues by itself.';
      else if (u.state === 'installing') {
        bar.style.width = '100%';
        msg.textContent = 'Opening the installer… choose Install (or Update).';
        // Some TV boxes don't show the installer the first time: offer another way after a few seconds.
        clearTimeout(retryTimer);
        if (nativeApp?.openInstaller) retryTimer = setTimeout(showRetry, 8000);
      } else if (u.state === 'cancelled') {
        clearTimeout(retryTimer);
        msg.textContent = 'The update was cancelled. Press Update now to try again.';
        $('[data-act="install"]', content).disabled = false;
      } else if (u.state === 'error') {
        clearTimeout(retryTimer);
        appLog.add('error', `Update failed: ${u.message || 'unknown error'}`);
        msg.textContent = /installer/.test(u.message || '')
          ? `The update couldn't be installed (${u.message}). Press Update now to try again.`
          : `The download failed (${u.message || 'unknown error'}). Check the internet connection and try again.`;
        $('[data-act="install"]', content).disabled = false;
      }
    };
    let retryTimer = null;
    const showRetry = () => {
      if (!content.isConnected || $('[data-act="open-installer"]', content)) return;
      msg.textContent = "Didn't see the installer? Press Open installer.";
      const btn = document.createElement('button');
      btn.className = 'btn btn-white';
      btn.dataset.act = 'open-installer';
      btn.textContent = 'Open installer';
      btn.addEventListener('click', () => {
        appLog.add('info', 'Opening the installer again');
        msg.textContent = 'Opening the installer… choose Install (or Update).';
        nativeApp.openInstaller();
      });
      $('.update-actions', content).prepend(btn);
      focusEl(btn);
    };
    autoFocus($('[data-act="install"]', content));
  }

  // ---------- Player ----------
  const QUALITY_OPTIONS = [
    { label: 'Auto (best)', bitrate: 120000000 },
    { label: '1080p (20 Mbps)', bitrate: 20000000 },
    { label: '1080p (10 Mbps)', bitrate: 10000000 },
    { label: '720p (4 Mbps)', bitrate: 4000000 },
    { label: '480p (1.5 Mbps)', bitrate: 1500000 },
    { label: '360p (0.7 Mbps)', bitrate: 720000 },
  ];
  const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2];
  const speedLabel = (r) => (r === 1 ? 'Normal' : `${r}x`);
  const ownBitrate = () => Number(store.get('ef.maxBitrate')) || QUALITY_OPTIONS[0].bitrate;
  const qualityCap = () => (Number(playbackCfg.maxQuality) || 0); // set in Admin → Playback; 0 = no cap
  const maxBitrate = () => (qualityCap() ? Math.min(ownBitrate(), qualityCap()) : ownBitrate());
  // "Auto" stays (it measures, within the cap); fixed choices above the cap are hidden.
  const qualityChoices = () => QUALITY_OPTIONS.filter((q, i) => i === 0 || !qualityCap() || q.bitrate <= qualityCap());
  const shownQuality = () => (autoQuality() || !qualityCap() ? ownBitrate() : Math.min(ownBitrate(), qualityCap()));
  const autoQuality = () => ownBitrate() === QUALITY_OPTIONS[0].bitrate;

  // "Auto" quality: measure the connection to the Emby server (as Emby's own apps do) so a film that's bigger
  // than the connection can carry gets sized down by Emby instead of stopping to buffer every few seconds.
  let measuredBitrate = null;
  // Downloads up to `size` bytes from Emby and returns the speed in bits per second. If the line is too slow to
  // finish in time, the bytes that did arrive still give the speed (a timeout means slow, never "fast").
  async function measureBitrate(size, limitMs = 4500) {
    const started = performance.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), limitMs);
    let bytes = 0;
    try {
      const res = await fetch(apiUrl('/Playback/BitrateTest', { Size: size }), { cache: 'no-store', signal: ctrl.signal });
      if (!res.ok) { const e = new Error('status ' + res.status); e.unavailable = true; throw e; }
      const reader = res.body?.getReader?.();
      if (reader) {
        for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; }
      } else bytes = (await res.arrayBuffer()).byteLength;
    } catch (e) {
      if (e.unavailable) throw e;
      // Timed out or dropped: judge by what arrived (nothing at all counts as very slow).
    } finally {
      clearTimeout(timer);
    }
    return { bps: (bytes * 8) / Math.max(0.05, (performance.now() - started) / 1000), complete: bytes >= size };
  }
  async function playbackBitrate() {
    if (!autoQuality()) return maxBitrate();
    const capped = (v) => (qualityCap() ? Math.min(v, qualityCap()) : v);
    if (measuredBitrate && Date.now() - measuredBitrate.t < 20 * 60000) return capped(measuredBitrate.bps);
    try {
      let r = await measureBitrate(1000000);
      // A quick first test on a fast line mostly measures the delay; a bigger one gives the real speed.
      if (r.complete && r.bps > 10000000) { const r2 = await measureBitrate(6000000); r = { bps: Math.max(r.bps, r2.bps), complete: r2.complete }; }
      const use = Math.round(Math.min(QUALITY_OPTIONS[0].bitrate, Math.max(700000, r.bps * 0.7)));
      // A slow answer is kept only briefly: it may have been a hiccup, and a stricter limit costs picture quality.
      measuredBitrate = { bps: use, t: Date.now() - (r.complete ? 0 : 15 * 60000) };
      appLog.add(r.bps < 4000000 ? 'warn' : 'info', `Connection to the server: ${(r.bps / 1e6).toFixed(1)} Mbps${r.complete ? '' : ' (slow: the test did not finish)'}; streaming up to ${(use / 1e6).toFixed(1)} Mbps`);
      return capped(use);
    } catch (e) {
      // This Emby has no speed test: keep the old behaviour (no limit beyond the Streaming quality setting).
      return maxBitrate();
    }
  }

  // Movies and episodes play in the Android app's own player (ExoPlayer) unless the viewer picked the old one.
  const useNativePlayer = () => !!nativeApp?.playVod && getPref('player') !== 'web';
  let nativeCodecs = null;
  function deviceCodecs() {
    if (nativeCodecs) return nativeCodecs;
    try { nativeCodecs = JSON.parse(nativeApp?.getCodecs?.() || 'null'); } catch { /* use the defaults */ }
    if (!nativeCodecs?.video?.length) nativeCodecs = { video: ['h264'], audio: ['aac', 'mp3'], hevc10: false, maxWidth: 1920 };
    return nativeCodecs;
  }

  // What the native player handles: nearly every film as it is, so Emby just sends the file.
  function nativeDeviceProfile(bitrate) {
    const c = deviceCodecs();
    const video = c.video.filter((v) => ['h264', 'hevc', 'vp9', 'av1', 'vp8', 'mpeg2video', 'mpeg4'].includes(v));
    const audio = c.audio.filter((a) => ['aac', 'mp3', 'ac3', 'eac3', 'opus', 'flac', 'vorbis', 'dts', 'truehd', 'mp2', 'pcm_s16le'].includes(a));
    if (!audio.includes('aac')) audio.unshift('aac');
    if (!audio.includes('mp3')) audio.push('mp3');
    const surround = audio.includes('ac3');
    // When Emby has to convert, it copies the picture if the device takes it and only redoes what's needed.
    const hlsVideo = ['h264', ...(video.includes('hevc') ? ['hevc'] : [])].join(',');
    const hlsAudio = ['aac', ...(surround ? ['ac3'] : []), ...(audio.includes('eac3') ? ['eac3'] : [])].join(',');
    const codecProfiles = [
      { Type: 'Video', Codec: 'h264', Conditions: [{ Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '52', IsRequired: false }] },
      { Type: 'Video', Conditions: [{ Condition: 'LessThanEqual', Property: 'Width', Value: String(c.maxWidth || 1920), IsRequired: false }] },
    ];
    if (video.includes('hevc') && !c.hevc10) {
      codecProfiles.push({ Type: 'Video', Codec: 'hevc', Conditions: [{ Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: false }] });
    }
    const embed = ['srt', 'subrip', 'ass', 'ssa', 'pgssub', 'pgs', 'dvdsub', 'dvbsub', 'vtt', 'webvtt'];
    return {
      Name: 'Aurora (Android)',
      MaxStreamingBitrate: bitrate,
      MaxStaticBitrate: bitrate,
      MusicStreamingTranscodingBitrate: 192000,
      DirectPlayProfiles: [
        { Container: 'mkv,webm,mp4,m4v,mov,ts,m2ts,mpegts,mts', Type: 'Video', VideoCodec: video.join(','), AudioCodec: audio.join(',') },
        { Container: 'mp3,aac,m4a,flac,webma,ogg,opus,wav', Type: 'Audio' },
      ],
      TranscodingProfiles: [
        { Container: 'ts', Type: 'Video', VideoCodec: hlsVideo, AudioCodec: hlsAudio, Context: 'Streaming', Protocol: 'hls',
          MaxAudioChannels: surround ? '6' : '2', MinSegments: '1', BreakOnNonKeyFrames: false },
        { Container: 'mp4', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac', Context: 'Static', Protocol: 'http' },
        { Container: 'mp3', Type: 'Audio', AudioCodec: 'mp3', Context: 'Streaming', Protocol: 'http' },
      ],
      ContainerProfiles: [],
      CodecProfiles: codecProfiles,
      // Subtitles inside the file are shown by the player itself; separate files are fetched alongside.
      SubtitleProfiles: [
        ...embed.map((f) => ({ Format: f, Method: 'Embed' })),
        ...['srt', 'vtt', 'ass', 'ssa'].map((f) => ({ Format: f, Method: 'External' })),
        ...['pgssub', 'dvdsub', 'dvbsub'].map((f) => ({ Format: f, Method: 'Encode' })),
      ],
      ResponseProfiles: [{ Type: 'Video', Container: 'm4v', MimeType: 'video/mp4' }],
    };
  }

  const player = {
    item: null, hls: null, playSessionId: null, mediaSourceId: null, playMethod: null, source: null,
    audioIndex: null, subtitleIndex: -1, forceTranscode: false, speed: 1, intro: null, isLive: false, liveStreamId: null,
    progressTimer: null, idleTimer: null, nextEpisode: null, startSeconds: 0, dragging: false,
    token: 0, // bumped on every playItem so a slower, older request can't take over
    creditsAt: null, upNextTimer: null, upNextShown: false, upNextDismissed: false,
    autoCount: 0, // episodes started automatically in a row with nobody touching the controls
    lastInput: 0, liveIdleTimer: null,
  };

  // Tells Emby what this browser can play directly; anything else is transcoded to HLS H.264/AAC.
  function deviceProfile(bitrate = maxBitrate()) {
    const v = document.createElement('video');
    const can = (t) => !!v.canPlayType(t).replace('no', '');
    const mp4Video = ['h264'];
    if (can('video/mp4; codecs="hvc1.1.6.L93.B0"')) mp4Video.push('hevc');
    if (can('video/mp4; codecs="av01.0.05M.08"')) mp4Video.push('av1');
    const webmVideo = ['vp8', 'vp9'];
    if (can('video/webm; codecs="av01.0.05M.08"')) webmVideo.push('av1');
    const mp4Audio = ['aac', 'mp3'];
    if (can('audio/mp4; codecs="ac-3"')) mp4Audio.push('ac3');
    if (can('audio/mp4; codecs="ec-3"')) mp4Audio.push('eac3');
    if (can('audio/mp4; codecs="flac"')) mp4Audio.push('flac');
    if (can('audio/mp4; codecs="opus"')) mp4Audio.push('opus');

    return {
      Name: 'Aurora',
      MaxStreamingBitrate: bitrate,
      MaxStaticBitrate: bitrate,
      MusicStreamingTranscodingBitrate: 192000,
      DirectPlayProfiles: [
        { Container: 'mp4,m4v', Type: 'Video', VideoCodec: mp4Video.join(','), AudioCodec: mp4Audio.join(',') },
        { Container: 'webm', Type: 'Video', VideoCodec: webmVideo.join(','), AudioCodec: 'vorbis,opus' },
        { Container: 'mp3,aac,m4a,flac,webma,ogg', Type: 'Audio' },
      ],
      TranscodingProfiles: [
        { Container: 'ts', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac,mp3', Context: 'Streaming', Protocol: 'hls', MaxAudioChannels: '2', MinSegments: '1', BreakOnNonKeyFrames: true },
        { Container: 'mp4', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac', Context: 'Static', Protocol: 'http' },
        { Container: 'mp3', Type: 'Audio', AudioCodec: 'mp3', Context: 'Streaming', Protocol: 'http' },
      ],
      ContainerProfiles: [],
      CodecProfiles: [
        { Type: 'Video', Codec: 'h264', Conditions: [{ Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '52', IsRequired: false }] },
      ],
      // Text subtitles are converted to WebVTT and shown by the browser; picture-based ones are burned in.
      SubtitleProfiles: [
        { Format: 'vtt', Method: 'External' },
        { Format: 'pgssub', Method: 'Encode' },
        { Format: 'dvdsub', Method: 'Encode' },
        { Format: 'dvbsub', Method: 'Encode' },
      ],
      ResponseProfiles: [{ Type: 'Video', Container: 'm4v', MimeType: 'video/mp4' }],
    };
  }

  async function resolvePlayable(item) {
    if (item.Type === 'Series' || item.Type === 'Season') {
      const seriesId = item.Type === 'Series' ? item.Id : item.SeriesId;
      const next = await api('/Shows/NextUp', { params: { SeriesId: seriesId, UserId: state.userId, Limit: 1, Fields: ITEM_FIELDS } });
      if (next?.Items?.[0]) return next.Items[0];
      const eps = await api(`/Shows/${seriesId}/Episodes`, { params: { UserId: state.userId, SeasonId: item.Type === 'Season' ? item.Id : undefined, Limit: 1, Fields: ITEM_FIELDS } });
      if (eps?.Items?.[0]) return eps.Items[0];
      throw new Error('No episodes found');
    }
    return item;
  }

  function withApiKey(path) {
    let url = state.server + (path.startsWith('/') ? '' : '/') + path;
    if (!/[?&]api_key=/i.test(url)) url += (url.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(state.apiKey);
    return url;
  }

  // audioIndex / subtitleIndex / forceTranscode are passed when the viewer changes tracks or quality.
  async function playItem(rawItem, opts = {}) {
    // Changing tracks or quality, or the next episode on the same device, isn't a new device starting to play.
    if (opts.audioIndex != null || opts.subtitleIndex != null || opts.forceTranscode || opts.auto) return startPlayItem(rawItem, opts);
    return whenAllowed(() => startPlayItem(rawItem, opts));
  }

  async function startPlayItem(rawItem, { startTicks, audioIndex, subtitleIndex, forceTranscode = false, auto = false, noCap = false } = {}) {
    if (!auto) noteInput();
    const isReload = player.item && rawItem.Id === player.item.Id;
    if (!isReload && $('#player').classList.contains('hidden')) rememberFocus('player');
    const token = ++player.token;
    player.noCap = noCap;
    const stale = () => token !== player.token;
    live.tunedId = rawItem.Type === 'TvChannel' ? rawItem.Id : null;
    await stopPlayback();
    if (stale()) return;
    const el = $('#player'), video = $('#video'), status = $('#player-status');
    el.classList.remove('hidden');
    nativeApp?.setPlayerMode(true);
    status.innerHTML = '<div class="spinner"></div>';
    status.classList.remove('hidden');
    $('#player-next').classList.add('hidden');
    $('#skip-intro').classList.add('hidden');
    hideUpNext();
    hideStillWatching();
    closeTracks();
    document.body.style.overflow = 'hidden';
    updateOsd();
    wakeOsd();
    // The Android app goes full screen natively via setPlayerMode.
    if (!nativeApp && !document.fullscreenElement) { try { await el.requestFullscreen?.(); } catch { /* not allowed, fine */ } }

    try {
      const item = await resolvePlayable(rawItem);
      if (stale()) return;
      const isLive = item.Type === 'TvChannel';
      // Refresh to get accurate resume position, user data and intro markers (or the channel's current program).
      const full = isLive
        ? await api(`/LiveTv/Channels/${item.Id}`, { params: { UserId: state.userId } })
        : await api(userPath(`/Items/${item.Id}`), { params: { Fields: ITEM_FIELDS + ',Chapters' } });
      if (stale()) return;
      player.item = full;
      player.isLive = isLive;
      el.classList.toggle('live', isLive);
      const start = isLive ? 0 : (startTicks ?? full.UserData?.PlaybackPositionTicks ?? 0);
      player.startSeconds = start / TICKS_PER_SECOND;
      player.intro = isLive ? null : findIntro(full.Chapters);
      player.creditsAt = isLive ? null : findCreditsStart(full.Chapters);
      player.upNextShown = false;
      player.upNextDismissed = false;

      $('#player-title').innerHTML = isLive
        ? `${esc(channelLabel(full))}<span class="sub">${esc(full.CurrentProgram?.Name || '')}</span>`
        : full.Type === 'Episode'
          ? `${esc(full.SeriesName)}<span class="sub">${esc(episodeLabel(full))}</span>`
          : esc(full.Name);

      const native = useNativePlayer() && !isLive;
      // noCap: Emby's conversion failed at the measured limit, so this time let the file play as it is (an admin's limit still holds).
      const bitrate = noCap ? (qualityCap() || QUALITY_OPTIONS[0].bitrate) : await playbackBitrate();
      if (stale()) return;
      player.bitrate = bitrate;
      const params = { UserId: state.userId, IsPlayback: true, AutoOpenLiveStream: true, MaxStreamingBitrate: bitrate };
      if (audioIndex != null) params.AudioStreamIndex = audioIndex;
      if (subtitleIndex != null) params.SubtitleStreamIndex = subtitleIndex;
      // Browsers can't switch audio tracks in a file, so a non-default track needs Emby to remux it.
      if (forceTranscode) { params.EnableDirectPlay = false; params.EnableDirectStream = false; }
      const info = await api(`/Items/${full.Id}/PlaybackInfo`, { method: 'POST', params, body: { DeviceProfile: native ? nativeDeviceProfile(bitrate) : deviceProfile(bitrate) } });
      const source = info?.MediaSources?.[0];
      if (stale()) {
        // A newer request took over; release the tuner this one may have opened.
        if (source?.LiveStreamId) api('/LiveTv/LiveStreams/Close', { method: 'POST', params: { LiveStreamId: source.LiveStreamId } }).catch(() => {});
        return;
      }
      if (!source) throw new Error(info?.ErrorCode || 'No playable media source');
      player.playSessionId = info.PlaySessionId;
      player.mediaSourceId = source.Id;
      player.source = source;
      player.liveStreamId = source.LiveStreamId || null;
      player.forceTranscode = forceTranscode;
      player.audioIndex = audioIndex ?? source.DefaultAudioStreamIndex ?? null;
      player.subtitleIndex = subtitleIndex ?? source.DefaultSubtitleStreamIndex ?? -1;

      let url, isHls = false;
      if (source.TranscodingUrl) {
        url = withApiKey(source.TranscodingUrl);
        isHls = source.TranscodingSubProtocol === 'hls' || /\.m3u8/i.test(url);
        player.playMethod = 'Transcode';
      } else {
        const container = (source.Container || 'mp4').split(',')[0];
        url = apiUrl(`/Videos/${full.Id}/stream.${container}`, {
          Static: true, MediaSourceId: source.Id, PlaySessionId: info.PlaySessionId, DeviceId: state.deviceId,
        });
        player.playMethod = source.SupportsDirectPlay ? 'DirectPlay' : 'DirectStream';
      }
      appLog.add('info', `Playing ${full.Name} (${player.playMethod}${native ? ', Aurora player' : ''})`);

      if (native) {
        await playNative(full, source, url, isHls, forceTranscode, stale);
        return;
      }

      // Text subtitles come as a separate WebVTT file; burned-in ones are already in the video.
      $$('track', video).forEach((t) => t.remove());
      const sub = (source.MediaStreams || []).find((s) => s.Type === 'Subtitle' && s.Index === player.subtitleIndex);
      if (sub && sub.DeliveryMethod === 'External' && sub.DeliveryUrl) {
        const track = document.createElement('track');
        track.kind = 'subtitles';
        track.label = sub.DisplayTitle || sub.Language || 'Subtitles';
        track.srclang = sub.Language || 'und';
        track.src = withApiKey(sub.DeliveryUrl);
        track.default = true;
        video.appendChild(track);
        track.addEventListener('load', () => { track.track.mode = 'showing'; });
      }

      await attachSource(video, url, isHls, player.startSeconds);
      if (stale()) return;
      status.classList.add('hidden');
      reportPlayback('/Sessions/Playing');
      player.progressTimer = setInterval(() => reportPlayback('/Sessions/Playing/Progress', 'TimeUpdate'), 10000);
      if (full.Type === 'Episode') findNextEpisode(full);
      wakeOsd();
    } catch (e) {
      if (stale()) return;
      console.error(e);
      const same = player.item?.Id === rawItem.Id;
      playLog.add({ kind: rawItem.Type === 'TvChannel' ? 'live-failed' : 'failed', title: itemTitle(same ? player.item : rawItem), itemId: rawItem.Id, method: same ? player.playMethod || '' : '', error: String(e.message || e).slice(0, 200) });
      status.innerHTML = `<p>Playback failed: ${esc(e.message)}</p><button class="btn btn-white" id="player-err-back">Go Back</button>`;
      $('#player-err-back').addEventListener('click', closePlayer);
      if (nav.on) focusEl($('#player-err-back'));
    }
  }

  function findCreditsStart(chapters) {
    const ticks = (chapters || []).find((c) => c.MarkerType === 'CreditsStart')?.StartPositionTicks;
    return ticks ? ticks / TICKS_PER_SECOND : null;
  }

  function findIntro(chapters) {
    const ticks = (type) => (chapters || []).find((c) => c.MarkerType === type)?.StartPositionTicks;
    const start = ticks('IntroStart'), end = ticks('IntroEnd');
    return start != null && end != null && end > start ? { start: start / TICKS_PER_SECOND, end: end / TICKS_PER_SECOND } : null;
  }

  function attachSource(video, url, isHls, startSeconds) {
    return new Promise((resolve, reject) => {
      const onReady = () => {
        if (startSeconds > 0 && Math.abs(video.currentTime - startSeconds) > 2) video.currentTime = startSeconds;
        video.play().catch(() => { /* autoplay may need a click */ });
        resolve();
      };
      // hls.js plays Emby's stream more smoothly than Android's built-in HLS; Apple's own is best on Apple devices.
      const apple = /Apple/.test(navigator.vendor || '');
      if (isHls && (!apple || !video.canPlayType('application/vnd.apple.mpegurl')) && window.Hls?.isSupported()) {
        const hls = new window.Hls({ startPosition: startSeconds || -1, maxBufferLength: 60, maxMaxBufferLength: 120, backBufferLength: 30,
          // Emby live channels: play a little further behind live, so there's more in hand when the stream hiccups.
          ...(player.isLive ? { liveSyncDurationCount: 4, liveMaxLatencyDurationCount: 12 } : {}) });
        player.hls = hls;
        hls.on(window.Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); resolve(); });
        hls.on(window.Hls.Events.ERROR, (_, data) => {
          if (!data.fatal) return;
          if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) hls.startLoad();
          else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) hls.recoverMediaError();
          else reject(new Error('Streaming error: ' + data.details));
        });
        hls.loadSource(url);
        hls.attachMedia(video);
      } else if (isHls && !video.canPlayType('application/vnd.apple.mpegurl')) {
        reject(new Error('This browser cannot play HLS streams (hls.js failed to load).'));
      } else {
        video.src = url;
        video.addEventListener('loadedmetadata', onReady, { once: true });
        video.addEventListener('error', () => reject(new Error('The browser could not play this file.')), { once: true });
        video.load();
      }
    });
  }

  // Emby only ticks an item off when playback stops past its own threshold, and not always (skipping to the
  // next episode in the credits, a stream that ends a little early). So when the viewer got to the end, say so.
  async function markFinished(item, posSec, durSec, ended) {
    if (!item || item.Type === 'TvChannel' || item.Type === 'Program') return;
    const dur = durSec || (item.RunTimeTicks || 0) / TICKS_PER_SECOND;
    const done = ended || (dur > 0 && (posSec >= dur * 0.9 || (dur > 600 && posSec >= dur - 120)));
    rowCache.clear();
    if (!done) return;
    try {
      await api(userPath(`/PlayedItems/${item.Id}`), { method: 'POST' });
    } catch (e) { appLog.add('warn', `Could not mark "${item.Name}" as watched (${e.message})`); }
  }

  // Emby saves the resume point (and Continue Watching) from these reports.
  function reportPlayback(path, eventName, { keepalive = false } = {}) {
    if (!player.item) return Promise.resolve();
    const stopped = path.endsWith('/Stopped');
    // After the app went to the background we told Emby playback stopped; don't revive the old session.
    if (player.suspended && !stopped) return Promise.resolve();
    const video = $('#video');
    const body = {
      ItemId: player.item.Id,
      MediaSourceId: player.mediaSourceId,
      PlaySessionId: player.playSessionId,
      PositionTicks: Math.floor((video.currentTime || 0) * TICKS_PER_SECOND),
      IsPaused: video.paused,
      IsMuted: video.muted,
      VolumeLevel: Math.round(video.volume * 100),
      PlayMethod: player.playMethod,
      LiveStreamId: player.liveStreamId || undefined,
      AudioStreamIndex: player.audioIndex ?? undefined,
      SubtitleStreamIndex: player.subtitleIndex,
      CanSeek: true,
      EventName: eventName,
    };
    const send = () => api(path, { method: 'POST', body, keepalive });
    // The final position matters most: retry it once if the network blips.
    return send().catch(() => (stopped ? new Promise((r) => setTimeout(r, 1500)).then(send) : null))
      .catch((e) => console.warn('report failed', e));
  }

  // The app is going to the background (Home button, screen off, box turned off): save the position now
  // as a finished session, because the app may never get the chance later.
  function suspendPlayback() {
    if (!player.item || player.suspended || player.isLive) return;
    $('#video').pause();
    reportPlayback('/Sessions/Playing/Stopped', null, { keepalive: true });
    player.suspended = true;
  }

  // Back in the app and playing again: start a fresh session from the current position.
  function resumeSuspended() {
    if (!player.suspended || !player.item) return;
    player.suspended = false;
    reportPlayback('/Sessions/Playing');
  }

  async function nextEpisodeOf(ep) {
    const res = await api(`/Shows/${ep.SeriesId}/Episodes`, { params: { UserId: state.userId, StartItemId: ep.Id, Limit: 2, Fields: ITEM_FIELDS } });
    return res?.Items?.find((i) => i.Id !== ep.Id) || null;
  }

  // ----- Aurora's native player (Android app) -----
  // The page picks what to play; the native screen plays it, keeps Emby up to date, and reports back here.
  let vodSession = null;
  async function playNative(full, source, url, isHls, forceTranscode, stale) {
    const next = full.Type === 'Episode' ? await nextEpisodeOf(full).catch(() => null) : null;
    if (stale()) return;
    const subs = (source.MediaStreams || [])
      .filter((s) => s.Type === 'Subtitle' && s.DeliveryMethod === 'External' && s.DeliveryUrl)
      .map((s) => ({
        url: withApiKey(s.DeliveryUrl),
        lang: s.Language || '',
        label: s.DisplayTitle || s.Language || 'Subtitles',
        format: (s.DeliveryUrl.match(/\.(\w+)(?:\?|$)/) || [])[1] || s.Codec || 'vtt',
        selected: s.Index === player.subtitleIndex,
      }));
    const cfg = state.user?.Configuration || {};
    const ms = (sec) => (sec == null ? -1 : Math.round(sec * 1000));
    const spec = {
      url, hls: isHls,
      startMs: Math.round(player.startSeconds * 1000),
      title: full.Type === 'Episode' ? full.SeriesName : full.Name,
      subtitle: full.Type === 'Episode' ? episodeLabel(full) : (full.ProductionYear ? String(full.ProductionYear) : ''),
      subs,
      introStartMs: ms(player.intro?.start), introEndMs: ms(player.intro?.end), creditsMs: ms(player.creditsAt),
      nextTitle: next ? episodeLabel(next) : '',
      audioLang: cfg.AudioLanguagePreference || '', subLang: cfg.SubtitleLanguagePreference || '', subMode: cfg.SubtitleMode || 'Default',
      report: {
        base: state.server + '/emby', apiKey: state.apiKey, auth: authHeader(), deviceId: state.deviceId,
        itemId: full.Id, mediaSourceId: source.Id, playSessionId: player.playSessionId, playMethod: player.playMethod,
        audioIndex: player.audioIndex ?? undefined, subtitleIndex: player.subtitleIndex,
      },
      stallSeconds: stallSeconds() || undefined,
    };
    vodSession = { item: full, next, forceTranscode, startMs: spec.startMs, playMethod: player.playMethod, bitrate: player.bitrate, noCap: !!player.noCap };
    // The native screen reports to Emby from here on.
    player.item = null;
    player.playSessionId = null;
    store.set('ef.liveReturn', JSON.stringify({ hash: location.hash || '#/home', t: Date.now() }));
    nativeApp.playVod(JSON.stringify(spec));
  }

  // How a viewing went (the Aurora player counts the stalls). A rough session goes into the app log as a warning,
  // so it reaches the admins with the automatic reports, and lowers the quality used for the next few plays.
  function noteStreamHealth(s, r) {
    const watched = r.watchedMs || 0, stalledMs = r.stalledMs || 0, stalls = r.stalls || 0;
    const pct = watched ? Math.round((stalledMs / watched) * 1000) / 10 : 0;
    const rough = stalls >= 3 || pct >= 3;
    if (rough) playLog.add({ kind: 'stalling', title: itemTitle(s.item), itemId: s.item.Id, method: s.playMethod, stalls, stalledSec: Math.round(stalledMs / 1000), pct, watchedMin: Math.round(watched / 60000), bitrate: s.bitrate || 0 });
    appLog.add(rough ? 'warn' : 'info',
      `Watched ${s.item.Name} (${s.playMethod}${s.bitrate ? ', limit ' + (s.bitrate / 1e6).toFixed(0) + ' Mbps' : ''}): ${Math.round(watched / 60000)} min, ${stalls} ${stalls === 1 ? 'stall' : 'stalls'}, ${Math.round(stalledMs / 1000)} s buffering (${pct}%)`);
    if (rough && autoQuality() && s.bitrate) {
      measuredBitrate = { bps: Math.max(700000, Math.round(s.bitrate * 0.6)), t: Date.now() };
      if (!store.get('ef.vodBufferTip')) {
        store.set('ef.vodBufferTip', '1');
        toast('That video kept stopping to buffer, so Aurora will use a lower quality next time. You can set it in Settings → Playback → Streaming quality.', 8000);
      }
    }
  }

  window.auroraVodClosed = async (r) => {
    store.del('ef.liveReturn');
    const s = vodSession;
    vodSession = null;
    r = r || {};
    if (s?.item && r.ready) await markFinished(s.item, (r.positionMs || 0) / 1000, (r.durationMs || 0) / 1000, !!r.ended);
    if (s && r.watchedMs > 60000) noteStreamHealth(s, r);
    if (!s || !isPlayerOpen()) {
      if (isPlayerOpen()) closePlayer(); else route();
      return;
    }
    if (r.touched) noteInput();
    if (r.error) {
      const converting = r.error.startsWith('unplayable') && !s.forceTranscode;
      playLog.add({ kind: converting ? 'converted' : 'failed', title: itemTitle(s.item), itemId: s.item.Id, method: s.playMethod, error: r.error,
        atSec: Math.round((r.positionMs || 0) / 1000), bitrate: s.bitrate || 0 });
    }
    if (r.error) appLog.add('warn', `Aurora player: ${s.item.Name} stopped (${r.error}, ${s.playMethod}, at ${Math.round((r.positionMs || 0) / 1000)}s of ${Math.round((r.durationMs || 0) / 1000)}s)`);
    // The device couldn't play the file as it is: ask Emby to convert it, from the same spot.
    if (r.error?.startsWith('unplayable') && !s.forceTranscode) {
      toast('Converting this video so it plays on this device…');
      const pos = r.ready ? r.positionMs : s.startMs;
      playItem(s.item, { startTicks: Math.round(pos * 10000), forceTranscode: true, auto: true });
      return;
    }
    // Emby's own conversion failed before anything played (it refused, or its converter broke): try once more without
    // the measured quality limit, which lets a file the device can play as it is play directly instead of converting.
    if (r.error?.startsWith('failed') && !r.ready && s.playMethod === 'Transcode' && !s.noCap && !s.forceTranscode && autoQuality() && (s.bitrate || 0) < (qualityCap() || QUALITY_OPTIONS[0].bitrate)) {
      toast('Trying another way to play this…');
      measuredBitrate = null;
      playItem(s.item, { startTicks: Math.round((s.startMs || 0) * 10000), auto: true, noCap: true });
      return;
    }
    if (r.next && s.next && (!r.ended || getPref('autoplay') === 'on')) {
      player.nextEpisode = s.next;
      startNextEpisode(!!r.ended);
      return;
    }
    if (r.error) toast("This video couldn't be played. Try again, or pick a lower Streaming quality in Settings.", 6000);
    closePlayer();
  };

  async function findNextEpisode(ep) {
    player.nextEpisode = null;
    try {
      const next = await nextEpisodeOf(ep);
      if (next && player.item?.Id === ep.Id) {
        player.nextEpisode = next;
        const btn = $('#player-next');
        btn.title = episodeLabel(next);
        btn.classList.remove('hidden');
      }
    } catch { /* ignore */ }
  }

  function playNextEpisode() {
    startNextEpisode(false);
  }

  // auto: started by the countdown or the end of an episode rather than by the viewer.
  function startNextEpisode(auto) {
    const next = player.nextEpisode;
    if (!next) return;
    hideUpNext();
    if (auto) {
      player.autoCount++;
      // Three episodes in a row with no one touching the remote: check before streaming more.
      if (getPref('stillWatching') === 'on' && player.autoCount >= 3) {
        showStillWatching(() => playItem(next, { startTicks: 0 }));
        return;
      }
      playItem(next, { startTicks: 0, auto: true });
    } else {
      playItem(next, { startTicks: 0 });
    }
  }

  // Called for any viewer input in the player (keys, clicks, taps).
  function noteInput() {
    player.autoCount = 0;
    player.lastInput = Date.now();
  }

  // ----- Next-episode countdown -----
  const upNextVisible = () => !$('#up-next').classList.contains('hidden');

  // When the credits start (Emby's credits marker, or the last 20 seconds of a longer episode).
  function creditsTime() {
    if (player.creditsAt) return player.creditsAt;
    const dur = mediaDuration();
    return dur > 300 ? dur - 20 : null;
  }

  function showUpNext() {
    const next = player.nextEpisode, card = $('#up-next');
    if (!next) return;
    player.upNextShown = true;
    const img = landscapeImage(next, 400);
    const autoplay = getPref('autoplay') === 'on';
    card.innerHTML = `
      <div class="up-next-img">${img ? `<img src="${esc(img)}" alt="">` : ''}</div>
      <div class="up-next-text">
        <span class="up-next-label">Next Episode</span>
        <strong>${esc(episodeLabel(next))}</strong>
        ${autoplay ? '<span class="up-next-count">Playing in <b>10</b></span>' : ''}
        <div class="up-next-actions">
          <button class="btn btn-white" data-act="now" data-autofocus>${ICONS.play} Play Now</button>
          <button class="btn btn-gray" data-act="credits">Watch Credits</button>
        </div>
      </div>`;
    card.classList.remove('hidden');
    $('[data-act="now"]', card).addEventListener('click', () => startNextEpisode(false));
    $('[data-act="credits"]', card).addEventListener('click', () => { player.upNextDismissed = true; hideUpNext(); wakeOsd(); });
    if (nav.on) focusEl($('[data-act="now"]', card));
    if (autoplay) {
      let left = 10;
      player.upNextTimer = setInterval(() => {
        left--;
        const n = $('.up-next-count b', card);
        if (n) n.textContent = left;
        if (left <= 0) startNextEpisode(true);
      }, 1000);
    }
  }

  function hideUpNext() {
    clearInterval(player.upNextTimer);
    player.upNextTimer = null;
    const card = $('#up-next');
    if (card.classList.contains('hidden')) return;
    const hadFocus = card.contains(document.activeElement);
    card.classList.add('hidden');
    card.innerHTML = '';
    if (hadFocus && nav.on && isPlayerOpen()) focusEl($('#osd-play'));
  }

  function checkUpNext(cur) {
    if (player.isLive || !player.nextEpisode || player.upNextDismissed) return;
    const at = creditsTime();
    if (at == null) return;
    if (cur >= at && !player.upNextShown) showUpNext();
    // Seeking back before the credits takes the card away again.
    else if (cur < at - 1 && player.upNextShown) { player.upNextShown = false; hideUpNext(); }
  }

  // ----- "Are you still watching?" -----
  const stillWatchingVisible = () => !$('#still-watching').classList.contains('hidden');

  async function showStillWatching(onContinue) {
    const name = player.item?.SeriesName || (player.isLive ? channelLabel(player.item || {}) : player.item?.Name) || '';
    // Stop streaming (and free any Live TV tuner) while we wait for an answer.
    player.token++;
    await stopPlayback();
    hideUpNext();
    const box = $('#still-watching');
    box.innerHTML = `
      <div class="still-box">
        <h2>Are you still watching${name ? ` <span>${esc(name)}</span>` : ''}?</h2>
        <div class="still-actions">
          <button class="btn btn-white" data-act="continue" data-autofocus>Continue Watching</button>
          <button class="btn btn-gray" data-act="exit">Back to Browse</button>
        </div>
      </div>`;
    box.classList.remove('hidden');
    $('#player').classList.remove('idle');
    $('[data-act="continue"]', box).addEventListener('click', () => { noteInput(); hideStillWatching(); onContinue(); });
    $('[data-act="exit"]', box).addEventListener('click', () => { hideStillWatching(); closePlayer(); });
    focusEl($('[data-act="continue"]', box));
  }

  function hideStillWatching() {
    const box = $('#still-watching');
    box.classList.add('hidden');
    box.innerHTML = '';
  }

  async function stopPlayback() {
    clearInterval(player.progressTimer);
    const video = $('#video');
    if (player.item) {
      const playSessionId = player.playSessionId;
      const wasTranscoding = player.playMethod === 'Transcode';
      const liveStreamId = player.liveStreamId;
      const item = player.item, pos = video.currentTime || 0, ended = video.ended;
      if (!player.suspended) await reportPlayback('/Sessions/Playing/Stopped');
      if (!player.isLive) await markFinished(item, pos, Number.isFinite(video.duration) ? video.duration : 0, ended);
      // Free the tuner.
      if (liveStreamId) api('/LiveTv/LiveStreams/Close', { method: 'POST', params: { LiveStreamId: liveStreamId } }).catch(() => {});
      if (wasTranscoding) {
        api('/Videos/ActiveEncodings', { method: 'DELETE', params: { DeviceId: state.deviceId, PlaySessionId: playSessionId } }).catch(() => {});
      }
    }
    if (player.hls) { player.hls.destroy(); player.hls = null; }
    video.pause();
    video.removeAttribute('src');
    video.load();
    player.item = null;
    player.nextEpisode = null;
    player.intro = null;
    player.liveStreamId = null;
    player.suspended = false;
  }

  async function closePlayer() {
    player.token++;
    await stopPlayback();
    hideUpNext();
    hideStillWatching();
    closeTracks();
    player.speed = 1; // each new title starts at normal speed
    $('#player').classList.add('hidden');
    nativeApp?.setPlayerMode(false);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    const modalOpen = !$('#modal').classList.contains('hidden');
    document.body.style.overflow = modalOpen ? 'hidden' : '';
    // Refresh what's on screen so "Continue Watching" and progress bars update.
    if (!modalOpen) route();
    else $('[data-episodes]')?.__reload?.();
    restoreFocus('player');
    showWaitingUpdate();
  }

  // ----- On-screen controls -----
  const isPlayerOpen = () => !$('#player').classList.contains('hidden');
  const tracksOpen = () => !$('#tracks-panel').classList.contains('hidden');
  const osdVisible = () => !$('#player').classList.contains('idle');

  function formatClock(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return (h ? `${h}:${String(m).padStart(2, '0')}` : `${m}`) + ':' + String(s).padStart(2, '0');
  }

  function mediaDuration() {
    const d = $('#video').duration;
    if (Number.isFinite(d) && d > 0) return d;
    return (player.item?.RunTimeTicks || 0) / TICKS_PER_SECOND;
  }

  function seekTo(sec) {
    const video = $('#video'), dur = mediaDuration();
    video.currentTime = Math.max(0, dur ? Math.min(sec, dur - 1) : sec);
    updateOsd();
  }
  const seekBy = (delta) => seekTo(($('#video').currentTime || 0) + delta);

  function togglePlay() {
    const video = $('#video');
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }

  function updateOsd() {
    const video = $('#video'), dur = mediaDuration(), cur = video.currentTime || 0;
    if (player.isLive) {
      const prog = player.item?.CurrentProgram;
      $('#osd-time').textContent = prog ? `${prog.Name} · ${timeRange(prog)}` : '';
    } else if (!player.dragging) $('#osd-seek').value = dur ? Math.round((cur / dur) * 1000) : 0;
    if (!player.isLive) {
      $('#osd-time').textContent = `${formatClock(cur)} / ${formatClock(dur)}`;
      $('#osd-remaining').textContent = '-' + formatClock(dur - cur);
    }
    $('#osd-play').innerHTML = video.paused ? ICONS.play : ICONS.pause;
    $('#osd-play').setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
    $('#osd-mute').innerHTML = video.muted ? ICONS.muted : ICONS.volume;
    const inIntro = player.intro && cur >= player.intro.start && cur < player.intro.end - 1;
    $('#skip-intro').classList.toggle('hidden', !inIntro);
    checkUpNext(cur);
  }

  function wakeOsd() {
    const el = $('#player'), video = $('#video');
    el.classList.remove('idle');
    clearTimeout(player.idleTimer);
    player.idleTimer = setTimeout(() => {
      if (video.paused || tracksOpen() || player.dragging) return;
      el.classList.add('idle');
      // Hidden controls shouldn't keep remote focus.
      const keep = document.activeElement === $('#skip-intro') || $('#up-next').contains(document.activeElement);
      if (el.contains(document.activeElement) && !keep) document.activeElement.blur();
    }, 4000);
  }

  function openTracks() {
    const panel = $('#tracks-panel'), streams = player.source?.MediaStreams || [], video = $('#video');
    const audio = streams.filter((s) => s.Type === 'Audio');
    const subs = streams.filter((s) => s.Type === 'Subtitle');
    const opt = (attr, value, label, selected) =>
      `<button class="track-opt${selected ? ' selected' : ''}" data-${attr}="${value}">${selected ? '&#10003; ' : ''}${esc(label)}</button>`;
    const nowPlaying = video.videoHeight ? `<p class="tracks-now">Now playing ${video.videoHeight >= 2000 ? '4K' : video.videoHeight + 'p'}</p>` : '';
    panel.innerHTML = `
      <h3 class="tracks-title">Playback settings</h3>
      <div class="tracks-cols">
        <div class="tracks-col"><h4>Language</h4>
          ${audio.length ? audio.map((s) => opt('audio', s.Index, s.DisplayTitle || s.Language || `Track ${s.Index}`, s.Index === player.audioIndex)).join('') : '<p>Default</p>'}
        </div>
        <div class="tracks-col"><h4>Subtitles</h4>
          ${opt('sub', -1, 'Off', player.subtitleIndex == null || player.subtitleIndex < 0)}
          ${subs.map((s) => opt('sub', s.Index, s.DisplayTitle || s.Language || `Subtitle ${s.Index}`, s.Index === player.subtitleIndex)).join('')}
        </div>
        ${player.isLive ? '' : `<div class="tracks-col"><h4>Speed</h4>
          ${SPEED_OPTIONS.map((r) => opt('speed', r, speedLabel(r), r === player.speed)).join('')}
        </div>`}
        <div class="tracks-col"><h4>Resolution</h4>
          ${qualityChoices().map((q) => opt('quality', q.bitrate, q.label, q.bitrate === shownQuality())).join('')}
          ${nowPlaying}
        </div>
      </div>`;
    panel.classList.remove('hidden');
    $('#player').classList.remove('idle');
    clearTimeout(player.idleTimer);
    focusEl($('.track-opt.selected', panel) || $('.track-opt', panel));
  }

  // Speed resets when a new video loads, so it's put back every time.
  function applySpeed() {
    const video = $('#video');
    video.defaultPlaybackRate = player.speed;
    video.playbackRate = player.speed;
  }

  function closeTracks() {
    const panel = $('#tracks-panel');
    if (panel.classList.contains('hidden')) return;
    panel.classList.add('hidden');
    wakeOsd();
    if (nav.on) focusEl($('#osd-tracks'));
  }

  function onTrackChoice(btn) {
    const video = $('#video'), item = player.item, source = player.source;
    if (!item) return;
    const startTicks = Math.floor((video.currentTime || 0) * TICKS_PER_SECOND);
    let { audioIndex, subtitleIndex, forceTranscode } = player;
    // Picking what's already chosen just closes the panel.
    if (btn.classList.contains('selected')) { closeTracks(); return; }
    if (btn.dataset.speed != null) {
      // Speed changes on the spot; no need to restart the stream.
      player.speed = Number(btn.dataset.speed);
      applySpeed();
      closeTracks();
      toast(`Speed: ${speedLabel(player.speed)}`, 1500);
      return;
    }
    if (btn.dataset.audio != null) {
      audioIndex = Number(btn.dataset.audio);
      forceTranscode = audioIndex !== source?.DefaultAudioStreamIndex;
    } else if (btn.dataset.sub != null) {
      subtitleIndex = Number(btn.dataset.sub);
    } else if (btn.dataset.quality != null) {
      store.set('ef.maxBitrate', btn.dataset.quality);
    }
    closeTracks();
    playItem(item, { startTicks, audioIndex: audioIndex ?? undefined, subtitleIndex, forceTranscode });
  }

  // Remote / keyboard handling while the player is open. Returns true when handled.
  function handlePlayerKey(action) {
    const video = $('#video');
    noteInput();
    if (stillWatchingVisible()) {
      if (action === 'back') { hideStillWatching(); closePlayer(); return true; }
      return false; // move between the two buttons
    }
    if (upNextVisible() && $('#up-next').contains(document.activeElement)) {
      // Arrows move between Play Now and Watch Credits; OK presses the focused one.
      if (['left', 'right', 'select'].includes(action)) return false;
      if (action === 'up') { wakeOsd(); focusEl($('#osd-play')); return true; }
    }
    if (tracksOpen()) {
      if (action === 'back') { closeTracks(); return true; }
      return false;
    }
    switch (action) {
      case 'playpause': togglePlay(); wakeOsd(); return true;
      case 'play': video.play().catch(() => {}); wakeOsd(); return true;
      case 'pause': video.pause(); wakeOsd(); return true;
      case 'ff': if (!player.isLive) seekBy(30); wakeOsd(); return true;
      case 'rw': if (!player.isLive) seekBy(-10); wakeOsd(); return true;
      case 'next': playNextEpisode(); return true;
      case 'chup': if (player.isLive) changeChannel(1); return true;
      case 'chdown': if (player.isLive) changeChannel(-1); return true;
      default: break;
    }
    if (player.isLive && (!osdVisible() || !$('#player').contains(document.activeElement))) {
      // Live TV: up/down changes channel and left/right moves into the controls (there's nothing to seek).
      if (action === 'up' || action === 'down') { changeChannel(action === 'up' ? 1 : -1); return true; }
      if (action === 'left' || action === 'right') { wakeOsd(); focusEl($('#osd-play')); return true; }
    }
    if (!osdVisible()) {
      const skipVisible = !$('#skip-intro').classList.contains('hidden');
      if (action === 'select') {
        if (skipVisible) $('#skip-intro').click();
        else togglePlay();
        wakeOsd();
        return true;
      }
      if (action === 'left' || action === 'right') { seekBy(action === 'left' ? -10 : 10); wakeOsd(); return true; }
      if (action === 'up' || action === 'down') { wakeOsd(); focusEl($('#osd-play')); return true; }
      return false;
    }
    wakeOsd();
    const focused = document.activeElement;
    if (focused === $('#osd-seek') && (action === 'left' || action === 'right')) {
      seekBy(action === 'left' ? -10 : 10);
      return true;
    }
    if (!$('#player').contains(focused) && ['up', 'down', 'left', 'right', 'select'].includes(action)) {
      focusEl($('#osd-play'));
      return true;
    }
    return false;
  }

  function setupPlayer() {
    const el = $('#player'), video = $('#video'), seek = $('#osd-seek');
    $('#player-back').addEventListener('click', closePlayer);
    $('#player-next').addEventListener('click', playNextEpisode);
    $('#osd-play').addEventListener('click', togglePlay);
    $('#osd-back10').innerHTML = ICONS.back10;
    $('#osd-fwd10').innerHTML = ICONS.fwd10;
    $('#osd-back10').addEventListener('click', () => seekBy(-10));
    $('#osd-fwd10').addEventListener('click', () => seekBy(10));
    $('#osd-mute').addEventListener('click', () => { video.muted = !video.muted; updateOsd(); });
    $('#osd-tracks').addEventListener('click', openTracks);
    $('#skip-intro').addEventListener('click', () => { if (player.intro) seekTo(player.intro.end); });
    $('#osd-fullscreen').addEventListener('click', () => {
      if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
      else el.requestFullscreen?.().catch(() => {});
    });
    $('#tracks-panel').addEventListener('click', (e) => {
      const btn = e.target.closest('.track-opt');
      if (btn) onTrackChoice(btn);
    });
    seek.addEventListener('input', () => {
      player.dragging = true;
      const dur = mediaDuration();
      $('#osd-time').textContent = `${formatClock((seek.value / 1000) * dur)} / ${formatClock(dur)}`;
    });
    seek.addEventListener('change', () => {
      player.dragging = false;
      seekTo((seek.value / 1000) * mediaDuration());
    });
    video.addEventListener('click', () => { if (osdVisible()) togglePlay(); wakeOsd(); });
    video.addEventListener('dblclick', () => $('#osd-fullscreen').click());
    ['timeupdate', 'play', 'pause', 'durationchange', 'volumechange'].forEach((ev) => video.addEventListener(ev, updateOsd));
    video.addEventListener('loadedmetadata', () => { if (video.playbackRate !== player.speed) applySpeed(); });
    video.addEventListener('playing', () => { if (video.playbackRate !== player.speed) applySpeed(); });
    video.addEventListener('pause', () => { reportPlayback('/Sessions/Playing/Progress', 'Pause'); wakeOsd(); });
    video.addEventListener('play', () => {
      if (player.suspended) resumeSuspended();
      else reportPlayback('/Sessions/Playing/Progress', 'Unpause');
      wakeOsd();
    });
    video.addEventListener('ended', () => {
      if (player.nextEpisode && getPref('autoplay') === 'on') startNextEpisode(true);
      else closePlayer();
    });
    el.addEventListener('click', noteInput, true);
    el.addEventListener('touchstart', noteInput, { capture: true, passive: true });
    // Live TV left on for 4 hours with no input: ask, and free the tuner meanwhile.
    setInterval(() => {
      if (!isPlayerOpen() || !player.isLive || stillWatchingVisible() || getPref('stillWatching') !== 'on') return;
      if (Date.now() - player.lastInput < 4 * 3600000) return;
      const channel = player.item;
      showStillWatching(() => playItem(channel));
    }, 60000);
    el.addEventListener('mousemove', wakeOsd);
    el.addEventListener('touchstart', wakeOsd, { passive: true });
    window.addEventListener('pagehide', () => { if (player.item && !player.suspended) reportPlayback('/Sessions/Playing/Stopped', null, { keepalive: true }); });
    document.addEventListener('visibilitychange', () => { if (document.hidden) suspendPlayback(); });
    // The Android app calls this from onPause, before the WebView is paused.
    window.auroraPause = suspendPlayback;
    $('#osd-fullscreen').classList.toggle('hidden', !!nativeApp || !document.fullscreenEnabled);
  }

  // ---------- Icons ----------
  const ICONS = {
    play: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M6 4v16a1 1 0 0 0 1.52.85l13-8a1 1 0 0 0 0-1.7l-13-8A1 1 0 0 0 6 4Z"/></svg>',
    info: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm1 6v8h-2v-8h2Zm0-4v2h-2V6h2Z"/></svg>',
    film: '<svg viewBox="0 0 24 24" width="22" height="22"><path fill="currentColor" d="M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm1 2v2h2V6H5Zm12 0v2h2V6h-2ZM5 10v4h2v-4H5Zm12 0v4h2v-4h-2ZM5 16v2h2v-2H5Zm12 0v2h2v-2h-2ZM9 6v12h6V6H9Z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M6 4h4v16H6zM14 4h4v16h-4z"/></svg>',
    back10: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 5V1L7 6l5 5V7a6 6 0 1 1-6 6H4a8 8 0 1 0 8-8Z"/><text x="12" y="16.5" font-size="7" font-weight="700" text-anchor="middle" fill="currentColor">10</text></svg>',
    fwd10: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 5V1l5 5-5 5V7a6 6 0 1 0 6 6h2a8 8 0 1 1-8-8Z"/><text x="12" y="16.5" font-size="7" font-weight="700" text-anchor="middle" fill="currentColor">10</text></svg>',
    volume: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3Zm13.5 3A4.5 4.5 0 0 0 14 8v8a4.5 4.5 0 0 0 2.5-4ZM14 3.2v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6Z"/></svg>',
    muted: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M3 9v6h4l5 5V4L7 9H3Zm13.6 3 2.7-2.7-1.4-1.4-2.7 2.7-2.7-2.7-1.4 1.4 2.7 2.7-2.7 2.7 1.4 1.4 2.7-2.7 2.7 2.7 1.4-1.4-2.7-2.7Z"/></svg>',
    eye: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17Z"/></svg>',
  };

  // ---------- Global UI wiring ----------
  function toggleProfileDropdown(e) {
    e.stopPropagation();
    $('#profile-dropdown').classList.toggle('hidden');
  }

  function setupUi() {
    $('#setup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button[type="submit"]', e.target);
      btn.disabled = true; btn.textContent = 'Connecting…';
      try {
        const user = await signIn($('#setup-username').value.trim(), $('#setup-password').value);
        await selectUser(user, { fresh: true });
      } catch (err) {
        showSetup(connectionErrorMessage(err));
      } finally {
        btn.disabled = false; btn.textContent = 'Sign In';
      }
    });

    $('#profile-btn').addEventListener('click', toggleProfileDropdown);
    document.addEventListener('click', () => $('#profile-dropdown').classList.add('hidden'));
    $('#profile-dropdown').addEventListener('click', (e) => {
      const act = e.target.dataset.action;
      if (act === 'settings') location.hash = '#/settings';
      if (act === 'admin') location.hash = '#/admin';
      if (act === 'switch') switchUser();
      if (act === 'signout') signOut();
    });

    // Search
    const box = $('#search-box'), input = $('#search-input');
    let searchTimer;
    // The magnifier only ever opens the box and puts the cursor in it. Pressing it must not blur the box
    // first, or the box would close on blur and then reopen on click.
    $('#search-toggle').addEventListener('mousedown', (e) => e.preventDefault());
    $('#search-toggle').addEventListener('click', () => {
      if (nav.tv) { location.hash = '#/search'; return; } // TV: on-screen keyboard page
      box.classList.add('open');
      input.focus();
      nativeApp?.showKeyboard();
    });
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        // Clearing the text stays on the search page (it used to jump to Home and hide the box mid-typing).
        const q = input.value.trim();
        const target = q ? '#/search?q=' + encodeURIComponent(q) : '#/search';
        if (location.hash !== target) location.hash = target;
      }, 350);
    });
    input.addEventListener('blur', () => {
      if (!input.value && !/^#\/search/.test(location.hash)) box.classList.remove('open');
    });

    // Modal
    $$('[data-close]').forEach((el) => el.addEventListener('click', closeModal));

    // Solid nav on scroll
    window.addEventListener('scroll', () => $('#nav').classList.toggle('solid', window.scrollY > 40), { passive: true });
    // A page change closes a details pop-up, but not the update prompt (the first screen loading right after
    // sign-in would otherwise close it as soon as it appeared).
    window.addEventListener('hashchange', () => { if (!$('#modal-content .update-body')) closeModal(); route(); });

    setupPlayer();
    setupKeys();
  }

  // ---------- Remote control & keyboard navigation ----------
  // Arrow keys move focus to the nearest item in that direction (TV remotes send arrow keys),
  // OK/Enter activates it and Back closes the top layer.
  const nav = { on: false, tv: false, returnFocus: {} };
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([type="hidden"]), select, textarea, [tabindex]';

  function enableNav() {
    if (nav.on) return;
    nav.on = true;
    document.documentElement.classList.add('kbd-nav');
  }

  function activeLayer() {
    if (isPlayerOpen()) {
      if (stillWatchingVisible()) return $('#still-watching');
      return tracksOpen() ? $('#tracks-panel') : $('#player');
    }
    if (trailerOpen()) return $('#trailer');
    if (!$('#modal').classList.contains('hidden')) return $('#modal');
    if (!$('#setup').classList.contains('hidden')) return $('#setup');
    return $('#main');
  }

  function focusables(layer) {
    return $$(FOCUSABLE, layer).filter((el) => {
      if (el.tabIndex < 0 || el.disabled) return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden';
    });
  }

  function focusEl(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
    // Instant scrolling keeps positions settled for the next remote press.
    if (el.closest('#nav')) window.scrollTo({ top: 0 });
    else if (el.closest('[data-nav-zone]')) el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); // scroll the side list, not the page
    else if (!el.closest('#player')) el.scrollIntoView({ block: 'center', inline: 'nearest' });
  }

  function focusInitial(layer = activeLayer()) {
    const items = focusables(layer);
    focusEl(items.find((el) => el.hasAttribute('data-autofocus')) || items[0]);
  }

  function autoFocus(el) {
    if (nav.on && el && activeLayer().contains(el)) focusEl(el);
  }

  function rememberFocus(key) { nav.returnFocus[key] = document.activeElement; }
  function restoreFocus(key) {
    const el = nav.returnFocus[key];
    nav.returnFocus[key] = null;
    if (!nav.on) return;
    if (el && document.contains(el) && activeLayer().contains(el)) focusEl(el);
  }

  function moveFocus(dir) {
    const layer = activeLayer();
    const cur = document.activeElement;
    if (!cur || cur === document.body || !layer.contains(cur)) { focusInitial(layer); return; }
    const r = cur.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const vertical = dir === 'up' || dir === 'down';
    const cands = [];
    // Only items near the current one are worth checking: a long grid or guide has thousands, and asking the
    // style of each one on every press made the remote lag on TV boxes.
    const W = window.innerWidth, H = window.innerHeight;
    for (const el of $$(FOCUSABLE, layer)) {
      // A disabled control (a setting the admin locked) reports tabIndex 0 but can't take focus: trying it left the remote stuck.
      if (el.tabIndex < 0 || el.disabled || el === cur || el.contains(cur) || cur.contains(el)) continue;
      const b = el.getBoundingClientRect();
      if (b.width <= 1 || b.height <= 1) continue;
      if (b.bottom < r.top - 1.5 * H || b.top > r.bottom + 1.5 * H || b.right < r.left - 1.5 * W || b.left > r.right + 1.5 * W) continue;
      const bx = b.left + b.width / 2, by = b.top + b.height / 2;
      let primary, cross, overlap;
      if (dir === 'down') { if (b.top < cy) continue; primary = by - cy; }
      else if (dir === 'up') { if (b.bottom > cy) continue; primary = cy - by; }
      else if (dir === 'right') { if (b.left < cx) continue; primary = bx - cx; }
      else { if (b.right > cx) continue; primary = cx - bx; }
      if (vertical) {
        cross = Math.max(0, b.left - r.right, r.left - b.right) + Math.abs(bx - cx) * 0.1;
      } else {
        overlap = b.top < r.bottom && b.bottom > r.top;
        cross = Math.abs(by - cy);
      }
      cands.push({ el, primary, cross, overlap });
    }
    for (let i = cands.length - 1; i >= 0; i--) if (getComputedStyle(cands[i].el).visibility === 'hidden') cands.splice(i, 1);
    // The fixed top bar is only reached when nothing else lies in that direction (like Netflix).
    const inPage = cands.filter((c) => !c.el.closest('#nav'));
    if (inPage.length && !cur.closest('#nav')) cands.splice(0, cands.length, ...inPage);
    // A side list (data-nav-zone, like the live TV categories) keeps up/down to itself, and up/down in the
    // grid beside it never lands in it: otherwise Down from a channel picks the nearer category.
    if (vertical) {
      const zone = cur.closest('[data-nav-zone]');
      const same = cands.filter((c) => c.el.closest('[data-nav-zone]') === zone);
      if (same.length || (!zone && cur.closest('.card'))) cands.splice(0, cands.length, ...same);
    }
    let best = null;
    if (vertical) {
      // Go to the nearest line of items first, then the one most in line with the current item.
      const nearest = Math.min(...cands.map((c) => c.primary));
      // Coming down out of the top bar, start at the left of the line (like Netflix) rather than under the button.
      // The same on the Settings page (its controls sit on the right, its buttons start on the left), so Down
      // reaches the first button of a line rather than the one nearest the control above.
      const fromNav = dir === 'down' && (cur.closest('#nav') || cur.closest('.settings-page'));
      for (const c of cands) {
        if (c.primary > nearest + 40) continue;
        const score = fromNav ? c.el.getBoundingClientRect().left : c.cross;
        if (!best || score < best.score) best = { ...c, score };
      }
    } else {
      // Sideways moves stay on the same row.
      for (const c of cands) {
        if (!c.overlap) continue;
        if (!best || c.primary + c.cross * 2 < best.primary + best.cross * 2) best = c;
      }
    }
    // Stepping sideways into a side list lands on its selected item (the category being shown).
    if (best && !vertical) {
      const zone = best.el.closest('[data-nav-zone]');
      if (zone && !zone.contains(cur)) best = { el: zone.querySelector('.active') || best.el };
    }
    // Some items do something when there's nowhere further to go (the guide's channel column opens the groups).
    if (!best && dir === 'left' && cur.__onLeftEdge) { cur.__onLeftEdge(); return; }
    if (dir === 'right' && cur.__onRightEdge && (!best || !best.el.closest('[data-nav-zone]'))) { cur.__onRightEdge(); return; }
    if (best) {
      focusEl(best.el);
      if (document.activeElement !== best.el) {
        // It wouldn't take the focus (hidden, or not focusable after all): never leave the remote stuck, try the next one.
        const rest = cands.filter((c) => c.el !== best.el).sort((a, b) => (a.primary + a.cross * 2) - (b.primary + b.cross * 2));
        for (const c of rest.slice(0, 8)) { focusEl(c.el); if (document.activeElement === c.el) break; }
      }
    }
  }

  const isTextInput = (el) => el && ((el.tagName === 'INPUT' && !['range', 'checkbox', 'radio', 'button', 'submit'].includes(el.type)) || el.tagName === 'TEXTAREA');

  function activate(el) {
    const layer = activeLayer();
    if (!el || el === document.body || !layer.contains(el)) { focusInitial(layer); return; }
    if (isTextInput(el)) { el.focus(); nativeApp?.showKeyboard(); return; }
    if (el.tagName === 'SELECT') {
      try { el.showPicker(); } catch {
        // Older WebViews: step through the options instead.
        el.selectedIndex = (el.selectedIndex + 1) % el.options.length;
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return;
    }
    if (el.type === 'range') { if (isPlayerOpen()) togglePlay(); return; }
    el.click();
  }

  // action: up/down/left/right/select/back or a media key. fromNative: sent by the Android app.
  function handleKey(action, fromNative = false) {
    const el = document.activeElement;
    if (action !== 'back') enableNav();
    if (action === 'guide' && isPlayerOpen()) closePlayer();
    else if (isPlayerOpen() && handlePlayerKey(action)) return true;
    if (['up', 'down', 'left', 'right'].includes(action)) {
      if (isTextInput(el) && (action === 'left' || action === 'right')) {
        const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
        const atEnd = el.selectionEnd === el.value.length;
        if (action === 'left' ? !atStart : !atEnd) return false; // move the text cursor
      }
      moveFocus(action);
      return true;
    }
    if (action === 'select') {
      if (isTextInput(el) && !fromNative) {
        // Keyboard Enter submits; an empty field on a TV opens the on-screen keyboard instead.
        if (nav.tv && !el.value) { nativeApp?.showKeyboard(); return true; }
        return false;
      }
      activate(el);
      return true;
    }
    if (action === 'back') return window.embyflixBack();
    if (action === 'guide' && showLiveLink()) {
      closeModal();
      location.hash = iptvOn() ? '#/livetv' : '#/livetv?tab=guide';
      return true;
    }
    return false;
  }

  function setupKeys() {
    const keys = {
      ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', Enter: 'select', Escape: 'back',
      MediaPlayPause: 'playpause', MediaPlay: 'play', MediaPause: 'pause',
      MediaFastForward: 'ff', MediaRewind: 'rw', MediaTrackNext: 'next',
      ChannelUp: 'chup', ChannelDown: 'chdown', PageUp: 'chup', PageDown: 'chdown', Guide: 'guide',
    };
    document.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      let action = keys[e.key];
      if (e.key === ' ' && isPlayerOpen() && !isTextInput(document.activeElement)) action = 'playpause';
      if (!action) return;
      if (handleKey(action)) { e.preventDefault(); e.stopPropagation(); }
    }, true);
    // Mouse or touch use turns the focus highlight off again.
    const pointer = () => { if (!nav.tv && nav.on) { nav.on = false; document.documentElement.classList.remove('kbd-nav'); } };
    document.addEventListener('mousedown', pointer, true);
    document.addEventListener('touchstart', pointer, { capture: true, passive: true });
    document.addEventListener('focusin', (e) => {
      if (!e.target.closest('.profile-menu')) $('#profile-dropdown').classList.add('hidden');
    });
    if (nativeApp?.isTv?.()) {
      // Lay out on a 1280x720 canvas that the WebView scales to fill the TV, so every box looks the same.
      document.querySelector('meta[name="viewport"]').setAttribute('content', 'width=1280, user-scalable=no');
      nav.tv = true;
      document.documentElement.classList.add('tv');
      enableNav();
    }
  }

  // ---------- Android app bridge ----------
  // Called by the Android back button. Returns true when the app handled it.
  window.embyflixBack = () => {
    // Leaving a text box that the remote can't otherwise get out of (Settings → Write a note on a TV).
    const typing = document.activeElement;
    if (typing?.__onBack && isTextInput(typing)) { typing.__onBack(); return true; }
    if (isPlayerOpen()) {
      if (tracksOpen()) closeTracks();
      else { hideStillWatching(); closePlayer(); }
      return true;
    }
    if (trailerOpen()) { closeTrailerWindow(); return true; }
    if ($('#page .tm-guide')?.__closeGroups?.()) return true;
    if (updateRequiredOpen()) return false; // Back leaves the app instead
    if (!$('#modal').classList.contains('hidden')) { closeModal(); return true; }
    if (!$('#profile-dropdown').classList.contains('hidden')) { $('#profile-dropdown').classList.add('hidden'); return true; }
    if (!$('#main').classList.contains('hidden') && location.hash && !/^#\/?(home)?$/.test(location.hash)) {
      location.hash = '#/home';
      return true;
    }
    return false;
  };

  // Called by the Android app for the remote's OK button and media keys.
  window.embyflixKey = (action) => handleKey(action, true);

  // ---------- Boot ----------
  async function boot() {
    setTimeout(hideSplash, SPLASH_MAX); // never leave anyone stuck on the splash
    if ($('#splash')) playSplashSound();
    if (liveReturn?.hash?.startsWith('#/') && (!location.hash || location.hash === '#' || location.hash === '#/')) history.replaceState(null, '', liveReturn.hash);
    loadConfig();
    autoCheckForUpdate();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - updates.lastCheck > RECHECK_AFTER) autoCheckForUpdate();
      // A TV left on the home screen for hours shows lists from when it was opened. Coming back after a long
      // time, load them again (the titles may have been removed or replaced meanwhile).
      if (!document.hidden && state.userId && Date.now() - lastRouteAt > 20 * 60000 && !isPlayerOpen()
        && $('#modal').classList.contains('hidden') && /^#\/(home|movies|tv|tvshows|series|)?$/.test(location.hash || '#/home')) {
        rowCache.clear();
        route();
      }
    });
    loadRemoteConfig();
    applySubtitleStyle();
    setupUi();
    applyRequiredUpdate(); // locked already (known from an earlier check), even without internet
    $('#setup-username').value = store.get('ef.username') || '';
    if (!state.apiKey || !state.userId) return showSetup();
    try {
      const user = await api(`/Users/${state.userId}`);
      upsertAccount(user, state.apiKey);
      await selectUser(user);
      hideSplashWhenHomeReady();
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        removeAccount(state.userId);
        state.apiKey = ''; store.del('ef.apiKey');
        showSetup('Your sign-in has expired. Please sign in again.');
      } else showSetup(connectionErrorMessage(e));
    }
  }

  boot();
})();
