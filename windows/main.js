// Aurora for Windows: the same Aurora app, in its own window. It opens the bundled files (the "app" folder next to this file) through
// aurora://app/, talks to your Emby server and Aurora Guard like every other Aurora app, and updates itself from GitHub releases.
const { app, BrowserWindow, protocol, shell, session, ipcMain, Menu, dialog, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const { resolveAsset } = require('./serve');

const APP_DIR = path.join(__dirname, 'app');
const HOME = 'aurora://app/index.html';

protocol.registerSchemesAsPrivileged([{ scheme: 'aurora', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } }]);

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null, updater = null, updateText = 'Not checked yet.';
const statePath = () => path.join(app.getPath('userData'), 'window.json');
const readState = () => { try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')); } catch { return {}; } };
const saveState = () => {
  if (!win || win.isDestroyed()) return;
  try { fs.writeFileSync(statePath(), JSON.stringify({ ...(win.isMaximized() || win.isFullScreen() ? {} : { bounds: win.getBounds() }), maximized: win.isMaximized() })); } catch { /* not important */ }
};
const onScreen = (b) => b && screen.getAllDisplays().some((d) => b.x < d.bounds.x + d.bounds.width && b.x + b.width > d.bounds.x && b.y < d.bounds.y + d.bounds.height && b.y + b.height > d.bounds.y);

function createWindow() {
  const st = readState();
  win = new BrowserWindow({
    width: 1280, height: 780, minWidth: 720, minHeight: 480, backgroundColor: '#070c1c', title: 'Aurora', show: false, autoHideMenuBar: true,
    icon: path.join(__dirname, 'build', 'icon.png'),
    ...(onScreen(st.bounds) ? st.bounds : {}),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, autoplayPolicy: 'no-user-gesture-required', devTools: !app.isPackaged },
  });
  Menu.setApplicationMenu(null);
  if (st.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', saveState);
  // Only Aurora's own pages open here. Everything else (links to a website, for example) opens in the normal browser.
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('aurora://app/')) { e.preventDefault(); if (/^https?:/i.test(url)) shell.openExternal(url); } });
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F11') { win.setFullScreen(!win.isFullScreen()); e.preventDefault(); }
    else if (input.key === 'Escape' && win.isFullScreen() && !win.webContents.isDevToolsOpened()) { /* the page decides what Escape does; leaving the player also leaves full screen */ }
    else if (input.control && input.key.toLowerCase() === 'r' && !app.isPackaged) { win.reload(); e.preventDefault(); }
  });
  // Full screen from the player button makes the whole window full screen, and leaving it brings the window back.
  win.webContents.on('enter-html-full-screen', () => win.setFullScreen(true));
  win.webContents.on('leave-html-full-screen', () => win.setFullScreen(false));
  win.loadURL(HOME);
}

// Aurora talks to your Emby server, your Aurora Guard and, for Live TV, other providers. Those answer an app that runs from another
// address, so this lets the answers through (the same as Aurora does in a web browser and in the Android app).
function allowServerAnswers() {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const h = details.responseHeaders || {};
    if (!details.url.startsWith('aurora://')) {
      for (const k of Object.keys(h)) if (/^access-control-allow-(origin|headers|methods)$/i.test(k)) delete h[k];
      h['Access-Control-Allow-Origin'] = ['*']; h['Access-Control-Allow-Headers'] = ['*']; h['Access-Control-Allow-Methods'] = ['GET, POST, PUT, DELETE, OPTIONS']; h['Access-Control-Expose-Headers'] = ['*'];
      if (details.method === 'OPTIONS') { callback({ responseHeaders: h, statusLine: 'HTTP/1.1 204 No Content' }); return; }
    }
    callback({ responseHeaders: h });
  });
}

function setUpUpdates() {
  if (!app.isPackaged) { updateText = 'Updates work in the installed app.'; return; }
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
    updater.autoDownload = true; updater.autoInstallOnAppQuit = true; updater.logger = null;
    updater.on('checking-for-update', () => { updateText = 'Checking…'; });
    updater.on('update-available', (i) => { updateText = `Downloading version ${i.version}…`; });
    updater.on('update-not-available', () => { updateText = 'You have the newest version.'; });
    updater.on('update-downloaded', (i) => { updateText = `Version ${i.version} is ready. It installs when you close Aurora.`; });
    updater.on('error', () => { updateText = 'Could not check for updates. Try again later.'; });
    updater.checkForUpdates().catch(() => { /* offline: try again next time */ });
  } catch { updateText = 'Could not check for updates.'; }
}

ipcMain.on('aurora:version', (e) => { e.returnValue = app.getVersion(); });
ipcMain.handle('aurora:check-update', async () => {
  if (!updater) return updateText;
  try { await updater.checkForUpdates(); } catch { return 'Could not check for updates. Try again later.'; }
  await new Promise((r) => setTimeout(r, 1500));
  return updateText;
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });

app.whenReady().then(() => {
  protocol.handle('aurora', (request) => {
    const r = resolveAsset(APP_DIR, new URL(request.url).pathname);
    if (!r) return new Response('Not found', { status: 404 });
    return fs.promises.readFile(r.file).then((buf) => new Response(buf, { status: 200, headers: { 'Content-Type': r.type, 'Cache-Control': 'no-cache' } })).catch(() => new Response('Not found', { status: 404 }));
  });
  allowServerAnswers();
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(['fullscreen', 'media', 'clipboard-sanitized-write', 'pointerLock'].includes(perm)));
  createWindow(); setUpUpdates();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => app.quit());
