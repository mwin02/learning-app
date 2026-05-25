// Prisma seed entry point. Real implementation lands in Block 2 once the
// `data/seed-resources.ts` source file exists. Block 1's job is only to wire
// up the schema and migration; running `prisma db seed` now is a no-op.

async function main() {
  console.log('seed: no-op (Block 1 — schema only; seed data lands in Block 2)');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
