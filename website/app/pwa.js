// Web app support: registers the service worker and offers "Install Aurora" where the browser allows it.
// Not used inside the Android, iPhone, TV or Windows apps, which already are apps.
(function () {
  var isApp = !!window.EmbyFlixAndroid || !!window.AuroraDesktop || location.protocol !== 'https:' || location.hostname === 'appassets.androidplatform.net';
  window.AuroraInstall = { available: false, installed: false, prompt: null, onchange: null };
  function changed() { if (typeof window.AuroraInstall.onchange === 'function') window.AuroraInstall.onchange(); }
  try { window.AuroraInstall.installed = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; } catch (e) { /* ignore */ }
  if (isApp) return;
  window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); window.AuroraInstall.prompt = e; window.AuroraInstall.available = true; changed(); });
  window.addEventListener('appinstalled', function () { window.AuroraInstall.prompt = null; window.AuroraInstall.available = false; window.AuroraInstall.installed = true; changed(); });
  if ('serviceWorker' in navigator) window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { /* the app works without it */ }); });
})();
