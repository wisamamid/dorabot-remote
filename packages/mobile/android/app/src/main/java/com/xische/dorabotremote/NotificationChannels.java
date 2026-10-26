package com.xische.dorabotremote;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.content.Context;

/** The three channels the relay's FCM payload names (packages/relay/src/push.ts CHANNEL). Safe to call repeatedly. */
final class NotificationChannels {
    static final String QUESTIONS = "questions";
    static final String APPROVALS = "approvals";
    static final String ACTIVITY = "activity";

    private NotificationChannels() {}

    static void ensure(Context c) {
        NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        make(nm, QUESTIONS, "Questions", "dorabot is waiting for your answer", NotificationManager.IMPORTANCE_HIGH);
        make(nm, APPROVALS, "Approvals", "dorabot needs your approval to run something", NotificationManager.IMPORTANCE_HIGH);
        make(nm, ACTIVITY, "Activity", "Finished and failed runs, connection alerts", NotificationManager.IMPORTANCE_DEFAULT);
    }

    private static void make(NotificationManager nm, String id, String name, String desc, int importance) {
        if (nm.getNotificationChannel(id) != null) return;
        NotificationChannel ch = new NotificationChannel(id, name, importance);
        ch.setDescription(desc);
        nm.createNotificationChannel(ch);
    }

    /** Only the three known ids; anything else (the relay is not trusted for this) becomes Activity. */
    static String known(String id) {
        if (QUESTIONS.equals(id) || APPROVALS.equals(id)) return id;
        return ACTIVITY;
    }
}
