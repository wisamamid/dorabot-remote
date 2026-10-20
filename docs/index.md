---
permalink: /
title: DoraBot Remote
---

# DoraBot Remote

Control your own dorabot AI agent from your phone, anywhere.

DoraBot Remote is a companion app for iOS that lets you pair your phone with dorabot running on your Mac. Answer questions, approve tool calls, read the stream, and send new prompts from anywhere, with end-to-end encryption and no account needed.

## Requirements

To use DoraBot Remote, you need:

- A Mac running [dorabot](https://github.com/suitedaces/dorabot)
- Node.js 22.13 or newer installed on that Mac
- An iPhone with iOS 14 or later

## Setup

The bridge runs on your Mac as a small daemon.

On your Mac, run:

```
npx dorabot-remote setup
```

This installs the bridge program and runs it at login. You will be prompted to confirm permissions (network and local file access) if this is the first time.

Open the control page in your web browser to see pairing codes. The address is shown in the terminal, typically `http://127.0.0.1:7788`.

On your phone, open DoraBot Remote and tap **Pair a device**. Scan the QR code shown on your Mac's control page. The code is single-use and expires after five minutes. Once paired, your phone can connect to your Mac whenever both are online.

### Updating

To update to the latest version:

```
npx dorabot-remote@latest update
```

### Uninstalling

To uninstall the bridge:

```
npx dorabot-remote uninstall
```

This removes the bridge but keeps your keys and paired devices so you can reinstall later. To also delete those:

```
npx dorabot-remote uninstall --purge
```

## Features

- Send prompts and read responses in real time
- Answer questions the agent asks you
- Approve or deny tool calls without going back to your Mac
- Work from anywhere: direct connection over your home WiFi or Tailscale, or through an optional relay when off your network
- All traffic is end-to-end encrypted; the relay cannot read your data
- Revoke access from any device at any time
- Open source (MIT license)

## Links

- [GitHub repository](https://github.com/wisamamid/dorabot-remote)
- [Privacy policy](privacy/)
- [Support and FAQ](support/)

## Contact

Questions or issues? Email wisam@xische.com.
