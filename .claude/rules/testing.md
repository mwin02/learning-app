---
paths:
  - "**/*.test.ts"
  - "tests/**"
  - "vitest.config.ts"
  - "scripts/verify-*.ts"
---

# Testing (Vitest — colocated unit + gated integration)

Tests run on **Vitest** (config in `vitest.config.ts`), split into two projects that resolve the `@/*` alias like the app:

- **unit** — pure, fast, no DB/LLM. Files are **colocated** next to the code as `src/**/*.test.ts`.
- **integration** — hits the real dev DB. Files live in `tests/integration/`. A setup file loads `.env.local`, and DB blocks skip cleanly (with a message) when there's no `DATABASE_URL`. Files run **one at a time** (`fileParallelism: false`) — see the shared-DB note below.

**npm scripts:** `test` = unit only (the safe default — runs with no secrets); `test:unit`; `test:int`; `test:all` (both projects).

## Which kind to write

- **Pure logic** (deterministic transforms, allocators, validators, slug/formatting helpers) → a **colocated unit test**. This is the default and where most coverage lives.
- **Needs the DB** but no LLM → an **integration test** under `tests/integration/`.
- **Costs LLM calls, needs a seeded DB, or drives live external APIs** → do **not** migrate to Vitest. It stays a manual `scripts/verify-*.ts` driver, run with `npx tsx --env-file=.env.local scripts/verify-*.ts`. Several scripts are split: the pure half is a colocated unit test, the live half remains a driver (see `scripts/verify-composer.ts`, `scripts/verify-sectioner.ts`). The historical assertion-style `verify-*` scripts were migrated to Vitest in the R-blocks; the survivors are all live/seeded drivers by design.

## Writing a unit test

Import from `@/*`, use `describe`/`it`/`expect`. Assertions are the plain `expect(...)` matchers — no `check(name, cond)` helper (that was the old script pattern; the conversion is `check(name, cond)` → `it(name, () => expect(...))`).

⚠️ **Module-eval gotcha.** Importing an app module that transitively pulls in `@/lib/db` or `@/lib/ai/vertex` will **throw at import** when the env vars are absent (`DATABASE_URL` / `GOOGLE_VERTEX_PROJECT`), even if the function under test never touches them — those modules validate env at module-eval. When the code under test is pure, stub the offending leaf so the unit test stays secret-free:

```ts
vi.mock("@/lib/db", () => ({ prisma: {} }));
// If the graph imports @/lib/ai/vertex directly (e.g. via tools/web-fallback), stub the leaf:
vi.mock("@/lib/ai/vertex", () => ({
  vertex: Object.assign(() => ({}), { textEmbeddingModel: () => ({}) }),
  chatModel: () => ({}),
  geminiFlash: {},
  vertexAnthropic: {},
  vertexGlobal: {},
}));
// Otherwise stubbing @/lib/ai/models is enough:
vi.mock("@/lib/ai/models", () => ({
  getModel: () => ({ model: {}, temperature: 0, maxOutputTokens: 0 }),
}));
```

Reach for a stub only when the import throws; most pure modules import cleanly and need none.

## Writing an integration test

Wrap every DB-touching block in **`describeDb`** (from `tests/integration/db.ts`) instead of `describe`, so it skips (not fails) without a `DATABASE_URL`. `.env.local` loads automatically. **Self-clean**: prefix throwaway rows with a unique marker (e.g. `__verify_prog__`) and delete them in `beforeAll`/`afterAll` — these tests write to the shared dev DB.

## The shared-DB / whole-table hazard

The queue primitives (`claimNextQueued`, `reclaimStale`, `queueDepth`) scan the **entire `CourseRequest` table** by design, so any row anyone else creates is indistinguishable from real backlog. Two writers can trip this, and both must be shut out:

1. **A live worker.** Since workers-C that includes the **dockerized compose workers**, which poll the same local DB and will steal the tests' rows. Run `docker compose --profile workers stop worker` before `npm run test:int` (restart afterwards with `docker compose --profile workers up -d`).
2. **A sibling test file.** Vitest runs files in parallel by default, so `program-fanout` / `program-enrollment` / `worker-pipeline` / `program-stuck-sweep` were creating `CourseRequest` rows mid-assertion — inflating `queueDepth` deltas in `course-request-queue.test.ts`, while its `claimMine()` drain stole *their* `queued` child requests and broke their `status === 'queued'` asserts. Measured at ~1 failure in 3 full runs (4 of 6 when forced parallel). Fixed by **`fileParallelism: false`** on the integration project in `vitest.config.ts`: files run one at a time, ~6s instead of ~2.5s for the whole project.

Keep it that way — **don't re-enable file parallelism**, and don't narrow those global queries to marker-prefixed rows to make a flake go away: the whole-table scope *is* the property the queue tests exist to verify. See `tests/integration/course-request-queue.test.ts` for the quarantine-and-restore pattern that keeps a stray foreign row from being stranded in `running` even so.
