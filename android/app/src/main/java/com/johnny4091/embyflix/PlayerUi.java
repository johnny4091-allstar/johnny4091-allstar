package com.johnny4091.embyflix;

import android.app.UiModeManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.drawable.GradientDrawable;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.FrameLayout;
import android.widget.TextView;

/** Small pieces both video screens share. */
final class PlayerUi {
    private PlayerUi() {}

    /** A TV or TV box (remote control, no touch screen). Same test the main screen uses. */
    static boolean isTv(Context c) {
        UiModeManager uiMode = (UiModeManager) c.getSystemService(Context.UI_MODE_SERVICE);
        PackageManager pm = c.getPackageManager();
        return (uiMode != null && uiMode.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION)
                || pm.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
                || !pm.hasSystemFeature(PackageManager.FEATURE_TOUCHSCREEN);
    }

    /** A round ☆ / ★ button for the top right corner (phones). Returns null on a TV, where the remote does it. */
    static TextView starButton(Context c, Runnable onTap) {
        if (isTv(c)) return null;
        float d = c.getResources().getDisplayMetrics().density;
        TextView b = new TextView(c);
        b.setText("\u2606");
        b.setTextColor(Color.WHITE);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        b.setGravity(Gravity.CENTER);
        b.setMinWidth(Math.round(48 * d));
        b.setMinHeight(Math.round(48 * d));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#B3000000"));
        bg.setShape(GradientDrawable.OVAL);
        bg.setStroke(Math.round(1 * d), Color.parseColor("#55FFFFFF"));
        b.setBackground(bg);
        b.setContentDescription("Favorite");
        b.setClickable(true);
        b.setOnClickListener(v -> onTap.run());
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.WRAP_CONTENT, android.view.ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.END);
        lp.setMargins(0, Math.round(14 * d), Math.round(20 * d), 0);
        b.setLayoutParams(lp);
        return b;
    }

    /**
     * A "‹ Back" button for the top left corner, for phones, where the back gesture is easy to miss and the
     * controls hide. Returns null on a TV (the remote's Back button does the job there).
     */
    static TextView backButton(Context c, Runnable onBack) {
        if (isTv(c)) return null;
        float d = c.getResources().getDisplayMetrics().density;
        TextView b = new TextView(c);
        b.setText("‹  Back");
        b.setTextColor(Color.WHITE);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        b.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        b.setGravity(Gravity.CENTER);
        b.setMinHeight(Math.round(48 * d));
        b.setPadding(Math.round(18 * d), 0, Math.round(22 * d), 0);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(Color.parseColor("#B3000000"));
        bg.setCornerRadius(24 * d);
        bg.setStroke(Math.round(1 * d), Color.parseColor("#55FFFFFF"));
        b.setBackground(bg);
        b.setContentDescription("Back");
        b.setClickable(true);
        b.setOnClickListener(v -> onBack.run());
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                android.view.ViewGroup.LayoutParams.WRAP_CONTENT, android.view.ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.START);
        lp.setMargins(Math.round(20 * d), Math.round(14 * d), 0, 0);
        b.setLayoutParams(lp);
        return b;
    }
}
