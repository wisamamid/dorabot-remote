---
permalink: /support/
title: Support
---

# Support

## Getting Started

### Install

Requires Node 22.13 or newer.

```bash
npx dorabot-remote setup
```

This will start the bridge on your Mac and open the pairing page in your browser.

### Update

To update to the latest version:

```bash
npx dorabot-remote@latest update
```

### Uninstall

To stop and remove the bridge:

```bash
npx dorabot-remote uninstall
```

Add `--purge` to also delete pairing keys and device records:

```bash
npx dorabot-remote uninstall --purge
```

## Frequently Asked Questions

### My phone says it's waiting for approval

The device needs approval on your Mac before it can connect.

1. On your Mac, run:
   ```
   npx dorabot-remote open
   ```
   This opens the control page in your browser.

2. On the control page, find your device and click **Approve**.

3. Your phone will connect immediately.

### The Code tab is empty / says no folders are shared

You have not shared any folders yet. Only folders you explicitly allow can be accessed by your phone.

To add folders:

1. On your Mac, run:
   ```
   npx dorabot-remote open
   ```

2. Go to **Shared folders** and click **Add**.

3. Or use the command line:
   ```
   npx dorabot-remote folders add /path/to/folder
   ```

### Something is being approved without asking me

You (or someone holding your unlocked phone) chose "Always allow" on an approval. Those rules live on the Mac, never in dorabot's own settings, and each automatic approval is recorded in the audit log. Risky actions (deleting files, sudo, git push, writes into dotfiles or outside the project, uploads) are never covered by a rule.

To see or remove rules: the **Always-allow rules** section of the Mac control page (`npx dorabot-remote open`), **Settings** in the phone app, or:

```
npx dorabot-remote rules
npx dorabot-remote rules remove <id>
```

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
