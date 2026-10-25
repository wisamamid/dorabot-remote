import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: { host: true, port: 5180 },
  build: {
    // The app ships inside a WebView on a phone that may be on cellular. The
    // entry chunk is held to a gzip budget by `npm run size`; the heavy things
    // (the terminal, the code viewer) are dynamic imports that become their own
    // chunks, named here so the budget script and bundle reports read clearly.
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/@xterm/')) return 'xterm'
          if (id.includes('/@codemirror/') || id.includes('/@lezer/') || id.includes('/codemirror/') || id.includes('/style-mod/') || id.includes('/w3c-keyname/') || id.includes('/crelt/')) {
            return 'codemirror'
          }
        },
      },
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.{ts,tsx}'],
    setupFiles: ['src/test-setup.ts'],
  },
})
