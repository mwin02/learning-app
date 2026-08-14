// Runs another driver against the Supabase pooler instead of the local Docker DB.
//
//   npx tsx --env-file=.env.local scripts/run-against-prod.ts scripts/<driver>.ts [driver flags]
//
// The connection string is read from SUPABASE_POOLER_URL **inside this process**
// (loaded by --env-file) and assigned to DATABASE_URL before the driver is
// imported, so the secret never becomes a shell word. That is the property
// AGENTS.md's "Secrets" section is protecting: the documented
// `DATABASE_URL="$SUPABASE_POOLER_URL" …` prefix needs the value exported in the
// shell, where a command that fails while holding it can print it.
//
// This exists because the library-quality drivers statically `import { prisma }
// from '../src/lib/db'`, and @/lib/db reads DATABASE_URL at module-eval. The
// per-script `--prod` flag (backfill-page-titles.ts, verify/c2-recon.ts) solves
// that by making every src/ import dynamic; a launcher gets the same ordering for
// any driver without rewriting six of them. The DYNAMIC import below is the whole
// mechanism — a static one would hoist above the assignment and silently bind to
// localhost while every log line claimed production.
//
// The driver's own target guard still applies: an --apply run against a remote
// host refuses without a matching --target-host=<hostname> (scripts/target-guard.ts).

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

async function main() {
  const [, , script, ...rest] = process.argv;
  if (!script) throw new Error('usage: run-against-prod.ts scripts/<driver>.ts [flags]');

  const pooler = process.env.SUPABASE_POOLER_URL;
  if (!pooler) throw new Error('SUPABASE_POOLER_URL is not set (expected in .env.local)');
  process.env.DATABASE_URL = pooler;

  // The driver parses process.argv itself, so present it the argv it would have
  // seen if it had been invoked directly.
  const target = resolve(process.cwd(), script);
  process.argv = [process.argv[0], target, ...rest];

  await import(pathToFileURL(target).href);
}

main();
