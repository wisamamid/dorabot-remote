---
permalink: /privacy/
title: Privacy Policy
---

# Privacy Policy

Effective date: October 19, 2026

## Who We Are

DoraBot Remote is published by Xische FZ-LLC, a company based in the United Arab Emirates. For questions about this privacy policy, contact wisam@xische.com.

## What This App Does

DoraBot Remote is a companion app for iOS that pairs with a small program (the bridge) running on your own Mac. The app lets you control your dorabot agent from your phone: send prompts, read responses, answer questions, and approve tool calls.

The app is designed to give you control over your own data. Your prompts, code, files, and conversations stay on your Mac and your phone. They never go to our servers.

## Data We Do Not Collect

DoraBot Remote does not require an account, sign-up, or login. We do not collect:

- Your prompts or conversations with dorabot
- Code or files from your Mac
- Information about what you use the app for
- Tracking data or analytics
- Advertising identifiers
- Browsing history or behavioral data

We do not sell, rent, or share your data with anyone for marketing, advertising, or any other purpose.

## Data We Do Process

### Connection Metadata (Relay Only)

When you are away from your home network and not using Tailscale, your connection travels through an optional relay server we run on Cloudflare. The relay forwards encrypted traffic between your phone and your Mac but cannot read or decrypt it.

The relay does see and temporarily handle:

- A random relay ID assigned to each paired device
- The timing and size of encrypted messages
- Your push notification token (described below)

This data is not stored and is used only to route your traffic.

### Push Notifications

When your Mac needs to tell your phone that a question or approval is waiting, it sends a push notification through Apple Push Notification service (APNS). Your Mac encrypts the notification content with your phone's pairing key before sending it. APNS and the relay see only a generic notification title; they cannot read the content.

Your Mac provides the relay with your device's push token (a unique identifier issued by Apple). The relay uses this token only to deliver notifications and does not store it.

### Cloudflare Logs

When traffic goes through the relay, Cloudflare (our hosting provider) logs standard request information: your IP address, user agent, and request timestamps. These logs are kept for a short time (typically 24 hours) for operations and abuse prevention, then discarded. See Cloudflare's privacy policy for details: https://www.cloudflare.com/privacy/

### Local Data

Your pairing keys and conversation history are stored on your Mac (in SQLite) and on your phone (in encrypted iOS Keychain storage). This data never leaves your devices unless you send it explicitly.

## Encryption

All traffic between your phone and Mac is encrypted end-to-end using X25519 key agreement and XChaCha20-Poly1305 authenticated encryption. The pairing key is derived from a one-time QR code and never transmitted over the network; only the derived keys are used.

- Your phone stores its pairing key in the iOS Keychain with maximum security constraints (readable only after first device unlock, never synced to iCloud or restored to another device).
- Biometric (Face ID) unlock of the app is handled entirely by iOS; we never see biometric data.

If you revoke a device from your Mac or uninstall the app, the pairing keys are deleted.

## Third Parties

We use two third-party services:

1. **Cloudflare** (relay hosting)
   - Sees connection metadata and IP addresses
   - Does not see encrypted traffic
   - Data is discarded after a short time

2. **Apple Push Notification Service (APNS)**
   - Sees push notification tokens
   - Sees generic (non-sensitive) notification titles
   - Cannot read encrypted notification content
   - Apple's privacy policy: https://www.apple.com/privacy/

We do not share your data with any other third parties.

## Your Choices

### Revoke a Device

You can revoke access to any paired device at any time:

- From your Mac: run `dorabot-remote revoke <deviceId>` or use the control page
- Any live connection from that device is dropped immediately
- The pairing record is kept; you can re-pair if you change your mind

You can also delete the pairing record entirely with `dorabot-remote remove <deviceId>`.

### Disable Notifications

You can turn off push notifications in the app's settings. Without push notifications, you will still see messages when you open the app (the relay will not be used for notification delivery).

### Uninstall

Uninstalling the app from your phone deletes all local data (pairing keys, conversation history). Uninstalling the bridge from your Mac removes the pairing records and shuts down the daemon.

## Children

DoraBot Remote is not directed at children under 13. If we become aware that a child under 13 has used the app, we will take steps to delete their data as required by law. If you believe a child has paired with your Mac, revoke that device immediately.

## Changes to This Policy

We may update this privacy policy from time to time. If we make material changes, we will notify you by email (if we have contact information) or by posting the new policy on this page with an updated effective date. Your continued use of the app after changes means you accept the new policy.

## Contact Us

Questions about this privacy policy or our privacy practices? Email wisam@xische.com.
