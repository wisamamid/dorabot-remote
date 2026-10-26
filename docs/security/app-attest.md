# App Attest for DoraBot Remote: design note

Status: not implemented. Written so the decision can be made later with the facts in one place.

## The question

Today the bridge trusts a phone because it holds a device private key that was registered at pairing and approved on the Mac. That key lives in the iOS Keychain (this-device-only, after first unlock). It proves "someone holds this key". It does not prove "this is the genuine DoraBot Remote app on a real, unmodified iPhone".

Apple's App Attest (`DCAppAttestService`) adds that missing proof. The question is whether it is worth the cost for a tool whose users each run their own bridge.

## What App Attest is

- The app asks the Secure Enclave to generate a hardware-bound key pair (`generateKey`). The private key never leaves the chip and cannot be exported.
- `attestKey(keyId, clientDataHash)` returns a CBOR attestation object signed through Apple's attestation CA. It contains a certificate chain, the key's public half, the app's identity (`teamID.bundleID` hashed into `rpIdHash`), a counter and an AAGUID that says production or development.
- `generateAssertion(keyId, clientDataHash)` later signs arbitrary data with that key, and bumps a counter. A verifier that remembers the last counter can reject replays.
- Verification is done by whoever needs to trust the app: check the chain to Apple's App Attest root CA, check `rpIdHash` equals SHA-256 of `<TeamID>.<bundle id>`, check the nonce binds our challenge, check the AAGUID, store the public key and counter.

## Design for DoraBot Remote

### On the device

1. At first launch (or at pairing) generate an App Attest key and keep only its `keyId` in the Keychain.
2. During pairing, after the host sends a challenge, call `attestKey` with `clientDataHash = SHA-256(host challenge || device public key || host id)`. Send the attestation object inside the sealed pairing request, next to the device public key.
3. Optionally, on each connection (or each risky action) produce an assertion over the session transcript hash so the proof is fresh and bound to that session.

This needs a small native Capacitor plugin (Swift, about 100 lines wrapping `DCAppAttestService`). It must follow the existing rule that plugin objects are never returned from async functions.

### Where it is verified

Two options, not exclusive:

| Verifier | What it can do | Cost |
| --- | --- | --- |
| Bridge (on the user's Mac) | Verify the attestation at pairing and record the attested public key and counter per device. Reject a pairing that is not attested. Check assertions on connect. Fully offline after the one-time chain check, since Apple's root CA is pinned in the bridge. | Parsing CBOR and X.509 in Node (libraries exist; about 300 lines). Pinning Apple's root; rotating it if Apple changes it. |
| Relay (Cloudflare Worker) | Refuse to forward device sockets that lack a valid assertion, so non-genuine clients never reach a Mac at all. | The relay would need per-device attested state (Durable Object storage) and the CBOR/X.509 code in the Worker. Raises the relay from "blind forwarder" to a component that holds device metadata. Probably not worth it. |

Recommendation if built: bridge-side only. It keeps the relay blind and keeps the trust decision on the user's own machine.

### Server-assisted risk metric

Apple also offers a receipt (`/v1/attestationData` style endpoints) that lets a server read a coarse "how many attestations has this device made" metric. That requires a call to Apple from a server with a key we would have to hold. We do not run a server for users, so skip it.

## What it protects against

- A cloned or scripted client that never ran on a real iPhone, using pairing details intercepted from a QR (QR codes are single use and the pairing is approved on the Mac, so the practical window is small).
- Someone who extracts the device key from an unencrypted backup or a jailbroken device and uses it from another machine. The Keychain item is this-device-only and not backed up, so this is already hard. App Attest makes the key non-extractable by hardware, not by policy.
- A repackaged or modified build of the app (different bundle id or team id fails `rpIdHash`).

## What it does not protect against

- A genuine app on a genuine phone that is unlocked in the wrong hands. That is the app lock (Face ID), the self-wipe, and "Lost" / lockdown on the Mac.
- A compromised iOS. App Attest says the device passed Apple's checks at attestation time, not that it is clean now.
- Anything on the Mac side. The bridge, gateway and Mac remain the trust anchor.

## What it costs

- Engineering: a Swift plugin, verifier code and tests in the bridge, a pairing protocol change (new optional field, new protocol version or capability flag), UX for the failure cases. Estimate 3 to 5 days plus device testing.
- Compatibility: simulators and some devices (and all of the web/PWA build) do not support App Attest (`isSupported == false`). Demo mode and the web build must keep working, so attestation has to be optional per host setting, "required" only if the user turns it on. Android needs Play Integrity, a separate and larger effort.
- Operations: Apple's endpoint is not involved in verification, but the root CA is pinned and must be kept current. Attestation can fail transiently (network to Apple during `attestKey`), so pairing needs a retry path. A key is lost on app reinstall or device restore, which forces re-pairing (already true of the device key).
- Privacy: the attestation reveals the app identity and a per-key identifier to the host. No new data goes to us. The App Store privacy answers do not change, but the policy should mention it.
- Review risk: low. App Attest is an ordinary public API, no new entitlement beyond `com.apple.developer.devicecheck.appattest-environment`.

## Recommendation

Defer. The pairing flow already requires a one-time code, sealed transport and explicit approval on the Mac, the device key is Keychain-bound, and the new lost-phone controls cover the stolen-phone case. App Attest mostly hardens against a cloned client, which is a narrower threat for a self-hosted tool than for a hosted service.

Revisit if any of these become true: the relay or bridge is offered as a hosted service for other people, pairing happens without a human at the Mac, abuse of the relay by non-genuine clients shows up, or an enterprise customer asks for hardware-backed device identity.

If it is built, start with "attest at pairing, verify in the bridge, log the result, do not block", ship that for a release, and only then offer a "require attested devices" switch on the control page.
