import { config as loadEnv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// Prisma CLI doesn't go through Next.js, so load .env.local explicitly.
loadEnv({ path: '.env.local' });

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  // Migrations use the direct (5432) connection; the pooled URL goes to the
  // runtime adapter in src/lib/db.ts. Falls back to a placeholder so
  // `prisma generate` works before Supabase is provisioned.
  datasource: {
    url: process.env.DIRECT_URL ?? 'postgresql://placeholder@localhost:5432/placeholder',
  },
});
