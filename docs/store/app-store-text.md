---
published: false
---

# App Store and TestFlight Text

## App Store Connect Fields

### App Name
DoraBot Remote

### Subtitle (max 30 chars)
Control dorabot on your phone

### Promotional Text (max 170 chars)
Answer questions and approve tool calls on your dorabot AI agent without leaving your phone. All traffic is encrypted end-to-end.

### Description (max 4000 chars)

DoraBot Remote is a companion app for your dorabot AI agent running on your own Mac. Pair your phone once with a QR code, then answer questions, approve tool calls, read the response stream, send new prompts, and manage your agent from anywhere, with no account, no sign-up, and no one reading your traffic.

**How it works**

The app pairs with a small program (the bridge) you install on your Mac using Node.js. Once paired, your phone connects directly to your Mac over your home network or Tailscale. If you are away from both, an optional relay routes encrypted traffic; the relay cannot read or decrypt it.

**Security**

All traffic between your phone and Mac is encrypted end-to-end using X25519 key agreement and XChaCha20-Poly1305. Your pairing key is stored in the iOS Keychain and never transmitted over the network. You can revoke any device instantly from your Mac.

**Your data stays yours**

Your prompts, code, files, and conversations never leave your Mac and phone. We do not collect them, and we do not have access to them. No analytics, no ads, no tracking.

**Features**

- Send prompts and read responses in real time
- Answer questions the agent asks you
- Approve or deny tool calls instantly
- Work from anywhere (home network, Tailscale, or optional relay)
- Revoke device access at any time
- Optional Face ID or passcode protection
- Open source (MIT license)

**Requirements**

- A Mac running dorabot and Node.js 22.5 or newer
- iOS 14 or later

**First time?**

Visit https://wisamamid.github.io/dorabot-remote for setup instructions (takes 3 steps).

### Keywords (max 100 chars, comma separated)
dorabot, AI, agent, automation, remote control, iOS

### Support URL
https://wisamamid.github.io/dorabot-remote/support/

### Privacy URL
https://wisamamid.github.io/dorabot-remote/privacy/

---

## TestFlight

### What to Test (max 4000 chars)

**What is DoraBot Remote?**

DoraBot Remote is a companion app for dorabot, an AI agent running on your Mac. The app lets you control your agent from your phone.

**Important: You need your own Mac with dorabot to use this app.** The app pairs with a bridge program you install on your Mac. If you do not have dorabot running, the pairing step will fail.

**How to test without your own Mac**

We have included a demo mode on the pairing screen. Tap "Try a demo" to see the interface in action without needing a Mac. This shows you:

- How the chat interface works
- The settings screen
- Notification handling
- Permissions screens

**How to test with your own Mac**

1. On your Mac, install the bridge:
   ```
   npx dorabot-remote setup
   ```

2. Start the bridge:
   ```
   dorabot-remote start
   ```

3. In the app, tap "Pair a device" and scan the QR code shown on your Mac's control page (http://127.0.0.1:7788).

4. Test these features:
   - Send a message to your dorabot agent and read the response
   - Ask a question and test the answer flow
   - Approve and deny tool calls
   - Go to Settings and check the device info
   - Disconnect and reconnect to the same device
   - Ask for additional permissions (like terminal access) and see the request on the Mac

**Known limitations**

- The app requires a local network connection or Tailscale to connect to your Mac
- Cellular-only connections are not supported (unless you have the relay enabled)
- The relay is optional and only works if your Mac has internet access
- Terminal access is disabled by default and must be granted from the Mac

**Feedback**

Found a bug or have a suggestion? Email wisam@xische.com or open an issue on GitHub: https://github.com/wisamamid/dorabot-remote

### Beta App Review Notes

**What is this app?**

DoraBot Remote is a companion app that pairs with dorabot, an open-source AI agent framework. The app lets users control their own dorabot instance running on their Mac from their iPhone.

**Testing without your own Mac**

If you do not have dorabot installed on a Mac, use the "Try a demo" mode on the pairing screen to preview the app's interface. This demo mode does not require any backend and shows the full UI.

**Testing with your own Mac**

1. Install dorabot on your Mac (https://github.com/suitedaces/dorabot) and Node.js 22.5 or newer
2. Run `npx dorabot-remote setup` and `dorabot-remote start` on your Mac
3. Use this app to scan the QR code and pair your iPhone

The app is fully functional for test purposes. We have included demo content so you can test without a full dorabot setup.

**Privacy**

This app requires no user account or signup. It pairs with a user's own Mac using a one-time QR code. All traffic is end-to-end encrypted (X25519, XChaCha20-Poly1305). We do not collect user data, analytics, or prompts. See the full privacy policy at https://wisamamid.github.io/dorabot-remote/privacy/

---

## App Privacy Questionnaire

### Does your app collect user data?

**No**. DoraBot Remote collects no user data. The app is designed to work entirely on the user's own devices (phone and Mac). There are no accounts, no sign-up, and no data transmission to our servers.

### Data Not Collected Section

- User ID or identifier: Not collected
- Purchases: Not applicable
- Financial information: Not collected
- Health and fitness: Not collected
- Messages: Not collected (messages are sent directly between the user's phone and Mac, not through our servers)
- Photos or videos: Not collected (photos are sent directly between devices if the user chooses to attach them)
- Audio data: Not collected
- Gameplay activity: Not applicable
- Search history: Not collected
- Location: Not collected
- Contacts: Not collected
- Emails or text messages: Not collected
- Calendar events: Not collected
- Browsing history: Not collected
- User preferences: Stored locally on the device, not sent to us
- Crash logs: Not collected
- Performance data: Not collected
- Other diagnostic data: Not collected
- Other user-generated content: Not collected
- Other sensitive information: Not collected

### Why your app collects this data

The app collects no data from users. User conversations and data remain entirely on the user's Mac and phone.

The only data that leaves the user's devices is:
- **Push notification tokens** (only the token itself, not message content), handled by Apple's APNS
- **Connection metadata** (random relay ID, timing, sizes) if the optional relay is used, which is not stored

For details, see the privacy policy: https://wisamamid.github.io/dorabot-remote/privacy/

### Third-party sharing

The app does not share user data with third parties. It only uses:
- Apple Push Notification Service (APNS) to deliver notifications
- Cloudflare (if the optional relay is enabled) to route encrypted traffic the relay cannot read

### Tracking

The app does not track users. There is no analytics, no advertising identifiers, and no behavioral tracking.

### Data retention and deletion

User data is stored entirely on the user's Mac and phone. When the user uninstalls the app or revokes a device, all data is deleted from that device. The app provides a one-tap option to remove all local data.

