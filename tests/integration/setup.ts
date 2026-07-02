// Integration-project setup: load .env.local so DATABASE_URL (and friends) are present
// when tests run under Vitest, matching how the app's scripts run under
// `tsx --env-file=.env.local`. Node 20.12+/24 exposes process.loadEnvFile natively, so
// no dotenv dependency is needed. A missing file is fine — tests guard on DATABASE_URL
// via describeDb (see ./db.ts) and skip with a message when it is absent.
try {
  process.loadEnvFile('.env.local');
} catch {
  // No .env.local (e.g. CI without secrets) — leave env as-is; describeDb handles the skip.
}

if (!process.env.DATABASE_URL) {
  console.warn('[integration] DATABASE_URL not set — DB-backed tests will be skipped.');
}
