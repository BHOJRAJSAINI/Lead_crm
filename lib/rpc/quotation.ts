import { NextRequest } from 'next/server';
import { supabaseAdmin } from '../supabase';
import { requireSession, AUTH_EXPIRED } from '../auth';
import { getConfig, audit } from '../config';
import { ENV } from '../env';
import { buildQuotationPdf } from '../quotation-pdf';

/**
 * Server-side quotation PDF via pdf-lib (6 columns S.NO/PARTICULARS/SIZE/QTY/RATE/AMOUNT,
 * GST, grand total, customer & BDM block). Stored in the private Supabase Storage
 * bucket `quotations`, returned as a signed URL. Mirrors generateQuotation() from Code.gs
 * including the Indu Hada assignment rule and Amount = Size×Qty×Rate | Size×Rate | Qty×Rate.
 */
export async function handleGenerateQuotation(req: NextRequest, args: any[]) {
  const s = await requireSession(req);
  if (!s) return AUTH_EXPIRED;
  const p = args[0] || {};
  const leadId = (p.leadId || '').toString().trim();
  if (!leadId) {
    return { success: false, code: 'ACCESS_DENIED', message: 'Quotation generation is allowed only for leads assigned to Indu Hada.' };
  }
  const sb = supabaseAdmin();
  const { data: lead } = await sb.from('leads').select('assigned_name').eq('lead_id', leadId).maybeSingle();
  const allowed = String(await getConfig('quotation_allowed_assignee') || 'indu hada');
  if (!lead || (lead.assigned_name || '').toString().trim().toLowerCase() !== allowed) {
    return { success: false, code: 'ACCESS_DENIED', message: 'Quotation generation is allowed only for leads assigned to Indu Hada.' };
  }

  const required: [string, string][] = [
    ['customerName', 'Customer Name'], ['contactPerson', 'Contact Person'], ['mobile', 'Mobile'],
    ['location', 'Location'], ['eventDate', 'Event Date'], ['days', 'Days'],
    ['salesPerson', 'Sales Person'], ['salesPersonMobile', 'Sales Person Mobile'],
  ];
  const missing = required.filter(([k]) => !String(p[k] ?? '').trim()).map(([, label]) => label);
  if (missing.length) return { success: false, code: 'VALIDATION_ERROR', message: 'Missing required field(s): ' + missing.join(', ') };

  const itemsIn = p.items || [];
  if (!itemsIn.length) return { success: false, code: 'VALIDATION_ERROR', message: 'At least one quotation item is required.' };

  const items: any[] = [];
  let total = 0;
  for (let i = 0; i < itemsIn.length; i++) {
    const it = itemsIn[i] || {};
    const particulars = String(it.particulars || '').trim();
    const sizeRaw = it.size === undefined || it.size === null ? '' : String(it.size).trim();
    const qtyRaw = it.qty === undefined || it.qty === null ? '' : String(it.qty).trim();
    const rateRaw = it.rate === undefined || it.rate === null ? '' : String(it.rate).trim();
    if (!particulars) return { success: false, code: 'VALIDATION_ERROR', message: 'Item #' + (i + 1) + ': Particulars is required.' };
    if (!rateRaw) return { success: false, code: 'VALIDATION_ERROR', message: 'Item #' + (i + 1) + ': Rate is required.' };
    const rateNum = parseFloat(rateRaw);
    if (isNaN(rateNum) || !isFinite(rateNum) || rateNum <= 0) return { success: false, code: 'VALIDATION_ERROR', message: 'Item #' + (i + 1) + ': Rate must be a positive number.' };
    let sizeNum: number | null = null;
    if (sizeRaw !== '') { sizeNum = parseFloat(sizeRaw); if (isNaN(sizeNum) || !isFinite(sizeNum) || sizeNum < 0) return { success: false, code: 'VALIDATION_ERROR', message: 'Item #' + (i + 1) + ': Size must be a non-negative number.' }; }
    let qtyNum: number | null = null;
    if (qtyRaw !== '') { qtyNum = parseFloat(qtyRaw); if (isNaN(qtyNum) || !isFinite(qtyNum) || qtyNum < 0) return { success: false, code: 'VALIDATION_ERROR', message: 'Item #' + (i + 1) + ': Qty must be a non-negative number.' }; }
    const hasSize = sizeNum !== null && sizeNum > 0;
    const hasQty = qtyNum !== null && qtyNum > 0;
    if (!hasSize && !hasQty) return { success: false, code: 'VALIDATION_ERROR', message: 'Item #' + (i + 1) + ': Enter a positive Size or Qty.' };
    let amount: number;
    if (hasSize && hasQty) amount = sizeNum! * qtyNum! * rateNum;
    else if (hasSize) amount = sizeNum! * rateNum;
    else amount = qtyNum! * rateNum;
    amount = Math.round(amount * 100) / 100;
    total += amount;
    items.push({ sno: i + 1, particulars, size: sizeRaw, qty: qtyRaw, rate: rateNum, amount });
  }
  total = Math.round(total * 100) / 100;
  let gstPercent = parseFloat(p.gstPercent);
  if (isNaN(gstPercent) || gstPercent < 0) gstPercent = 18;
  const gstAmount = Math.round(total * gstPercent) / 100;
  const grandTotal = Math.round((total + gstAmount) * 100) / 100;

  const fileName = 'Quotation - ' + String(p.customerName || 'Customer').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().substring(0, 40) + ' - ' + Date.now() + '.pdf';
  const storagePath = 'quotations/' + new Date().toISOString().slice(0, 10) + '/' + Date.now() + '-' + fileName.replace(/\s+/g, '-');

  try {
    const bytes = await buildQuotationPdf(p, items, total, gstPercent, gstAmount, grandTotal);
    const { error: upErr } = await sb.storage.from(ENV.QUOTATIONS_BUCKET).upload(storagePath, bytes, {
      contentType: 'application/pdf', upsert: false,
    });
    if (upErr) return { success: false, code: 'SERVER_ERROR', message: 'Failed to save PDF: ' + upErr.message };

    const { data: signed, error: signErr } = await sb.storage.from(ENV.QUOTATIONS_BUCKET).createSignedUrl(storagePath, 7 * 24 * 60 * 60);
    const pdfUrl = signed?.signedUrl || '';

    await sb.from('quotations').insert({
      lead_id: leadId, customer_name: p.customerName, contact_person: p.contactPerson,
      mobile: p.mobile, location: p.location, event_date: p.eventDate, days: p.days,
      sales_person: p.salesPerson, sales_person_mobile: p.salesPersonMobile,
      items, total, gst_percent: gstPercent, gst_amount: gstAmount, grand_total: grandTotal,
      generated_by: s.email, storage_path: storagePath, pdf_url: pdfUrl, status: 'Hot Lead',
    });
    // follow-up auto-saved as Hot Lead (same as GAS flow)
    const today = new Date().toISOString().slice(0, 10);
    await sb.from('follow_ups').insert({
      lead_id: leadId, follow_date: today, follow_time: new Date().toTimeString().slice(0, 5),
      remark: 'Quotation generated', lead_status: 'Hot Lead', created_by: s.email,
    });
    await audit({ actorEmail: s.email, action: 'generate_quotation', entity: 'quotations', entityId: leadId });
    return { success: true, message: 'Quotation generated successfully.', pdfUrl, pdfId: storagePath, fileName, total, gstPercent, gstAmount, grandTotal };
  } catch (e: any) {
    return { success: false, code: 'SERVER_ERROR', message: 'Quotation generation failed: ' + (e?.message || 'unknown') };
  }
}
