package com.johnny4091.embyflix;

import android.content.Context;
import android.os.Build;

import java.io.File;
import java.io.FileOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Writes the details of a crash to a file before Android closes the app, so the next start can show it in
 * the app log (Admin → App log) and send it to the Emby server. Without this a crash on a TV box leaves no trace.
 */
final class CrashRecorder implements Thread.UncaughtExceptionHandler {
    private static final String FILE = "last-crash.txt";

    private final File file;
    private final Thread.UncaughtExceptionHandler next;

    private CrashRecorder(File file, Thread.UncaughtExceptionHandler next) {
        this.file = file;
        this.next = next;
    }

    static void install(Context context) {
        Thread.UncaughtExceptionHandler current = Thread.getDefaultUncaughtExceptionHandler();
        if (current instanceof CrashRecorder) return;
        Thread.setDefaultUncaughtExceptionHandler(new CrashRecorder(new File(context.getFilesDir(), FILE), current));
    }

    /** The last crash report, or "" if there isn't one. Reading it removes it. */
    static String take(Context context) {
        File f = new File(context.getFilesDir(), FILE);
        if (!f.exists()) return "";
        try {
            byte[] data = new byte[(int) Math.min(f.length(), 16 * 1024)];
            try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
                int read = 0;
                for (int n; read < data.length && (n = in.read(data, read, data.length - read)) > 0; ) read += n;
                return new String(data, 0, read, StandardCharsets.UTF_8);
            }
        } catch (Exception e) {
            return "";
        } finally {
            //noinspection ResultOfMethodCallIgnored
            f.delete();
        }
    }

    @Override
    public void uncaughtException(Thread thread, Throwable error) {
        try {
            StringWriter trace = new StringWriter();
            error.printStackTrace(new PrintWriter(trace));
            String text = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss", Locale.ROOT).format(new Date())
                    + " · " + Build.MANUFACTURER + " " + Build.MODEL + " · Android " + Build.VERSION.RELEASE
                    + " · thread " + thread.getName() + "\n" + trace;
            if (text.length() > 12000) text = text.substring(0, 12000);
            try (FileOutputStream out = new FileOutputStream(file)) {
                out.write(text.getBytes(StandardCharsets.UTF_8));
            }
        } catch (Throwable ignored) {
            // Recording is best effort; never get in the way of the crash itself.
        }
        if (next != null) next.uncaughtException(thread, error);
    }
}
