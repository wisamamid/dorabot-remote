# Apple Watch approvals

The watch app (`packages/mobile/ios/App/WatchApp`, bundle id `com.xische.dorabotremote.watchkitapp`, watchOS 10+) shows the pending Inbox from the phone and lets you Approve / Deny routine approvals.

- The watch holds no pairing keys and never talks to the Mac or the relay. It only uses WatchConnectivity to the iPhone app.
- The phone (`WatchBridge` plugin + `src/lib/watch*.ts`) sends a snapshot `{rid, kind, hostName, sessionName, title, summary, risky}` whenever the Inbox changes, and runs the watch's requests through the same `tool.approve` / `tool.deny` path as the phone UI (the bridge audit-logs them as usual).
- Risky approvals (the shared classifier in `@dorabot-remote/protocol`) show "Open on iPhone to approve" with no buttons; the phone re-checks risk on every request and refuses them. Questions show their text and "Answer on iPhone".
- If the phone has no live link to the Mac (or the app cannot answer within 8 s), the watch gets "Phone not connected" and nothing is done. The snapshot is emptied while the phone is not connected.
- Wrist / lock state: watchOS has no public API to ask whether the watch is on a wrist and unlocked. The OS locks the watch when it is taken off (with a passcode set), so a locked watch cannot be operated. The app additionally acts only while its scene is active, the display is not dimmed (`isLuminanceReduced`), and the snapshot is under 5 minutes old.
- Project setup: `GEM_PATH=~/.local/share/gem/ruby/4.0.0 ruby scripts/ios-add-watch.rb` (idempotent; `cap sync` does not touch it).
