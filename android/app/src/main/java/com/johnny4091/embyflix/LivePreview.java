package com.johnny4091.embyflix;

import android.app.Activity;
import android.app.ActivityManager;
import android.graphics.Color;
import android.graphics.Outline;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewOutlineProvider;
import android.widget.FrameLayout;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;

/**
 * The small live picture in the Live TV guide. One ExoPlayer and its video view sit on top of the page at a rectangle the
 * page gives (the guide's preview box). It never takes the remote's focus or touches, so the guide works as usual, and it
 * is always stopped before a channel opens full screen (a TV provider often allows only one connection at a time).
 */
@OptIn(markerClass = UnstableApi.class)
final class LivePreview {
    private final Activity activity;
    private final FrameLayout root;
    private PlayerView view;
    private ExoPlayer player;
    private String url = "";
    /** Called (on the UI thread) when the picture stops by itself: "ended-error" or "released". */
    private final Runnable onFailed;
    private boolean muted;

    LivePreview(Activity activity, FrameLayout root, Runnable onFailed) {
        this.activity = activity;
        this.root = root;
        this.onFailed = onFailed;
    }

    boolean running() { return player != null; }

    private int bufferBytes() {
        ActivityManager am = (ActivityManager) activity.getSystemService(Activity.ACTIVITY_SERVICE);
        int heapMb = am == null ? 128 : Math.max(am.getMemoryClass(), am.getLargeMemoryClass());
        int mb = Math.max(8, Math.min(24, heapMb / 8)); // a preview needs much less than the full player
        if (am != null && am.isLowRamDevice()) mb = 8;
        return mb * 1024 * 1024;
    }

    /** Starts (or moves to) a channel. x, y, w, h are in screen pixels relative to the page. */
    void start(String channelUrl, String userAgent, int x, int y, int w, int h, boolean software) {
        if (channelUrl == null || channelUrl.isEmpty() || w < 40 || h < 24) return;
        if (player != null && channelUrl.equals(url)) { // already showing it: just follow the box
            move(x, y, w, h);
            player.setPlayWhenReady(true);
            return;
        }
        if (view == null) {
            view = new PlayerView(activity);
            view.setUseController(false);
            view.setBackgroundColor(Color.BLACK);
            view.setResizeMode(AspectRatioFrameLayout.RESIZE_MODE_FIT);
            view.setShutterBackgroundColor(Color.BLACK);
            // The remote and touches belong to the page underneath.
            view.setFocusable(false);
            view.setFocusableInTouchMode(false);
            view.setClickable(false);
            view.setDescendantFocusability(ViewGroup.FOCUS_BLOCK_DESCENDANTS);
            view.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            view.setOutlineProvider(new ViewOutlineProvider() {
                @Override
                public void getOutline(View v, Outline outline) { outline.setRoundRect(0, 0, v.getWidth(), v.getHeight(), 18f); }
            });
            view.setClipToOutline(true);
            root.addView(view, new FrameLayout.LayoutParams(w, h));
        }
        move(x, y, w, h);
        view.setVisibility(View.VISIBLE);
        if (player == null) build(userAgent, software);
        url = channelUrl;
        player.setMediaItem(mediaItem(channelUrl));
        player.prepare();
        player.setVolume(muted ? 0f : 1f);
        player.setPlayWhenReady(true);
    }

    private void build(String userAgent, boolean software) {
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent(userAgent == null || userAgent.isEmpty() ? "Aurora" : userAgent)
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(15000)
                .setReadTimeoutMs(20000);
        DefaultLoadControl load = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(15000, 30000, 2500, 5000)
                .setTargetBufferBytes(bufferBytes())
                .setPrioritizeTimeOverSizeThresholds(false)
                .build();
        DefaultRenderersFactory renderers = Decoders.factory(activity, software);
        player = new ExoPlayer.Builder(activity, renderers)
                .setLoadControl(load)
                .setAudioAttributes(new androidx.media3.common.AudioAttributes.Builder()
                        .setUsage(C.USAGE_MEDIA).setContentType(C.AUDIO_CONTENT_TYPE_MOVIE).build(), true)
                .setHandleAudioBecomingNoisy(true)
                .setWakeMode(C.WAKE_MODE_NETWORK)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(new DefaultDataSource.Factory(activity, http),
                        new DefaultExtractorsFactory().setTsExtractorFlags(DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES
                                | DefaultTsPayloadReaderFactory.FLAG_DETECT_ACCESS_UNITS)))
                .build();
        player.addListener(new Player.Listener() {
            @Override
            public void onPlayerError(androidx.media3.common.PlaybackException error) {
                // A preview doesn't retry or show errors: it is dropped, and the page says so beside the box.
                root.post(() -> { release(); if (onFailed != null) onFailed.run(); }); // not from inside the player's own callback
            }
        });
        view.setPlayer(player);
    }

    void move(int x, int y, int w, int h) {
        if (view == null || w < 40 || h < 24) return;
        FrameLayout.LayoutParams lp = (FrameLayout.LayoutParams) view.getLayoutParams();
        if (lp.width != w || lp.height != h || lp.leftMargin != x || lp.topMargin != y) {
            lp.width = w; lp.height = h; lp.leftMargin = x; lp.topMargin = y; lp.gravity = android.view.Gravity.TOP | android.view.Gravity.START;
            view.setLayoutParams(lp);
        }
    }

    /** Hides the picture and pauses it (a menu is open over the box); it carries on when shown again. */
    void setVisible(boolean on) {
        if (view == null) return;
        view.setVisibility(on ? View.VISIBLE : View.INVISIBLE);
        if (player != null) player.setPlayWhenReady(on);
    }

    void mute(boolean on) {
        muted = on;
        if (player != null) player.setVolume(on ? 0f : 1f);
    }

    /** Stops the picture and frees the player (and the provider connection). Safe to call at any time. */
    void release() {
        url = "";
        if (view != null) {
            view.setPlayer(null);
            root.removeView(view);
            view = null;
        }
        if (player != null) {
            try { player.release(); } catch (RuntimeException ignored) { /* already gone */ }
            player = null;
        }
    }

    private static MediaItem mediaItem(String url) {
        MediaItem.Builder item = new MediaItem.Builder().setUri(url);
        if (url.toLowerCase().contains(".m3u8")) item.setMimeType(MimeTypes.APPLICATION_M3U8);
        return item.build();
    }
}
