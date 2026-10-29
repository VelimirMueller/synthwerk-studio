import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // The BFF logic. Route files and app pages are thin wrappers around it.
      include: ['server/lib/**/*.ts'],
      // Fleet floor (CI-UNIT-02, CI-UNIT-03).
      thresholds: { lines: 80, branches: 70 }
    }
  }
})
