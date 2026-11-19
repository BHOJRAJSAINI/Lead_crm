import { supabaseAdmin } from './supabase';

/**
 * Durable outbox: every RPC write enqueues a row here; the Vercel Cron
 * (/api/cron/sync-sheets) drains it to Google Sheets. Never blocks the request.
 */
export async function enqueueSheetSync(tableName: string, rowId: string, payload: any, op: 'upsert' | 'delete' = 'upsert') {
  try {
    await supabaseAdmin().from('sheet_outbox').insert({
      op,
      table_name: tableName,
      row_id: String(rowId),
      payload,
    });
  } catch (e) {
    console.error('outbox enqueue failed', e);
    return;
  }
  // Push to Google Sheets immediately (background) instead of waiting for the next cron tick.
  try {
    const run = import('./outbox-drain').then((m) => m.drainOutbox(10)).catch((e) => console.error('instant drain failed', e));
    let done = false;
    try { // Cloudflare Workers
      const { getCloudflareContext } = await import('@opennextjs/cloudflare');
      getCloudflareContext().ctx.waitUntil(run); done = true;
    } catch (_) { /* not on Cloudflare */ }
    if (!done) { const { waitUntil } = await import('@vercel/functions'); waitUntil(run); }
  } catch (e) { /* cron will pick it up */ }
}
