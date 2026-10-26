package com.xische.dorabotremote;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * The per-Mac push content keys (32 random bytes each, keyed by the Mac's short key id).
 *
 * Each key is sealed with AES-256-GCM under a non-exportable Android Keystore key (no user
 * authentication required, so the FirebaseMessagingService can read it while the phone is locked,
 * the same trade-off as iOS "after first unlock") and the sealed blob lives in app-private
 * SharedPreferences (app backup is off, and the Keystore key would not travel anyway).
 */
final class PushKeyStore {
    private static final String PREFS = "dorabot_push_keys";
    private static final String ALIAS = "dorabot_push_wrap_v1";
    private static final String PREFIX = "k:";
    private static final Pattern KID = Pattern.compile("^[A-Za-z0-9_-]{0,16}$");

    static final class Entry {
        final String kid;
        final byte[] key;

        Entry(String kid, byte[] key) {
            this.kid = kid;
            this.key = key;
        }
    }

    private PushKeyStore() {}

    static boolean validKid(String kid) {
        return kid != null && KID.matcher(kid).matches();
    }

    private static SecretKey wrapKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(ALIAS)) {
            return (SecretKey) ks.getKey(ALIAS, null);
        }
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(
            new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return gen.generateKey();
    }

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static synchronized void set(Context c, String kid, byte[] key) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, wrapKey());
        byte[] iv = cipher.getIV();
        byte[] ct = cipher.doFinal(key);
        byte[] blob = new byte[iv.length + ct.length];
        System.arraycopy(iv, 0, blob, 0, iv.length);
        System.arraycopy(ct, 0, blob, iv.length, ct.length);
        prefs(c).edit().putString(PREFIX + kid, Base64.encodeToString(blob, Base64.NO_WRAP)).commit();
    }

    private static byte[] open(String stored) throws Exception {
        byte[] blob = Base64.decode(stored, Base64.DEFAULT);
        if (blob.length < 12 + 16) return null;
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, wrapKey(), new GCMParameterSpec(128, blob, 0, 12));
        return cipher.doFinal(blob, 12, blob.length - 12);
    }

    static synchronized byte[] get(Context c, String kid) {
        String s = prefs(c).getString(PREFIX + kid, null);
        if (s == null) return null;
        try {
            return open(s);
        } catch (Exception e) {
            return null;
        }
    }

    static synchronized List<Entry> all(Context c) {
        List<Entry> out = new ArrayList<>();
        for (Map.Entry<String, ?> e : prefs(c).getAll().entrySet()) {
            if (!e.getKey().startsWith(PREFIX) || !(e.getValue() instanceof String)) continue;
            try {
                byte[] k = open((String) e.getValue());
                if (k != null && k.length == 32) out.add(new Entry(e.getKey().substring(PREFIX.length()), k));
            } catch (Exception ignored) {
                // A key that no longer opens (Keystore reset) is as good as absent; the Mac re-registers.
            }
        }
        return out;
    }

    /** The kid match first, then every other key, each once (mirrors keyCandidates in push-keys.ts). */
    static List<Entry> candidates(Context c, String kid) {
        List<Entry> all = all(c);
        if (kid == null || kid.isEmpty()) return all;
        List<Entry> out = new ArrayList<>();
        for (Entry e : all) if (e.kid.equals(kid)) out.add(e);
        for (Entry e : all) if (!e.kid.equals(kid)) out.add(e);
        return out;
    }

    static synchronized void clear(Context c, String kid) {
        prefs(c).edit().remove(PREFIX + kid).commit();
    }

    /** Every sealed key and the Keystore wrapping key itself (a new one is generated on the next set). */
    static synchronized void clearAll(Context c) {
        prefs(c).edit().clear().commit();
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS);
        } catch (Exception ignored) {
            // The sealed blobs are gone; the wrapping key alone opens nothing.
        }
    }

    static String text(byte[] b) {
        return new String(b, StandardCharsets.UTF_8);
    }
}
