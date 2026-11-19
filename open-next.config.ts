import { defineCloudflareConfig } from '@opennextjs/cloudflare';
const config = defineCloudflareConfig({});
// OpenNext runs this to build the Next app (the package.json "build" script wraps OpenNext on Cloudflare).
(config as any).buildCommand = 'npx next build';
export default config;
