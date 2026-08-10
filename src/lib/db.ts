import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';
import { describeDatabaseUrl } from '@/lib/db-target';
import { log } from '@/lib/log';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function makeClient() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is not set');
  // Recent node-postgres treats `sslmode=require` as `verify-full`, which
  // rejects Supabase's self-signed cert chain. Opt into libpq-compatible
  // semantics so `require` means "encrypted, don't verify the chain."
  const url = new URL(raw);
  if (!url.searchParams.has('uselibpqcompat')) {
    url.searchParams.set('uselibpqcompat', 'true');
  }
  // Announce the target once per process. The operator pattern for the review
  // skills is a LOCAL dev server pointed at the PRODUCTION database (free-beta
  // E1, operator-tooling.md): the `curl localhost:3000/…` those skills run
  // is byte-identical either way, so this line is the only thing at the call
  // site that says which library is about to be edited. Emitted here because
  // this is the only place the app resolves DATABASE_URL.
  log('db.client_created', { target: describeDatabaseUrl(raw) });
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url.toString() }),
  });
}

export const prisma = globalForPrisma.prisma ?? makeClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
