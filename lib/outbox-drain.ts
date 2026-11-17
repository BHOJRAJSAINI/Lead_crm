/** Drains sheet_outbox -> Google Sheets. Used by the cron route and fired right after every app write. */
export async function drainOutbox(limit = 50) {
  const { supabaseAdmin } = await import('./supabase');
  const sheets = await import('./sheets');
  const sb = supabaseAdmin();

  // Source tabs: where each lead lives and which columns hold Assigned Name / Status (same maps as ingest).
  const SRC_TABS: Record<string, { tab: string; assigned: string; status: string }> = {
    INDIAMART: { tab: 'Leads', assigned: 'O', status: 'Q' },
    FB_INSTA: { tab: 'FB & INSTA', assigned: 'J', status: 'K' },
    CORP_FB: { tab: 'Corp FB', assigned: 'J', status: 'K' },
  };
  const istStamp = () => new Date(Date.now() + 330 * 60000).toISOString().replace('T', ' ').slice(0, 19);

  const { data: batch } = await sb.from('sheet_outbox')
    .select('*').eq('status', 'pending').order('id').limit(limit);

  const results: any[] = [];
  for (const job of batch || []) {
    try {
      const p = job.payload || {};
      if (job.table_name === 'follow_ups') {
        // Append below the last follow-up (A:H = LEAD NO, Follow Date, Follow Time, Remark, Status, Next Date, Next Time, Timestamp)
        await sheets.appendValues('Lead FollowUps', 'A:H', [[p.leadId, p.followDate, p.followTime, p.remark, p.leadStatus, p.nextFollowDate, p.nextFollowTime, istStamp()]]);
      } else if (job.table_name === 'leads') {
        // Update only the Assigned Name / Status cells of that lead's row in its own source tab (never rewrites the row).
        const { data: lead } = await sb.from('leads').select('source_key').eq('lead_id', p.leadId).limit(1).maybeSingle();
        const src = lead && SRC_TABS[lead.source_key];
        if (!src) throw new Error('No source tab for lead ' + p.leadId);
        const rowNo = await sheets.findRowByColA(src.tab, p.leadId);
        if (!rowNo) throw new Error('Lead ' + p.leadId + ' not found in sheet tab ' + src.tab);
        const upd: { range: string; values: any[][] }[] = [];
        if (p.assignedName !== undefined) upd.push({ range: sheets.a1Cell(src.tab, src.assigned, rowNo), values: [[p.assignedName ?? '']] });
        if (p.status !== undefined) upd.push({ range: sheets.a1Cell(src.tab, src.status, rowNo), values: [[p.status ?? '']] });
        await sheets.batchUpdateValues(upd);
      } else if (job.table_name === 'quotations') {
        const now = new Date().toISOString();
        await sheets.appendValues('Quotations', 'A:T', [[now, p.leadId, p.customerName, p.contactPerson, p.mobile, p.location, p.eventDate, p.days,
          p.salesPerson, p.salesPersonMobile, JSON.stringify(p.items || []), p.total, p.gstPercent, p.gstAmount, p.grandTotal,
          p.status, p.generatedBy, now, p.storagePath || '', p.pdfUrl || '']]);
      } else {
        // users / checklist / delegation / checklist / delegation: not mirrored back to the sheet (sheet is their source).
        await sb.from('sheet_sync_log').insert({ direction: 'db->sheet', table_name: job.table_name, ok: true, detail: { skipped: true } });
      }
      await sb.from('sheet_outbox').update({ status: 'done', processed_at: new Date().toISOString() }).eq('id', job.id);
      results.push({ id: job.id, ok: true });
    } catch (e: any) {
      const attempts = (job.attempts || 0) + 1;
      const status = attempts >= 10 ? 'dead' : 'pending';
      await sb.from('sheet_outbox').update({
        attempts, status, last_error: String(e?.message || e).substring(0, 500),
      }).eq('id', job.id);
      await sb.from('sheet_sync_log').insert({ direction: 'db->sheet', table_name: job.table_name, ok: false, error: String(e?.message || e).substring(0, 500) });
      results.push({ id: job.id, ok: false, error: String(e?.message || e) });
    }
  }
  await sb.from('sheet_sync_log').insert({ direction: 'db->sheet', table_name: 'outbox_drain', ok: true, detail: { count: results.length } });
  return results;
}
