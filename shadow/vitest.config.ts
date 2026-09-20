import { defineConfig } from 'vitest/config'

// The live test calls Zerion and chain RPCs. It runs only with LIVE=1, and skips unless
// ZERION_API_KEY and the chain RPC variable are set.
const live = process.env.LIVE === '1'

export default defineConfig({
  test: {
    include: live ? ['test/live/**/*.test.ts'] : ['test/**/*.test.ts'],
    exclude: live ? ['node_modules/**'] : ['node_modules/**', 'test/live/**'],
    testTimeout: live ? 300_000 : 5_000,
  },
})
