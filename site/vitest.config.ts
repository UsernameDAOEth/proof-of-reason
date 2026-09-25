import { defineConfig } from 'vitest/config'

// Reads the files it checks. No network, no build step, no browser.
export default defineConfig({
  test: { include: ['test/**/*.test.ts'], exclude: ['node_modules/**'] },
})
