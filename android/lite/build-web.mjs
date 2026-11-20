// Builds the web app for Aurora Lite: the same app, rewritten for older Android System WebViews (Chrome 60 and up),
// with a few polyfills, a plainer look and a still opening screen. Run: node build-web.mjs   (needs esbuild: npm install in this folder)
import { build, transform } from 'esbuild';
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, '..', '..', 'aurora');
const out = join(here, 'web');
const target = 'chrome60';

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(src, out, { recursive: true, filter: (p) => !/README\.md$/.test(p) });

const must = (cond, what) => { if (!cond) { console.error('Lite build: ' + what); process.exit(1); } };

// Scripts: rewritten for the older engine and made smaller.
for (const f of ['app.js', 'splash.js', 'tour-config.js']) {
  let code = readFileSync(join(src, f), 'utf8');
  if (f === 'splash.js') {
    // The opening screen is drawn still on Lite (it is a heavy animation for an old TV stick).
    const before = code;
    code = code.replace(/var still = !!\(window\.matchMedia[^;]*;/, 'var still = true;');
    must(code !== before, "splash.js no longer has the 'var still' line this build changes");
  }
  const r = await transform(code, { loader: 'js', target, minify: true, legalComments: 'none' });
  writeFileSync(join(out, f), r.code);
}

// Styles: modern shortcuts (like "inset") rewritten, then the Lite look added at the end.
const css = readFileSync(join(src, 'styles.css'), 'utf8') + '\n' + readFileSync(join(here, 'lite.css'), 'utf8');
writeFileSync(join(out, 'styles.css'), (await transform(css, { loader: 'css', target, minify: true })).code);

// The page: polyfills first, then everything else as before.
copyPolyfill();
function copyPolyfill() { writeFileSync(join(out, 'lite.js'), readFileSync(join(here, 'lite.js'), 'utf8')); }
let html = readFileSync(join(src, 'index.html'), 'utf8');
const before = html;
html = html.replace('<script src="splash.js"></script>', '<script src="lite.js"></script>\n  <script src="splash.js"></script>');
must(html !== before, 'index.html no longer loads splash.js the way this build expects');
writeFileSync(join(out, 'index.html'), html);
console.log('Lite web app written to ' + out);
