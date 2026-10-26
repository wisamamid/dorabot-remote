package com.xische.dorabotremote;

import android.content.ClipData;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * Android's half of the JS "AppGroup" plugin (src/lib/appgroup.ts): only takeShare. Text, URLs and photos
 * shared to the app (ACTION_SEND / ACTION_SEND_MULTIPLE) wait here until JS picks them up on start / resume;
 * the app then shows its usual confirm sheet and sends nothing until the user taps Send. There is no widget,
 * Live Activity or Watch on Android, so those methods do not exist (the JS side never calls them there).
 */
@CapacitorPlugin(name = "AppGroup")
public class AppGroupPlugin extends Plugin {
    private static final int MAX_IMAGES = 4;
    private static final int MAX_EDGE = 1600;
    private static final int MAX_TEXT = 20000;

    private static final Object LOCK = new Object();
    private static String pendingId;
    private static String pendingText;
    private static List<Uri> pendingImages = new ArrayList<>();

    @Override
    public void load() {
        if (getActivity() != null) capture(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        capture(intent);
    }

    private void capture(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (!Intent.ACTION_SEND.equals(action) && !Intent.ACTION_SEND_MULTIPLE.equals(action)) return;
        String text = intent.getStringExtra(Intent.EXTRA_TEXT);
        String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
        List<Uri> uris = new ArrayList<>();
        String type = intent.getType();
        if (type != null && type.startsWith("image/")) {
            try {
                if (Intent.ACTION_SEND.equals(action)) {
                    Uri u = intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
                    if (u != null) uris.add(u);
                } else {
                    ArrayList<Uri> many = intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM, Uri.class);
                    if (many != null) uris.addAll(many);
                }
            } catch (Exception ignored) {
                // malformed extras
            }
            ClipData clip = intent.getClipData();
            if (uris.isEmpty() && clip != null) {
                for (int i = 0; i < clip.getItemCount(); i++) if (clip.getItemAt(i).getUri() != null) uris.add(clip.getItemAt(i).getUri());
            }
        }
        if ((text == null || text.isEmpty()) && subject != null) text = subject;
        if ((text == null || text.isEmpty()) && uris.isEmpty()) return;
        // Consume the intent so a resume with the same Intent does not re-offer it.
        intent.setAction(Intent.ACTION_MAIN);
        synchronized (LOCK) {
            pendingId = UUID.randomUUID().toString();
            pendingText = text == null ? "" : (text.length() > MAX_TEXT ? text.substring(0, MAX_TEXT) : text);
            pendingImages = uris.size() > MAX_IMAGES ? new ArrayList<>(uris.subList(0, MAX_IMAGES)) : uris;
        }
    }

    @PluginMethod
    public void takeShare(PluginCall call) {
        String id;
        String text;
        List<Uri> uris;
        synchronized (LOCK) {
            id = pendingId;
            text = pendingText;
            uris = pendingImages;
            pendingId = null;
            pendingText = null;
            pendingImages = new ArrayList<>();
        }
        JSObject r = new JSObject();
        if (id == null) {
            r.put("found", false);
            call.resolve(r);
            return;
        }
        JSArray images = new JSArray();
        for (Uri u : uris) {
            String b64 = jpegBase64(u);
            if (b64 == null) continue;
            JSObject o = new JSObject();
            o.put("data", b64);
            o.put("mediaType", "image/jpeg");
            images.put(o);
        }
        r.put("found", true);
        r.put("id", id);
        r.put("text", text == null ? "" : text);
        r.put("images", images);
        call.resolve(r);
    }

    private String jpegBase64(Uri uri) {
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
                BitmapFactory.decodeStream(in, null, bounds);
            }
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) return null;
            int sample = 1;
            while (Math.max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MAX_EDGE) sample *= 2;
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = sample;
            Bitmap bmp;
            try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
                bmp = BitmapFactory.decodeStream(in, null, opts);
            }
            if (bmp == null) return null;
            int longest = Math.max(bmp.getWidth(), bmp.getHeight());
            if (longest > MAX_EDGE) {
                float s = (float) MAX_EDGE / longest;
                bmp = Bitmap.createScaledBitmap(bmp, Math.max(1, Math.round(bmp.getWidth() * s)), Math.max(1, Math.round(bmp.getHeight() * s)), true);
            }
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, 80, out);
            return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        } catch (Exception e) {
            return null;
        }
    }
}
