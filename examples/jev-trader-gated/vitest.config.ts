import { defineConfig } from 'vitest/config'

// Offline only: the vendored upstream tree is never run, only read.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'upstream/**'],
  },
})
