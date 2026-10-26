# Changelog

All notable changes to the DoraBot Remote app and npm package are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to semantic versioning.

## Unreleased

## Build 13 (202610261054) - 2026-10-26

Big security and convenience release: richer approvals, a lost-phone lockdown, Apple Watch, widgets, a share extension and an Android app.

### Added

- Approval preview: see the exact command, file edit or new file before you approve, with risky actions flagged in red and the reason spelled out
- Always-allow rules for trusted tools and exact commands, which never cover anything flagged as risky
- Lockdown and self-wipe: lock out all devices from the Mac, and the app erases itself after too many failed unlock attempts
- Time-limited permissions: access for a device can expire after a set number of hours
- New-network alerts when your Mac is reached from an unfamiliar network
- Run summaries after a session finishes, with a summary card in the session view
- Saved prompts you can re-run with one tap
- Voice prompts: dictate a prompt instead of typing
- Send to dorabot share extension: share text, links and files from any app into a session
- Home screen widget and Live Activity showing what is waiting for you
- Search across your sessions and messages
- iPad keyboard shortcuts
- Offline drafts: prompts you write without a connection are kept and sent when you are back online
- Diff viewer for file edits
- Light theme and adjustable text size
- Apple Watch app to see and approve routine requests from your wrist
- Android app (debug build for now)

### Changed

- Risky approvals now ask for Face ID every time, even if the app is already unlocked
- The bridge keeps its keys in the macOS Keychain instead of a file (moved automatically on first start)
- The relay rotates its access tokens regularly
- The risk check now looks inside wrapped commands such as `bash -c`, `eval`, `$(...)` and backticks, and flags inline scripts (`python -c`, `node -e`, `perl -e`, `osascript -e`), downloaded or temporary scripts and anything piped into a shell
- The Apple Watch follows the iPhone app lock: while the app is locked it shows tool names only and cannot approve or deny (it says "Unlock DoraBot on iPhone")

### Fixed

- Fixes from a full security review, including a confirmation step before a pair link is accepted
- Wiping or unpairing now also clears the widget, Watch list, shared items, Live Activity and the Android key

### Security

- Face ID required for risky approvals
- Bridge keys moved to the macOS Keychain
- Relay token rotation
- Pair links must be confirmed before they pair a device
- Fuzz tests for bridge frames, protocol decoders, the risk classifier and the app's link and push parsers

## Build 12 (202610210655) - 2026-10-21

Stability pack: outage alerts, compatibility checks, compression of large transcripts, and E2E UI testing.

### Added

