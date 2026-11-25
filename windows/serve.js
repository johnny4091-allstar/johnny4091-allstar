// Maps an aurora://app/... address to a file inside the bundled Aurora folder. Kept separate so it can be tested without Electron.
const path = require('path');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.mp3': 'audio/mpeg', '.txt': 'text/plain; charset=utf-8', '.md': 'text/markdown; charset=utf-8',
};

// Returns { file, type } for a request path, or null when it would leave the folder.
function resolveAsset(root, urlPath) {
  let p;
  try { p = decodeURIComponent(String(urlPath || '/').split('?')[0].split('#')[0]); } catch { return null; }
  if (p.includes('\0')) return null;
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(root, p));
  const rel = path.relative(root, file);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return { file, type: TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' };
}

module.exports = { resolveAsset, TYPES };
