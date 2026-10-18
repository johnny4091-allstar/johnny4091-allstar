package com.johnny4091.embyflix;

import android.app.Activity;
import android.app.ActivityManager;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.KeyEvent;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionParameters;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.datasource.DefaultDataSource;
import androidx.media3.datasource.DefaultHttpDataSource;
import androidx.media3.exoplayer.DefaultLoadControl;
import androidx.media3.exoplayer.DefaultRenderersFactory;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory;
import androidx.media3.ui.PlayerView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Full-screen player for Emby movies and episodes. ExoPlayer plays most files as they are (MKV, MP4, HEVC,
 * AC3 …), so Emby rarely has to convert them, and when it does, ExoPlayer handles Emby's HLS stream far more
 * smoothly than the WebView's video element.
 *
 * The page works out what to play (Emby's PlaybackInfo) and hands over a JSON spec:
 * {url, hls, startMs, title, subtitle, subs: [{url, lang, label, format}], introStartMs, introEndMs, creditsMs,
 *  nextTitle, report: {base, auth, itemId, mediaSourceId, playSessionId, playMethod, deviceId, audioIndex, subtitleIndex}}
 * This screen tells Emby the position itself (so Continue Watching is right), and returns
 * {positionMs, ended, next, error, ready} to the page when it closes.
 */
@OptIn(markerClass = UnstableApi.class)
public class VodPlayerActivity extends Activity {
    static final String EXTRA_SPEC = "spec";
    static final String RESULT_JSON = "result";

    private static final int ACCENT = Color.parseColor("#2AD4D0");
    private static final long SEEK_MS = 10000;
    private static final long PROGRESS_MS = 10000;
    private static final int MAX_RETRIES = 4;
    /** An error this close to the end counts as the end. */
    private static final long END_SLACK_MS = 30000;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService reports = Executors.newSingleThreadExecutor();

    private JSONObject spec, report;
    private String url, playMethod;
    private boolean hls;
    private final List<MediaItem.SubtitleConfiguration> subs = new ArrayList<>();
    private long introStart = -1, introEnd = -1, credits = -1;
    private String nextTitle = "";

    private ExoPlayer player;
    private PlayerView playerView;
    private TextView status, skipIntro, nextButton;

    /** Where to start (again) when the player is (re)built. */
    private long resumeMs;
    private boolean everReady, ended, stopped, closing, reportedStart, touched;
    private int retries;
    private long endStuckSince, stallSince;
    private int stalls;
    private long stalledMs, stallStart, playingSince;
    private boolean wasReady, seeking;
    /** How long a film may sit buffering before the player reconnects; the page can set it (Admin → Playback). */
    private long stallMs = 30000;
    private String error;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        hideSystemBars();
        try {
            spec = new JSONObject(getIntent().getStringExtra(EXTRA_SPEC));
        } catch (Exception e) {
            finish();
            return;
        }
        url = spec.optString("url");
        if (url.isEmpty()) { finish(); return; }
        hls = spec.optBoolean("hls");
        resumeMs = Math.max(0, spec.optLong("startMs"));
        introStart = spec.optLong("introStartMs", -1);
        introEnd = spec.optLong("introEndMs", -1);
        credits = spec.optLong("creditsMs", -1);
        nextTitle = spec.optString("nextTitle", "");
        report = spec.optJSONObject("report");
        if (report == null) report = new JSONObject();
        playMethod = report.optString("playMethod", "DirectPlay");
        int stallSeconds = spec.optInt("stallSeconds", 30);
        if (stallSeconds >= 8 && stallSeconds <= 120) stallMs = stallSeconds * 1000L;
        JSONArray s = spec.optJSONArray("subs");
        for (int i = 0; s != null && i < s.length(); i++) {
            JSONObject o = s.optJSONObject(i);
            if (o == null || o.optString("url").isEmpty()) continue;
            String format = o.optString("format", "vtt").toLowerCase();
            String mime = format.equals("srt") || format.equals("subrip") ? MimeTypes.APPLICATION_SUBRIP
                    : format.equals("ass") || format.equals("ssa") ? MimeTypes.TEXT_SSA : MimeTypes.TEXT_VTT;
            subs.add(new MediaItem.SubtitleConfiguration.Builder(Uri.parse(o.optString("url")))
                    .setMimeType(mime)
                    .setLanguage(o.optString("lang", null))
                    .setLabel(o.optString("label", null))
                    .setSelectionFlags(o.optBoolean("selected") ? C.SELECTION_FLAG_DEFAULT : 0)
                    .build());
        }
        buildViews();
        buildPlayer();
    }

    // ---------- Player ----------

    /**
     * How much video to hold in memory: a third of what this device allows the app, 32-160 MB. Films are
     * often 10-40 Mbps when sent as they are, so 64 MB was only 13-50 seconds and a slow moment on the
     * internet stopped playback. This screen has little else in memory, unlike live TV's channel list.
     */
    private int bufferBytes() {
        ActivityManager am = (ActivityManager) getSystemService(ACTIVITY_SERVICE);
        int heapMb = am == null ? 192 : Math.max(am.getMemoryClass(), am.getLargeMemoryClass());
        int mb = Math.max(32, Math.min(160, heapMb / 3));
        if (am != null && am.isLowRamDevice()) mb = 32;
        return mb * 1024 * 1024;
    }

    private void buildPlayer() {
        DefaultHttpDataSource.Factory http = new DefaultHttpDataSource.Factory()
                .setUserAgent("Aurora (Android)")
                .setAllowCrossProtocolRedirects(true)
                .setConnectTimeoutMs(15000)
                .setReadTimeoutMs(30000);
        // Start quickly, then build up a deep buffer so a slow moment on the internet doesn't stop the film.
        DefaultLoadControl loadControl = new DefaultLoadControl.Builder()
                .setBufferDurationsMs(30000, 180000, 2500, 5000)
                .setTargetBufferBytes(bufferBytes())
                .setPrioritizeTimeOverSizeThresholds(false)
                .build();
        DefaultRenderersFactory renderers = new DefaultRenderersFactory(this)
                .setEnableDecoderFallback(true)
                // Software decoders for audio the box can't decode itself, where available.
                .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON);
        player = new ExoPlayer.Builder(this, renderers)
                .setLoadControl(loadControl)
                .setWakeMode(C.WAKE_MODE_NETWORK)
                .setSeekBackIncrementMs(SEEK_MS)
                .setSeekForwardIncrementMs(SEEK_MS)
                .setMediaSourceFactory(new DefaultMediaSourceFactory(this)
                        .setDataSourceFactory(new DefaultDataSource.Factory(this, http)))
                .build();
        player.addListener(new Player.Listener() {
            @Override
            public void onPlaybackStateChanged(int state) {
                // Stalls while watching (not the start, and not after a seek), with how long they lasted.
                long nowMs = System.currentTimeMillis();
                if (state == Player.STATE_BUFFERING && wasReady && !seeking) { stalls++; stallStart = nowMs; }
                else if (state != Player.STATE_BUFFERING && stallStart != 0) { stalledMs += nowMs - stallStart; stallStart = 0; }
                wasReady = state == Player.STATE_READY;
                seeking = false;
                if (state == Player.STATE_READY) {
                    retries = 0;
                    status.setVisibility(View.GONE);
                    if (!everReady) {
                        everReady = true;
                        playerView.hideController();
                    }
                    if (playingSince == 0) playingSince = System.currentTimeMillis();
                    if (!reportedStart) {
                        reportedStart = true;
                        sendReport("/Sessions/Playing", null);
                        handler.removeCallbacks(progress);
                        handler.postDelayed(progress, PROGRESS_MS);
                    }
                } else if (state == Player.STATE_ENDED) {
                    ended = true;
                    close(!nextTitle.isEmpty());
                }
            }

            @Override
            public void onPositionDiscontinuity(Player.PositionInfo oldPosition, Player.PositionInfo newPosition, int reason) {
                if (reason == Player.DISCONTINUITY_REASON_SEEK || reason == Player.DISCONTINUITY_REASON_SEEK_ADJUSTMENT) seeking = true;
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                if (reportedStart && !closing) sendReport("/Sessions/Playing/Progress", isPlaying ? "Unpause" : "Pause");
            }

            @Override
            public void onPlayerError(PlaybackException e) {
                onError(e);
            }
        });
        applyLanguagePrefs();
        playerView.setPlayer(player);
        MediaItem.Builder item = new MediaItem.Builder().setUri(url).setSubtitleConfigurations(subs);
        if (hls) item.setMimeType(MimeTypes.APPLICATION_M3U8);
        player.setMediaItem(item.build(), resumeMs);
        player.prepare();
        player.setPlayWhenReady(true);
        handler.removeCallbacks(markers);
        handler.post(markers);
    }

    /** The viewer's Emby language settings: which audio track to pick, and when subtitles come on. */
    private void applyLanguagePrefs() {
        String audioLang = spec.optString("audioLang"), subLang = spec.optString("subLang"), subMode = spec.optString("subMode");
        TrackSelectionParameters.Builder p = player.getTrackSelectionParameters().buildUpon();
        if (!audioLang.isEmpty()) p.setPreferredAudioLanguage(audioLang);
        if ("None".equals(subMode)) {
            p.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true);
        } else if ("Always".equals(subMode)) {
            if (!subLang.isEmpty()) p.setPreferredTextLanguage(subLang);
            p.setSelectUndeterminedTextLanguage(true);
        }
        // Default / Smart / OnlyForced: subtitles the file marks as default or forced, or one picked in Aurora.
        player.setTrackSelectionParameters(p.build());
    }

    private void releasePlayer() {
        handler.removeCallbacks(progress);
        handler.removeCallbacks(markers);
        handler.removeCallbacks(retry);
        if (player == null) return;
        resumeMs = Math.max(0, player.getCurrentPosition());
        if (playerView != null) playerView.setPlayer(null);
        player.release();
        player = null;
    }

    private final Runnable retry = () -> {
        if (player == null) return;
        player.seekTo(resumeMs);
        player.prepare();
        player.setPlayWhenReady(true);
    };

    private void onError(PlaybackException e) {
        if (player == null || closing) return;
        String why = e.getErrorCodeName();
        // A failure in the last moments is the end of the video, not a fault: Emby's converted stream often
        // lists a little more than it delivers, so the final piece fails to load. Carry on as if it ended.
        long pos = player.getCurrentPosition(), dur = player.getDuration();
        if (everReady && dur != C.TIME_UNSET && dur > 0
                && (pos >= dur - END_SLACK_MS || (credits > 0 && pos >= credits))) {
            ended = true;
            close(!nextTitle.isEmpty());
            return;
        }
        // A file the device can't play as it is: let the page ask Emby to convert it instead.
        if (!"Transcode".equals(playMethod) && (!everReady || isDecodeError(e))) {
            error = "unplayable:" + why;
            close(false);
            return;
        }
        // Otherwise it's usually the connection: pick up where it stopped.
        retries++;
        resumeMs = Math.max(0, player.getCurrentPosition());
        if (retries <= MAX_RETRIES) {
            status.setText("Reconnecting…");
            status.setVisibility(View.VISIBLE);
            handler.removeCallbacks(retry);
            handler.postDelayed(retry, 1500L * retries);
        } else {
            error = "failed:" + why;
            status.setText("This video stopped playing (" + why + ").\nPress OK to try again, or Back to leave.");
            status.setVisibility(View.VISIBLE);
        }
    }

    private static boolean isDecodeError(PlaybackException e) {
        int c = e.errorCode;
        return (c >= PlaybackException.ERROR_CODE_DECODER_INIT_FAILED && c <= PlaybackException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED)
                || (c >= PlaybackException.ERROR_CODE_PARSING_CONTAINER_MALFORMED && c <= PlaybackException.ERROR_CODE_PARSING_MANIFEST_UNSUPPORTED)
                || c == PlaybackException.ERROR_CODE_AUDIO_TRACK_INIT_FAILED;
    }

    /** Shows Skip Intro during the intro and Next Episode once the credits start. */
    private final Runnable markers = new Runnable() {
        @Override public void run() {
            if (player == null) return;
            long pos = player.getCurrentPosition(), dur = player.getDuration();
            boolean inIntro = introStart >= 0 && introEnd > introStart && pos >= introStart && pos < introEnd - 1000;
            setVisible(skipIntro, inIntro);
            long nextAt = credits > 0 ? credits : (dur > 0 ? dur - 30000 : -1);
            setVisible(nextButton, !nextTitle.isEmpty() && nextAt > 0 && pos >= nextAt);
            // Stuck loading in the last seconds (the final piece never arrives): that's the end.
            boolean stuckAtEnd = everReady && dur != C.TIME_UNSET && dur > 0 && pos >= dur - END_SLACK_MS
                    && player.getPlayWhenReady() && player.getPlaybackState() == Player.STATE_BUFFERING;
            // Stuck loading mid-film with no error (a stalled connection, or Emby's converting stalled):
            // reconnect at the same spot rather than spinning for ever.
            boolean buffering = everReady && player.getPlayWhenReady() && player.getPlaybackState() == Player.STATE_BUFFERING && !stuckAtEnd;
            if (!buffering) stallSince = 0;
            else if (stallSince == 0) stallSince = System.currentTimeMillis();
            else if (System.currentTimeMillis() - stallSince > stallMs && retries < MAX_RETRIES) {
                stallSince = 0;
                retries++;
                resumeMs = Math.max(0, player.getCurrentPosition());
                status.setText("Reconnecting…");
                status.setVisibility(View.VISIBLE);
                handler.removeCallbacks(retry);
                handler.post(retry);
            }
            if (!stuckAtEnd) endStuckSince = 0;
            else if (endStuckSince == 0) endStuckSince = System.currentTimeMillis();
            else if (System.currentTimeMillis() - endStuckSince > 8000) {
                ended = true;
                close(!nextTitle.isEmpty());
                return;
            }
            handler.postDelayed(this, 1000);
        }
    };

    private void setVisible(TextView button, boolean show) {
        boolean shown = button.getVisibility() == View.VISIBLE;
        if (show == shown) return;
        button.setVisibility(show ? View.VISIBLE : View.GONE);
        if (show && !playerView.isControllerFullyVisible()) button.requestFocus();
    }

    private final Runnable progress = new Runnable() {
        @Override public void run() {
            if (player == null) return;
            sendReport("/Sessions/Playing/Progress", "TimeUpdate");
            handler.postDelayed(this, PROGRESS_MS);
        }
    };

    // ---------- Reporting to Emby ----------

    private long positionMs() {
        return player != null ? Math.max(0, player.getCurrentPosition()) : resumeMs;
    }

    private void sendReport(String path, String event) {
        if (report.optString("base").isEmpty() || reports.isShutdown()) return;
        try {
            JSONObject body = new JSONObject()
                    .put("ItemId", report.optString("itemId"))
                    .put("MediaSourceId", report.optString("mediaSourceId"))
                    .put("PlaySessionId", report.optString("playSessionId"))
                    .put("PositionTicks", positionMs() * 10000L)
                    .put("IsPaused", player == null || !player.getPlayWhenReady())
                    .put("IsMuted", false)
                    .put("VolumeLevel", 100)
                    .put("PlayMethod", playMethod)
                    .put("CanSeek", true);
            if (report.has("audioIndex")) body.put("AudioStreamIndex", report.optInt("audioIndex"));
            if (report.has("subtitleIndex")) body.put("SubtitleStreamIndex", report.optInt("subtitleIndex"));
            if (event != null) body.put("EventName", event);
            post(path, body.toString(), "POST");
        } catch (Exception ignored) {
            // Reporting is best effort.
        }
    }

    private void post(String path, String body, String method) {
        String base = report.optString("base"), auth = report.optString("auth"), key = report.optString("apiKey");
        if (reports.isShutdown()) return;
        reports.execute(() -> {
            HttpURLConnection conn = null;
            for (int attempt = 0; attempt < 2; attempt++) {
                try {
                    String u = base + path + (path.contains("?") ? "&" : "?") + "api_key=" + Uri.encode(key);
                    conn = (HttpURLConnection) new URL(u).openConnection();
                    conn.setRequestMethod(method);
                    conn.setConnectTimeout(10000);
                    conn.setReadTimeout(15000);
                    if (!auth.isEmpty()) conn.setRequestProperty("X-Emby-Authorization", auth);
                    if (body != null) {
                        conn.setDoOutput(true);
                        conn.setRequestProperty("Content-Type", "application/json");
                        try (OutputStream out = conn.getOutputStream()) { out.write(body.getBytes("UTF-8")); }
                    }
                    if (conn.getResponseCode() < 500) return;
                } catch (Exception ignored) {
                    // Try once more below.
                } finally {
                    if (conn != null) conn.disconnect();
                }
                try { Thread.sleep(1500); } catch (InterruptedException e) { return; }
            }
        });
    }

    /** Playback is over (for now): the final position, and let Emby stop converting the video. */
    private void reportStopped() {
        if (!reportedStart) return;
        reportedStart = false;
        handler.removeCallbacks(progress);
        sendReport("/Sessions/Playing/Stopped", null);
        if ("Transcode".equals(playMethod)) {
            post("/Videos/ActiveEncodings?DeviceId=" + Uri.encode(report.optString("deviceId"))
                    + "&PlaySessionId=" + Uri.encode(report.optString("playSessionId")), null, "DELETE");
        }
    }

    // ---------- Views ----------

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    private TextView button(String label) {
        TextView b = new TextView(this);
        b.setText(label);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        b.setTypeface(Typeface.DEFAULT_BOLD);
        b.setTextColor(Color.WHITE);
        b.setPadding(dp(22), dp(12), dp(22), dp(12));
        b.setFocusable(true);
        b.setClickable(true);
        GradientDrawable off = new GradientDrawable();
        off.setColor(Color.parseColor("#CC1A1F2E"));
        off.setStroke(dp(2), Color.parseColor("#88FFFFFF"));
        off.setCornerRadius(dp(6));
        GradientDrawable on = new GradientDrawable();
        on.setColor(ACCENT);
        on.setStroke(dp(2), Color.WHITE);
        on.setCornerRadius(dp(6));
        StateListDrawable bg = new StateListDrawable();
        bg.addState(new int[]{android.R.attr.state_focused}, on);
        bg.addState(new int[]{android.R.attr.state_pressed}, on);
        bg.addState(new int[]{}, off);
        b.setBackground(bg);
        b.setVisibility(View.GONE);
        return b;
    }

    private void buildViews() {
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);

        playerView = new PlayerView(this);
        playerView.setUseController(true);
        playerView.setControllerShowTimeoutMs(4000);
        playerView.setControllerAutoShow(true);
        playerView.setShowBuffering(PlayerView.SHOW_BUFFERING_ALWAYS);
        playerView.setShowSubtitleButton(true);
        playerView.setShowNextButton(false);
        playerView.setShowPreviousButton(false);
        playerView.setKeepScreenOn(true);
        root.addView(playerView, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        // Title along the top, shown with the controls.
        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.VERTICAL);
        top.setPadding(dp(32), dp(20), dp(32), dp(28));
        top.setBackground(new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{Color.parseColor("#CC000000"), Color.TRANSPARENT}));
        TextView title = new TextView(this);
        title.setText(spec.optString("title"));
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 20);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        title.setSingleLine(true);
        title.setEllipsize(TextUtils.TruncateAt.END);
        top.addView(title);
        String sub = spec.optString("subtitle");
        if (!sub.isEmpty()) {
            TextView subtitle = new TextView(this);
            subtitle.setText(sub);
            subtitle.setTextColor(Color.parseColor("#D5DCEF"));
            subtitle.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
            subtitle.setSingleLine(true);
            top.addView(subtitle);
        }
        root.addView(top, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP));
        top.setVisibility(View.GONE);
        playerView.setControllerVisibilityListener((PlayerView.ControllerVisibilityListener) v -> top.setVisibility(v));

        // Skip Intro / Next Episode, bottom right above the controls.
        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        skipIntro = button("Skip Intro");
        skipIntro.setOnClickListener(v -> {
            if (player != null && introEnd > 0) player.seekTo(introEnd);
            skipIntro.setVisibility(View.GONE);
        });
        nextButton = button("Next Episode ▶");
        nextButton.setOnClickListener(v -> close(true));
        actions.addView(skipIntro);
        LinearLayout.LayoutParams gap = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        gap.setMargins(dp(12), 0, 0, 0);
        actions.addView(nextButton, gap);
        FrameLayout.LayoutParams actionsLp = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.END);
        actionsLp.setMargins(0, 0, dp(36), dp(110));
        root.addView(actions, actionsLp);

        status = new TextView(this);
        status.setTextColor(Color.WHITE);
        status.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18);
        status.setTypeface(Typeface.DEFAULT_BOLD);
        status.setGravity(Gravity.CENTER);
        status.setPadding(dp(20), dp(12), dp(20), dp(12));
        GradientDrawable pill = new GradientDrawable();
        pill.setColor(Color.parseColor("#CC000000"));
        pill.setCornerRadius(dp(10));
        status.setBackground(pill);
        status.setVisibility(View.GONE);
        status.setOnClickListener(v -> retryNow());
        root.addView(status, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.CENTER));

        setContentView(root);
    }

    private void retryNow() {
        if (player == null) return;
        retries = 0;
        error = null;
        status.setText("Trying again…");
        handler.removeCallbacks(retry);
        retry.run();
    }

    // ---------- Remote ----------

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (player == null) return super.dispatchKeyEvent(event);
        int code = event.getKeyCode();
        boolean down = event.getAction() == KeyEvent.ACTION_DOWN;
        if (down) touched = true;
        boolean controls = playerView.isControllerFullyVisible();
        boolean onButton = skipIntro.hasFocus() || nextButton.hasFocus();
        switch (code) {
            case KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_PLAY:
            case KeyEvent.KEYCODE_MEDIA_PAUSE:
            case KeyEvent.KEYCODE_MEDIA_FAST_FORWARD:
            case KeyEvent.KEYCODE_MEDIA_REWIND:
                if (down && event.getRepeatCount() == 0) {
                    if (code == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD) player.seekForward();
                    else if (code == KeyEvent.KEYCODE_MEDIA_REWIND) player.seekBack();
                    else if (code == KeyEvent.KEYCODE_MEDIA_PLAY) player.play();
                    else if (code == KeyEvent.KEYCODE_MEDIA_PAUSE) player.pause();
                    else if (player.isPlaying()) player.pause(); else player.play();
                    playerView.showController();
                }
                return true;
            case KeyEvent.KEYCODE_DPAD_CENTER:
            case KeyEvent.KEYCODE_ENTER:
            case KeyEvent.KEYCODE_NUMPAD_ENTER:
                if (status.getVisibility() == View.VISIBLE && error != null) {
                    if (down) retryNow();
                    return true;
                }
                if (!controls && !onButton) {
                    // Controls hidden: OK pauses / plays and shows them.
                    if (down && event.getRepeatCount() == 0) {
                        if (player.isPlaying()) player.pause(); else player.play();
                        playerView.showController();
                    }
                    return true;
                }
                break;
            case KeyEvent.KEYCODE_DPAD_LEFT:
            case KeyEvent.KEYCODE_DPAD_RIGHT:
                if (!controls && !onButton) {
                    // Controls hidden: Left / Right jump back / ahead (held: keeps going).
                    if (down) {
                        if (code == KeyEvent.KEYCODE_DPAD_LEFT) player.seekBack(); else player.seekForward();
                        playerView.showController();
                    }
                    return true;
                }
                break;
            default:
                break;
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    public boolean dispatchTouchEvent(MotionEvent event) {
        touched = true;
        return super.dispatchTouchEvent(event);
    }

    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (playerView != null && playerView.isControllerFullyVisible() && player != null && player.isPlaying()) {
            playerView.hideController();
            return;
        }
        close(false);
    }

    private void close(boolean next) {
        if (closing) return;
        closing = true;
        long pos = positionMs();
        long dur = player != null ? player.getDuration() : C.TIME_UNSET;
        reportStopped();
        releasePlayer();
        reports.shutdown(); // queued reports still go out
        try {
            JSONObject result = new JSONObject()
                    .put("positionMs", pos)
                    .put("durationMs", dur == C.TIME_UNSET ? 0 : dur)
                    .put("ended", ended)
                    .put("next", next)
                    .put("ready", everReady)
                    .put("touched", touched)
                    .put("stalls", stalls)
                    .put("stalledMs", stalledMs + (stallStart != 0 ? System.currentTimeMillis() - stallStart : 0))
                    .put("watchedMs", playingSince == 0 ? 0 : System.currentTimeMillis() - playingSince);
            if (error != null) result.put("error", error);
            setResult(RESULT_OK, new Intent().putExtra(RESULT_JSON, result.toString()));
        } catch (Exception ignored) {
            setResult(RESULT_OK);
        }
        finish();
    }

    // ---------- Lifecycle ----------

    @Override
    protected void onStart() {
        super.onStart();
        if (stopped && !closing && playerView != null) {
            // Back in the app: carry on from where it was.
            stopped = false;
            buildPlayer();
        }
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (closing) return;
        // Home button, screen off: save the position with Emby and let go of the stream.
        if (player != null) resumeMs = Math.max(0, player.getCurrentPosition());
        reportStopped();
        releasePlayer();
        stopped = true;
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        if (!closing) reportStopped();
        releasePlayer();
        reports.shutdown();
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
}
