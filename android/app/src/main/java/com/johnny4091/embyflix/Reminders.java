package com.johnny4091.embyflix;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;

import org.json.JSONObject;

import java.util.Iterator;

/**
 * Game reminders (Live TV → Sports → Remind me). The page asks for a reminder at a time; this keeps it in the phone's own
 * alarm list and shows a notification when it goes off. Tapping the notification opens Aurora at Live TV → Sports.
 * Reminders are also saved here so they come back after the phone restarts. Timing is "about then" (the phone may delay an
 * alarm a little to save battery), which is why the page asks for ten minutes before the game.
 */
public final class Reminders {
    static final String CHANNEL_ID = "aurora-reminders";
    static final String EXTRA_OPEN = "openHash";
    static final String EXTRA_ID = "rid", EXTRA_TITLE = "rtitle", EXTRA_TEXT = "rtext";
    private static final String PREFS = "aurora-reminders";

    private Reminders() { }

    /** Sets (or moves) the reminder with this id. A time in the past is ignored. */
    static void schedule(Context ctx, String id, String title, String text, long whenMs) {
        if (id == null || id.isEmpty() || whenMs <= System.currentTimeMillis()) return;
        try {
            SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            JSONObject all = load(prefs);
            all.put(id, new JSONObject().put("title", title).put("text", text).put("when", whenMs));
            prefs.edit().putString("all", all.toString()).apply();
        } catch (Exception ignored) {
            // The alarm below still works for this session.
        }
        arm(ctx, id, title, text, whenMs);
    }

    static void cancel(Context ctx, String id) {
        if (id == null || id.isEmpty()) return;
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am != null) am.cancel(pending(ctx, id, "", ""));
        forget(ctx, id);
    }

    /** After a restart: every saved reminder that is still to come is armed again. */
    static void rescheduleAll(Context ctx) {
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSONObject all = load(prefs);
        long now = System.currentTimeMillis();
        Iterator<String> keys = all.keys();
        while (keys.hasNext()) {
            String id = keys.next();
            JSONObject r = all.optJSONObject(id);
            if (r == null || r.optLong("when", 0) <= now) continue;
            arm(ctx, id, r.optString("title"), r.optString("text"), r.optLong("when"));
        }
    }

    static void forget(Context ctx, String id) {
        try {
            SharedPreferences prefs = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            JSONObject all = load(prefs);
            all.remove(id);
            prefs.edit().putString("all", all.toString()).apply();
        } catch (Exception ignored) {
            // Nothing to forget.
        }
    }

    private static JSONObject load(SharedPreferences prefs) {
        try {
            return new JSONObject(prefs.getString("all", "{}"));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    private static void arm(Context ctx, String id, String title, String text, long whenMs) {
        AlarmManager am = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, whenMs, pending(ctx, id, title, text));
    }

    private static PendingIntent pending(Context ctx, String id, String title, String text) {
        Intent intent = new Intent(ctx, ReminderReceiver.class)
                .setData(Uri.parse("aurora://reminder/" + Uri.encode(id)))
                .putExtra(EXTRA_ID, id).putExtra(EXTRA_TITLE, title).putExtra(EXTRA_TEXT, text);
        return PendingIntent.getBroadcast(ctx, id.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** The alarm went off: show the notification. */
    public static final class ReminderReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            String id = intent.getStringExtra(EXTRA_ID);
            if (id == null) return;
            String title = intent.getStringExtra(EXTRA_TITLE), text = intent.getStringExtra(EXTRA_TEXT);
            NotificationManager nm = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            nm.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Game reminders", NotificationManager.IMPORTANCE_HIGH));
            Intent open = new Intent(ctx, MainActivity.class)
                    .putExtra(EXTRA_OPEN, "#/livetv?tab=sports")
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
            PendingIntent tap = PendingIntent.getActivity(ctx, id.hashCode(), open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification note = new Notification.Builder(ctx, CHANNEL_ID)
                    .setSmallIcon(android.R.drawable.ic_popup_reminder)
                    .setContentTitle(title == null || title.isEmpty() ? "A game is about to start" : title)
                    .setContentText(text == null ? "" : text)
                    .setCategory(Notification.CATEGORY_REMINDER)
                    .setAutoCancel(true)
                    .setContentIntent(tap)
                    .build();
            nm.notify(id.hashCode(), note); // quietly ignored if the customer hasn't allowed notifications
            forget(ctx, id);
        }
    }

    /** The phone restarted: alarms don't survive that, so set the saved ones again. */
    public static final class BootReceiver extends BroadcastReceiver {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            if (Intent.ACTION_BOOT_COMPLETED.equals(intent.getAction())) rescheduleAll(ctx);
        }
    }
}
