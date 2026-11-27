// Packs the Roku channel into roku/dist/Aurora-Roku.zip: the manifest, source, components and images, with the version stamped in.
// Usage: node tools/build-roku.js [versionName like 1.2.3] [buildNumber]
const fs = require('fs'), path = require('path'), { execFileSync } = require('child_process');
const root = path.join(__dirname, '..', 'roku'), out = path.join(root, 'dist'), stage = path.join(root, 'build', 'pack');
const [name, build] = [process.argv[2] || '1.0.0', process.argv[3] || '1'];
const [maj, min, pat] = name.split('.').map((n) => parseInt(n, 10) || 0);
fs.rmSync(stage, { recursive: true, force: true }); fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true }); fs.mkdirSync(out, { recursive: true });
for (const d of ['source', 'components', 'images']) fs.cpSync(path.join(root, d), path.join(stage, d), { recursive: true });
let manifest = fs.readFileSync(path.join(root, 'manifest'), 'utf8');
manifest = manifest.replace(/^major_version=.*$/m, 'major_version=' + maj).replace(/^minor_version=.*$/m, 'minor_version=' + min).replace(/^build_version=.*$/m, 'build_version=' + (parseInt(build, 10) || pat));
fs.writeFileSync(path.join(stage, 'manifest'), manifest);
// The app shows this number in Settings.
const main = path.join(stage, 'source', 'main.brs');
fs.writeFileSync(main, fs.readFileSync(main, 'utf8').replace('appVersion: "1.0.0"', 'appVersion: "' + name + '"'));
// Roku wants the manifest at the top of the zip.
execFileSync('zip', ['-r', '-X', path.join(out, 'Aurora-Roku.zip'), 'manifest', 'source', 'components', 'images'], { cwd: stage, stdio: 'inherit' });
console.log('Built', path.join(out, 'Aurora-Roku.zip'), 'version', name);
