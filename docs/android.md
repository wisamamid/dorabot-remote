# Android build notes

- Firebase project `dorabot-remote-xische`, Android app `com.xische.dorabotremote`
  (appId `1:1007068731432:android:cfdf015fc16f757951bd1d`).
- `google-services.json` is git-ignored. Fetch it:
  `firebase apps:sdkconfig ANDROID 1:1007068731432:android:cfdf015fc16f757951bd1d --project dorabot-remote-xische > packages/mobile/android/app/google-services.json`
- Relay: set the `FCM_SERVICE_ACCOUNT` secret (service account JSON of that project) to enable Android push.
- Android pushes are FCM data messages; `DorabotMessagingService` decrypts `enc` (ChaCha20-Poly1305, needs
  Android 9+/API 28; older shows generic text) with per-Mac keys sealed by an Android Keystore AES key.
- Build: `cd packages/mobile && npm run build && npx cap sync android && cd android && ./gradlew assembleDebug`
