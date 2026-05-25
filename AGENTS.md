<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Hosting portability

We deploy to Vercel now but plan to migrate to Cloud Run after Phase 3 ships (first paying customer). To keep that migration a half-day move rather than a week:

- **Avoid Vercel-only features**: edge middleware, Vercel KV / Postgres / Blob, Vercel Cron, the Vercel `next/image` loader. Anything that only exists because Vercel hosts the app is a future migration tax.
- `next.config.ts` sets `output: 'standalone'` — produces `.next/standalone/` for a trivial Cloud Run Dockerfile. Vercel ignores the flag.
- If a feature genuinely needs a Vercel-only primitive, raise it in discussion before reaching for it.
