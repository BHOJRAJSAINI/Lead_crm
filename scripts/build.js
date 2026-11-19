// Cloudflare Workers Builds sets WORKERS_CI=1 -> build with OpenNext; everywhere else plain `next build`.
const { spawnSync } = require('child_process');
const cmd = process.env.WORKERS_CI || process.env.CF_PAGES ? 'npx opennextjs-cloudflare build' : 'npx next build';
const r = spawnSync(cmd, { stdio: 'inherit', shell: true });
process.exit(r.status ?? 1);
