// One-shot: the 6.042J session pages are typed `book` and are not books.
//
//   npx tsx --env-file=.env.local scripts/retype-ocw-sessions.ts
//   … --apply --target-host=<host>
//
// Each is a ~20-minute reading assignment ("Session 5: Chapter 3.6"), and the type
// is the defect the library-quality plan named but never assigned an owner (open
// question 4). The duration follows from it: `checkDuration` rejects a book under
// 30 minutes, so `rederive-durations`' book-floor pass would blank all 32 of the
// under-floor rows to null/unknown — recording "nobody measured this" for rows whose
// only real problem is that they claim to be books.
//
// Scope is the `Session N: …` children only. Two other 6.042J rows are typed `book`
// correctly and are left alone: the 240m textbook (Ch. 1–4) and the 90m Chapter 12
// PDF, neither of which is under the floor.
//
// Idempotent: a second run selects nothing.

import { prisma } from '../src/lib/db';
import { requireTargetAck } from './target-guard';

async function main() {
  const apply = process.argv.includes('--apply');
  requireTargetAck('retype-ocw-sessions', apply, 'RETYPE rows in');
  console.log(`\n=== retype-ocw-sessions (${apply ? 'APPLY' : 'DRY RUN'}) ===`);

  const rows = await prisma.resource.findMany({
    where: {
      url: { contains: '6-042j' },
      type: 'book',
      title: { startsWith: 'Session ' },
    },
    orderBy: { title: 'asc' },
    select: { id: true, title: true, durationMin: true, durationSource: true, status: true },
  });

  console.log(`${rows.length} session row(s) typed book`);
  const underFloor = rows.filter((r) => r.durationMin !== null && r.durationMin < 30).length;
  console.log(`  ${underFloor} of them under the 30-minute book floor (the rows at risk)`);
  for (const r of rows) {
    console.log(`  ${String(r.durationMin).padStart(4)}m ${r.durationSource.padEnd(9)} ${r.status.padEnd(10)} ${r.title}`);
  }

  if (!apply) {
    console.log(`\nDry run only. Re-run with --apply to retype ${rows.length} row(s) book → article.`);
    return;
  }

  const { count } = await prisma.resource.updateMany({
    where: { id: { in: rows.map((r) => r.id) } },
    data: { type: 'article' },
  });
  console.log(`\nretyped ${count} row(s) book → article`);

  const remaining = await prisma.resource.count({
    where: { url: { contains: '6-042j' }, type: 'book', title: { startsWith: 'Session ' } },
  });
  console.log(`session rows still typed book: ${remaining}`);
}

main().finally(() => prisma.$disconnect());
