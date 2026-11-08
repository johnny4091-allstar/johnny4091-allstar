package com.johnny4091.embyflix;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.RadialGradient;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.SweepGradient;
import android.graphics.Typeface;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.animation.LinearInterpolator;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The loading screen of both video players: a glowing ring around the AURORA name with a line of words under it.
 * If it takes over 8 seconds the words turn amber and say so, with a hint. On a TV only the ring turns (the glow pulse
 * is left out; weak TV boxes have enough to do).
 */
final class AuroraLoader extends LinearLayout {
    private static final long SLOW_MS = 8000;
    private final Logo logo;
    private TextView message, hint; // not final: the slowTask below is built before the constructor sets them
    private String slowHint = "";
    private boolean slow;

    AuroraLoader(Context c) {
        super(c);
        setOrientation(VERTICAL);
        setGravity(Gravity.CENTER_HORIZONTAL);
        setVisibility(GONE);
        setClickable(false);
        logo = new Logo(c, PlayerUi.isTv(c));
        addView(logo, new LayoutParams(dp(PlayerUi.isTv(c) ? 120 : 92), dp(PlayerUi.isTv(c) ? 120 : 92)));
        message = new TextView(c);
        message.setTextColor(Color.parseColor("#DBE2FB"));
        message.setTextSize(TypedValue.COMPLEX_UNIT_SP, PlayerUi.isTv(c) ? 20 : 15);
        message.setGravity(Gravity.CENTER);
        message.setShadowLayer(dp(4), 0, 0, Color.BLACK);
        LayoutParams mlp = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        mlp.topMargin = dp(16);
        addView(message, mlp);
        hint = new TextView(c);
        hint.setTextColor(Color.parseColor("#B3BEE8"));
        hint.setTextSize(TypedValue.COMPLEX_UNIT_SP, PlayerUi.isTv(c) ? 15 : 12);
        hint.setGravity(Gravity.CENTER);
        hint.setMaxWidth(dp(PlayerUi.isTv(c) ? 520 : 280));
        hint.setShadowLayer(dp(4), 0, 0, Color.BLACK);
        hint.setVisibility(GONE);
        LayoutParams hlp = new LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        hlp.topMargin = dp(8);
        addView(hint, hlp);
    }

    private int dp(float v) {
        return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()));
    }

    /** Shows the loader (no-op if it is already showing) with these words; {@code slowHint} is added if it takes over 8 seconds. */
    void show(String words, String slowHint) {
        this.slowHint = slowHint == null ? "" : slowHint;
        if (getVisibility() != VISIBLE) {
            slow = false;
            hint.setVisibility(GONE);
            message.setTextColor(Color.parseColor("#DBE2FB"));
            setVisibility(VISIBLE);
            logo.start();
            removeCallbacks(slowTask);
            postDelayed(slowTask, SLOW_MS);
        }
        if (!slow) message.setText(words);
    }

    /** Changes the words while showing (not once it is in its "taking longer" state). */
    void setMessage(String words) {
        if (!slow) message.setText(words);
    }

    boolean isShowing() { return getVisibility() == VISIBLE; }

    void hide() {
        removeCallbacks(slowTask);
        if (getVisibility() != GONE) setVisibility(GONE);
        logo.stop();
    }

    private final Runnable slowTask = () -> {
        if (getVisibility() != VISIBLE) return;
        slow = true;
        message.setText("This is taking longer than usual…");
        message.setTextColor(Color.parseColor("#FFD27A"));
        if (!slowHint.isEmpty()) { hint.setText(slowHint); hint.setVisibility(VISIBLE); }
    };

    @Override
    protected void onDetachedFromWindow() {
        removeCallbacks(slowTask);
        logo.stop();
        super.onDetachedFromWindow();
    }

    /** The ring, the halo behind it and the name in the middle. */
    private static final class Logo extends View {
        private final boolean tv;
        private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG), halo = new Paint(Paint.ANTI_ALIAS_FLAG),
                disc = new Paint(Paint.ANTI_ALIAS_FLAG), text = new Paint(Paint.ANTI_ALIAS_FLAG), track = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final RectF box = new RectF();
        private ValueAnimator anim;
        private float t; // 0..1, once round every 2.4 seconds

        Logo(Context c, boolean tv) {
            super(c);
            this.tv = tv;
            ring.setStyle(Paint.Style.STROKE);
            ring.setStrokeCap(Paint.Cap.ROUND);
            track.setStyle(Paint.Style.STROKE);
            track.setColor(Color.parseColor("#14FFFFFF"));
            disc.setStyle(Paint.Style.FILL);
            disc.setColor(Color.parseColor("#1F1B2760"));
            text.setColor(Color.WHITE);
            text.setTypeface(Typeface.create(Typeface.DEFAULT, Typeface.BOLD));
            text.setTextAlign(Paint.Align.CENTER);
            text.setLetterSpacing(0.16f);
        }

        void start() {
            if (anim != null) return;
            anim = ValueAnimator.ofFloat(0f, 1f);
            anim.setDuration(2400);
            anim.setRepeatCount(ValueAnimator.INFINITE);
            anim.setInterpolator(new LinearInterpolator());
            anim.addUpdateListener(a -> { t = (float) a.getAnimatedValue(); invalidate(); });
            anim.start();
        }

        void stop() {
            if (anim != null) { anim.cancel(); anim = null; }
        }

        @Override
        protected void onDraw(Canvas canvas) {
            float w = getWidth(), h = getHeight(), cx = w / 2f, cy = h / 2f, size = Math.min(w, h);
            float stroke = size * 0.07f, r = size / 2f - stroke * 1.6f;
            if (!tv) {
                // The glow behind the ring breathes in and out.
                float pulse = 1f + 0.08f * (float) Math.sin(2 * Math.PI * t);
                halo.setShader(new RadialGradient(cx, cy, size * 0.62f * pulse, new int[]{Color.parseColor("#664F7BFF"), Color.TRANSPARENT}, null, Shader.TileMode.CLAMP));
                canvas.drawCircle(cx, cy, size * 0.62f * pulse, halo);
            }
            canvas.drawCircle(cx, cy, r, disc);
            track.setStrokeWidth(stroke);
            canvas.drawCircle(cx, cy, r, track);
            box.set(cx - r, cy - r, cx + r, cy + r);
            ring.setStrokeWidth(stroke);
            ring.setShader(new SweepGradient(cx, cy, new int[]{Color.parseColor("#002AD4D0"), Color.parseColor("#2AD4D0"), Color.parseColor("#4F7BFF"), Color.parseColor("#9A6BFF"), Color.parseColor("#002AD4D0")}, new float[]{0f, 0.15f, 0.5f, 0.85f, 1f}));
            canvas.save();
            canvas.rotate(360f * t, cx, cy);
            canvas.drawArc(box, 0f, 340f, false, ring);
            canvas.restore();
            text.setTextSize(size * 0.15f);
            float breathe = tv ? 1f : 0.82f + 0.18f * (0.5f + 0.5f * (float) Math.sin(2 * Math.PI * t));
            text.setAlpha(Math.round(255 * breathe));
            text.setShadowLayer(size * 0.1f, 0, 0, Color.parseColor("#E67AA0FF"));
            canvas.drawText("AURORA", cx, cy + text.getTextSize() * 0.35f, text);
        }
    }
}
