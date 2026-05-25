import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

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
  return new PrismaClient({
    adapter: new PrismaPg({ connectionString: url.toString() }),
  });
}

export const prisma = globalForPrisma.prisma ?? makeClient();

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = prisma;
