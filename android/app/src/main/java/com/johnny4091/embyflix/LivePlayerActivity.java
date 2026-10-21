package com.johnny4091.embyflix;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.ActivityManager;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.LruCache;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.BaseAdapter;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.TextView;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.datasource.HttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.extractor.DefaultExtractorsFactory;
import androidx.media3.extractor.ts.DefaultTsPayloadReaderFactory;
import androidx.media3.ui.PlayerView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;

/**
 * Full-screen live TV player for M3U / Xtream channels. ExoPlayer plays the provider's streams directly
 * (MPEG-TS or HLS), which is far steadier than the WebView's video element.
 *
 * Remote: Up / Channel+ next channel, Down / Channel- previous, OK or Left opens the channel list,
 * Right or Info shows what's on, number keys tune by channel number, Back closes.
 */
@OptIn(markerClass = UnstableApi.class)
public class LivePlayerActivity extends Activity {
    /** The channel list (JSON array of {name, url, logo, num, now}); big lists don't fit in an Intent. */
    static String pendingChannels;
    static final String EXTRA_INDEX = "index";
    static final String EXTRA_GROUP = "group";         // category name, shown above the channel list
    static final String EXTRA_USER_AGENT = "userAgent";
    static final String EXTRA_REPORT = "report";       // Emby details for telling the admin what's playing
    static final String RESULT_INDEX = "index";
    static final String RESULT_STALLS = "stalls", RESULT_MINUTES = "minutes", RESULT_BUFFER = "buffer";
    /** Channels that stopped working while open (for Admin → Playback problems): how many, the last one, and why. */
    static final String RESULT_FAILED = "failed", RESULT_FAILED_NAME = "failedName", RESULT_FAILED_CODE = "failedCode";

    private static final int ACCENT = Color.parseColor("#2AD4D0");
    private static final int PANEL = Color.parseColor("#E6070C1C");
    private static final int MAX_RETRIES = 6;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService logoLoader = Executors.newFixedThreadPool(3);
    private final LruCache<String, Bitmap> logoCache = new LruCache<String, Bitmap>(6 * 1024 * 1024) {
        @Override
        protected int sizeOf(String key, Bitmap value) { return value.getByteCount(); }
    };

    private final List<Channel> channels = new ArrayList<>();
    private int index;
    private int retries;
    /** Gave up the quick retries; still trying now and then until the viewer picks something else. */
    private boolean failed;
    private int failedChannels, failedCode;
    private boolean failureCounted; // this channel's failure is already counted (OK to retry doesn't count it again)
    private String failedName = "";
    private long bufferingSince;
    private boolean stopped;
    private String group = "";
    private String userAgent;
    private LiveReporter reporter;
    private String bufferLevel = "medium";
    private boolean wasReady;
    private int stalls;
    private final long openedAt = System.currentTimeMillis();

    private ExoPlayer player;
    private PlayerView playerView;
    private LinearLayout banner;
    private ImageView bannerLogo;
    private TextView bannerTitle, bannerNow, bannerGroup, status, numberEntry;
    private LinearLayout listPanel;
    private ListView listView;
    private ChannelAdapter adapter;
    private final StringBuilder typedNumber = new StringBuilder();

    static final class Channel {
        String name, url, logo, num, now;
        /** The same channel in the other format (MPEG-TS / HLS), tried when the first keeps failing. */
        boolean triedOther;
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        hideSystemBars();

        Intent intent = getIntent();
        try {
            JSONArray arr = new JSONArray(pendingChannels == null ? "[]" : pendingChannels);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.getJSONObject(i);
                Channel c = new Channel();
                c.name = o.optString("name", "Channel");
                c.url = o.optString("url", "");
                c.logo = o.optString("logo", "");
                c.num = o.optString("num", "");
                c.now = o.optString("now", "");
                channels.add(c);
            }
        } catch (Exception e) {
            finish();
            return;
        }
        if (channels.isEmpty()) { finish(); return; }
        index = Math.max(0, Math.min(intent.getIntExtra(EXTRA_INDEX, 0), channels.size() - 1));
        group = intent.getStringExtra(EXTRA_GROUP) == null ? "" : intent.getStringExtra(EXTRA_GROUP);
        userAgent = intent.getStringExtra(EXTRA_USER_AGENT);
        if (TextUtils.isEmpty(userAgent)) userAgent = "Aurora/" + versionName() + " (Android)";

