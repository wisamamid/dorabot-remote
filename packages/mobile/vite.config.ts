import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: true, port: 5180 },
  build: {
    // The app ships inside a WebView on a phone that may be on cellular.
    // Keep an eye on this; nothing here should pull in a code editor.
    chunkSizeWarningLimit: 600,
  },
})
