# Deploy on Cloudflare Workers (free plan)

Branch `cloudflare` = same app built with OpenNext (`@opennextjs/cloudflare`).

## Steps
1. Cloudflare dashboard → **Workers & Pages → Create → Import a repository** → pick `Lead_crm`, branch `cloudflare`.
2. Build command: `npx opennextjs-cloudflare build` · Deploy command: `npx wrangler deploy`
3. Settings → **Variables and Secrets**: add every name from `.env.example` (same values as Vercel; secrets as "Secret").
4. After first deploy, set the Worker URL in Supabase `public.crm_hit` (replace the host) so pg_cron calls the new app.

## Local / CLI
`npm run cf:preview` (local) · `npm run cf:deploy` (needs `wrangler login`).

## Limits (free plan)
- Workers Free allows ~10 ms CPU per request. Light routes are fine; heavy ones (sheet ingest over ~3.5k rows, quotation PDF) may exceed it. If they fail with "exceeded CPU", use Workers Paid ($5/mo) which gives 30 s CPU.
