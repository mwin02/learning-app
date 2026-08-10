# docs/

Four tiers, by how much authority a file has over new code. The tier decides where a fact
belongs — putting a rule in the wrong tier is how it stops being followed.

## 1. Contract — read every session, binding

Not in this directory. [`AGENTS.md`](../AGENTS.md) and [`CLAUDE.md`](../CLAUDE.md) at the
repo root, plus [`.claude/rules/`](../.claude/rules/) which loads on matching file paths.

These are law: invariants, "never do X", conventions with blast radius. Keep them small —
every line here is paid for on every request. A new convention goes to `.claude/rules/` or
a skill, not to `CLAUDE.md`.

## 2. Runbook — read on demand, current

Procedures against live systems. Kept accurate; a wrong runbook breaks production.

| Doc | Covers |
| --- | --- |
| [app-deploy.md](app-deploy.md) | Cloud Run app service, `deploy-main` trigger, secrets |
| [worker-deploy.md](worker-deploy.md) | the GCE `e2-micro` course worker (manual deploys) |
| [operator-tooling.md](operator-tooling.md) | local app against the deployed DB, `operator-curl.sh` |
| [db-setup.md](db-setup.md) | Prisma + Supabase Postgres setup |
| [supabase-auth-setup.md](supabase-auth-setup.md) | Google OAuth, redirect allowlists |

## 3. Record — read to answer "why is it like this"

Historical. **Not maintained against drifting code** — a record is true as of its date, and
that is the point of it.

| Doc | Is |
| --- | --- |
| [ROADMAP.md](ROADMAP.md) | phase plan and milestone status |
| [plans/](plans/) | feature plans — active at the top level, shipped in `plans/archive/` |
| [c2-campaign-record.md](c2-campaign-record.md) | per-topic outcomes of the warm-path campaign |
| [curriculum-agent-audit.md](curriculum-agent-audit.md) | the audit that shaped the curriculum agent |

## 4. Disposable — git-ignored

`docs/audits/` — machine-written queue drains, review records, sanity sweeps. Regenerable,
never committed.

---

**Where does this fact go?** If it constrains code someone writes tomorrow, tier 1. If it
is a sequence of commands someone runs against a live system, tier 2. If it explains a
decision already made, tier 3. If a script wrote it, tier 4.
