# dorabot-remote

The Mac-side bridge for **DoraBot Remote**, the iPhone app that lets you approve
tool calls, answer questions and follow your own [dorabot](https://github.com/suitedaces/dorabot)
from your pocket. End-to-end encrypted, no account, nothing to sign up for.

```bash
npx dorabot-remote setup
```

That one command:

1. checks you have Node 22.13+ and that dorabot is installed and running
2. installs the bridge to `~/.dorabot-remote/app/<version>/` so it survives the npx cache being cleared
3. registers a launchd agent so the bridge starts at login and restarts if it stops
4. waits until the bridge is healthy, then prints a pairing QR in your terminal
5. offers to open the control page at http://127.0.0.1:7788/

Scan the QR from the DoraBot Remote app. Running setup again is safe.

## Commands

| Command | |
| --- | --- |
| `setup` | Install or repair, then show the pairing QR |
| `update` | Re-run setup with this version: `npx dorabot-remote@latest update` |
| `pair` | Print a fresh pairing QR |
| `devices`, `grant`, `revoke`, `remove` | Manage paired devices and their permissions |
| `status` | Is the launchd agent running |
| `start` | Run the bridge in the foreground |
| `uninstall` | Remove the agent and installed app. Keeps keys and paired devices |
| `uninstall --purge` | Also delete keys, paired devices and logs |

Run `npx dorabot-remote --help` for the rest.

## Requirements

macOS, Node 22.13 or newer (`nvm install 24` or `brew install node`), and dorabot
set up on the same Mac (the bridge reads `~/.dorabot/gateway.sock` and
`~/.dorabot/gateway-token`, like any local client; dorabot is never modified).

## Security

Your phone and Mac authenticate each other with keys exchanged in the QR, and all
traffic is end-to-end encrypted. The bridge holds your dorabot gateway token and
never sends it to a device. Each paired device has its own permissions, and the
terminal permission is off unless you grant it. Source and threat model:
https://github.com/wisamamid/dorabot-remote

MIT licensed. See NOTICE for attribution of work derived from dorabot.
