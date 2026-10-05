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
import android.os.Bundle;
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

import androidx.webkit.WebViewAssetLoader;

/** Hosts the EmbyFlix web app (bundled in assets/) in a full-screen WebView. */
public class MainActivity extends Activity {
    private static final String APP_HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + APP_HOST + "/assets/index.html";

    private FrameLayout root;
    private WebView webView;
    private View customView;
    private WebChromeClient.CustomViewCallback customViewCallback;
    private boolean playerMode;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#141414"));
        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#141414"));
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        // Allow http:// Emby servers even though the app itself is served from https://.
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " EmbyFlixAndroid/" + versionName());

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
                || getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK);
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
        webView.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
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

        /** Opens the on-screen keyboard for the focused text field (needed with a TV remote). */
        @JavascriptInterface
        public void showKeyboard() {
            runOnUiThread(() -> {
                webView.requestFocus();
                InputMethodManager imm = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
                if (imm != null) imm.showSoftInput(webView, InputMethodManager.SHOW_IMPLICIT);
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
