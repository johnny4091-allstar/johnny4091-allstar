package com.johnny4091.embyflix;

import android.content.Context;
import android.util.Log;

import androidx.media3.exoplayer.DefaultRenderersFactory;

import io.github.anilbeesetti.nextlib.media3ext.ffdecoder.NextRenderersFactory;

/**
 * Builds the player's decoder list for both players. The device's own decoders always come first. With software
 * decoders on, FFmpeg (version 6.0, bundled by NextLib) is tried next for audio and video the device can't play.
 * If the FFmpeg code can't be loaded on some device the player carries on with the device's decoders alone.
 */
final class Decoders {
    private static final String TAG = "AuroraDecoders";

    private Decoders() {}

    static DefaultRenderersFactory factory(Context context, boolean software) {
        DefaultRenderersFactory factory = null;
        if (software) {
            try {
                factory = new NextRenderersFactory(context);
            } catch (Throwable t) { // a missing native library must never stop playback
                Log.w(TAG, "FFmpeg decoders unavailable: " + t);
            }
        }
        if (factory == null) factory = new DefaultRenderersFactory(context);
        factory.setEnableDecoderFallback(true); // a box whose preferred video decoder can't cope tries its others
        factory.setExtensionRendererMode(software && factory instanceof NextRenderersFactory
                ? DefaultRenderersFactory.EXTENSION_RENDERER_MODE_ON : DefaultRenderersFactory.EXTENSION_RENDERER_MODE_OFF);
        return factory;
    }
}
