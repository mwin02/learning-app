// Integration-project setup: load .env.local so DATABASE_URL (and friends) are present
// when tests run under Vitest, matching how the app's scripts run under
// `tsx --env-file=.env.local`. Node 20.12+/24 exposes process.loadEnvFile natively, so
// no dotenv dependency is needed.
//
// Skip mechanics: DB-backed blocks are gated by describeDb (see ./db.ts). But an
// integration test file imports `@/lib/db` at its top level, and that module THROWS at
// eval when DATABASE_URL is absent — before describeDb can skip anything. So when there
// is no real DATABASE_URL we (a) record that via __INTEGRATION_DB__ (what describeDb
// keys off), and (b) inject a syntactically-valid dummy URL so the import succeeds.
// Because every block is then skipped, no connection is ever attempted against it.
try {
  process.loadEnvFile('.env.local');
} catch {
  // No .env.local (e.g. CI without secrets) — leave env as-is; the guard below handles it.
}

const hasRealDb = Boolean(process.env.DATABASE_URL);
process.env.__INTEGRATION_DB__ = hasRealDb ? '1' : '';

if (!hasRealDb) {
  console.warn('[integration] DATABASE_URL not set — DB-backed tests will be skipped.');
  // Valid URL shape so @/lib/db can construct its client at import; never connected to.
  process.env.DATABASE_URL = 'postgresql://skip:skip@localhost:5432/skip';
}
