import { describe } from 'vitest';

// Shared gate for DB-backed integration tests. When DATABASE_URL is absent (a checkout
// without .env.local), the whole block is skipped rather than failing to connect — the
// setup file has already printed why. Use in place of `describe` for any test that
// touches the database:
//
//   describeDb('course-request queue', () => { ... });
export const hasDb = Boolean(process.env.DATABASE_URL);
export const describeDb = describe.skipIf(!hasDb);
