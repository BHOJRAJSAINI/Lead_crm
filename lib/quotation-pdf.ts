import { ENV } from './env';

/** Builds the quotation PDF (A4) — layout mirrors the approved Panache quotation format. */
export async function buildQuotationPdf(p: any, items: any[], total: number, gstPercent: number, gstAmount: number, grandTotal: number): Promise<Uint8Array> {
    const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const W = 595.28, H = 841.89, L = 33.6, R = 562, CW = R - L; // content box (pt)
    const INDIGO = rgb(0.31, 0.27, 0.9), DARK = rgb(0.07, 0.09, 0.15), GRAY = rgb(0.42, 0.45, 0.5);
    const BORDER = rgb(0.9, 0.91, 0.94), TINT = rgb(0.96, 0.965, 1), CARD = rgb(0.985, 0.988, 1);
    const safe = (v: any) => String(v ?? '').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
    const inr = (n: number | string) => {
      const num = Number(n);
      if (isNaN(num)) return String(n);
      return num.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    };
    let page = doc.addPage([W, H]);
    const Y = (top: number) => H - top; // convert "distance from top" to pdf y
    const textW = (t: string, f: any, size: number) => f.widthOfTextAtSize(t, size);
    const txt = (t: any, x: number, top: number, size: number, f = font, color = DARK) =>
      page.drawText(safe(t), { x, y: Y(top) - size * 0.35, size, font: f, color });
    const txtC = (t: any, cx: number, top: number, size: number, f = font, color = DARK) =>
      txt(t, cx - textW(safe(t), f, size) / 2, top, size, f, color);
    const txtR = (t: any, rx: number, top: number, size: number, f = font, color = DARK) =>
      txt(t, rx - textW(safe(t), f, size), top, size, f, color);
    const spaced = (t: string, x: number, top: number, size: number, f: any, color: any, sp: number, center = false) => {
      const chars = safe(t).split('');
      const total = chars.reduce((w, c) => w + textW(c, f, size) + sp, -sp);
      let cx = center ? x - total / 2 : x;
      for (const c of chars) { page.drawText(c, { x: cx, y: Y(top) - size * 0.35, size, font: f, color }); cx += textW(c, f, size) + sp; }
    };
    const rect = (x: number, top: number, w: number, h: number, o: any) => page.drawRectangle({ x, y: Y(top) - h, width: w, height: h, ...o });
    const hline = (x1: number, x2: number, top: number, color: any, thickness = 0.6) =>
      page.drawLine({ start: { x: x1, y: Y(top) }, end: { x: x2, y: Y(top) }, thickness, color });
    const rrect = (x: number, top: number, w: number, h: number, r: number, o: any) => {
      const d = `M ${r} 0 H ${w - r} Q ${w} 0 ${w} ${r} V ${h - r} Q ${w} ${h} ${w - r} ${h} H ${r} Q 0 ${h} 0 ${h - r} V ${r} Q 0 0 ${r} 0 Z`;
      page.drawSvgPath(d, { x, y: Y(top), ...o });
    };
    const wrap = (t: string, f: any, size: number, maxW: number): string[] => {
      const out: string[] = [];
      for (const para of safe(t).split(/\r?\n/)) {
        let line = '';
        for (const word of para.split(/\s+/).filter(Boolean)) {
          const test = line ? line + ' ' + word : word;
          if (textW(test, f, size) <= maxW) line = test;
          else { if (line) out.push(line); line = word; }
        }
        out.push(line);
      }
      return out.length ? out : [''];
    };

    // ---- header image (remote URL if valid, else bundled Panache header) ----
    let hdr: any = null;
    if (/^https?:\/\//i.test(ENV.QUOTATION_HEADER_URL || '')) {
      try {
        const imgRes = await fetch(ENV.QUOTATION_HEADER_URL);
        if (imgRes.ok) {
          const bytes = await imgRes.arrayBuffer();
          hdr = new Uint8Array(bytes)[0] === 0x89 ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
        }
      } catch (_) { /* fall back to bundled header */ }
    }
    if (!hdr) {
      try {
        const { QUOTATION_HEADER_B64 } = await import('./quotation-header-data');
        hdr = await doc.embedPng(Buffer.from(QUOTATION_HEADER_B64, 'base64'));
      } catch (e) { console.error('quotation header failed:', e); }
    }
    if (hdr) {
      const hw = 529, hh = (hdr.height / hdr.width) * hw;
      page.drawImage(hdr, { x: (W - hw) / 2, y: Y(30) - hh, width: hw, height: hh });
    }

    // ---- title band ----
    rect(L, 138.5, CW, 38.5, { color: TINT });
    hline(L, R, 138.5, INDIGO, 1.4);
    hline(L, R, 177, INDIGO, 1.4);
    spaced('QUOTATION', (L + R) / 2, 157.5, 15, bold, INDIGO, 6, true);

    // ---- info card ----
    rrect(L, 192, CW, 94, 5, { color: CARD, borderColor: BORDER, borderWidth: 0.8 });
    page.drawLine({ start: { x: 298, y: Y(192) }, end: { x: 298, y: Y(286) }, thickness: 0.6, color: BORDER });
    spaced('QUOTATION TO', 46.5, 205, 6.3, bold, INDIGO, 1.1);
    spaced('QUOTATION DETAILS', 310, 205, 6.3, bold, INDIGO, 1.1);
    hline(46.5, 285.5, 214.5, BORDER); hline(310, 550, 214.5, BORDER);
    const leftRows: [string, any][] = [['Customer Name', p.customerName], ['Contact Person', p.contactPerson], ['Mobile No.', p.mobile], ['Location', p.location]];
    const rightRows: [string, any][] = [['Date', p.eventDate], ['Days', p.days], ['Sales Person', p.salesPerson], ['Sales Mobile', p.salesPersonMobile]];
    leftRows.forEach(([lbl, val], i) => {
      const t = 226.6 + i * 13.9;
      txt(lbl, 46.5, t, 7, bold, GRAY); txt(val, 125, t, 7.4, font, DARK);
      txt(rightRows[i][0], 310, t, 7, bold, GRAY); txt(rightRows[i][1], 388.5, t, 7.4, font, DARK);
    });

    // ---- item details ----
    spaced('ITEM DETAILS', L, 303.5, 6.3, bold, INDIGO, 1.1);
    hline(L, R, 314, BORDER);
    let top = 321;
    rect(L, top, CW, 12.5, { color: INDIGO });
    const colC = { sno: 53.6, part: 182, size: 319, qty: 371, rate: 448, amt: 520 };
    txtC('S.NO', colC.sno, top + 6.3, 6.6, bold, rgb(1, 1, 1)); txtC('PARTICULARS', colC.part, top + 6.3, 6.6, bold, rgb(1, 1, 1));
    txtC('SIZE(Sqft)', colC.size, top + 6.3, 6.6, bold, rgb(1, 1, 1)); txtC('QTY', colC.qty, top + 6.3, 6.6, bold, rgb(1, 1, 1));
    txtC('RATE', colC.rate, top + 6.3, 6.6, bold, rgb(1, 1, 1)); txtC('AMOUNT', colC.amt, top + 6.3, 6.6, bold, rgb(1, 1, 1));
    top += 12.5;
    const LIMIT = 748; // content must end above the footer
    const newPage = () => { page = doc.addPage([W, H]); top = 40; };
    for (const it of items) {
      const lines = wrap(it.particulars, font, 7.2, 180);
      const rh = Math.max(22.4, lines.length * 9.5 + 12);
      if (top + rh > LIMIT) newPage();
      const mid = top + rh / 2;
      txtC(it.sno, colC.sno + 1, mid, 7.2, font, GRAY);
      lines.forEach((ln, i) => txt(ln, 84, mid - ((lines.length - 1) * 9.5) / 2 + i * 9.5, 7.2, font, DARK));
      txtC(it.size || '-', colC.size, mid, 7.2, font, GRAY);
      txtC(it.qty || '-', colC.qty, mid, 7.2, bold, DARK);
      txtR(inr(it.rate), 470, mid, 7.2, font, GRAY);
      txtR(inr(it.amount), 553, mid, 7.2, bold, DARK);
      hline(L, R, top + rh, BORDER, 0.5);
      top += rh;
    }

    // ---- totals box ----
    top += 12;
    if (top + 82 > LIMIT) newPage();
    const bx = 272, bw = R - bx;
    rect(bx, top, 152, 80, { color: rgb(0.945, 0.953, 0.975) });
    rect(bx + 152, top, bw - 152, 80, { color: rgb(1, 1, 1) });
    rect(bx, top + 49, bw, 31, { color: rgb(0.925, 0.935, 0.99) });
    hline(bx, R, top + 25, BORDER, 0.5);
    hline(bx, R, top + 49, INDIGO, 1.4);
    txt('TOTAL', 283, top + 12.5, 7, bold, GRAY); txtR(inr(total), 551, top + 12.5, 7.4, bold, DARK);
    txt('GST (' + gstPercent + '%)', 283, top + 37, 7, bold, GRAY); txtR(inr(gstAmount), 551, top + 37, 7.4, bold, DARK);
    txt('GRAND TOTAL', 283, top + 64.5, 7.6, bold, INDIGO); txtR(inr(grandTotal), 551, top + 64.5, 10.5, bold, INDIGO);
    top += 80 + 17;

    // ---- terms & conditions ----
    const terms: { t: string; bullets?: string[] }[] = [
      { t: 'Inclusive: Installation, Dismantlement & Labor charges.' },
      { t: 'Additional Expenses: If there are any additional expenses beyond what is approved or mentioned in the list, would be chargeable accordingly on actuals.' },
      { t: 'Payment Terms:', bullets: ['50% advance at the time of confirmation', '30% immediately after the installation of the structure', '20% Within 15 days of period after installation'] },
      { t: 'Losses and Damages: Any losses or damages will be recovered based on actual costs incurred.' },
      { t: 'Force Majeure & Liability Disclaimer: We shall not be held liable for any loss of life, injury, or damage to property/materials arising directly or indirectly from extreme or unforeseen weather conditions, including but not limited to storm winds, thunderstorms, heavy rainfall, lightning, or other acts of nature. Necessary safety measures and precautions will be advised and implemented to the extent reasonably practicable; however, the company shall not be responsible for consequences arising from such force majeure events.' },
    ];
    const termH = terms.reduce((h, tm) => h + wrap(tm.t, font, 7, 502).length * 10.4 + (tm.bullets ? tm.bullets.length * 12.8 : 0) + 3, 0);
    if (top + 28 + termH > LIMIT) newPage();
    hline(L, R, top, rgb(0.88, 0.9, 0.98), 0.8);
    spaced('TERMS & CONDITIONS', L, top + 15.5, 6.3, bold, INDIGO, 1.1);
    hline(L, R, top + 25.5, BORDER, 0.6);
    top += 40;
    terms.forEach((tm, i) => {
      txt((i + 1) + '.', 39, top, 7, font, rgb(0.25, 0.27, 0.32));
      wrap(tm.t, font, 7, 502).forEach((ln, k) => { txt(ln, 49.5, top, 7, font, rgb(0.25, 0.27, 0.32)); if (k < wrap(tm.t, font, 7, 502).length - 1) top += 10.4; });
      top += 12.8;
      (tm.bullets || []).forEach((b) => {
        page.drawCircle({ x: 50, y: Y(top), size: 0.9, color: GRAY });
        txt(b, 59, top, 6.8, font, GRAY);
        top += 12.8;
      });
      top += 3;
    });

    // ---- signature card ----
    top += 6;
    if (top + 60 > LIMIT) newPage();
    rrect(L, top, CW, 60, 5, { color: CARD, borderColor: BORDER, borderWidth: 0.8 });
    txt(p.salesPerson, 46.5, top + 15.5, 8.6, bold, DARK);
    txt('Sr. Business Development Manager', 46.5, top + 28.5, 6.6, font, GRAY);
    txt('Mobile: ' + safe(p.salesPersonMobile), 46.5, top + 43, 7, bold, DARK);
    {
      const label = 'AUTHORIZED SIGNATORY';
      const lw = label.split('').reduce((w, c) => w + textW(c, font, 5.6) + 0.9, -0.9);
      spaced(label, 549 - lw, top + 28.5, 5.6, font, rgb(0.62, 0.64, 0.7), 0.9);
    }
    // ---- footer on every page ----
    for (const pg of doc.getPages()) {
      page = pg;
      hline(L, R, 773.5, INDIGO, 1);
      txtC('Head Office: 4F-04, Mahima Trinity Mall, Swez farm, Jaipur-302020 (Raj)', W / 2, 787, 6.4, font, rgb(0.33, 0.35, 0.4));
      txtC('Branch Office: D-05, TCC, Satellite, Ahmedabad - 380015 (Gujarat)', W / 2, 797.5, 6.4, font, rgb(0.33, 0.35, 0.4));
      const a1 = 'www.panacheevents.in', a2 = '  |  Email: sales@panacheevents.in';
      const tw = textW(a1, bold, 6.4) + textW(a2, font, 6.4), sx = W / 2 - tw / 2;
      txt(a1, sx, 808, 6.4, bold, INDIGO); txt(a2, sx + textW(a1, bold, 6.4), 808, 6.4, font, rgb(0.33, 0.35, 0.4));
    }

    return await doc.save();
}
