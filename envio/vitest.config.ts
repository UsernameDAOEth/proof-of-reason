import { defineConfig } from 'vitest/config'

// Pure tests only: nothing here needs `envio codegen`, a database, or a network.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['node_modules/**', 'generated/**', 'worker/**'],
  },
})
