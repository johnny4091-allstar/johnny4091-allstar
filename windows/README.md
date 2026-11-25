# Aurora for Windows

The same Aurora app (the `aurora` folder) in its own Windows window, made with Electron.

- `main.js`: opens the window, serves the bundled files at `aurora://app/`, lets answers from your Emby server, Aurora Guard and Live TV providers through (the same as the web and Android apps), remembers the window size, F11 full screen, and updates itself.
- `preload.js`: gives the page `window.AuroraDesktop` (platform, version, check for updates). Nothing else from Node is reachable from the page.
- `serve.js`: maps an address to a file inside the bundled folder and refuses anything outside it (`npm test`).
- `scripts/copy-app.js`: copies `../aurora` into `./app` before running or building.

## Build

The installer is built by GitHub (`.github/workflows/aurora-windows.yml`) on every change to `aurora/` or `windows/`, and published as **Aurora-Setup.exe** on the release tagged `aurora-windows`. The website link `aurora-streaming.org/windows` points there, and the installed app checks the same release for updates (`latest.yml`).

To try it on a Windows PC with Node 22: `cd windows`, `npm ci`, `npm start` (runs it) or `npm run dist` (makes the installer in `dist`).

The installer is not code-signed, so Windows SmartScreen asks the user to choose More info, then Run anyway, the first time. A code-signing certificate removes that. If you get one, add it to the `win` section in `package.json`.

## The web app

`aurora/manifest.webmanifest`, `aurora/sw.js` and `aurora/pwa.js` make Aurora installable from Chrome or Edge. The website serves a copy at `aurora-streaming.org/app/`. Make that copy with `node tools/sync-web-app.js` before deploying the website (`--check` tells you if it is out of date).