        reporter = LiveReporter.from(intent.getStringExtra(EXTRA_REPORT));
        try {
            JSONObject extra = new JSONObject(intent.getStringExtra(EXTRA_REPORT));
            String level = extra.optString("buffer", "medium");
            if (level.equals("small") || level.equals("large")) bufferLevel = level;
            int stallSeconds = extra.optInt("stallSeconds", 25);
            if (stallSeconds >= 8 && stallSeconds <= 120) stallMs = stallSeconds * 1000L;
        } catch (Exception ignored) {
            // Medium.
        }
        buildViews();
        buildPlayer();
        tune(index);
    }

    // ---------- Player ----------

    /**
     * How much video to hold in memory. ExoPlayer's default allows about 130 MB, which together with the app's
     * own screens is more than many TV boxes give an app, so Android closed Aurora. A quarter of what this
     * device allows the app (16-64 MB) is still tens of seconds of HD.
     */
    private int bufferBytes() {
        ActivityManager am = (ActivityManager) getSystemService(ACTIVITY_SERVICE);
        int heapMb = am == null ? 128 : Math.max(am.getMemoryClass(), am.getLargeMemoryClass());
        int mb = Math.max(16, Math.min(64, heapMb / 4));
        if (am != null && am.isLowRamDevice()) mb = 16;
        return mb * 1024 * 1024;
    }

    private void buildPlayer() {
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent(userAgent)
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(15000)
                .setReadTimeoutMs(20000);
        // Live video arrives in real time, so the cushion built up before playback starts (and again after a
        // stall) is all there is to ride out a slow moment. 2 seconds was too little; the viewer picks the size
        // in Settings → Playback → Live TV buffer (Medium by default), trading channel-change speed for smoothness.
        int startMs, afterStallMs;
        switch (bufferLevel) {
            case "small": startMs = 2500; afterStallMs = 5000; break;
            case "large": startMs = 10000; afterStallMs = 20000; break;
            default: startMs = 5000; afterStallMs = 10000; break;
        }
        DefaultLoadControl loadControl = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(Math.max(20000, afterStallMs + 10000), 60000, startMs, afterStallMs)
                .setTargetBufferBytes(bufferBytes())
                .setPrioritizeTimeOverSizeThresholds(false)
                .build();
        // If a TV box's preferred video decoder can't handle a channel, try its others rather than failing.
        DefaultRenderersFactory renderers = new DefaultRenderersFactory(this).setEnableDecoderFallback(true);
        player = new ExoPlayer.Builder(this, renderers)
                .setLoadControl(loadControl)
                // Keep Wi-Fi awake while watching; some boxes otherwise let it doze and the stream drops.
                .setWakeMode(C.WAKE_MODE_NETWORK)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(new DefaultDataSource.Factory(this, http),
                        // IPTV MPEG-TS often has keyframes the default reader doesn't treat as start points, which
                        // slows the start of a channel and can stutter.
                        new DefaultExtractorsFactory().setTsExtractorFlags(DefaultTsPayloadReaderFactory.FLAG_ALLOW_NON_IDR_KEYFRAMES
                                | DefaultTsPayloadReaderFactory.FLAG_DETECT_ACCESS_UNITS)))
                .build();
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                // Count stalls while watching (not the start of a channel), for the app log.
                if (state == Player.STATE_BUFFERING && wasReady) stalls++;
                wasReady = state == Player.STATE_READY;
                if (state == Player.STATE_READY) {
                    retries = 0;
                    failed = false;
                    failureCounted = false;
                    bufferingSince = 0;
                    status.setVisibility(View.GONE);
                } else if (state == Player.STATE_BUFFERING) {
                    if (bufferingSince == 0) bufferingSince = System.currentTimeMillis();
                } else if (state == Player.STATE_ENDED) {
                    // A live channel shouldn't end; the provider closed the stream. Connect again.
                    retryAfterError(null);
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                retryAfterError(error);
            }
        });
        playerView.setPlayer(player);
    }

    private void releasePlayer() {
        handler.removeCallbacks(retryRunnable);
        handler.removeCallbacks(watchdog);
        if (player == null) return;
        if (playerView != null) playerView.setPlayer(null);
        player.release();
        player = null;
    }

    private void tune(int i) {
        if (channels.isEmpty() || player == null) return;
        index = (i + channels.size()) % channels.size();
        retries = 0;
        failed = false;
        failureCounted = false;
        bufferingSince = 0;
        handler.removeCallbacks(retryRunnable);
        status.setVisibility(View.GONE);
        Channel c = channels.get(index);
        wasReady = false; // a new channel loading isn't a stall
        player.setMediaItem(mediaItem(c.url));
        player.prepare();
        player.setPlayWhenReady(true);
        handler.removeCallbacks(watchdog);
        handler.postDelayed(watchdog, WATCHDOG_MS);
        // Report the channel once the viewer settles on it (not every channel while flicking through).
        handler.removeCallbacks(reportChannel);
        handler.postDelayed(reportChannel, 4000);
        showBanner();
        if (adapter != null) adapter.notifyDataSetChanged();
    }

    private static MediaItem mediaItem(String url) {
        MediaItem.Builder item = new MediaItem.Builder().setUri(url);
        if (url.toLowerCase().contains(".m3u8")) item.setMimeType(MimeTypes.APPLICATION_M3U8);
        return item.build();
    }

    /** An Xtream channel's address in the other format: /live/…/123.ts ⇄ /live/…/123.m3u8. Null if there isn't one. */
    static String otherFormat(String url) {
        java.util.regex.Matcher m = java.util.regex.Pattern.compile("(?i)^(.*/live/.+)\\.(ts|m3u8)(\\?.*)?$").matcher(url);
        if (!m.matches()) return null;
        return m.group(1) + ("ts".equalsIgnoreCase(m.group(2)) ? ".m3u8" : ".ts") + (m.group(3) == null ? "" : m.group(3));
    }

    private final Runnable retryRunnable = () -> {
        if (player == null) return;
        bufferingSince = 0;
        player.seekToDefaultPosition();
        player.prepare();
        player.setPlayWhenReady(true);
    };

    private static final long HEARTBEAT_MS = 60000;
    private final Runnable heartbeat = new Runnable() {
        @Override public void run() {
            if (reporter != null) reporter.heartbeat();
            handler.postDelayed(this, HEARTBEAT_MS);
        }
    };
    private final Runnable reportChannel = () -> {
        if (reporter == null || channels.isEmpty()) return;
        Channel c = channels.get(index);
        reporter.playing(c.name, c.num, c.logo, group, c.now);
        handler.removeCallbacks(heartbeat);
        handler.postDelayed(heartbeat, HEARTBEAT_MS);
    };

    /** A stream can stall without any error (the provider stops sending but keeps the connection open). */
    private static final long WATCHDOG_MS = 5000;
    private long stallMs = 25000; // the page can set it (Admin → Playback)
    private final Runnable watchdog = new Runnable() {
        @Override public void run() {
            if (player == null) return;
            if (player.getPlayWhenReady() && player.getPlaybackState() == Player.STATE_BUFFERING
                    && bufferingSince > 0 && System.currentTimeMillis() - bufferingSince > stallMs) {
                retryAfterError(null);
            }
            handler.postDelayed(this, WATCHDOG_MS);
        }
    };

    /** After the quick retries, keep trying now and then (about five minutes) in case the channel comes back. */
    private static final int SLOW_RETRIES = 20;
    private static final long SLOW_RETRY_MS = 15000;

    /** The HTTP status the provider answered with, if that's what went wrong (0 if it was something else). */
    private static int httpCode(Throwable t) {
        for (int depth = 0; t != null && depth < 8; t = t.getCause(), depth++) {
            if (t instanceof HttpDataSource.InvalidResponseCodeException) return ((HttpDataSource.InvalidResponseCodeException) t).responseCode;
        }
        return 0;
    }

    /** What a provider's refusal usually means, in words the viewer can act on. */
    private static String providerHint(int code) {
        if (code == 429 || code == 458) return "The TV provider says this subscription is in use on too many devices. Stop any other TV using it.";
        if (code == 401 || code == 403) return "The TV provider refused this channel. The subscription may have expired, or be in use on too many devices.";
        if (code == 404 || code == 410) return "The TV provider doesn't have this channel any more.";
        if (code >= 500) return "The TV provider's server is having trouble.";
        return null;
    }
    private String providerNote = "";

    // Live streams drop now and then; reconnect, and if a channel keeps failing try it in the other format.
    private void retryAfterError(PlaybackException error) {
        if (player == null) return;
        retries++;
        bufferingSince = 0;
        int code = error == null ? 0 : httpCode(error);
        String hint = providerHint(code);
        providerNote = hint == null ? "" : "\n" + hint;
        handler.removeCallbacks(retryRunnable);
        Channel c = channels.get(index);
        String other = c.triedOther ? null : otherFormat(c.url);
        if (retries == 3 && other != null) {
            // Some providers only serve a channel properly as HLS (or as MPEG-TS): switch and keep that.
            c.triedOther = true;
            c.url = other;
            status.setText("Reconnecting…");
            status.setVisibility(View.VISIBLE);
            player.setMediaItem(mediaItem(other));
            handler.postDelayed(retryRunnable, 1000);
            return;
        }
        if (retries <= MAX_RETRIES) {
            status.setText((retries == 1 ? "Reconnecting…" : "Reconnecting… (" + retries + ")") + (retries >= 2 ? providerNote : ""));
            status.setVisibility(View.VISIBLE);
            // A provider that says "too many connections" is also counting our retries: don't hammer it.
            handler.postDelayed(retryRunnable, code == 429 || code == 458 ? 8000L : Math.min(1000L * retries, 5000L));
        } else if (retries <= MAX_RETRIES + SLOW_RETRIES) {
            if (!failureCounted) { failureCounted = true; failedChannels++; failedName = c.name; failedCode = code; }
            failed = true;
            status.setText("This channel isn't working right now. Still trying…" + providerNote + "\nPress OK to try again now, or pick another channel.");
            status.setVisibility(View.VISIBLE);
            handler.postDelayed(retryRunnable, SLOW_RETRY_MS);
        } else {
            failed = true;
            status.setText("This channel isn't working right now." + providerNote + "\nPress OK to try again, or pick another channel.");
            status.setVisibility(View.VISIBLE);
        }
    }

    /** OK while a channel is failing: try again straight away. */
    private void retryNow() {
        retries = MAX_RETRIES; // stay in the slow-retry phase if this attempt fails too
        status.setText("Trying again…");
        handler.removeCallbacks(retryRunnable);
        retryRunnable.run();
    }

    // ---------- Views ----------

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private TextView text(float sizeSp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        return t;
    }

    @SuppressLint("ClickableViewAccessibility")
    private void buildViews() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        playerView = new PlayerView(this);
        playerView.setUseController(false);
        playerView.setShowBuffering(PlayerView.SHOW_BUFFERING_ALWAYS);
        playerView.setKeepScreenOn(true);
        playerView.setOnClickListener(v -> toggleList());
        root.addView(playerView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // Channel banner along the bottom.
        banner = new LinearLayout(this);
        banner.setOrientation(LinearLayout.HORIZONTAL);
        banner.setGravity(Gravity.CENTER_VERTICAL);
        banner.setPadding(dp(32), dp(20), dp(32), dp(24));
        GradientDrawable shade = new GradientDrawable(GradientDrawable.Orientation.BOTTOM_TOP,
                new int[]{Color.parseColor("#E6000000"), Color.TRANSPARENT});
        banner.setBackground(shade);
        bannerLogo = new ImageView(this);
        bannerLogo.setScaleType(ImageView.ScaleType.FIT_CENTER);
        banner.addView(bannerLogo, new LinearLayout.LayoutParams(dp(72), dp(54)));
        LinearLayout bannerText = new LinearLayout(this);
        bannerText.setOrientation(LinearLayout.VERTICAL);
        bannerText.setPadding(dp(16), 0, 0, 0);
        bannerTitle = text(22, Color.WHITE, true);
        bannerNow = text(15, Color.parseColor("#D5DCEF"), false);
        bannerGroup = text(12, ACCENT, true);
        bannerText.addView(bannerGroup);
        bannerText.addView(bannerTitle);
        bannerText.addView(bannerNow);
        banner.addView(bannerText, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        FrameLayout.LayoutParams bannerLp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
        root.addView(banner, bannerLp);

        // Reconnecting / error message in the middle.
        status = text(18, Color.WHITE, true);
        status.setSingleLine(false);
        status.setGravity(Gravity.CENTER);
        status.setPadding(dp(20), dp(12), dp(20), dp(12));
        GradientDrawable pill = new GradientDrawable();
        pill.setColor(Color.parseColor("#B3000000"));
        pill.setCornerRadius(dp(10));
        status.setBackground(pill);
        status.setVisibility(View.GONE);
        status.setOnClickListener(v -> { if (failed) retryNow(); }); // tap on a phone
        root.addView(status, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));

        // Typed channel number, top right.
        numberEntry = text(40, Color.WHITE, true);
        numberEntry.setPadding(dp(18), dp(8), dp(18), dp(8));
        GradientDrawable numBg = new GradientDrawable();
        numBg.setColor(Color.parseColor("#B3000000"));
        numBg.setCornerRadius(dp(8));
        numberEntry.setBackground(numBg);
        numberEntry.setVisibility(View.GONE);
        FrameLayout.LayoutParams numLp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.END);
        numLp.setMargins(0, dp(28), dp(36), 0);
        root.addView(numberEntry, numLp);

        // Channel list down the left side.
        listPanel = new LinearLayout(this);
        listPanel.setOrientation(LinearLayout.VERTICAL);
        listPanel.setBackgroundColor(PANEL);
        listPanel.setPadding(0, dp(PlayerUi.isTv(this) ? 20 : 76), 0, dp(12)); // phones: room for the Back button above the list
        TextView header = text(13, ACCENT, true);
        header.setText(group.isEmpty() ? "CHANNELS" : group.toUpperCase());
        header.setPadding(dp(20), 0, dp(20), dp(10));
        listPanel.addView(header);
        listView = new ListView(this);
        listView.setDivider(new ColorDrawable(Color.TRANSPARENT));
        listView.setDividerHeight(dp(2));
        listView.setSelector(rowSelector());
        listView.setDrawSelectorOnTop(false);
        listView.setItemsCanFocus(false);
        adapter = new ChannelAdapter();
        listView.setAdapter(adapter);
        listView.setOnItemClickListener((parent, view, position, id) -> {
            hideList();
            if (position != index) tune(position);
        });
        listPanel.addView(listView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        listPanel.setVisibility(View.GONE);
        root.addView(listPanel, new FrameLayout.LayoutParams(dp(380), ViewGroup.LayoutParams.MATCH_PARENT, Gravity.START));

        // Phones: a Back button that shows with the channel banner (tap the picture to bring it up).
        backButton = PlayerUi.backButton(this, this::finishWithResult);
        if (backButton != null) {
            backButton.setVisibility(View.GONE);
            root.addView(backButton);
        }

        setContentView(root);
    }

    private StateListDrawable rowSelector() {
        GradientDrawable on = new GradientDrawable();
        on.setColor(Color.parseColor("#33FFFFFF"));
        on.setStroke(dp(2), Color.WHITE);
        on.setCornerRadius(dp(6));
        StateListDrawable s = new StateListDrawable();
        s.addState(new int[]{android.R.attr.state_focused}, on);
        s.addState(new int[]{android.R.attr.state_selected}, on);
        s.addState(new int[]{android.R.attr.state_pressed}, on);
        s.addState(new int[]{}, new ColorDrawable(Color.TRANSPARENT));
        return s;
    }

    private TextView backButton; // null on a TV
    private final Runnable hideBanner = () -> {
        banner.animate().alpha(0f).setDuration(300).start();
        if (backButton != null && !listOpen()) {
            backButton.animate().alpha(0f).setDuration(300).withEndAction(() -> {
                if (backButton.getAlpha() == 0f) backButton.setVisibility(View.GONE);
            }).start();
        }
    };

    private void showBanner() {
        Channel c = channels.get(index);
        bannerTitle.setText((c.num.isEmpty() ? "" : c.num + "   ") + c.name);
        bannerNow.setText(c.now.isEmpty() ? "" : "Now: " + c.now);
        bannerNow.setVisibility(c.now.isEmpty() ? View.GONE : View.VISIBLE);
        bannerGroup.setText(group.toUpperCase());
        bannerGroup.setVisibility(group.isEmpty() ? View.GONE : View.VISIBLE);
        bannerLogo.setImageDrawable(null);
        loadLogo(c.logo, bannerLogo);
        banner.animate().cancel();
        banner.setAlpha(1f);
        if (backButton != null) {
            backButton.animate().cancel();
            backButton.setAlpha(1f);
            backButton.setVisibility(View.VISIBLE);
        }
        handler.removeCallbacks(hideBanner);
        handler.postDelayed(hideBanner, 4500);
    }

    private boolean listOpen() { return listPanel.getVisibility() == View.VISIBLE; }

    private void showList() {
        listPanel.setVisibility(View.VISIBLE);
        adapter.notifyDataSetChanged();
        listView.requestFocus();
        listView.setSelection(index);
        handler.post(() -> listView.setSelection(index));
    }

    private void hideList() {
        listPanel.setVisibility(View.GONE);
        playerView.requestFocus();
        // The Back button goes with the banner again once the list is closed.
        handler.removeCallbacks(hideBanner);
        handler.postDelayed(hideBanner, 2500);
    }

    private void toggleList() {
        if (listOpen()) hideList(); else { showBanner(); showList(); }
    }

    // ---------- Logos ----------

    private void loadLogo(String url, ImageView into) {
        into.setTag(url);
        if (TextUtils.isEmpty(url) || !(url.startsWith("http://") || url.startsWith("https://"))) return;
        Bitmap cached = logoCache.get(url);
        if (cached != null) { into.setImageBitmap(cached); return; }
        if (isFinishing()) return;
        try {
            logoLoader.execute(() -> {
                Bitmap bmp = null;
                HttpURLConnection conn = null;
                try {
                    conn = (HttpURLConnection) new URL(url).openConnection();
                    conn.setConnectTimeout(8000);
                    conn.setReadTimeout(8000);
                    conn.setInstanceFollowRedirects(true);
                    byte[] data;
                    try (InputStream in = conn.getInputStream(); ByteArrayOutputStream buf = new ByteArrayOutputStream()) {
                        byte[] chunk = new byte[16 * 1024];
                        for (int n; (n = in.read(chunk)) > 0; ) {
                            buf.write(chunk, 0, n);
                            if (buf.size() > 2 * 1024 * 1024) throw new java.io.IOException("logo too big");
                        }
                        data = buf.toByteArray();
                    }
                    // Decode big logos at a reduced size straight away instead of full size first.
                    BitmapFactory.Options opts = new BitmapFactory.Options();
                    opts.inJustDecodeBounds = true;
                    BitmapFactory.decodeByteArray(data, 0, data.length, opts);
                    int sample = 1;
                    while (opts.outWidth / (sample * 2) >= 240 && opts.outHeight / (sample * 2) >= 60) sample *= 2;
                    opts = new BitmapFactory.Options();
                    opts.inSampleSize = sample;
                    bmp = BitmapFactory.decodeByteArray(data, 0, data.length, opts);
                    if (bmp != null && bmp.getWidth() > 240) {
                        int h = Math.max(1, Math.round(bmp.getHeight() * 240f / bmp.getWidth()));
                        bmp = Bitmap.createScaledBitmap(bmp, 240, h, true);
                    }
                } catch (Exception | OutOfMemoryError ignored) {
                    // No logo; the name is enough.
                } finally {
                    if (conn != null) conn.disconnect();
                }
                if (bmp == null) return;
                final Bitmap result = bmp;
                logoCache.put(url, result);
                handler.post(() -> { if (url.equals(into.getTag())) into.setImageBitmap(result); });
            });
        } catch (RejectedExecutionException ignored) {
            // Closing.
        }
    }

    private final class ChannelAdapter extends BaseAdapter {
        @Override public int getCount() { return channels.size(); }
        @Override public Object getItem(int position) { return channels.get(position); }
        @Override public long getItemId(int position) { return position; }

        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            LinearLayout row = (LinearLayout) convertView;
            if (row == null) {
                row = new LinearLayout(LivePlayerActivity.this);
                row.setOrientation(LinearLayout.HORIZONTAL);
                row.setGravity(Gravity.CENTER_VERTICAL);
                row.setPadding(dp(16), dp(8), dp(16), dp(8));
                TextView num = text(14, Color.parseColor("#9AA3BD"), true);
                num.setMinWidth(dp(44));
                ImageView logo = new ImageView(LivePlayerActivity.this);
                logo.setScaleType(ImageView.ScaleType.FIT_CENTER);
                LinearLayout texts = new LinearLayout(LivePlayerActivity.this);
                texts.setOrientation(LinearLayout.VERTICAL);
                texts.setPadding(dp(12), 0, 0, 0);
                TextView name = text(16, Color.WHITE, true);
                TextView now = text(12, Color.parseColor("#9AA3BD"), false);
                texts.addView(name);
                texts.addView(now);
                row.addView(num);
                row.addView(logo, new LinearLayout.LayoutParams(dp(48), dp(36)));
                row.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
            }
            Channel c = channels.get(position);
            TextView num = (TextView) row.getChildAt(0);
            ImageView logo = (ImageView) row.getChildAt(1);
            LinearLayout texts = (LinearLayout) row.getChildAt(2);
            TextView name = (TextView) texts.getChildAt(0);
            TextView now = (TextView) texts.getChildAt(1);
            num.setText(c.num);
            name.setText(c.name);
            name.setTextColor(position == index ? ACCENT : Color.WHITE);
            now.setText(c.now);
            now.setVisibility(c.now.isEmpty() ? View.GONE : View.VISIBLE);
            logo.setImageDrawable(null);
            loadLogo(c.logo, logo);
            return row;
        }
    }

    // ---------- Remote ----------

    private final Runnable tuneTypedNumber = () -> {
        String n = typedNumber.toString();
        typedNumber.setLength(0);
        numberEntry.setVisibility(View.GONE);
        for (int i = 0; i < channels.size(); i++) {
            if (n.equals(channels.get(i).num)) { tune(i); return; }
        }
        // No channel with that number: treat it as a position in the list.
        try {
            int pos = Integer.parseInt(n) - 1;
            if (pos >= 0 && pos < channels.size()) tune(pos);
        } catch (NumberFormatException ignored) {
            // Not a number.
        }
    };

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // Closing early (no channels): nothing on screen to steer.
        if (listPanel == null || event.getAction() != KeyEvent.ACTION_DOWN) return super.dispatchKeyEvent(event);
        int code = event.getKeyCode();
        if (listOpen()) {
            if (code == KeyEvent.KEYCODE_BACK || code == KeyEvent.KEYCODE_DPAD_RIGHT || code == KeyEvent.KEYCODE_ESCAPE) {
                hideList();
                return true;
            }
            if (code == KeyEvent.KEYCODE_CHANNEL_UP) { tune(index + 1); return true; }
            if (code == KeyEvent.KEYCODE_CHANNEL_DOWN) { tune(index - 1); return true; }
            return super.dispatchKeyEvent(event); // the list handles up/down/OK
        }
        if (code >= KeyEvent.KEYCODE_0 && code <= KeyEvent.KEYCODE_9) {
            if (typedNumber.length() < 5) typedNumber.append((char) ('0' + code - KeyEvent.KEYCODE_0));
            numberEntry.setText(typedNumber);
            numberEntry.setVisibility(View.VISIBLE);
            handler.removeCallbacks(tuneTypedNumber);
            handler.postDelayed(tuneTypedNumber, 1500);
            return true;
        }
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_UP:
            case KeyEvent.KEYCODE_CHANNEL_UP:
                if (event.getRepeatCount() == 0) tune(index + 1);
                return true;
            case KeyEvent.KEYCODE_DPAD_DOWN:
            case KeyEvent.KEYCODE_CHANNEL_DOWN:
                if (event.getRepeatCount() == 0) tune(index - 1);
                return true;
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
                if (failed) { retryNow(); return true; }
                showBanner();
                showList();
                return true;
            case KeyEvent.KEYCODE_DPAD_LEFT:
            case KeyEvent.KEYCODE_GUIDE:
            case KeyEvent.KEYCODE_MENU:
                showBanner();
                showList();
                return true;
            case KeyEvent.KEYCODE_DPAD_RIGHT:
            case KeyEvent.KEYCODE_INFO:
                showBanner();
                return true;
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
                if (player == null) return true;
                if (player.isPlaying()) player.pause();
                else { player.seekToDefaultPosition(); player.play(); }
                showBanner();
                return true;
            default:
                return super.dispatchKeyEvent(event);
        }
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (listPanel != null && listOpen()) { hideList(); return; }
        finishWithResult();
    }

    private void finishWithResult() {
        // Free the video memory now, before the app's main screen comes back, rather than whenever
        // Android gets round to destroying this screen.
        releasePlayer();
        logoCache.evictAll();
        Intent result = new Intent();
        result.putExtra(RESULT_INDEX, index);
        result.putExtra(RESULT_STALLS, stalls);
        result.putExtra(RESULT_MINUTES, (int) ((System.currentTimeMillis() - openedAt) / 60000));
        result.putExtra(RESULT_BUFFER, bufferLevel);
        result.putExtra(RESULT_FAILED, failedChannels);
        result.putExtra(RESULT_FAILED_NAME, failedName);
        result.putExtra(RESULT_FAILED_CODE, failedCode);
        setResult(RESULT_OK, result);
        finish();
    }

    // ---------- Lifecycle ----------

    @Override
    protected void onStart() {
        super.onStart();
        if (stopped && !isFinishing() && listPanel != null) {
            // Coming back to live TV: start the channel again at "now".
            stopped = false;
            buildPlayer();
            tune(index);
        }
    }

    @Override
    protected void onStop() {
        super.onStop();
        handler.removeCallbacks(reportChannel);
        handler.removeCallbacks(heartbeat);
        if (reporter != null) reporter.stopped();
        // Out of sight (Home button, another app): let go of the stream and its memory entirely.
        releasePlayer();
        stopped = true;
    }

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        logoCache.evictAll();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        logoLoader.shutdownNow();
        if (reporter != null) reporter.close();
        releasePlayer();
        super.onDestroy();
    }

    @SuppressWarnings("deprecation")
    private void hideSystemBars() {
        getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN);
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "1";
        }
    }
}
