---
permalink: /support/
title: Support
---

# Support

## Frequently Asked Questions

### I can connect on WiFi but not on cellular

By design, the app only works when both your phone and Mac are on the same network (your home WiFi or a Tailscale network). Cellular connections are not supported by direct connection.

To work on cellular, you need:

1. Your Mac running Tailscale, or
2. An optional relay enabled on your Mac (contact us for access)

If neither is available, you will not be able to use the app away from your network.

### My pairing code expired

Pairing codes are single-use and expire five minutes after they are generated. If your code expired before you could scan it:

1. On your Mac, go to the control page (default: http://127.0.0.1:7788)
2. Click **Show pairing code** again
3. Scan the new code with the app

### Notifications are not arriving

If you are waiting for a notification but it does not appear:

1. Check that notifications are enabled:
   - Open the app and go to Settings
   - Confirm "Allow Notifications" is on
   - Confirm that iOS has not disabled notifications for DoraBot Remote (check iOS Settings > Notifications)

2. Make sure the relay is reachable:
   - The notification will only send if your Mac can reach our relay
   - If your Mac is offline or has no internet connection, notifications will not send
   - You will still see the message when you open the app on the home network

3. Check your connection:
   - Open the app and try to connect
   - If the connection is unstable, notifications may not arrive reliably
   - See "Send a connection log" below

### How do I revoke a device?

If you want to block access from a paired device:

1. On your Mac, run:
   ```
   dorabot-remote revoke <deviceId>
   ```
   Or use the control page (http://127.0.0.1:7788) to revoke a device.

2. The device will be disconnected immediately.

3. The pairing record is kept. If you change your mind, you can still use that device to reconnect.

To delete the pairing record entirely:
```
dorabot-remote remove <deviceId>
```

### How do I uninstall the bridge?

To remove the bridge from your Mac:

```
dorabot-remote uninstall
```

This stops the bridge and removes it, but keeps its keys and paired devices so you can reinstall later. Add `--purge` to delete those too:

```
dorabot-remote uninstall --purge
```

## Send a Connection Log

If you are experiencing connection issues, a connection log will help diagnose the problem.

On your phone, in the app:

1. Go to Settings (gear icon)
2. Tap **Connection log**
3. Tap **Copy** (or **Export** if available)
4. Paste the log into an email to wisam@xische.com

Include:

- What you were trying to do when the problem occurred
- Whether you were on WiFi, cellular, or Tailscale
- Any error messages you saw

This log contains connection metadata and timing information but not your prompts or files.

## Contact Us

If you did not find what you need above:

- Email: wisam@xische.com
- GitHub issues: https://github.com/wisamamid/dorabot-remote/issues

When you contact us, tell us:

- What you were trying to do
- What went wrong
- What you have already tried
- A connection log (see above)
