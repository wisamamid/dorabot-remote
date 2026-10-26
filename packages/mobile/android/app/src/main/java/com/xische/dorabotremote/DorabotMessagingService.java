package com.xische.dorabotremote;

import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import androidx.annotation.NonNull;
import androidx.core.app.NotificationCompat;
import androidx.lifecycle.Lifecycle;
import androidx.lifecycle.ProcessLifecycleOwner;
import com.capacitorjs.plugins.pushnotifications.MessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.List;
import java.util.Map;

/**
 * Android counterpart of the iOS Notification Service Extension. The relay sends DATA-only FCM messages,
 * so this runs for every push, foreground or background. It opens the E2E `enc` with a stored per-Mac key,
 * posts a local notification with the real title/body (and Approve / Deny for approvals), and falls back
 * to the generic text (tap opens the Inbox) if anything fails. Approve / Deny only open the app; the
 * decision itself happens in JS behind biometrics (src/lib/push-actions.ts), exactly as on iOS.
 *
 * Extends the Capacitor push plugin's service so token refreshes still reach JS.
 */
public class DorabotMessagingService extends MessagingService {
    static final String TAG = "dr";

    @Override
    public void onMessageReceived(@NonNull RemoteMessage message) {
        Map<String, String> data = message.getData();
        if (data == null || !data.containsKey("t")) {
            super.onMessageReceived(message);
            return;
        }
        try {
            handle(getApplicationContext(), data);
        } catch (Exception e) {
            // Never crash the service on a malformed push.
        }
    }

    private static boolean appInForeground() {
        try {
            return ProcessLifecycleOwner.get().getLifecycle().getCurrentState().isAtLeast(Lifecycle.State.STARTED);
        } catch (Throwable t) {
            return false;
        }
    }

    private static String clip(String s, int max, String fallback) {
        if (s == null || s.isEmpty()) return fallback;
        return s.length() > max ? s.substring(0, max) : s;
    }

    static void handle(Context c, Map<String, String> data) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        String t = data.get("t");
        String rid = data.get("rid");
        if ("withdraw".equals(t)) {
            if (rid != null) nm.cancel(TAG, rid.hashCode());
            return;
        }
        // The inbox shows things live while the app is open, and iOS does not banner in the foreground either.
        if (appInForeground()) return;

        NotificationChannels.ensure(c);
        String enc = data.get("enc");
        List<PushKeyStore.Entry> keys = enc == null ? null : PushKeyStore.candidates(c, data.get("kid"));
        PushCrypto.Content content = enc == null ? null : PushCrypto.decrypt(enc, keys);

        String title;
        String body;
        String channel;
        String subText = null;
        if (content != null) {
            title = clip(content.title, 200, "dorabot");
            body = clip(content.body, 1000, "");
            channel = "approval".equals(content.kind) ? NotificationChannels.APPROVALS : NotificationChannels.QUESTIONS;
            if (keys.size() > 1 && !content.hostName.isEmpty()) subText = content.hostName;
            rid = content.rid;
        } else {
            title = clip(data.get("title"), 80, "dorabot remote");
            body = clip(data.get("body"), 160, "Tap to open");
            channel = NotificationChannels.known(data.get("channel"));
        }

        int id = rid != null ? rid.hashCode() : (int) System.currentTimeMillis();
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, channel)
            .setSmallIcon(R.drawable.ic_stat_dorabot)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setCategory(content != null ? NotificationCompat.CATEGORY_MESSAGE : NotificationCompat.CATEGORY_STATUS)
            .setPriority(NotificationChannels.ACTIVITY.equals(channel) ? NotificationCompat.PRIORITY_DEFAULT : NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(launch(c, id, "tap", content, enc, data.get("kid")));
        if (subText != null) b.setSubText(subText);
        if (content != null && "approval".equals(content.kind)) {
            b.addAction(0, "Approve", launch(c, id, "APPROVE", content, enc, data.get("kid")));
            b.addAction(0, "Deny", launch(c, id, "DENY", content, enc, data.get("kid")));
        }
        try {
            nm.notify(TAG, id, b.build());
        } catch (SecurityException denied) {
            // POST_NOTIFICATIONS not granted.
        }
    }

    /**
     * Opens the app with the encrypted blob attached; JS decrypts it again and is the only judge of
     * rid / kind / host. Nothing in these extras is acted on without that decrypt. An undecryptable
     * push carries no extras, so a tap is a plain open (Inbox).
     */
    private static PendingIntent launch(Context c, int id, String actionId, PushCrypto.Content content, String enc, String kid) {
        Intent i = new Intent(c, MainActivity.class);
        i.setAction(content != null ? PushKeyStorePlugin.ACTION_PUSH : Intent.ACTION_MAIN);
        i.addCategory(Intent.CATEGORY_LAUNCHER);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if (content != null) {
            i.putExtra("actionId", actionId);
            i.putExtra("enc", enc);
            if (kid != null) i.putExtra("kid", kid);
            i.putExtra("rid", content.rid);
            i.putExtra("k", content.kind);
        }
        int req = (actionId + ":" + id).hashCode();
        return PendingIntent.getActivity(c, req, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
