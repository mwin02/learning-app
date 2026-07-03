import { describe } from 'vitest';

// Shared gate for DB-backed integration tests. When no real DATABASE_URL was present at
// startup, the whole block is skipped rather than failing to connect — the setup file
// has already printed why and injected a dummy URL so imports still resolve. We key off
// __INTEGRATION_DB__ (set by setup.ts), NOT DATABASE_URL, which may hold that dummy. Use
// in place of `describe` for any test that touches the database:
//
//   describeDb('course-request queue', () => { ... });
export const hasDb = process.env.__INTEGRATION_DB__ === '1';
export const describeDb = describe.skipIf(!hasDb);
