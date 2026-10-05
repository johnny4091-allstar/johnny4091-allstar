/* EmbyFlix — a Netflix-style web client for Emby. Plain JS, no build step. */
(() => {
  'use strict';

  const DEFAULT_SERVER = 'https://emby4836.duckdns.org:8920';
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

  // authMode 'user': signed in with username/password, apiKey holds that user's access token.
  // authMode 'key': an admin API key, with a "Who's watching?" picker over all users.
  const state = { server: '', apiKey: '', authMode: 'user', userId: '', user: null, deviceId: '', views: [] };
  const CLIENT = { name: 'EmbyFlix', version: '1.1.0' };
  // Set by the Android wrapper (android/); undefined in a normal browser.
  const nativeApp = window.EmbyFlixAndroid || null;

  function normalizeServer(url) {
    let u = (url || '').trim().replace(/\/+$/, '');
    if (u && !/^https?:\/\//i.test(u)) u = 'http://' + u;
    return u.replace(/\/emby$/i, '');
  }

  function loadConfig() {
    const cfg = window.EMBYFLIX_CONFIG || {};
    state.server = normalizeServer(store.get('ef.server') || cfg.serverUrl || DEFAULT_SERVER);
    state.apiKey = store.get('ef.apiKey') || cfg.apiKey || '';
    state.authMode = store.get('ef.authMode') || (store.get('ef.apiKey') || cfg.apiKey ? 'key' : 'user');
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
    el.textContent = msg;
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

  async function api(path, { params, method = 'GET', body } = {}) {
    const opts = { method, headers: { Accept: 'application/json', 'X-Emby-Authorization': authHeader() } };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(apiUrl(path, params), opts);
    if (!res.ok) {
      const err = new Error(`Emby returned ${res.status} ${res.statusText}`);
      err.status = res.status;
      throw err;
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  function authHeader() {
    const device = /Mobi|Android/i.test(navigator.userAgent) ? 'Mobile Browser' : 'Web Browser';
    return `Emby UserId="${state.userId || ''}", Client="${CLIENT.name}", Device="${device}", DeviceId="${state.deviceId}", Version="${CLIENT.version}"`;
  }

  const userPath = (p) => `/Users/${state.userId}${p}`;

  function getItems(params) {
    return api(userPath('/Items'), { params: { Recursive: true, Fields: ITEM_FIELDS, ...IMAGE_PARAMS, ...params } });
  }

  function getItem(id) {
    return api(userPath(`/Items/${id}`), { params: { Fields: ITEM_FIELDS + ',People,Studios,Taglines,ChildCount' } });
  }

  function imageUrl(id, type, { tag, maxWidth, maxHeight, index } = {}) {
    if (!id) return '';
    const path = `/Items/${id}/Images/${type}` + (index != null ? `/${index}` : '');
    return apiUrl(path, { tag, maxWidth, maxHeight, quality: 90 });
  }

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

  function backdropImage(item, w = 1920) {
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
    const colors = ['#e50914', '#2f80ed', '#f2c94c', '#27ae60', '#9b51e0', '#eb5757'];
    const name = user.Name || '?';
    return {
      color: colors[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length],
      initial: name[0].toUpperCase(),
      image: user.PrimaryImageTag ? apiUrl(`/Users/${user.Id}/Images/Primary`, { tag: user.PrimaryImageTag, maxWidth: 300 }) : '',
    };
  }

  function avatarHtml(user) {
    const a = avatarInfo(user);
    return a.image
      ? `<div class="avatar" style="background-image:url('${esc(a.image)}')"></div>`
      : `<div class="avatar" style="background:${a.color}">${esc(a.initial)}</div>`;
  }

  // ---------- Screens ----------
  function showScreen(name) {
    $('#setup').classList.toggle('hidden', name !== 'setup');
    $('#profiles').classList.toggle('hidden', name !== 'profiles');
    $('#main').classList.toggle('hidden', name !== 'main');
  }

  function showSetup(errorMsg) {
    showScreen('setup');
    $('#setup-server').value = state.server;
    $('#setup-key').value = state.authMode === 'key' ? state.apiKey : '';
    $('#setup-password').value = '';
    setSetupMode(state.authMode);
    const err = $('#setup-error');
    err.textContent = errorMsg || '';
    err.classList.toggle('hidden', !errorMsg);
    updateMixedContentWarning();
  }

  function setSetupMode(mode) {
    $('#setup-form').dataset.mode = mode;
    $$('#setup-form [data-mode]').forEach((el) => el.classList.toggle('hidden', el.dataset.mode !== mode));
    $('#setup-username').required = mode === 'user';
    $('#setup-key').required = mode === 'key';
    $('#setup-title').textContent = mode === 'user' ? 'Sign In' : 'Connect with an API key';
    $('#setup-mode-toggle').textContent = mode === 'user' ? 'Use an API key instead' : 'Sign in with username and password instead';
    $('#setup-form button[type="submit"]').textContent = mode === 'user' ? 'Sign In' : 'Connect';
  }

  function updateMixedContentWarning() {
    const server = normalizeServer($('#setup-server').value);
    const warn = $('#setup-warning');
    // The Android app allows http:// servers, so only browsers need the warning.
    const blocked = !nativeApp && location.protocol === 'https:' && server.startsWith('http:');
    warn.textContent = blocked
      ? 'This page is loaded over HTTPS but your server uses HTTP, so the browser will block it. Open EmbyFlix from your computer (double-click index.html) or serve it over plain HTTP, or put your Emby server behind HTTPS.'
      : '';
    warn.classList.toggle('hidden', !blocked);
  }

  async function connect(server, apiKey) {
    state.server = normalizeServer(server);
    state.apiKey = apiKey.trim();
    state.authMode = 'key';
    await api('/System/Info'); // validates server + key
    store.set('ef.server', state.server);
    store.set('ef.apiKey', state.apiKey);
    store.set('ef.authMode', 'key');
  }

  async function signIn(server, username, password) {
    state.server = normalizeServer(server);
    state.apiKey = '';
    state.userId = '';
    const res = await api('/Users/AuthenticateByName', { method: 'POST', body: { Username: username, Pw: password } });
    if (!res?.AccessToken || !res.User) throw new Error('Unexpected response from server');
    state.apiKey = res.AccessToken;
    state.authMode = 'user';
    store.set('ef.server', state.server);
    store.set('ef.apiKey', state.apiKey);
    store.set('ef.authMode', 'user');
    store.set('ef.username', username);
    return res.User;
  }

  async function signOut() {
    if (state.authMode === 'user' && state.apiKey) {
      await api('/Sessions/Logout', { method: 'POST' }).catch(() => {});
      state.apiKey = '';
      store.del('ef.apiKey');
    }
    state.userId = '';
    store.del('ef.userId');
    showSetup();
  }

  async function showProfiles() {
    showScreen('profiles');
    closeModal();
    const list = $('#profile-list');
    list.innerHTML = '<div class="spinner"></div>';
    try {
      const users = (await api('/Users', { params: { IsHidden: false, IsDisabled: false } })) || [];
      if (!users.length) {
        list.innerHTML = '<p class="empty-msg">No users found on this server.</p>';
        return;
      }
      list.innerHTML = users.map((u) => `
        <button class="profile" data-id="${esc(u.Id)}">
          ${avatarHtml(u)}
          <span>${esc(u.Name)}</span>
        </button>`).join('');
      $$('.profile', list).forEach((btn) => btn.addEventListener('click', () => {
        selectUser(users.find((u) => u.Id === btn.dataset.id));
      }));
    } catch (e) {
      showSetup(connectionErrorMessage(e));
    }
  }

  async function selectUser(user) {
    state.userId = user.Id;
    state.user = user;
    store.set('ef.userId', user.Id);
    const a = avatarInfo(user), btn = $('#profile-btn');
    btn.style.backgroundImage = a.image ? `url("${a.image}")` : '';
    btn.style.backgroundColor = a.image ? '' : a.color;
    btn.textContent = a.image ? '' : a.initial;
    btn.title = user.Name || '';
    $('#profile-dropdown [data-action="switch"]').classList.toggle('hidden', state.authMode !== 'key');
    try {
      const views = await api(userPath('/Views'));
      state.views = views?.Items || [];
    } catch { state.views = []; }
    showScreen('main');
    if (!location.hash || location.hash === '#' || location.hash === '#/') location.hash = '#/home';
    else route();
  }

  function connectionErrorMessage(e) {
    if (e.status === 401 || e.status === 403) {
      return state.authMode === 'user' ? 'Incorrect username or password.' : 'The API key was rejected by the server.';
    }
    if (e.status) return `Server error: ${e.message}`;
    if (state.server.startsWith('https:')) {
      return `Could not reach the server. Check that Emby is running and that ${state.server} opens in this browser without a certificate warning.`;
    }
    return 'Could not reach the server. Check the address, that Emby is running, and that this device can reach it.';
  }

  // ---------- Router ----------
  let routeToken = 0;

  function route() {
    if (!state.userId) return;
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
      case 'search': return renderSearch(page, params.get('q') || '', isCurrent);
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
            <button class="btn btn-white" data-act="play">${ICONS.play} Play</button>
            <button class="btn btn-gray" data-act="info">${ICONS.info} More Info</button>
          </div>
        </div>`;
      $('[data-act="play"]', hero).addEventListener('click', () => playItem(item));
      $('[data-act="info"]', hero).addEventListener('click', () => openDetails(item.Id));
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
    add('Next Up', async () =>
      (await api('/Shows/NextUp', { params: { UserId: state.userId, Limit: 20, Fields: ITEM_FIELDS, ...IMAGE_PARAMS } }))?.Items);
    add('My List', async () =>
      (await getItems({ Filters: 'IsFavorite', IncludeItemTypes: 'Movie,Series', SortBy: 'DateCreated', SortOrder: 'Descending', Limit: 20 }))?.Items);

    const videoViews = state.views.filter((v) => ['movies', 'tvshows', 'homevideos', 'musicvideos', undefined, null, ''].includes(v.CollectionType));
    for (const view of videoViews) {
      add(`Recently Added in ${view.Name}`, () =>
        api(userPath('/Items/Latest'), { params: { ParentId: view.Id, Limit: 20, Fields: ITEM_FIELDS, ...IMAGE_PARAMS } }));
    }

    add('Top Rated Movies', async () =>
      (await getItems({ IncludeItemTypes: 'Movie', SortBy: 'CommunityRating', SortOrder: 'Descending', Limit: 20 }))?.Items);
    add('Popular TV Shows', async () =>
      (await getItems({ IncludeItemTypes: 'Series', SortBy: 'CommunityRating', SortOrder: 'Descending', Limit: 20 }))?.Items);

    // A few random genre rows, Netflix-style.
    (async () => {
      try {
        const genres = (await api('/Genres', { params: { UserId: state.userId, IncludeItemTypes: 'Movie,Series', Recursive: true, SortBy: 'SortName' } }))?.Items || [];
        if (!isCurrent()) return;
        for (const g of shuffle(genres).slice(0, 5)) {
          add(g.Name, async () =>
            (await getItems({ IncludeItemTypes: 'Movie,Series', GenreIds: g.Id, SortBy: 'Random', Limit: 20 }))?.Items);
        }
      } catch (e) { console.error(e); }
    })();
  }

  // ---------- Rows & cards ----------
  function addRow(container, title, loader, { isCurrent, showProgress } = {}) {
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
          <button class="row-arrow left" aria-label="Scroll left">&#8249;</button>
          <div class="row-track"></div>
          <button class="row-arrow right" aria-label="Scroll right">&#8250;</button>
        </div>`;
      const track = $('.row-track', row);
      items.forEach((item) => track.appendChild(createCard(item, { showProgress })));
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
    $('.card-play', card).addEventListener('click', (e) => { e.stopPropagation(); playItem(item); });
    card.addEventListener('click', () => openItem(item));
    return card;
  }

  function createPoster(item) {
    const el = document.createElement('div');
    el.className = 'poster';
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
    if (item.Type === 'Episode' && item.SeriesId) openDetails(item.SeriesId, { focusEpisode: item });
    else if (item.Type === 'Season' && item.SeriesId) openDetails(item.SeriesId, { seasonId: item.Id });
    else openDetails(item.Id);
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
  function renderSearch(page, q, isCurrent) {
    $('#search-box').classList.add('open');
    const input = $('#search-input');
    if (input.value !== q) input.value = q;
    page.innerHTML = `<div class="page-pad"><div class="page-head"><h1></h1></div><div class="grid"></div><div class="sentinel"></div></div>`;
    $('h1', page).textContent = q ? `Results for "${q}"` : 'Search';
    if (!q) {
      $('.grid', page).innerHTML = '<p class="empty-msg" style="grid-column:1/-1">Type to search your library.</p>';
      return;
    }
    const pager = makePager($('.grid', page), $('.sentinel', page), isCurrent, (start, limit) =>
      getItems({ SearchTerm: q, IncludeItemTypes: 'Movie,Series,Episode', StartIndex: start, Limit: limit }));
    pager.reset();
  }

  // ---------- Details modal ----------
  let modalToken = 0;

  function closeModal() {
    modalToken++;
    $('#modal').classList.add('hidden');
    document.body.style.overflow = '';
  }

  async function openDetails(id, { focusEpisode, seasonId } = {}) {
    const token = ++modalToken;
    const modal = $('#modal'), content = $('#modal-content');
    content.innerHTML = '<div class="spinner" style="margin:6rem auto"></div>';
    modal.classList.remove('hidden');
    modal.scrollTop = 0;
    document.body.style.overflow = 'hidden';

    let item;
    try { item = await getItem(id); } catch (e) {
      if (token === modalToken) content.innerHTML = `<p class="empty-msg">Could not load details: ${esc(e.message)}</p>`;
      return;
    }
    if (token !== modalToken) return;

    const isSeries = item.Type === 'Series';
    const logo = logoImage(item);
    const people = (item.People || []).filter((p) => p.Type === 'Actor').slice(0, 6).map((p) => p.Name);
    const directors = (item.People || []).filter((p) => p.Type === 'Director').map((p) => p.Name);
    const match = item.CommunityRating ? Math.round(item.CommunityRating * 10) : null;
    const resumeTicks = item.UserData?.PlaybackPositionTicks || 0;

    content.innerHTML = `
      <div class="m-hero" style="background-image:url('${esc(backdropImage(item, 1280))}')">
        <div class="m-hero-content">
          ${logo ? `<img class="hero-logo" src="${esc(logo)}" alt="${esc(item.Name)}">` : `<h2>${esc(item.Name)}</h2>`}
          <div class="m-actions">
            <button class="btn btn-white" data-act="play">${ICONS.play} <span>${resumeTicks ? 'Resume' : 'Play'}</span></button>
            ${resumeTicks ? `<button class="btn btn-gray" data-act="restart">Start Over</button>` : ''}
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
        ${seasons.length > 1
          ? `<select>${seasons.map((s) => `<option value="${esc(s.Id)}"${s.Id === selected.Id ? ' selected' : ''}>${esc(s.Name)}</option>`).join('')}</select>`
          : `<span style="color:var(--muted)">${esc(selected.Name)}</span>`}
      </div>
      <div data-episodes></div>`;
    const list = $('[data-episodes]', container);

    const load = async (seasonId) => {
      list.innerHTML = '<div class="spinner"></div>';
      try {
        const eps = (await api(`/Shows/${series.Id}/Episodes`, { params: { SeasonId: seasonId, UserId: state.userId, Fields: ITEM_FIELDS, ...IMAGE_PARAMS } }))?.Items || [];
        if (token !== modalToken) return;
        list.innerHTML = '';
        if (!eps.length) list.innerHTML = '<p class="empty-msg">No episodes.</p>';
        for (const ep of eps) {
          const row = document.createElement('div');
          row.className = 'episode' + (ep.Id === currentEpisodeId ? ' current' : '');
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
        $('.episode.current', list)?.scrollIntoView({ block: 'nearest' });
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

  // ---------- Player ----------
  const player = {
    item: null, hls: null, playSessionId: null, mediaSourceId: null, playMethod: null,
    progressTimer: null, idleTimer: null, nextEpisode: null, startSeconds: 0,
  };

  // Tells Emby what this browser can play directly; anything else is transcoded to HLS H.264/AAC.
  function deviceProfile() {
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
      Name: 'EmbyFlix',
      MaxStreamingBitrate: 120000000,
      MaxStaticBitrate: 120000000,
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
      SubtitleProfiles: [
        { Format: 'vtt', Method: 'External' },
        { Format: 'srt', Method: 'Encode' },
        { Format: 'ass', Method: 'Encode' },
        { Format: 'ssa', Method: 'Encode' },
        { Format: 'pgssub', Method: 'Encode' },
        { Format: 'dvdsub', Method: 'Encode' },
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

  async function playItem(rawItem, { startTicks } = {}) {
    await stopPlayback();
    const el = $('#player'), video = $('#video'), status = $('#player-status');
    el.classList.remove('hidden');
    nativeApp?.setPlayerMode(true);
    status.innerHTML = '<div class="spinner"></div>';
    status.classList.remove('hidden');
    $('#player-next').classList.add('hidden');
    document.body.style.overflow = 'hidden';
    // The Android app goes full screen natively via setPlayerMode.
    if (!nativeApp) { try { await el.requestFullscreen?.(); } catch { /* not allowed, fine */ } }

    try {
      const item = await resolvePlayable(rawItem);
      // Refresh to get accurate resume position + user data.
      const full = await getItem(item.Id);
      player.item = full;
      const start = startTicks ?? full.UserData?.PlaybackPositionTicks ?? 0;
      player.startSeconds = start / TICKS_PER_SECOND;

      $('#player-title').innerHTML = full.Type === 'Episode'
        ? `${esc(full.SeriesName)}<span class="sub">${esc(episodeLabel(full))}</span>`
        : esc(full.Name);

      const info = await api(`/Items/${full.Id}/PlaybackInfo`, {
        method: 'POST',
        params: { UserId: state.userId, IsPlayback: true, AutoOpenLiveStream: true, MaxStreamingBitrate: 120000000 },
        body: { DeviceProfile: deviceProfile() },
      });
      const source = info?.MediaSources?.[0];
      if (!source) throw new Error(info?.ErrorCode || 'No playable media source');
      player.playSessionId = info.PlaySessionId;
      player.mediaSourceId = source.Id;

      let url, isHls = false;
      if (source.TranscodingUrl) {
        url = state.server + (source.TranscodingUrl.startsWith('/') ? '' : '/') + source.TranscodingUrl;
        if (!/[?&]api_key=/i.test(url)) url += (url.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(state.apiKey);
        isHls = source.TranscodingSubProtocol === 'hls' || /\.m3u8/i.test(url);
        player.playMethod = 'Transcode';
      } else {
        const container = (source.Container || 'mp4').split(',')[0];
        url = apiUrl(`/Videos/${full.Id}/stream.${container}`, {
          Static: true, MediaSourceId: source.Id, PlaySessionId: info.PlaySessionId, DeviceId: state.deviceId,
        });
        player.playMethod = source.SupportsDirectPlay ? 'DirectPlay' : 'DirectStream';
      }

      // External VTT subtitles (default track) when available.
      $$('track', video).forEach((t) => t.remove());
      for (const s of source.MediaStreams || []) {
        if (s.Type === 'Subtitle' && s.DeliveryMethod === 'External' && s.DeliveryUrl) {
          const track = document.createElement('track');
          track.kind = 'subtitles';
          track.label = s.DisplayTitle || s.Language || 'Subtitles';
          track.srclang = s.Language || 'und';
          track.src = state.server + (s.DeliveryUrl.startsWith('/') ? '' : '/') + s.DeliveryUrl;
          if (!/[?&]api_key=/i.test(track.src)) track.src += (track.src.includes('?') ? '&' : '?') + 'api_key=' + encodeURIComponent(state.apiKey);
          if (s.Index === source.DefaultSubtitleStreamIndex) track.default = true;
          video.appendChild(track);
        }
      }

      await attachSource(video, url, isHls, player.startSeconds);
      status.classList.add('hidden');
      reportPlayback('/Sessions/Playing');
      player.progressTimer = setInterval(() => reportPlayback('/Sessions/Playing/Progress', 'TimeUpdate'), 10000);
      if (full.Type === 'Episode') findNextEpisode(full);
    } catch (e) {
      console.error(e);
      status.innerHTML = `<p>Playback failed: ${esc(e.message)}</p><button class="btn btn-white" id="player-err-back">Go Back</button>`;
      $('#player-err-back').addEventListener('click', closePlayer);
    }
  }

  function attachSource(video, url, isHls, startSeconds) {
    return new Promise((resolve, reject) => {
      const onReady = () => {
        if (startSeconds > 0 && Math.abs(video.currentTime - startSeconds) > 2) video.currentTime = startSeconds;
        video.play().catch(() => { /* autoplay may need a click */ });
        resolve();
      };
      if (isHls && !video.canPlayType('application/vnd.apple.mpegurl') && window.Hls?.isSupported()) {
        const hls = new window.Hls({ startPosition: startSeconds || -1, maxBufferLength: 30 });
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

  function reportPlayback(path, eventName) {
    if (!player.item) return Promise.resolve();
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
      CanSeek: true,
      EventName: eventName,
    };
    return api(path, { method: 'POST', body }).catch((e) => console.warn('report failed', e));
  }

  async function findNextEpisode(ep) {
    player.nextEpisode = null;
    try {
      const res = await api(`/Shows/${ep.SeriesId}/Episodes`, { params: { UserId: state.userId, StartItemId: ep.Id, Limit: 2, Fields: ITEM_FIELDS } });
      const next = res?.Items?.find((i) => i.Id !== ep.Id);
      if (next && player.item?.Id === ep.Id) {
        player.nextEpisode = next;
        const btn = $('#player-next');
        btn.title = episodeLabel(next);
        btn.classList.remove('hidden');
      }
    } catch { /* ignore */ }
  }

  async function stopPlayback() {
    clearInterval(player.progressTimer);
    const video = $('#video');
    if (player.item) {
      const playSessionId = player.playSessionId;
      const wasTranscoding = player.playMethod === 'Transcode';
      await reportPlayback('/Sessions/Playing/Stopped');
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
  }

  async function closePlayer() {
    await stopPlayback();
    $('#player').classList.add('hidden');
    nativeApp?.setPlayerMode(false);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    document.body.style.overflow = $('#modal').classList.contains('hidden') ? '' : 'hidden';
    // Refresh what's on screen so "Continue Watching" and progress bars update.
    if ($('#modal').classList.contains('hidden')) route();
  }

  function setupPlayer() {
    const el = $('#player'), video = $('#video');
    $('#player-back').addEventListener('click', closePlayer);
    $('#player-next').addEventListener('click', () => { if (player.nextEpisode) playItem(player.nextEpisode, { startTicks: 0 }); });
    video.addEventListener('pause', () => reportPlayback('/Sessions/Playing/Progress', 'Pause'));
    video.addEventListener('play', () => reportPlayback('/Sessions/Playing/Progress', 'Unpause'));
    video.addEventListener('ended', () => {
      if (player.nextEpisode) playItem(player.nextEpisode, { startTicks: 0 });
      else closePlayer();
    });
    const wake = () => {
      el.classList.remove('idle');
      clearTimeout(player.idleTimer);
      player.idleTimer = setTimeout(() => { if (!video.paused) el.classList.add('idle'); }, 3000);
    };
    el.addEventListener('mousemove', wake);
    el.addEventListener('touchstart', wake, { passive: true });
    video.addEventListener('pause', wake);
    window.addEventListener('beforeunload', () => { if (player.item) reportPlayback('/Sessions/Playing/Stopped'); });
  }

  // ---------- Icons ----------
  const ICONS = {
    play: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M6 4v16a1 1 0 0 0 1.52.85l13-8a1 1 0 0 0 0-1.7l-13-8A1 1 0 0 0 6 4Z"/></svg>',
    info: '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M12 2a10 10 0 1 1 0 20 10 10 0 0 1 0-20Zm0 2a8 8 0 1 0 0 16 8 8 0 0 0 0-16Zm1 6v8h-2v-8h2Zm0-4v2h-2V6h2Z"/></svg>',
    eye: '<svg viewBox="0 0 24 24" width="20" height="20"><path fill="currentColor" d="M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17Z"/></svg>',
  };

  // ---------- Global UI wiring ----------
  function toggleProfileDropdown(e) {
    e.stopPropagation();
    $('#profile-dropdown').classList.toggle('hidden');
  }

  function setupUi() {
    $('#setup-server').addEventListener('input', updateMixedContentWarning);
    $('#setup-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = $('button[type="submit"]', e.target);
      btn.disabled = true; btn.textContent = 'Connecting…';
      try {
        if (e.target.dataset.mode === 'key') {
          await connect($('#setup-server').value, $('#setup-key').value);
          state.userId = ''; store.del('ef.userId');
          await showProfiles();
        } else {
          const user = await signIn($('#setup-server').value, $('#setup-username').value.trim(), $('#setup-password').value);
          await selectUser(user);
        }
      } catch (err) {
        const mode = e.target.dataset.mode;
        state.authMode = mode;
        showSetup(connectionErrorMessage(err));
      } finally {
        btn.disabled = false;
        setSetupMode(e.target.dataset.mode);
      }
    });
    $('#setup-mode-toggle').addEventListener('click', () => {
      setSetupMode($('#setup-form').dataset.mode === 'user' ? 'key' : 'user');
      $('#setup-error').classList.add('hidden');
    });
    $('#profiles-settings').addEventListener('click', () => showSetup());

    $('#profile-btn').addEventListener('click', toggleProfileDropdown);
    document.addEventListener('click', () => $('#profile-dropdown').classList.add('hidden'));
    $('#profile-dropdown').addEventListener('click', (e) => {
      const act = e.target.dataset.action;
      if (act === 'switch') { state.userId = ''; store.del('ef.userId'); showProfiles(); }
      if (act === 'signout') signOut();
    });

    // Search
    const box = $('#search-box'), input = $('#search-input');
    let searchTimer;
    $('#search-toggle').addEventListener('click', () => {
      box.classList.toggle('open');
      if (box.classList.contains('open')) input.focus();
    });
    input.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        const q = input.value.trim();
        const target = q ? '#/search?q=' + encodeURIComponent(q) : '#/home';
        if (location.hash !== target) location.hash = target;
      }, 350);
    });
    input.addEventListener('blur', () => { if (!input.value) box.classList.remove('open'); });

    // Modal
    $$('[data-close]').forEach((el) => el.addEventListener('click', closeModal));
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('#player').classList.contains('hidden')) { if (!document.fullscreenElement) closePlayer(); }
      else if (!$('#modal').classList.contains('hidden')) closeModal();
    });

    // Solid nav on scroll
    window.addEventListener('scroll', () => $('#nav').classList.toggle('solid', window.scrollY > 40), { passive: true });
    window.addEventListener('hashchange', () => { closeModal(); route(); });

    setupPlayer();
  }

  // ---------- Android app bridge ----------
  // Called by the Android back button. Returns true when the app handled it.
  window.embyflixBack = () => {
    if (!$('#player').classList.contains('hidden')) { closePlayer(); return true; }
    if (!$('#modal').classList.contains('hidden')) { closeModal(); return true; }
    if (!$('#profile-dropdown').classList.contains('hidden')) { $('#profile-dropdown').classList.add('hidden'); return true; }
    if (!$('#main').classList.contains('hidden') && location.hash && !/^#\/?(home)?$/.test(location.hash)) {
      location.hash = '#/home';
      return true;
    }
    return false;
  };

  // ---------- Boot ----------
  async function boot() {
    loadConfig();
    setupUi();
    $('#setup-username').value = store.get('ef.username') || '';
    if (!state.server || !state.apiKey) return showSetup();
    if (!state.userId) return state.authMode === 'key' ? showProfiles() : showSetup();
    try {
      const user = await api(`/Users/${state.userId}`);
      await selectUser(user);
    } catch (e) {
      if (state.authMode === 'user' && (e.status === 401 || e.status === 403)) {
        state.apiKey = ''; store.del('ef.apiKey');
        showSetup('Your sign-in has expired. Please sign in again.');
      } else if (e.status && state.authMode === 'key') { store.del('ef.userId'); state.userId = ''; showProfiles(); }
      else showSetup(connectionErrorMessage(e));
    }
  }

  boot();
})();
