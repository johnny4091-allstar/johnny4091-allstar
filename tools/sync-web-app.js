// Makes website/app, the web version of Aurora (aurora-streaming.org/app/), from the aurora folder.
// Run it before deploying the website:  node tools/sync-web-app.js     (add --check to only see whether the copy is out of date)
const fs = require('fs');
const path = require('path');
const src = path.join(__dirname, '..', 'aurora');
const dest = path.join(__dirname, '..', 'website', 'app');
const skip = (f) => /[\\/](README\.md|whats-new\.md|whats-new\.release\.md)$/.test(f);

const list = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const f = path.join(dir, e.name);
  return e.isDirectory() ? list(f) : skip(f) ? [] : [path.relative(dir === src || f.startsWith(src) ? src : dest, f)];
});

if (process.argv.includes('--check')) {
  const want = list(src).sort(), have = fs.existsSync(dest) ? list(dest).sort() : [];
  let stale = want.length !== have.length || want.some((f, i) => f !== have[i]);
  if (!stale) stale = want.some((f) => !fs.readFileSync(path.join(src, f)).equals(fs.readFileSync(path.join(dest, f))));
  console.log(stale ? 'website/app is out of date. Run: node tools/sync-web-app.js' : 'website/app is up to date.');
  process.exit(stale ? 1 : 0);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true, filter: (f) => !skip(f) });
console.log('Copied the Aurora web app into website/app');
