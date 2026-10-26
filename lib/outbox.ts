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
  }
}
