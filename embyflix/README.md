# EmbyFlix

A Netflix-style web app for your own Emby media server. Plain HTML/CSS/JavaScript: no build step, no install.

## Features

- "Who's watching?" profile picker using your Emby users
- Home page with a rotating hero banner and rows: Continue Watching, Next Up, My List,
  Recently Added for each library, Top Rated, Popular TV, and random genre rows
- TV Shows and Movies pages with genre, sort, and watched filters and infinite scroll
- Search
- Details pop-up with cast, genres, and rating; season picker and episode list for shows; "More Like This" for movies
- Add to My List (Emby favorites) and mark as watched/unwatched
- Video player that plays files directly when the browser supports them and asks Emby to transcode (HLS) when it doesn't
- Resume where you left off, progress reported back to Emby, and auto-play of the next episode
- Works on phones, tablets, and desktops

## Run it

1. Download this `embyflix` folder.
2. Open `index.html` in Chrome, Edge, Firefox, or Safari. Double-clicking it works, or you can serve the folder:
   `python3 -m http.server 8080`, then go to http://localhost:8080
3. Enter your server address (for example `http://192.168.1.10:8096`) and your API key, then pick a profile.

Create an API key in Emby under **Settings → Advanced → API Keys**.

### Prefill your server (optional)

Copy `config.example.js` to `config.js` and fill in your server and key. `config.js` is gitignored,
so your key is never committed. You can also just type them into the connect screen. They are saved in that browser.

## Notes

- **HTTPS pages cannot talk to an HTTP server.** If your Emby server uses `http://`, open EmbyFlix from a local file
  or over plain HTTP, not from an `https://` host such as GitHub Pages. You can also put Emby behind HTTPS
  (a reverse proxy, or Emby's own certificate setting).
- **Keep your API key private.** An Emby API key gives full admin access to your server. Don't publish it in a
  public repository or on a public website. If it has been shared publicly, delete it in Emby and create a new one.
- If playback won't start for a file, check that transcoding is enabled for your user in Emby.
