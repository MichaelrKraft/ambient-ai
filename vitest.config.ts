import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Each file gets its own worker so SQLite in-memory databases don't share state.
    pool: 'forks',
    poolOptions: {
      forks: {
        singleFork: false,
      },
    },
    coverage: {
      provider: 'v8',
      include: ['src/leadspot/**/*.ts'],
      exclude: ['src/leadspot/keychain.ts'],  // Keychain requires real macOS Keychain; excluded.
      reporter: ['text', 'json-summary'],
    },
    // Silence expected logger noise during tests.
    silent: false,
  },
  resolve: {
    // The project uses .js extensions in imports (ESM compiled output).
    // Vitest can resolve these to .ts sources directly.
    conditions: ['node'],
  },
});
