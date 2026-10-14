import { defineConfig } from 'vitest/config'
// Integration tests boot `wrangler dev --local`, which is slow on a cold cache.
export default defineConfig({ test: { testTimeout: 30000, hookTimeout: 90000, fileParallelism: false } })
