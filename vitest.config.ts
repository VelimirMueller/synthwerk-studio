import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The Nuxt alias of shared/, for app code under test (app/utils/site.ts).
  resolve: { alias: { '#shared': fileURLToPath(new URL('./shared', import.meta.url)) } },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      // The BFF logic. Route files and app pages are thin wrappers around it.
      include: ['server/lib/**/*.ts', 'shared/**/*.ts'],
      // Fleet floor (CI-UNIT-02, CI-UNIT-03).
      thresholds: { lines: 80, branches: 70 }
    }
  }
})
