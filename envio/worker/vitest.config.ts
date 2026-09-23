import { defineConfig } from 'vitest/config'

// Fixtures and fakes only: no network, no wrangler, no indexer.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], exclude: ['node_modules/**'] },
})
