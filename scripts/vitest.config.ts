import { defineConfig } from 'vitest/config'

// Offline: fixtures, a fake facilitator and the Worker app in process. No RPC, no payment, no keys.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], exclude: ['node_modules/**'] },
})
