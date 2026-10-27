import { NextRequest } from 'next/server';
import { supabaseAdmin } from '../supabase';
import { requireSession, AUTH_EXPIRED } from '../auth';
import { getConfig, audit } from '../config';
import { ENV } from '../env';

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
    const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const page = doc.addPage([595.28, 841.89]); // A4
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    let y = 800;
    const M = 48;
    const inr = (n: number | string) => {
      const num = Number(n);
      if (isNaN(num)) return String(n);
      return num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };
    // Header: optional remote image (only if QUOTATION_HEADER_URL is a real http URL), else bundled Panache header.
    let headerDrawn = false;
    if (/^https?:\/\//i.test(ENV.QUOTATION_HEADER_URL || '')) {
      try {
        const imgRes = await fetch(ENV.QUOTATION_HEADER_URL);
        if (imgRes.ok) {
          const bytes = await imgRes.arrayBuffer();
          const isPng = new Uint8Array(bytes)[0] === 0x89;
          const img = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
          const w = 499; const h = (img.height / img.width) * w;
          page.drawImage(img, { x: M, y: y - h, width: w, height: h });
          y -= h + 16;
          headerDrawn = true;
        }
      } catch (_) { /* fall back to bundled header */ }
    }
    if (!headerDrawn) {
      try {
        const { QUOTATION_HEADER_B64 } = await import('../quotation-header-data');
        const img = await doc.embedPng(Buffer.from(QUOTATION_HEADER_B64, 'base64'));
        const w = 499; const h = (img.height / img.width) * w;
        page.drawImage(img, { x: M, y: y - h, width: w, height: h });
        y -= h + 14;
      } catch (e) { console.error('quotation header failed:', e); }
    }
    page.drawText('QUOTATION', { x: M, y: y - 20, size: 20, font: bold, color: rgb(0.31, 0.27, 0.9) });
    y -= 40;
    // customer / quotation details blocks
    const leftRows: [string, string][] = [
      ['Customer Name', p.customerName], ['Contact Person', p.contactPerson],
      ['Mobile No.', p.mobile], ['Location', p.location],
    ];
    const rightRows: [string, string][] = [
      ['Date', p.eventDate], ['Days', p.days],
      ['Sales Person', p.salesPerson], ['Sales Mobile', p.salesPersonMobile],
    ];
    page.drawText('QUOTATION TO', { x: M, y, size: 9, font: bold, color: rgb(0.31, 0.27, 0.9) });
    page.drawText('QUOTATION DETAILS', { x: 310, y, size: 9, font: bold, color: rgb(0.31, 0.27, 0.9) });
    y -= 14;
    leftRows.forEach(([lbl, val], i) => {
      page.drawText(lbl + ':', { x: M, y: y - i * 14, size: 10, font: bold, color: rgb(0.4, 0.4, 0.45) });
      page.drawText(String(val || ''), { x: M + 100, y: y - i * 14, size: 10, font });
      page.drawText(rightRows[i][0] + ':', { x: 310, y: y - i * 14, size: 10, font: bold, color: rgb(0.4, 0.4, 0.45) });
      page.drawText(String(rightRows[i][1] || ''), { x: 310 + 90, y: y - i * 14, size: 10, font });
    });
    y -= leftRows.length * 14 + 18;

    // items table
    const cols = [M, M + 45, M + 230, M + 320, M + 370, M + 460];
    const th = ['S.NO', 'PARTICULARS', 'SIZE(Sqft)', 'QTY', 'RATE', 'AMOUNT'];
    page.drawRectangle({ x: M - 6, y: y - 6, width: 499, height: 18, color: rgb(0.31, 0.27, 0.9) });
    th.forEach((h, i) => page.drawText(h, { x: cols[i], y, size: 9, font: bold, color: rgb(1, 1, 1) }));
    y -= 22;
    for (const it of items) {
      const row = [String(it.sno), it.particulars, it.size || '-', it.qty, inr(it.rate), inr(it.amount)];
      row.forEach((v, i) => page.drawText(String(v).substring(0, 38), { x: cols[i], y, size: 9.5, font: i === 5 ? bold : font }));
      page.drawLine({ start: { x: M - 6, y: y - 5 }, end: { x: M + 493, y: y - 5 }, thickness: 0.4, color: rgb(0.9, 0.9, 0.94) });
      y -= 17;
      if (y < 120) { y = 800; /* naive continuation */ }
    }
    y -= 8;
    const totalsRows: [string, string][] = [
      ['Total', inr(total)],
      ['GST (' + gstPercent + '%)', inr(gstAmount)],
      ['Grand Total', inr(grandTotal)],
    ];
    totalsRows.forEach(([lbl, val], i) => {
      const yy = y - i * 16;
      const isGrand = i === 2;
      page.drawText(lbl, { x: 340, y: yy, size: isGrand ? 12 : 10, font: bold, color: isGrand ? rgb(0.26, 0.22, 0.79) : rgb(0.4, 0.4, 0.45) });
      page.drawText(val, { x: 500, y: yy, size: isGrand ? 12 : 10, font: bold, color: isGrand ? rgb(0.26, 0.22, 0.79) : rgb(0.12, 0.12, 0.14) });
    });
    y -= totalsRows.length * 16 + 24;
    // terms + footer
    const terms = [
      'Terms & Conditions:',
      '1. Inclusive: Installation, Dismantlement & Labor charges.',
      '2. Exclusive: Transportation on actuals.',
      '3. Payment Terms: 50% advance at confirmation, 30% before installation, 20% after installation.',
      '4. Any losses and damages will be recovered based on actual costs incurred.',
    ];
    terms.forEach((t, i) => page.drawText(t, { x: M, y: y - i * 13, size: 8.5, font: i === 0 ? bold : font, color: rgb(0.3, 0.3, 0.35) }));
    y -= terms.length * 13 + 20;
    page.drawText(p.salesPerson || '', { x: M, y, size: 11, font: bold });
    page.drawText('Sr. Business Development Manager', { x: M, y: y - 13, size: 9, font });
    page.drawText('Mobile: ' + (p.salesPersonMobile || ''), { x: M, y: y - 25, size: 9.5, font: bold });
    page.drawText('Authorized Signatory', { x: 440, y, size: 8, font, color: rgb(0.6, 0.6, 0.65) });
    page.drawText('Head Office: 4F-04, Mahima Trinity Mall, Swez farm, Jaipur-302020 (Raj)', { x: M, y: 40, size: 8, font });
    page.drawText('Branch Office: D-05, TCC, Satellite, Ahmedabad - 380015 (Gujarat)', { x: M, y: 28, size: 8, font });
    page.drawText('www.panacheevents.in  |  Email: sales@panacheevents.in', { x: M, y: 16, size: 8, font: bold, color: rgb(0.31, 0.27, 0.9) });

    const bytes = await doc.save();
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
