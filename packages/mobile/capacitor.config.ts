import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.xische.dorabotremote',
  appName: 'DoraBot Remote',
  webDir: 'dist',
  ios: {
    // The webview sits under the status bar so the app can paint its own
    // translucent header, matching how the design treats the top of the screen.
    contentInset: 'never',
    backgroundColor: '#0b0c0e',
  },
  android: {
    backgroundColor: '#0b0c0e',
  },
  server: {
    // The bridge is reachable over plain ws:// on a LAN or Tailnet address.
    // Transport TLS would mean certificates for an IP that changes; instead the
    // payload itself is end-to-end encrypted and mutually authenticated, so a
    // cleartext transport adds no exposure. See packages/protocol/src/crypto.ts.
    cleartext: true,
    androidScheme: 'https',
  },
  plugins: {
    Keyboard: {
      resize: 'none',
    },
  },
}

export default config
