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
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
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
    static final String RESULT_INDEX = "index";

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
    private boolean stopped;
    private String group = "";
    private String userAgent;

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
        // A deeper buffer than the default: live IPTV streams often arrive in bursts.
        DefaultLoadControl loadControl = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(15000, 50000, 2000, 4000)
                .setTargetBufferBytes(bufferBytes())
                .setPrioritizeTimeOverSizeThresholds(false)
                .build();
        player = new ExoPlayer.Builder(this)
                .setLoadControl(loadControl)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(this)
                        .setDataSourceFactory(new DefaultDataSource.Factory(this, http)))
                .build();
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                if (state == Player.STATE_READY) {
                    retries = 0;
                    status.setVisibility(View.GONE);
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
        if (player == null) return;
        if (playerView != null) playerView.setPlayer(null);
        player.release();
        player = null;
    }

    private void tune(int i) {
        if (channels.isEmpty() || player == null) return;
        index = (i + channels.size()) % channels.size();
        retries = 0;
        handler.removeCallbacks(retryRunnable);
        status.setVisibility(View.GONE);
        Channel c = channels.get(index);
        MediaItem.Builder item = new MediaItem.Builder().setUri(c.url);
        String lower = c.url.toLowerCase();
        if (lower.contains(".m3u8")) item.setMimeType(MimeTypes.APPLICATION_M3U8);
        player.setMediaItem(item.build());
        player.prepare();
        player.setPlayWhenReady(true);
        showBanner();
        if (adapter != null) adapter.notifyDataSetChanged();
    }

    private final Runnable retryRunnable = () -> {
        if (player == null) return;
        player.seekToDefaultPosition();
        player.prepare();
        player.setPlayWhenReady(true);
    };

    // Live streams drop now and then; reconnect a few times before giving up.
    private void retryAfterError(PlaybackException error) {
        if (retries < MAX_RETRIES) {
            retries++;
            status.setText(retries == 1 ? "Reconnecting…" : "Reconnecting… (" + retries + ")");
            status.setVisibility(View.VISIBLE);
            handler.removeCallbacks(retryRunnable);
            handler.postDelayed(retryRunnable, Math.min(1000L * retries, 5000L));
        } else {
            status.setText("This channel isn't working right now.\nTry another channel.");
            status.setVisibility(View.VISIBLE);
        }
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
        listPanel.setPadding(0, dp(20), 0, dp(12));
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

    private final Runnable hideBanner = () -> banner.animate().alpha(0f).setDuration(300).start();

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
