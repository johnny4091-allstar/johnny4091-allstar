package com.johnny4091.embyflix;

import android.content.Context;

import java.io.File;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The app's own cache: downloaded TV guides, channel lists and update files. Never the sign-in, settings,
 * favorites or watch history (those live elsewhere). {@link #tidy} runs by itself at start-up; {@link #clear}
 * is what Settings → Clear cache calls.
 */
final class CacheCleaner {
    private static final String[] FOLDERS = {"epg", "iptv"};
    private static final long MAX_BYTES = 150L * 1024 * 1024;
    private static final long OLD_MS = 7L * 24 * 3600_000;

    private CacheCleaner() {}

    /** Removes everything in the guide and channel-list caches. Returns how many bytes that freed. */
    static long clear(Context context) {
        long freed = 0;
        for (String name : FOLDERS) freed += deleteContents(new File(context.getCacheDir(), name));
        freed += deleteStaleUpdates(context, 5 * 60_000L); // not one that is being downloaded right now
        return freed;
    }

    /** Quietly keeps the cache small: drops week-old files, update files that are no longer needed, and the oldest files above 150 MB. */
    static void tidy(Context context) {
        try {
            long now = System.currentTimeMillis();
            List<File> files = new ArrayList<>();
            for (String name : FOLDERS) collect(new File(context.getCacheDir(), name), files);
            long total = 0;
            for (File f : new ArrayList<>(files)) {
                if (now - f.lastModified() > OLD_MS) { f.delete(); files.remove(f); }
                else total += f.length();
            }
            Collections.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
            for (int i = 0; i < files.size() && total > MAX_BYTES; i++) { total -= files.get(i).length(); files.get(i).delete(); }
            deleteStaleUpdates(context, 24 * 3600_000L);
        } catch (Throwable ignored) { /* housekeeping must never get in the way */ }
    }

    private static long deleteStaleUpdates(Context context, long olderThanMs) {
        long freed = 0, now = System.currentTimeMillis();
        File[] list = new File(context.getCacheDir(), "updates").listFiles();
        for (int i = 0; list != null && i < list.length; i++) {
            if (now - list[i].lastModified() >= olderThanMs && list[i].isFile()) { freed += list[i].length(); list[i].delete(); }
        }
        return freed;
    }

    private static void collect(File dir, List<File> out) {
        File[] list = dir.listFiles();
        for (int i = 0; list != null && i < list.length; i++) {
            if (list[i].isDirectory()) collect(list[i], out); else out.add(list[i]);
        }
    }

    private static long deleteContents(File dir) {
        long freed = 0;
        File[] list = dir.listFiles();
        for (int i = 0; list != null && i < list.length; i++) {
            if (list[i].isDirectory()) freed += deleteContents(list[i]);
            else { freed += list[i].length(); list[i].delete(); }
        }
        return freed;
    }
}