- Relay outage alerts: bridge self-tests the relay path every 5 min and alerts when the relay is unavailable (#21)
- Load earlier history in long sessions to provide context for interrupted conversations (#21)
- Negotiated deflate compression for large bridge-to-phone frames (>4 KB) to reduce bandwidth (#21)

### Changed

- E2E UI tests on demo mode using Playwright WebKit for automated quality verification (#21)

### Fixed

- Self-test reporting and zombie-link detection for more reliable relay connectivity (#21)

## Build 11 (202610201517) - 2026-10-20

Security pack from the Opus audit (C1, H1-H4, M1-M4, lows).

### Added

- Device approval on Mac: new phones must be approved on the Mac before they can control it (#19)
- Audit log (append-only) tracking all approvals, denials, and device activity (#19)
- Per-device tokens on the relay to prevent token abuse (#19)
- 90-day device expiry to ensure old phones are cycled out (#19)
- npm provenance workflow for supply-chain security (#19)
- Dependabot for automated dependency updates (#19)
- SECURITY.md documenting how to report vulnerabilities (#19)

### Changed

- Approvals can't rewrite commands: modifiedInput stripped without terminal scope (#19)
- Per-method parameter allowlists to prevent unauthorized command variations (#19)
- File access is an allowlist of shared folders (nothing by default); search results and git are covered (#19)
- Control page requires one-time login link (dorabot-remote open); new phones must be approved on the Mac (#19)
- One-time channel header and plaintext refusal after handshake for replay protection (#19)
- Default scopes: sessions, chat, approvals (not admin or fs) (#19)

### Fixed

- Relay: check device tokens before announcing devices to host (#20)
- Self-test only reconnects on real failures, not transient issues (#20)
- Siri intent wording: replaced Mac with computer in App Store text to avoid error 90626 (#18)

### Security

- Deep links and Siri asks need explicit confirmation; non-web links in agent output are inert (#19)
- Notification Approve/Deny act only on decrypted content bound to the right Mac (#19)
- Bridge.db file permissions set to 0600 for privacy (#19)
- Face ID lock flag stored securely in Keychain (#19)
- DoS limits on LAN listener and relay device slots (#19)
- Push deduplication to prevent replay attacks (#19)

## Build 10 (202610200555) - 2026-10-20

Multiple Macs and Siri / Shortcuts integration.

### Added

- Multiple Macs: pairings list (v2) with safe migration from v1; read errors never overwrite existing data (#16)
- Per-Mac caches to keep sessions and state separate (#16)
- Switcher in Sessions header and Settings > Macs to quickly switch between paired Macs (#16)
- Siri integration: Ask dorabot and Open dorabot Inbox App Intents via dorabot-remote:// links (#16)
- App Intents queued until phone is unlocked and connected to the Mac (#16)

### Changed

- Push: hostId/hostName now sent inside encrypted content; per-Mac key selected by unencrypted kid (#16)
- NSE picks the right key based on Mac identity (#16)

## Build 8 (202610191057) - 2026-10-19

Encrypted rich notifications, Face ID app lock, pinned sessions, photo attachments, one-command installer, demo mode, and icon redesign.

### Added

- C2: Notification Service Extension for encrypted notification content (ChaCha20-Poly1305) (#14)
- Notification Approve/Deny/Answer actions with Face ID requirement option (#14)
- Face ID app lock: optional biometric protection to prevent unauthorized access (#14)
- Pinned sessions synced through the bridge and Keychain group (#14)
- Photo attachments in the message composer (up to 4, resized to fit relay frame limit) (#14)
- E1: One-command installer: npx dorabot-remote setup / update / uninstall (#14)
- Demo mode for App Review with pre-populated sessions (#14)
- Icon v2: larger robot pixel art with white Wi-Fi mark in top-right corner (#14)
- Docs: GitHub Pages (privacy policy, support page, store text) (#14)

### Fixed

- Scene root: iOS now uses MainViewController to ensure plugins (like PushKeyStore) are registered (#15)

### Changed

- npm package dorabot-remote 0.1.0 published and ready for installation (#17)
- Install instructions now lead with npx dorabot-remote setup as the primary method (#17)

## Build 7 (202610190827) - 2026-10-19

Persist relay configuration, connection diagnostics, and keyboard fix.

### Added

- Relay persistence: saved from QR code pairing so cold starts on 5G work (#12)
- Connection log in Settings (300-entry ring buffer): attempts, transports, network state, app state changes (#12)
- onRelay callback refreshes relay info whenever the host reports it (#12)
- Per-attempt timeouts: LAN 3s, relay 10s with jittered backoff (#12)

### Fixed

- Root cause of "can't connect on 5G": phone now persists the relay from the QR code (#12)
- Relay socket armed before LAN sockets; relay starts immediately on cellular (#12)
- Rename sheet now stays above the iOS keyboard (lift by --kb) (#12)

### Changed

- Relay Workers Logs and structured JSON events for debugging relay issues (#12)
- Bridge logs relay sockets that fail before auth (#12)

## Build 5 (202610182132) - 2026-10-18

Rename sessions on mobile, iPad support, model picker, keyboard handling, and message source tracking.

### Added

- Rename sessions on phone: long-press, swipe-left, or tap title in session (#10)
- iPad: two-pane layout at 768px and wider with tab rail (#10)
- Split View and Slide Over support with adaptive layout (#10)
- Model picker: header pill opens a sheet grouped by provider (#10)
- Per-session model selection mirroring the desktop (sessions.setModel) (#10)
- Keyboard handling with shell-level inset so composer stays above keyboard (#10)
- Message source tracking: chat.send includes source remote/mobile (#10)

### Fixed

- Keyboard inset (--kb) prevents composer from hiding when typing (#10)

### Changed

- Desktop shows phone-typed messages live with source identification (#10)
- Rename is optimistic with rollback on failure (#10)
- Read-only provider listing; config.set and provider auth remain denied (#10)

## Build 4 (202610182050) - 2026-10-18

App icon, live session sync, pull-to-refresh, network reconnect, and iOS swipe back.

### Added

- Live sync: desktop renames and new sessions appear on phone immediately (#9)
- Pull-to-refresh on Sessions, Inbox, and session detail (#9)
- Debounced and 20s foreground polling for live updates (#9)
- Interactive swipe-back from left edge (commits past 35% or on flick) (#9)
- Status banner showing Reconnecting / Offline / Connected via relay (#9)
- Stale data never appears without a status indicator (#9)
- App icon: DoraBot robot with green signal badge on white square (#8)

### Changed

- Wi-Fi to 5G reconnect: detects network type change and reconnects immediately (#9)
- Foreground ping now 10s with 5s pong timeout (#9)
- After reconnect, open session history and list are refreshed (#9)

### Fixed

- Outer WKWebView rubber-band disabled to prevent scroll jank (#9)
- Code scrollers and pull-to-refresh don't trigger swipe-back (#9)

## Build 3 (202610182036) - 2026-10-18

Push notifications with APNs.

### Added

- Push notifications for questions and approvals when phone is not actively connected (#7)
- APNs integration: contentless payloads sent directly from relay to iOS (#7)
- ES256 provider JWT via WebCrypto cached for 50 min (#7)
- Notification categories APPROVAL and QUESTION with timed actions (#7)
- Time-sensitive designation for question notifications (300s expiry) (#7)
- App: explainer card instead of launch-time prompt (#7)
- APNs token registration with bridge via remote.registerPush (#7)
- Notification settings and opt-in toggle for push preferences (#7)
- Clean disconnect on background; immediate reconnect on resume (#7)

### Changed

- Questions and approvals only push when phone is offline (no frame in 45s) (#7)
- Approvals coalesced to 1 per 30s; stale events (>2 min) ignored (#7)
- Tapping notification opens Inbox and session when matched (#7)

### Fixed

- 410 BadDeviceToken maps to unregistered so bridge drops old tokens (#7)

## Build 2 (202610181951) - 2026-10-18

Bridge relay client for off-LAN connectivity.

### Added

- Relay client: outbound wss to /h/<relayId> (#2)
- Ed25519 challenge authentication for relay connections (#2)
- Per-device virtual sockets multiplexed through relay (#2)
- 30s ping and 10s pong timeout with jittered backoff (1s to 30s) (#2)
- Backoff reset only after link has been up 5s (prevents tight loops) (#2)
- Relay frame size limit of 1 MiB (#2)
- Frame pre-sizing: oversize RPC responses become too_large errors (#2)
- Oversize events are dropped with logging (#2)
- QR payload and host info include relay {u, i} when configured (#2)
- remote.relay_state broadcast and shown on control page (#2)

### Changed

- Pairing and connecting share one relay URL (#2)
- Bridge routes on first frame (pair vs hello) (#2)
- LAN stays preferred; phone races LAN vs relay (#2)

### Fixed

- Relay recovery from 4000 (replaced) and 4401 (unauthorized) codes (#2)

## Build 1 (202610181920) - 2026-10-18

Initial TestFlight build: LAN pairing, remote control, messaging, and session management.

### Added

- iOS app for remote control of dorabot on your Mac (#1)
- LAN discovery and pairing via QR code (#1)
- Session list with real-time status (#1)
- Inbox for questions and approvals (#1)
- Chat interface to send prompts and receive responses (#1)
- Settings screen for pairing management and configuration (#1)
- Relay Durable Object on Cloudflare Workers (blind relay infrastructure) (#1)

### Changed

- CI: typecheck every workspace; manual runs allowed (#1)
- README documents optional blind relay and crypto accurately (#1)
- ITSAppUsesNonExemptEncryption deliberately unset pending export compliance review (#1)

### Security

- Path deny-list before any fs.* / search.* call (#3)
- Bridge keys, ~/.dorabot, ~/.config, ~/.ssh, ~/.aws, keychains, and credential files protected (#3)
- Control page Host and Origin checks against DNS rebinding (#3)
- remote.events scope-gated; admin no longer grants fs or security (#3)
- Shell ownership set before spawn (#3)
- Revoke and scope changes from CLI apply to live connections within 5s (#3)

### Fixed

- Cached session snapshots stay current (#3)
- Single delivery path with per-session dedup (#3)
- Large histories trimmed to newest messages fitting relay frame (#3)
- Fresh devices don't replay entire log (#3)
- Half-open socket detection with 10s pong timeout (#3)
- Generation-guarded connect races (#3)
- revoked state prevents infinite retries (#3)
- mDNS name fixed (#3)

## npm package dorabot-remote

### 0.1.0 - 2026-10-20

Initial release: one-command installer for DoraBot Remote on macOS.

### Added

- npx dorabot-remote setup: single command to install the bridge (#17)
- npm publish: published to npmjs.com for easy installation (#17)
- Requires Node 22.13 or later (#17)

### Changed

- Primary install method now via npx instead of from-source build (#17)
- Em dashes removed throughout documentation (#17)
