package com.johnny4091.embyflix;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.UiModeManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.view.inputmethod.InputMethodManager;
import android.widget.FrameLayout;

import androidx.core.content.FileProvider;
import androidx.webkit.WebViewAssetLoader;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import java.util.Iterator;
import java.util.List;
import java.util.Map;

/** Hosts the Aurora web app (bundled in assets/) in a full-screen WebView. */
public class MainActivity extends Activity {
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + APP_HOST + "/assets/index.html";

    private FrameLayout root;
    private WebView webView;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private boolean playerMode;
    /**
     * HTTP for services that don't allow cross-site calls from a web page (Jellyseerr).
     * Result goes to window.auroraHttpDone(id, {status, body, setCookie}); status 0 means a network error.
     */
    private void nativeHttp(String id, String method, String url, String headersJson, String body) {
        JSONObject result = new JSONObject();
        HttpURLConnection conn = null;
        try {
            if (!url.startsWith("https://") && !url.startsWith("http://")) throw new IOException("unsupported address");
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setRequestMethod(method);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            JSONObject headers = new JSONObject(headersJson == null || headersJson.isEmpty() ? "{}" : headersJson);
            for (Iterator<String> it = headers.keys(); it.hasNext(); ) {
                String key = it.next();
                conn.setRequestProperty(key, headers.getString(key));
            }
            if (body != null && !body.isEmpty()) {
                conn.setDoOutput(true);
                try (OutputStream out = conn.getOutputStream()) {
                    out.write(body.getBytes(StandardCharsets.UTF_8));
                }
            }
            int status = conn.getResponseCode();
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            result.put("status", status);
            result.put("body", in == null ? "" : readAll(in));
            // Keep just the name=value part of each cookie, to send back on later calls.
            StringBuilder cookies = new StringBuilder();
            for (Map.Entry<String, List<String>> h : conn.getHeaderFields().entrySet()) {
                if (h.getKey() == null || !h.getKey().equalsIgnoreCase("Set-Cookie")) continue;
                for (String c : h.getValue()) {
                    if (cookies.length() > 0) cookies.append("; ");
                    cookies.append(c.split(";", 2)[0].trim());
                }
            }
            result.put("setCookie", cookies.toString());
        } catch (Exception e) {
            try {
                result.put("status", 0).put("error", String.valueOf(e.getMessage()));
            } catch (Exception ignored) {
                // Leave the result empty.
            }
        } finally {
            if (conn != null) conn.disconnect();
        }
        String js = "window.auroraHttpDone && window.auroraHttpDone(" + JSONObject.quote(id) + "," + result + ")";
        runOnUiThread(() -> webView.evaluateJavascript(js, null));
    }

    private static final String CREDENTIAL_KEY = "aurora-credentials";

