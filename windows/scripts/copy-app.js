// Copies the Aurora web app (../aurora) into ./app so the installer carries exactly the same files as every other Aurora app.
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', '..', 'aurora');
const dest = path.join(__dirname, '..', 'app');
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, {
  recursive: true,
  // The web-app helpers do nothing inside the Windows app, and the notes are for the website.
  filter: (f) => !/[\\/](sw\.js|pwa\.js|README\.md|whats-new\.md|whats-new\.release\.md)$/.test(f),
});
// index.html loads pwa.js; the Windows app has no use for it, so drop that line.
const idx = path.join(dest, 'index.html');
fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace(/\s*<script src="pwa\.js"><\/script>/, ''));
console.log('Copied Aurora into', dest);
