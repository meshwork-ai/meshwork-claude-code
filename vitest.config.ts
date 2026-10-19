import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['plugin/test/**/*.test.ts'],
    testTimeout: 20_000,
  },
})
