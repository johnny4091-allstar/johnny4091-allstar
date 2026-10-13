package com.johnny4091.embyflix;

import android.media.MediaCodecInfo;
import android.media.MediaCodecList;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Lists the video and audio formats this device can decode, in Emby's codec names. The page builds its Emby
 * device profile from it: everything listed is sent as it is, anything else gets converted by the server.
 */
final class Codecs {
    private static String cached;

    private Codecs() {}

    private static final String[][] VIDEO = {
            {"h264", "video/avc"}, {"hevc", "video/hevc"}, {"vp9", "video/x-vnd.on2.vp9"}, {"av1", "video/av01"},
            {"vp8", "video/x-vnd.on2.vp8"}, {"mpeg2video", "video/mpeg2"}, {"mpeg4", "video/mp4v-es"},
    };
    private static final String[][] AUDIO = {
            {"aac", "audio/mp4a-latm"}, {"mp3", "audio/mpeg"}, {"ac3", "audio/ac3"}, {"eac3", "audio/eac3"},
            {"opus", "audio/opus"}, {"flac", "audio/flac"}, {"vorbis", "audio/vorbis"}, {"dts", "audio/vnd.dts"},
            {"truehd", "audio/true-hd"}, {"mp2", "audio/mpeg-L2"}, {"pcm_s16le", "audio/raw"},
    };

    static synchronized String describe() {
        if (cached != null) return cached;
        JSONObject out = new JSONObject();
        try {
            MediaCodecInfo[] infos = new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos();
            JSONArray video = new JSONArray(), audio = new JSONArray();
            boolean hevc10 = false;
            int maxWidth = 1920;
            for (String[] v : VIDEO) {
                MediaCodecInfo.CodecCapabilities caps = find(infos, v[1]);
                if (caps == null) continue;
                video.put(v[0]);
                MediaCodecInfo.VideoCapabilities vc = caps.getVideoCapabilities();
                if (vc != null && ("h264".equals(v[0]) || "hevc".equals(v[0]))) {
                    maxWidth = Math.max(maxWidth, vc.getSupportedWidths().getUpper());
                }
                if ("hevc".equals(v[0]) && caps.profileLevels != null) {
                    for (MediaCodecInfo.CodecProfileLevel pl : caps.profileLevels) {
                        if (pl.profile == MediaCodecInfo.CodecProfileLevel.HEVCProfileMain10) hevc10 = true;
                    }
                }
            }
            for (String[] a : AUDIO) {
                // MP3 and AAC are always there; ExoPlayer also reads PCM itself.
                if ("pcm_s16le".equals(a[0]) || find(infos, a[1]) != null) audio.put(a[0]);
            }
            out.put("video", video).put("audio", audio).put("hevc10", hevc10).put("maxWidth", maxWidth);
        } catch (Exception e) {
            try {
                out.put("video", new JSONArray().put("h264")).put("audio", new JSONArray().put("aac").put("mp3"));
            } catch (Exception ignored) {
                // Leave it empty: the page falls back to its own guess.
            }
        }
        cached = out.toString();
        return cached;
    }

    private static MediaCodecInfo.CodecCapabilities find(MediaCodecInfo[] infos, String mime) {
        for (MediaCodecInfo info : infos) {
            if (info.isEncoder()) continue;
            for (String type : info.getSupportedTypes()) {
                if (!type.equalsIgnoreCase(mime)) continue;
                try {
                    return info.getCapabilitiesForType(type);
                } catch (Exception ignored) {
                    // Try the next decoder.
                }
            }
        }
        return null;
    }
}