    /** AES key that lives in Android's key store and can't be read out of it, even by this app. */
    private static SecretKey credentialKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        if (keyStore.containsAlias(CREDENTIAL_KEY)) {
            return ((KeyStore.SecretKeyEntry) keyStore.getEntry(CREDENTIAL_KEY, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(CREDENTIAL_KEY,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build());
        return generator.generateKey();
    }

    private static String readAll(InputStream in) throws IOException {
        try (InputStream input = in; ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = input.read(buf)) > 0) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }

    /** A downloaded update waiting for the "install unknown apps" permission. */
    private File pendingApk;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#070C1C"));
        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#070C1C"));
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        // Allow http:// Emby servers even though the app itself is served from https://.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        // Honour the page's viewport width so TV mode can lay out on a fixed canvas scaled to the screen.
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setUserAgentString(settings.getUserAgentString() + " AuroraAndroid/" + versionName());

        final WebViewAssetLoader assetLoader = new WebViewAssetLoader.Builder()
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .build();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return assetLoader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (APP_HOST.equals(uri.getHost())) return false;
                // Links to anything else open in the regular browser.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) {
                    // No browser installed; ignore the link.
                }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customView = view;
                customViewCallback = callback;
                root.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                webView.setVisibility(View.GONE);
                setSystemBarsHidden(true);
                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
            }

            @Override
            public void onHideCustomView() {
                exitFullscreen();
            }

            @Override
            public Bitmap getDefaultVideoPoster() {
                // Avoid the grey placeholder WebView draws before a video starts.
                return Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
            }
        });

        webView.addJavascriptInterface(new NativeBridge(), "EmbyFlixAndroid");

        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        webView.requestFocus();

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(START_URL);
        }
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "1";
        }
    }

    private void exitFullscreen() {
        if (customView == null) return;
        root.removeView(customView);
        customView = null;
        webView.setVisibility(View.VISIBLE);
        setSystemBarsHidden(playerMode);
        setRequestedOrientation(playerMode
                ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
        if (customViewCallback != null) {
            customViewCallback.onCustomViewHidden();
            customViewCallback = null;
        }
    }

    @SuppressWarnings("deprecation")
    private void setSystemBarsHidden(boolean on) {
        View decor = getWindow().getDecorView();
        if (on) {
            decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                    | View.SYSTEM_UI_FLAG_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
        } else {
            decor.setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
        }
    }

    private boolean detectTv() {
        UiModeManager uiMode = (UiModeManager) getSystemService(UI_MODE_SERVICE);
        return (uiMode != null && uiMode.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION)
                || getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK)
                // Many Android TV boxes report neither of the above, but none has a touchscreen.
                || !getPackageManager().hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN);
    }

    /** Remote buttons the web page can't receive reliably are forwarded to window.embyflixKey(). */
    private static String remoteAction(int keyCode) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_DPAD_CENTER: return "select";
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_HEADSETHOOK: return "playpause";
            case KeyEvent.KEYCODE_MEDIA_PLAY: return "play";
            case KeyEvent.KEYCODE_MEDIA_PAUSE: return "pause";
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD: return "ff";
            case KeyEvent.KEYCODE_MEDIA_REWIND: return "rw";
            case KeyEvent.KEYCODE_MEDIA_NEXT: return "next";
            case KeyEvent.KEYCODE_CHANNEL_UP: return "chup";
            case KeyEvent.KEYCODE_CHANNEL_DOWN: return "chdown";
            case KeyEvent.KEYCODE_GUIDE:
            case KeyEvent.KEYCODE_TV: return "guide";
            default: return null;
        }
    }

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        String action = customView == null ? remoteAction(event.getKeyCode()) : null;
        if (action != null) {
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                webView.evaluateJavascript("window.embyflixKey && window.embyflixKey('" + action + "')", null);
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (customView != null) {
            exitFullscreen();
            return;
        }
        // Let the web app close the player, details pop-up, or go back to Home first.
        webView.evaluateJavascript("window.embyflixBack ? window.embyflixBack() : false", value -> {
            if (!"true".equals(value)) finish();
        });
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Save the playback position before the WebView stops running the page.
        webView.evaluateJavascript("window.auroraPause && window.auroraPause()", null);
        webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
        // Back from the "install unknown apps" screen: carry on with the update.
        if (pendingApk != null && getPackageManager().canRequestPackageInstalls()) installPendingApk();
    }

    @SuppressWarnings("deprecation")
    private int versionCode() {
        try {
            android.content.pm.PackageInfo info = getPackageManager().getPackageInfo(getPackageName(), 0);
            return Build.VERSION.SDK_INT >= 28 ? (int) info.getLongVersionCode() : info.versionCode;
        } catch (Exception e) {
            return 0;
        }
    }

    /** Sends update progress to window.auroraUpdate() in the page. */
    private void notifyUpdate(String state, Object value) {
        try {
            JSONObject json = new JSONObject().put("state", state);
            if (value instanceof Integer) json.put("pct", value);
            else if (value != null) json.put("message", String.valueOf(value));
            String js = "window.auroraUpdate && window.auroraUpdate(" + json + ")";
            runOnUiThread(() -> webView.evaluateJavascript(js, null));
        } catch (Exception ignored) {
            // Nothing useful to report.
        }
    }

    private void downloadUpdate(String url) {
        HttpURLConnection conn = null;
        try {
            File dir = new File(getCacheDir(), "updates");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new IOException("no storage");
            File apk = new File(dir, "Aurora.apk");
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setInstanceFollowRedirects(true);
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);
            int status = conn.getResponseCode();
            if (status >= 400) throw new IOException("HTTP " + status);
            long total = conn.getContentLengthLong(), done = 0;
            int lastPct = -1;
            try (InputStream in = conn.getInputStream(); OutputStream out = new FileOutputStream(apk)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) {
                    out.write(buf, 0, n);
                    done += n;
                    int pct = total > 0 ? (int) (done * 100 / total) : -1;
                    if (pct >= 0 && pct != lastPct) {
                        lastPct = pct;
                        notifyUpdate("progress", pct);
                    }
                }
            }
            pendingApk = apk;
            runOnUiThread(this::installPendingApk);
        } catch (Exception e) {
            notifyUpdate("error", e.getMessage());
        } finally {
            if (conn != null) conn.disconnect();
        }
    }

    private void installPendingApk() {
        File apk = pendingApk;
        if (apk == null) return;
        if (!getPackageManager().canRequestPackageInstalls()) {
            notifyUpdate("permission", null);
            try {
                startActivity(new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getPackageName())));
                return; // onResume continues once it's allowed
            } catch (ActivityNotFoundException e) {
                // Some TV boxes have no such screen; try the installer anyway, which asks on its own.
            }
        }
        pendingApk = null;
        try {
            Uri uri = FileProvider.getUriForFile(this, getPackageName() + ".updates", apk);
            Intent install = new Intent(Intent.ACTION_VIEW)
                    .setDataAndType(uri, "application/vnd.android.package-archive")
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            notifyUpdate("installing", null);
            startActivity(install);
        } catch (Exception e) {
            notifyUpdate("error", e.getMessage());
        }
    }

    @Override
    protected void onDestroy() {
        root.removeAllViews();
        webView.destroy();
        super.onDestroy();
    }

    /** Methods the web app can call as window.EmbyFlixAndroid.*. */
    private class NativeBridge {
        private final boolean tv = detectTv();

        @JavascriptInterface
        public boolean isTv() {
            return tv;
        }

        @JavascriptInterface
        public int getVersionCode() {
            return versionCode();
        }

        @JavascriptInterface
        public String getVersionName() {
            return versionName();
        }

        /** Opens a YouTube video in the YouTube app. Returns false if there isn't one (the page then plays it itself). */
        @JavascriptInterface
        public boolean openYouTube(String videoId) {
            if (videoId == null || !videoId.matches("[\\w-]{11}")) return false;
            try {
                Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("vnd.youtube:" + videoId))
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                startActivity(intent);
                return true;
            } catch (ActivityNotFoundException e) {
                return false;
            }
        }

        /** Encrypts text with the key-store key; returns "iv:ciphertext" in Base64, or null on failure. */
        @JavascriptInterface
        public String encrypt(String plain) {
            try {
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.ENCRYPT_MODE, credentialKey());
                byte[] sealed = cipher.doFinal(plain.getBytes(StandardCharsets.UTF_8));
                return Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP) + ":" + Base64.encodeToString(sealed, Base64.NO_WRAP);
            } catch (Exception e) {
                return null;
            }
        }

        /** Reverses encrypt(); null if the text can't be decrypted (for example after the key store was reset). */
        @JavascriptInterface
        public String decrypt(String blob) {
            try {
                String[] parts = blob.split(":", 2);
                Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
                cipher.init(Cipher.DECRYPT_MODE, credentialKey(), new GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)));
                return new String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), StandardCharsets.UTF_8);
            } catch (Exception e) {
                return null;
            }
        }

        @JavascriptInterface
        public void httpRequest(String id, String method, String url, String headersJson, String body) {
            new Thread(() -> nativeHttp(id, method, url, headersJson, body), "aurora-http").start();
        }

        /** Downloads the APK at url and opens the system installer. Progress goes to window.auroraUpdate(). */
        @JavascriptInterface
        public void installUpdate(String url) {
            if (url == null || !url.startsWith("https://github.com/")) {
                notifyUpdate("error", "unexpected download address");
                return;
            }
            new Thread(() -> downloadUpdate(url), "aurora-update").start();
        }

        /** Opens the on-screen keyboard for the focused text field (needed with a TV remote). */
        @JavascriptInterface
        public void showKeyboard() {
            runOnUiThread(() -> {
                webView.requestFocus();
                InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
                if (imm == null) return;
                // Give the page a moment to focus its text box, then ask. Some TV-provider keyboards
                // ignore a polite request, so fall back to a forced one.
                webView.postDelayed(() -> {
                    if (!imm.showSoftInput(webView, InputMethodManager.SHOW_IMPLICIT)) {
                        imm.showSoftInput(webView, InputMethodManager.SHOW_FORCED);
                    }
                }, 150);
            });
        }

        /** Video player open: keep the screen on, hide the system bars and turn to landscape. */
        @JavascriptInterface
        public void setPlayerMode(boolean on) {
            runOnUiThread(() -> {
                playerMode = on;
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                if (customView == null) {
                    setSystemBarsHidden(on);
                    setRequestedOrientation(on
                            ? ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
                            : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED);
                }
            });
        }
    }
}
