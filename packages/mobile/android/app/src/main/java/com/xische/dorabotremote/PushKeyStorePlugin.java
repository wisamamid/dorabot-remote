package com.xische.dorabotremote;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;
import android.util.Base64;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * App-local plugin (JS name "PushKeyStore", wrapper in src/lib/push-key.ts): the per-Mac push content
 * keys, shared with DorabotMessagingService through PushKeyStore, plus the hand-off of a notification
 * tap / Approve / Deny to JS (takeAction + the retained "pushAction" event).
 */
@CapacitorPlugin(name = "PushKeyStore")
public class PushKeyStorePlugin extends Plugin {
    static final String ACTION_PUSH = "com.xische.dorabotremote.PUSH";

    private static final Object LOCK = new Object();
    private static JSObject pending;

    @Override
    public void load() {
        // Cold start from a notification: the launch intent is already there.
        if (getActivity() != null) capture(getActivity().getIntent(), false);
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        capture(intent, true);
    }

    private void capture(Intent intent, boolean notifyJs) {
        if (intent == null || !ACTION_PUSH.equals(intent.getAction())) return;
        JSObject o = new JSObject();
        o.put("found", true);
        for (String k : new String[] { "actionId", "enc", "kid", "rid", "k" }) {
            String v = intent.getStringExtra(k);
            if (v != null) o.put(k, v);
        }
        // Consume it so a later resume of the same Intent object does not replay the action.
        intent.setAction(Intent.ACTION_MAIN);
        for (String k : new String[] { "actionId", "enc", "kid", "rid", "k" }) intent.removeExtra(k);
        String rid = o.optString("rid", "");
        if (!rid.isEmpty()) {
            NotificationManager nm = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(DorabotMessagingService.TAG, rid.hashCode());
        }
        synchronized (LOCK) {
            pending = o;
        }
        if (notifyJs) notifyListeners("pushAction", new JSObject(), true);
    }

    @PluginMethod
    public void takeAction(PluginCall call) {
        JSObject o;
        synchronized (LOCK) {
            o = pending;
            pending = null;
        }
        call.resolve(o != null ? o : new JSObject().put("found", false));
    }

    @PluginMethod
    public void set(PluginCall call) {
        String kid = call.getString("kid");
        String b64 = call.getString("key");
        if (!PushKeyStore.validKid(kid)) {
            call.reject("invalid kid");
            return;
        }
        byte[] key;
        try {
            key = Base64.decode(b64 == null ? "" : b64, Base64.DEFAULT);
        } catch (IllegalArgumentException e) {
            key = new byte[0];
        }
        if (key.length != 32) {
            call.reject("key must be base64 of 32 bytes");
            return;
        }
        try {
            PushKeyStore.set(getContext(), kid, key);
            call.resolve();
        } catch (Exception e) {
            call.reject("keystore write failed");
        }
    }

    @PluginMethod
    public void get(PluginCall call) {
        String kid = call.getString("kid");
        byte[] key = kid == null ? null : PushKeyStore.get(getContext(), kid);
        JSObject o = new JSObject();
        if (key != null) o.put("key", Base64.encodeToString(key, Base64.NO_WRAP));
        call.resolve(o);
    }

    @PluginMethod
    public void list(PluginCall call) {
        JSArray keys = new JSArray();
        for (PushKeyStore.Entry e : PushKeyStore.all(getContext())) {
            JSObject o = new JSObject();
            o.put("kid", e.kid);
            o.put("key", Base64.encodeToString(e.key, Base64.NO_WRAP));
            keys.put(o);
        }
        JSObject r = new JSObject();
        r.put("keys", keys);
        call.resolve(r);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        String kid = call.getString("kid");
        if (kid != null) PushKeyStore.clear(getContext(), kid);
        call.resolve();
    }

    @PluginMethod
    public void clearAll(PluginCall call) {
        PushKeyStore.clearAll(getContext());
        call.resolve();
    }
}
