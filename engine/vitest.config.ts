import { defineConfig } from 'vitest/config'

// Live tests read a public Monad RPC and the Morpho API. They run only with LIVE=1.
const live = process.env.LIVE === '1'

export default defineConfig({
  test: {
    include: live ? ['test/live/**/*.test.ts'] : ['test/**/*.test.ts'],
    exclude: live ? ['node_modules/**'] : ['node_modules/**', 'test/live/**'],
    testTimeout: live ? 120_000 : 5_000,
  },
})
