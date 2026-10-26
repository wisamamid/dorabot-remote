package com.xische.dorabotremote;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // App-local plugins must be registered before super.onCreate builds the bridge.
        registerPlugin(PushKeyStorePlugin.class);
        registerPlugin(AppGroupPlugin.class);
        super.onCreate(savedInstanceState);
        NotificationChannels.ensure(this);
    }
}
