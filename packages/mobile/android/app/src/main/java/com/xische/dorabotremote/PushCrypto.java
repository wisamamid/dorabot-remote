package com.xische.dorabotremote;

import android.os.Build;
import android.util.Base64;
import java.util.List;
import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;
import org.json.JSONObject;

/**
 * Opens the `enc` blob of a push: base64( nonce[12] || ciphertext || tag[16] ), ChaCha20-Poly1305 (IETF),
 * 32-byte key. Same bytes as packages/protocol push-crypto and the iOS Notification Service Extension.
 * The plaintext is JSON {kind, rid, sessionKey?, title, body, hostId?, hostName?}.
 *
 * The platform ChaCha20-Poly1305 Cipher exists from Android 9 (API 28). On 8.x everything returns null
 * and the caller shows the generic notification (which opens the Inbox).
 */
final class PushCrypto {
    static final class Content {
        String kind;
        String rid;
        String title;
        String body;
        String hostName;
        String hostId;
        /** Key id of the key that opened it. */
        String kid;
    }

    private PushCrypto() {}

    /**
     * A key only vouches for its own Mac: the hostId inside must hash to the key id of the key that opened it
     * (first 8 hex of sha256(hostId), as in the bridge). The pre-multi-Mac key (kid "") is tied to no Mac, so it never qualifies.
     */
    static boolean boundToKey(Content c) {
        if (c == null || c.kid == null || c.kid.isEmpty() || c.hostId == null || c.hostId.isEmpty()) return false;
        try {
            byte[] d = java.security.MessageDigest.getInstance("SHA-256").digest(c.hostId.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder hex = new StringBuilder();
            for (int i = 0; i < 4; i++) hex.append(String.format("%02x", d[i] & 0xff));
            return hex.toString().equals(c.kid);
        } catch (java.security.NoSuchAlgorithmException e) {
            return false;
        }
    }

    static Content decrypt(String enc, List<PushKeyStore.Entry> keys) {
        if (enc == null || Build.VERSION.SDK_INT < 28) return null;
        byte[] raw;
        try {
            raw = Base64.decode(enc, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            return null;
        }
        if (raw.length < 12 + 16) return null;
        for (PushKeyStore.Entry e : keys) {
            try {
                Cipher c = Cipher.getInstance("ChaCha20-Poly1305");
                c.init(Cipher.DECRYPT_MODE, new SecretKeySpec(e.key, "ChaCha20"), new IvParameterSpec(raw, 0, 12));
                byte[] plain = c.doFinal(raw, 12, raw.length - 12);
                JSONObject o = new JSONObject(PushKeyStore.text(plain));
                String kind = o.optString("kind", "");
                String rid = o.optString("rid", "");
                if ((!kind.equals("question") && !kind.equals("approval")) || rid.isEmpty()) continue;
                Content out = new Content();
                out.kind = kind;
                out.rid = rid;
                out.title = o.optString("title", "");
                out.body = o.optString("body", "");
                out.hostName = o.optString("hostName", "");
                out.hostId = o.optString("hostId", "");
                out.kid = e.kid;
                return out;
            } catch (Exception ignored) {
                // wrong key, tampered, malformed: try the next one
            }
        }
        return null;
    }
}
