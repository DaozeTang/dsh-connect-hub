import { defineConfig } from 'vitest/config'

export default defineConfig({
  // The host entry reads the version through this build-time define; tsdown
  // substitutes it in the shipped bundle and the tests use a stable stand-in.
  define: {
    __DSH_CONNECT_HUB_VERSION__: JSON.stringify('0.0.0-test'),
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts', 'tests/**/*.spec.tsx'],
    setupFiles: ['tests/support/setup-desktop-isolation.ts'],
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
})
