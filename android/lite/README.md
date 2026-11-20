# Aurora Lite

The same Aurora app for older devices: it installs on Android 7 and up (the full app needs Android 8). Built for the
Fire TV Stick 4K (1st generation) and similar boxes and phones.

What is different from the full app:

- **Installs on Android 7.** `gradle assembleRelease -Plite=true` sets the minimum to Android 7.
- **Web app rewritten for older WebViews.** `build-web.mjs` converts the code to what Chrome 60 understands, adds the missing
  browser functions (`lite.js`) and makes the files smaller. It writes `android/lite/web`, which the Lite APK bundles.
- **Plainer look.** No moving backgrounds, fades or blur (`lite.css`), and the opening screen is drawn still.
- **Its own updates.** Lite checks releases tagged `aurora-lite-v...`, so it never installs the full app by mistake.

CI builds it with every full release (same version number and signing key) and publishes `Aurora-Lite.apk` to a release tagged
`aurora-lite-v...` and to one tagged `aurora-lite` that always holds the newest file. `aurora-streaming.org/lite` redirects to that file.
A failed Lite build never stops the full app's release.

Build it on your own computer: `cd android/lite && npm install && node build-web.mjs`, then `cd .. && gradle assembleRelease -Plite=true`.
