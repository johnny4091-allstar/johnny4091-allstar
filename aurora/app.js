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

  // keepalive lets a request finish even if the app is being closed or sent to the background.
  async function api(path, { params, method = 'GET', body, keepalive = false } = {}) {
    const opts = { method, keepalive, headers: { Accept: 'application/json', 'X-Emby-Authorization': authHeader() } };
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
    return api(userPath(`/Items/${id}`), { params: { Fields: ITEM_FIELDS + ',People,Studios,Taglines,ChildCount,RemoteTrailers' } });
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
    const colors = ['#18b6d6', '#4f7bff', '#7a5cff', '#2ad4a0', '#c05cff', '#3a8dde'];
    const name = user.Name || '?';
    return {
      color: colors[[...name].reduce((a, c) => a + c.charCodeAt(0), 0) % colors.length],
      initial: name[0].toUpperCase(),
      image: user.PrimaryImageTag ? apiUrl(`/Users/${user.Id}/Images/Primary`, { tag: user.PrimaryImageTag, maxWidth: 300 }) : '',
    };
  }

  // ---------- Screens ----------
  function showScreen(name) {
    $('#setup').classList.toggle('hidden', name !== 'setup');
    $('#main').classList.toggle('hidden', name !== 'main');
  }

  function showSetup(errorMsg) {
    closeModal();
    showScreen('setup');
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

  async function selectUser(user) {
    state.userId = user.Id;
    state.user = user;
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
    try {
      const views = await api(userPath('/Views'));
      state.views = views?.Items || [];
    } catch { state.views = []; }
    $$('[data-route="livetv"]').forEach((a) => a.classList.toggle('hidden', !hasLiveTv()));
    updateRequestsLink();
    live.channelIds = [];
    showScreen('main');
    if (!location.hash || location.hash === '#' || location.hash === '#/') location.hash = '#/home';
    else route();
  }

  function connectionErrorMessage(e) {
    if (e.status === 401 || e.status === 403) return 'Incorrect username or password.';
    if (e.status) return `Server error: ${e.message}`;
    return 'Could not reach the Emby server. Check your internet connection and that the server is running.';
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
      case 'search': return renderSearch(page, params.get('q') || '', isCurrent, params.get('person') || '', params.get('name') || '');
      case 'livetv': return renderLiveTv(page, params.get('tab') || 'guide', isCurrent);
      case 'settings': return renderSettings(page, isCurrent);
      case 'requests': return renderRequests(page, isCurrent);
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
    if (hasLiveTv()) {
      addRow(rows, 'On Now', async () => (await getChannels({ Limit: 20 }))?.Items?.filter((c) => c.CurrentProgram),
        { isCurrent, createItem: createChannelCard });
    }
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

  function closeModal() {
    modalToken++;
    if ($('#modal').classList.contains('hidden')) return;
    $('#modal').classList.add('hidden');
    document.body.style.overflow = '';
    restoreFocus('modal');
  }

  async function openDetails(id, { focusEpisode, seasonId } = {}) {
    const token = ++modalToken;
    const modal = $('#modal'), content = $('#modal-content');
    if (modal.classList.contains('hidden')) rememberFocus('modal');
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
  function nativeHttp(method, url, headers, body) {
    return new Promise((resolve, reject) => {
      const id = 'h' + (++httpSeq);
      const timer = setTimeout(() => { httpPending.delete(id); reject(new Error('The request server took too long to answer.')); }, 30000);
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
    const req = m.request; // set for "My Requests" cards
    if (req?.status === 3) return 'Declined';
    if (MEDIA_STATUS[m.mediaInfo?.status]) return MEDIA_STATUS[m.mediaInfo.status];
    if (req) return REQUEST_STATUS[req.status] || 'Requested';
    return '';
  }

  function createSeerrCard(m) {
    const card = document.createElement('div');
    card.className = 'card seerr-card';
    card.tabIndex = 0;
    const img = tmdbImage(m.backdropPath, 'w500') || tmdbImage(m.posterPath, 'w342');
    const status = seerrStatus(m);
    const kind = m.mediaType === 'tv' ? 'Series' : 'Movie';
    card.innerHTML = `
      ${img ? `<img loading="lazy" src="${esc(img)}" alt=""${m.backdropPath ? '' : ' class="contain"'}>` : `<div class="card-fallback">${esc(seerrTitle(m))}</div>`}
      ${status ? `<span class="seerr-badge s-${esc(status.split(' ')[0].toLowerCase())}">${esc(status)}</span>` : ''}
      <div class="card-info"><div>${esc(seerrTitle(m))}</div><div class="sub">${esc([seerrYear(m), kind].filter(Boolean).join(' • '))}</div></div>`;
    card.addEventListener('click', () => openSeerrItem(m.mediaType, m.id));
    return card;
  }

  const onlyMedia = (results) => (results || []).filter((m) => m.mediaType === 'movie' || m.mediaType === 'tv');

  async function myRequests(me) {
    const { data } = await seerr(`/request?take=20&skip=0&sort=added&filter=all&requestedBy=${me.id}`);
    const reqs = data?.results || [];
    // Requests only carry the TMDB id; fetch titles and pictures alongside.
    const detailed = await Promise.allSettled(reqs.map(async (r) => {
      const type = r.media?.mediaType || r.type;
      const { data: m } = await seerr(`/${type}/${r.media.tmdbId}`);
      return { ...m, mediaType: type, request: r };
    }));
    return detailed.filter((d) => d.status === 'fulfilled').map((d) => d.value);
  }

  async function renderRequests(page, isCurrent) {
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
          <div class="req-search hidden"><input type="search" placeholder="Search for a movie or show to request" autocomplete="off"></div>
        </div>
        <div data-req-body><div class="spinner"></div></div>
      </div>`;
    const body = $('[data-req-body]', page);
    let me;
    try { me = await seerrMe(); } catch (e) {
      if (isCurrent()) body.innerHTML = `<p class="empty-msg">${esc(e.message)}</p>`;
      return;
    }
    if (!isCurrent()) return;
    if (!me) return renderRequestsConnect(page, body, isCurrent);

    const searchBox = $('.req-search', page), input = $('input', searchBox);
    searchBox.classList.remove('hidden');
    const showBrowse = () => {
      body.innerHTML = '';
      const rows = document.createElement('div');
      rows.className = 'rows flush-rows';
      body.appendChild(rows);
      const add = (title, loader) => addRow(rows, title, loader, { isCurrent, createItem: createSeerrCard });
      add('My Requests', () => myRequests(me));
      add('Trending', async () => onlyMedia((await seerr('/discover/trending?page=1')).data?.results));
      add('Popular Movies', async () => onlyMedia((await seerr('/discover/movies?page=1')).data?.results));
      add('Popular TV Shows', async () => onlyMedia((await seerr('/discover/tv?page=1')).data?.results));
      add('Coming Soon', async () => onlyMedia((await seerr('/discover/movies/upcoming?page=1')).data?.results));
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
        toast(`Requested ${seerrTitle(m)}`);
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

  // Reads the current Requests address from aurora-config.json in the repo, so a changed address
  // (a restarted Cloudflare quick tunnel, say) reaches every installed app without an update.
  async function loadRemoteConfig() {
    for (const url of REMOTE_CONFIG_URLS) {
      try {
        const res = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) continue;
        const cfg = await res.json();
        const value = typeof cfg.requestsServer === 'string' ? cfg.requestsServer.trim().replace(/\/+$/, '') : '';
        if (value && !/^https?:\/\//.test(value)) return;
        const enabled = cfg.requestsEnabled === true && !!value;
        if (value !== state.requestsServer || enabled !== state.requestsEnabled) {
          state.requestsServer = value;
          state.requestsEnabled = enabled;
          store.set('ef.requestsServer', value);
          store.set('ef.requestsEnabled', enabled ? '1' : '0');
          updateRequestsLink();
          if (/^#\/requests/.test(location.hash)) route();
        }
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
  const PREF_DEFAULTS = { autoplay: 'on', stillWatching: 'on', subSize: 'm', subBg: 'semi' };
  const getPref = (key) => store.get('ef.pref.' + key) || PREF_DEFAULTS[key];
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

  const selectHtml = (name, options, value) =>
    `<select data-setting="${name}">${options.map(([v, label]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select>`;
  const settingRow = (label, help, control) =>
    `<div class="setting-row"><div class="setting-label"><strong>${esc(label)}</strong>${help ? `<span>${esc(help)}</span>` : ''}</div>${control}</div>`;

  async function renderSettings(page, isCurrent) {
    page.innerHTML = `<div class="page-pad settings-page"><div class="page-head"><h1>Settings</h1></div><div class="spinner"></div></div>`;
    let user = state.user;
    try { user = await api(`/Users/${state.userId}`); state.user = user; } catch { /* fall back to what we have */ }
    if (!isCurrent()) return;
    const cfg = user?.Configuration || {};
    const langs = (value) => (value && !LANGUAGES.some(([v]) => v === value) ? [...LANGUAGES, [value, value]] : LANGUAGES);
    const version = nativeApp?.getVersionName ? `Aurora ${nativeApp.getVersionName()} for Android` : 'Aurora (web)';

    $('.settings-page', page).innerHTML = `
      <div class="page-head"><h1>Settings</h1></div>
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
        ${settingRow('Auto-play next episode', 'Count down and start the next episode when the credits roll.', selectHtml('autoplay', [['on', 'On'], ['off', 'Off']], getPref('autoplay')))}
        ${settingRow('"Are you still watching?"', 'Pause after 3 episodes, or 4 hours of Live TV, with no button pressed.', selectHtml('stillWatching', [['on', 'On'], ['off', 'Off']], getPref('stillWatching')))}
        ${settingRow('Streaming quality', 'Lower it if videos keep buffering.', selectHtml('quality', QUALITY_OPTIONS.map((q) => [q.bitrate, q.label]), maxBitrate()))}
      </section>
      <section class="settings-section">
        <h2>About</h2>
        ${settingRow('Version', null, `<span class="setting-value">${esc(version)}</span>`)}
        ${settingRow('Signed in as', null, `<span class="setting-value">${esc(user?.Name || '')}</span>`)}
        ${nativeApp?.getVersionCode ? settingRow('Updates', null, '<div class="update-check"><span class="setting-value" data-update-status></span><button class="btn btn-gray" data-check-update>Check for updates</button></div>') : ''}
      </section>`;
    applySubtitleStyle();

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
        default: setPref(sel.dataset.setting, v); applySubtitleStyle(); toast('Saved', 1500);
      }
    });
    $('[data-check-update]', page)?.addEventListener('click', async () => {
      const status = $('[data-update-status]', page);
      status.textContent = 'Checking…';
      const result = await checkForUpdate();
      if (result.status === 'available') { status.textContent = `${result.version} available`; showUpdatePrompt(result); }
      else status.textContent = result.status === 'current' ? "You're up to date." : "Couldn't check for updates. Try again later.";
    });
  }

  // ---------- App updates (Android app only) ----------
  // Customers install the APK by hand, so the app checks GitHub Releases for a newer build itself.
  const RELEASES_URL = 'https://api.github.com/repos/johnny4091-allstar/johnny4091-allstar/releases/latest';
  const RECHECK_AFTER = 15 * 60000; // when coming back to the app
  const updates = { checking: null, lastCheck: 0, dismissedCode: 0, waiting: null };

  async function checkForUpdate() {
    if (!nativeApp?.getVersionCode) return { status: 'web' };
    try {
      // Always ask GitHub fresh, and give up after 8 seconds rather than hanging on a slow connection.
      const res = await fetch(RELEASES_URL, {
        headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store', signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(res.status);
      const rel = await res.json();
      const code = Number((rel.tag_name || '').match(/(\d+)$/)?.[1] || 0);
      const apk = (rel.assets || []).find((a) => /\.apk$/i.test(a.name));
      if (!apk || code <= nativeApp.getVersionCode()) return { status: 'current' };
      return { status: 'available', code, version: rel.name || rel.tag_name, url: apk.browser_download_url };
    } catch {
      return { status: 'error' };
    }
  }

  // Runs as soon as the app opens, and again when it comes back to the front after a while.
  async function autoCheckForUpdate() {
    if (!nativeApp?.getVersionCode || updates.checking) return;
    updates.lastCheck = Date.now();
    updates.checking = checkForUpdate();
    const result = await updates.checking;
    updates.checking = null;
    if (result.status !== 'available' || result.code === updates.dismissedCode) return;
    if ($('#modal .update-body')) return; // already asking
    // Don't interrupt a video; ask as soon as the player closes.
    if (isPlayerOpen()) { updates.waiting = result; return; }
    showUpdatePrompt(result);
  }

  function showWaitingUpdate() {
    const result = updates.waiting;
    updates.waiting = null;
    if (result && result.code !== updates.dismissedCode && !$('#modal .update-body')) showUpdatePrompt(result);
  }

  function showUpdatePrompt(update) {
    const modal = $('#modal'), content = $('#modal-content');
    modalToken++;
    if (modal.classList.contains('hidden')) rememberFocus('modal');
    content.innerHTML = `
      <div class="m-body update-body">
        <h2>Update available</h2>
        <p class="overview">${esc(update.version)} is ready to install. It keeps you signed in.</p>
        <div class="update-progress hidden"><div class="update-bar"><span></span></div><p class="update-msg"></p></div>
        <div class="m-actions update-actions">
          <button class="btn btn-red" data-act="install" data-autofocus>Update now</button>
          <button class="btn btn-gray" data-act="later">Later</button>
        </div>
      </div>`;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    const msg = $('.update-msg', content), bar = $('.update-bar span', content), progress = $('.update-progress', content);
    // "Later" skips this version until the app is next opened.
    $('[data-act="later"]', content).addEventListener('click', () => {
      updates.dismissedCode = update.code;
      closeModal();
    });
    $('[data-act="install"]', content).addEventListener('click', (e) => {
      e.target.disabled = true;
      progress.classList.remove('hidden');
      msg.textContent = 'Downloading…';
      nativeApp.installUpdate(update.url);
    });
    // Progress and results reported by the Android app.
    window.auroraUpdate = (u) => {
      if (u.state === 'progress') { bar.style.width = u.pct + '%'; msg.textContent = `Downloading… ${u.pct}%`; }
      else if (u.state === 'permission') msg.textContent = 'Allow Aurora to install apps in the screen that just opened, then come back. The update continues by itself.';
      else if (u.state === 'installing') { bar.style.width = '100%'; msg.textContent = 'Opening the installer… choose Install (or Update).'; }
      else if (u.state === 'error') {
        msg.textContent = `The download failed (${u.message || 'unknown error'}). Check the internet connection and try again.`;
        $('[data-act="install"]', content).disabled = false;
      }
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
  ];
  const maxBitrate = () => Number(store.get('ef.maxBitrate')) || QUALITY_OPTIONS[0].bitrate;

  const player = {
    item: null, hls: null, playSessionId: null, mediaSourceId: null, playMethod: null, source: null,
    audioIndex: null, subtitleIndex: -1, forceTranscode: false, intro: null, isLive: false, liveStreamId: null,
    progressTimer: null, idleTimer: null, nextEpisode: null, startSeconds: 0, dragging: false,
    token: 0, // bumped on every playItem so a slower, older request can't take over
    creditsAt: null, upNextTimer: null, upNextShown: false, upNextDismissed: false,
    autoCount: 0, // episodes started automatically in a row with nobody touching the controls
    lastInput: 0, liveIdleTimer: null,
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
    const bitrate = maxBitrate();

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
  async function playItem(rawItem, { startTicks, audioIndex, subtitleIndex, forceTranscode = false, auto = false } = {}) {
    if (!auto) noteInput();
    const isReload = player.item && rawItem.Id === player.item.Id;
    if (!isReload && $('#player').classList.contains('hidden')) rememberFocus('player');
    const token = ++player.token;
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

      const params = { UserId: state.userId, IsPlayback: true, AutoOpenLiveStream: true, MaxStreamingBitrate: maxBitrate() };
      if (audioIndex != null) params.AudioStreamIndex = audioIndex;
      if (subtitleIndex != null) params.SubtitleStreamIndex = subtitleIndex;
      // Browsers can't switch audio tracks in a file, so a non-default track needs Emby to remux it.
      if (forceTranscode) { params.EnableDirectPlay = false; params.EnableDirectStream = false; }
      const info = await api(`/Items/${full.Id}/PlaybackInfo`, { method: 'POST', params, body: { DeviceProfile: deviceProfile() } });
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
      if (!player.suspended) await reportPlayback('/Sessions/Playing/Stopped');
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
    $('#player').classList.add('hidden');
    nativeApp?.setPlayerMode(false);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    const modalOpen = !$('#modal').classList.contains('hidden');
    document.body.style.overflow = modalOpen ? 'hidden' : '';
    // Refresh what's on screen so "Continue Watching" and progress bars update.
    if (!modalOpen) route();
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
    const panel = $('#tracks-panel'), streams = player.source?.MediaStreams || [];
    const audio = streams.filter((s) => s.Type === 'Audio');
    const subs = streams.filter((s) => s.Type === 'Subtitle');
    const opt = (attr, value, label, selected) =>
      `<button class="track-opt${selected ? ' selected' : ''}" data-${attr}="${value}">${selected ? '&#10003; ' : ''}${esc(label)}</button>`;
    panel.innerHTML = `
      <div class="tracks-cols">
        <div class="tracks-col"><h4>Audio</h4>
          ${audio.length ? audio.map((s) => opt('audio', s.Index, s.DisplayTitle || s.Language || `Track ${s.Index}`, s.Index === player.audioIndex)).join('') : '<p>Default</p>'}
        </div>
        <div class="tracks-col"><h4>Subtitles</h4>
          ${opt('sub', -1, 'Off', player.subtitleIndex == null || player.subtitleIndex < 0)}
          ${subs.map((s) => opt('sub', s.Index, s.DisplayTitle || s.Language || `Subtitle ${s.Index}`, s.Index === player.subtitleIndex)).join('')}
        </div>
        <div class="tracks-col"><h4>Quality</h4>
          ${QUALITY_OPTIONS.map((q) => opt('quality', q.bitrate, q.label, q.bitrate === maxBitrate())).join('')}
        </div>
      </div>`;
    panel.classList.remove('hidden');
    $('#player').classList.remove('idle');
    clearTimeout(player.idleTimer);
    focusEl($('.track-opt.selected', panel) || $('.track-opt', panel));
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
        await selectUser(user);
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
    window.addEventListener('hashchange', () => { closeModal(); route(); });

    setupPlayer();
    setupKeys();
  }

  // ---------- Remote control & keyboard navigation ----------
  // Arrow keys move focus to the nearest item in that direction (TV remotes send arrow keys),
  // OK/Enter activates it and Back closes the top layer.
  const nav = { on: false, tv: false, returnFocus: {} };
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([type="hidden"]), select, [tabindex]';

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
      if (el.tabIndex < 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1 && getComputedStyle(el).visibility !== 'hidden';
    });
  }

  function focusEl(el) {
    if (!el) return;
    el.focus({ preventScroll: true });
    // Instant scrolling keeps positions settled for the next remote press.
    if (el.closest('#nav')) window.scrollTo({ top: 0 });
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
    for (const el of focusables(layer)) {
      if (el === cur || el.contains(cur) || cur.contains(el)) continue;
      const b = el.getBoundingClientRect();
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
    // The fixed top bar is only reached when nothing else lies in that direction (like Netflix).
    const inPage = cands.filter((c) => !c.el.closest('#nav'));
    if (inPage.length && !cur.closest('#nav')) cands.splice(0, cands.length, ...inPage);
    let best = null;
    if (vertical) {
      // Go to the nearest line of items first, then the one most in line with the current item.
      const nearest = Math.min(...cands.map((c) => c.primary));
      // Coming down out of the top bar, start at the left of the line (like Netflix) rather than under the button.
      const fromNav = dir === 'down' && cur.closest('#nav');
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
    if (best) focusEl(best.el);
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
    if (action === 'guide' && hasLiveTv()) {
      closeModal();
      location.hash = '#/livetv?tab=guide';
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
    if (isPlayerOpen()) {
      if (tracksOpen()) closeTracks();
      else { hideStillWatching(); closePlayer(); }
      return true;
    }
    if (trailerOpen()) { closeTrailerWindow(); return true; }
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
    loadConfig();
    autoCheckForUpdate();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && Date.now() - updates.lastCheck > RECHECK_AFTER) autoCheckForUpdate();
    });
    loadRemoteConfig();
    applySubtitleStyle();
    setupUi();
    $('#setup-username').value = store.get('ef.username') || '';
    if (!state.apiKey || !state.userId) return showSetup();
    try {
      const user = await api(`/Users/${state.userId}`);
      upsertAccount(user, state.apiKey);
      await selectUser(user);
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
