import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Single source of truth for the `@/*` import alias (mirrors tsconfig paths), shared
// across both projects so tests import app code exactly like the app does.
const alias = { '@': fileURLToPath(new URL('./src', import.meta.url)) };

export default defineConfig({
  test: {
    // The integration project has no files until R3, and even after, a checkout without
    // DATABASE_URL skips every DB-backed block — so "no active tests" is a clean pass,
    // not a failure, for `test:int` in isolation.
    passWithNoTests: true,
    projects: [
      {
        // Unit: pure, fast, no DB/LLM. Colocated next to the code they cover.
        resolve: { alias },
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // Integration: hits the real dev DB. Loads .env.local via a setup file and
        // skips cleanly (with a message) when DATABASE_URL is absent, so a checkout
        // without secrets can still run `npm test` / `npm run test:all`.
        resolve: { alias },
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
          setupFiles: ['./tests/integration/setup.ts'],
        },
      },
    ],
  },
});
