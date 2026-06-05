---
name: decompose-large-page
description: Decompose large server-rendered doc/tutorial pages (javascript.info, big MDN guides, book tables of contents) that the automatic doc-TOC router could not process because its single-shot LLM section-selection ran out of output tokens. Harvests the full ordered table of contents in Node and applies decompose_manual. Takes one or more resource ids.
argument-hint: [resourceId ...]
disable-model-invocation: true
allowed-tools: Bash(node *)
---

# Decompose large doc/tutorial pages

**Bandaid.** The automatic doc-TOC router (`lib/agents/decomposition/doctoc.ts`) selects a page's ordered lesson links in **one** LLM call. On a very large table of contents (javascript.info ≈ 200 articles, sprawling MDN guides, a full book TOC) that call exhausts its output-token budget, so the container never decomposes and the row stays `pending` / `human_review` (or gets manually rejected to `unsupported`).

These pages are **server-rendered** — the links are in the static HTML; the router can *see* them, it just can't *emit* them all in one shot. So do the whole thing in **Node**: `fetch` the page, extract the ordered TOC with a regex, and POST `decompose_manual`. No browser. (`decompose_manual` derives child concepts in **chunks**, so the token budget is never the bottleneck.)

> Use [decompose-spa](../decompose-spa/SKILL.md) instead when the links are **not** in the HTML — client-rendered SPAs (Khan Academy) where the router got nothing to begin with. That one needs a headless browser; this one must not (the cross-origin browser POST stalls on some doc sites — Node is reliable).

Resource ids to process: **$ARGUMENTS**

## Preconditions

- Dev server on `http://localhost:3000` with its env (incl. `DEV_AUTH=1` and Vertex creds — the API derives child concepts server-side). Probe: `curl -s -o /dev/null -w "%{http_code}" -X POST localhost:3000/api/playground/decomposition-review -H 'content-type: application/json' -d '{"resourceId":"__probe__","action":"reject"}'` → `404` with a JSON `NOT_FOUND` body.
- **Run one at a time.** Concurrent decompositions fire many parallel Vertex concept-derivation calls; rate-limiting there stalls the whole request (no per-call timeout). Don't run this alongside `decompose-spa` or another instance.

## Per resource id (all from the repo root)

1. **Look up & gate.** `node --env-file=.env.local ${CLAUDE_SKILL_DIR}/scripts/decomp-db.cjs lookup <id>`.
   - `human_review` / `pending` → proceed.
   - `unsupported` (rejected or router-gave-up) and you intend to decompose it → `... decomp-db.cjs requeue <id>` first (the curation API only moves rows *out* of the queue). Skip `atomic` / `decomposed` unless you mean to redo them.

2. **Extract + POST in one Node script.** Fetch the page, regex out the ordered article links + titles (site-specific — exclude nav/header/footer/sidebar, "edit on GitHub", ebook/translate/legal, search, in-page anchors; dedup; decode HTML entities; preserve document order), then POST `{ resourceId, action: 'decompose_manual', children }` to the API with a long `AbortSignal.timeout`. A decomposition needs ≥2 children; expect 100s. The full runnable template (validated on javascript.info → 202 articles) is in [references/javascript-info.md](references/javascript-info.md) — copy it and adjust the extractor for other sites.

3. **Verify.** `... decomp-db.cjs verify <id>` → expect `parentStatus: "decomposed"`, `childCount` ≈ extracted, `emptyConcepts: 0`, `embedded` == `childCount`. The POST itself returns `{ status, childrenCreated }` synchronously, so you usually don't need to poll.

## Notes

- **Slow & local-only.** ~200 children takes ~2 min (chunked concept derivation + inserts + per-child embeddings, all in-request). That exceeds serverless request limits (Vercel 60s) — this is a local/admin operation, like a force-decompose.
- Report per id: extracted count, resulting `parentStatus` / `childCount` / `embedded`, whether a re-queue was needed, anything skipped.
