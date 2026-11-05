const PDFDocument = require('pdfkit');
const { createPdfLayout } = require('./pdf-layout');
// formatDisplayDate keeps a 'YYYY-MM-DD' on its own calendar day whatever the
// server's time zone; new Date('2026-10-20') is UTC midnight, which renders as
// the 19th anywhere west of Greenwich.
const { formatDisplayDate, balanceDue } = require('./document-math');

// Colours
const PRIMARY   = '#4a90e2';
const DARK      = '#1a1a2e';
const MEDIUM    = '#6b7280';
const LIGHT_BG  = '#f3f4f6';
const SUCCESS   = '#16a34a';
const WARNING   = '#d97706'; // amber — used for quote badge

/**
 * Build a PDF invoice buffer.
 * @param {object} invoice  - Full invoice row (documents JOIN customers)
 * @param {Array}  items    - document_items rows
 * @param {object} user     - users row (company info + bank details)
 * @returns {Promise<Buffer>}
 */
function buildInvoicePdf(invoice, items, user) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
    const layout = createPdfLayout(doc, user, 'Invoice', invoice.document_number);
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end',  ()    => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth  = doc.page.width  - 100;
    const col = {
      left:  50,
      right: doc.page.width - 50,
      mid:   doc.page.width / 2
    };

    // ── HEADER ────────────────────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 90).fill(DARK);

    const LOGO_MAX_W = 120;
    const LOGO_MAX_H = 70;
    const LOGO_X     = col.left;
    const LOGO_Y     = 10;
    let textX = col.left;

    if (user.logo_path) {
      try {
        doc.image(user.logo_path, LOGO_X, LOGO_Y, { fit: [LOGO_MAX_W, LOGO_MAX_H] });
        textX = LOGO_X + LOGO_MAX_W + 14;
      } catch (err) {
        // Still render the document without the logo, but leave a trace.
        console.warn(`PDF logo skipped (${user.logo_path}): ${err.message}`);
      }
    }

    const textW = 300 - (textX - col.left);
    doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold')
       .text(user.company_name || 'Your Company', textX, 28, { width: textW });

    if (user.vat_number) {
      doc.fontSize(9).font('Helvetica').fillColor('#aaaacc')
         .text(`VAT Reg: ${user.vat_number}`, textX, 55);
    }

    const badgeX = doc.page.width - 160;
    doc.fillColor(PRIMARY).rect(badgeX, 0, 160, 90).fill();
    doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold')
       .text('INVOICE', badgeX, 30, { width: 155, align: 'center' });
    doc.fontSize(13).font('Helvetica-Bold')
       .text(invoice.document_number, badgeX, 48, { width: 155, align: 'center' });

    doc.moveDown(0.5);
    doc.y = 110;

    // ── BILLED TO / INVOICE DETAILS ───────────────────────────────────────────
    const detailsY = doc.y;

    doc.fillColor(MEDIUM).fontSize(8).font('Helvetica-Bold').text('BILLED TO', col.left, detailsY);
    doc.fillColor(DARK).fontSize(11).font('Helvetica-Bold').text(invoice.customer_name, col.left, detailsY + 14);
    if (invoice.customer_email) {
      doc.fillColor(MEDIUM).fontSize(9).font('Helvetica').text(invoice.customer_email, col.left, doc.y + 2);
    }
    if (invoice.customer_billing_address) {
      doc.fillColor(MEDIUM).fontSize(9).font('Helvetica').text(invoice.customer_billing_address, col.left, doc.y + 2, { width: 200 });
    }
    if (invoice.customer_vat_number) {
      doc.fillColor(MEDIUM).fontSize(9).text(`VAT: ${invoice.customer_vat_number}`, col.left, doc.y + 4);
    }

    const metaX = col.mid + 20;
    const metaLabelW = 90;
    const metaValueX = metaX + metaLabelW + 5;

    const formatDate = (d) => formatDisplayDate(d);

    const metaRows = [
      ['Issue Date:',    formatDate(invoice.issue_date)],
      ['Due Date:',      formatDate(invoice.due_date)],
      invoice.payment_terms != null ? ['Payment Terms:', `${invoice.payment_terms} days`] : null,
      invoice.purchase_order_ref ? ['PO / Ref:', invoice.purchase_order_ref] : null,
    ].filter(Boolean);

    let metaY = detailsY;
    for (const [label, value] of metaRows) {
      doc.fillColor(MEDIUM).fontSize(9).font('Helvetica-Bold').text(label, metaX, metaY, { width: metaLabelW });
      const valueWidth = col.right - metaValueX;
      doc.fillColor(DARK).fontSize(9).font('Helvetica').text(value, metaValueX, metaY, { width: valueWidth });
      metaY += Math.max(16, doc.heightOfString(String(value), { width: valueWidth }) + 3);
    }

    doc.y = Math.max(doc.y, metaY) + 20;

    // ── LINE ITEMS TABLE ──────────────────────────────────────────────────────
    const currSym = invoice.currency_symbol || 'R';
    const fmt = (n) => `${currSym} ${parseFloat(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
    let rowY = layout.table(items, doc.y, fmt);

    const totalsLabelX = col.right - 200;
    const totalsValueX = col.right - 100;
    const totalsW      = 95;

    const totalsRows = [
      ['Subtotal', fmt(invoice.subtotal),   DARK, false],
      ['VAT',      fmt(invoice.vat_amount), DARK, false],
      ['TOTAL',    fmt(invoice.total),      DARK, true ],
    ];
    if (Number(invoice.credit_total)>0) totalsRows.push(['Credit notes',fmt(-Number(invoice.credit_total)),DARK,false]);
    if (Number(invoice.refund_total)>0) totalsRows.push(['Refunded',fmt(invoice.refund_total),DARK,false]);
    // A part-paid invoice shows what is still owed, so a re-sent copy does not
    // ask the customer for money they have already paid.
    if (Number(invoice.amount_paid) > 0 || Number(invoice.credit_total)>0 || Number(invoice.refund_total)>0) {
      totalsRows.push(['Net paid',fmt(invoice.amount_paid || 0), SUCCESS, false]);
      totalsRows.push(['Balance due',fmt(invoice.balance_due ?? balanceDue(Number(invoice.total)-Number(invoice.credit_total || 0),invoice.amount_paid)), DARK, false]);
    }

    rowY = layout.ensureSpace(rowY, totalsRows.length * 24 + 16);
    for (const [label, value, color, bold] of totalsRows) {
      if (bold) {
        const bannerX = totalsLabelX - 8;
        doc.rect(bannerX, rowY - 2, col.right - bannerX, 22).fill(PRIMARY);
        doc.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold').text(label, totalsLabelX, rowY + 3, { width: 90 });
        doc.font('Courier-Bold').text(value, totalsValueX, rowY + 3, { width: totalsW, align: 'right' });
        rowY += 24;
      } else {
        doc.fillColor(MEDIUM).fontSize(9).font('Helvetica').text(label, totalsLabelX, rowY, { width: 90 });
        doc.fillColor(color).font('Courier').text(value, totalsValueX, rowY, { width: totalsW, align: 'right' });
        rowY += 18;
      }
    }

    rowY += 16;

    // ── NOTES & TERMS ─────────────────────────────────────────────────────────
    if (invoice.notes) {
      rowY = layout.section('NOTES', invoice.notes, rowY);
    }
    if (invoice.delivery_details) rowY = layout.section('DELIVERY DETAILS', invoice.delivery_details, rowY);
    if (invoice.terms_conditions) {
      rowY = layout.section('TERMS & CONDITIONS', invoice.terms_conditions, rowY);
    }

    // ── PAY ONLINE ────────────────────────────────────────────────────────────
    // A link annotation drawn over a button. The URL is printed alongside it as
    // text because link annotations do not survive printing, every PDF viewer,
    // or a screenshot forwarded to whoever actually settles the invoice.
    //
    // Reserve room before drawing the payment action and printable URL.
    if (invoice.pay_url) {
      rowY = layout.ensureSpace(rowY, 70);
      const btnW = 175;
      const btnH = 26;
      doc.roundedRect(col.left, rowY, btnW, btnH, 4).fill(PRIMARY);
      doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold')
         .text('Pay this invoice online', col.left, rowY + 8.5, { width: btnW, align: 'center' });
      doc.link(col.left, rowY, btnW, btnH, invoice.pay_url);

      doc.fillColor(MEDIUM).fontSize(7.5).font('Helvetica')
         .text(invoice.pay_url, col.left + btnW + 12, rowY + 9.5, {
           width: pageWidth - btnW - 12,
           link: invoice.pay_url,
         });
      rowY += btnH + 14;
    }

    // ── BANKING DETAILS ───────────────────────────────────────────────────────
    if (user.bank_name || user.bank_account_number) {
      rowY = layout.ensureSpace(rowY + 4, 54);
      doc.rect(col.left, rowY, pageWidth, 16).fill(LIGHT_BG);
      doc.fillColor(MEDIUM).fontSize(8).font('Helvetica-Bold').text('BANKING DETAILS', col.left + 4, rowY + 4);
      rowY += 20;

      const bankFields = [
        user.bank_name           && `Bank: ${user.bank_name}`,
        user.bank_account_number && `Account: ${user.bank_account_number}`,
        user.bank_branch_code    && `Branch Code: ${user.bank_branch_code}`,
        user.bank_account_type   && `Account Type: ${user.bank_account_type}`,
      ].filter(Boolean);

      rowY = layout.text(bankFields.join('   |   '), rowY) + 16;
    }

    // ── FOOTER ────────────────────────────────────────────────────────────────
    layout.finish();

    doc.end();
  });
}

/**
 * Build a PDF quote buffer.
 * @param {object} quote  - Full quote row (documents JOIN customers)
 * @param {Array}  items  - document_items rows
 * @param {object} user   - users row (company info)
 * @returns {Promise<Buffer>}
 */
function buildQuotePdf(quote, items, user) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
    const layout = createPdfLayout(doc, user, 'Quote', quote.document_number);
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end',  ()    => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width - 100;
    const col = {
      left:  50,
      right: doc.page.width - 50,
      mid:   doc.page.width / 2
    };

    const formatDate = (d) => formatDisplayDate(d);

    const currSym = quote.currency_symbol || 'R';
    const fmt = (n) => `${currSym} ${parseFloat(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    // ── HEADER ────────────────────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 90).fill(DARK);

    const LOGO_MAX_W = 120;
    const LOGO_MAX_H = 70;
    let textX = col.left;

    if (user.logo_path) {
      try {
        doc.image(user.logo_path, col.left, 10, { fit: [LOGO_MAX_W, LOGO_MAX_H] });
        textX = col.left + LOGO_MAX_W + 14;
      } catch (err) {
        // Still render the document without the logo, but leave a trace.
        console.warn(`PDF logo skipped (${user.logo_path}): ${err.message}`);
      }
    }

    const textW = 300 - (textX - col.left);
    doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold')
       .text(user.company_name || 'Your Company', textX, 28, { width: textW });

    if (user.vat_number) {
      doc.fontSize(9).font('Helvetica').fillColor('#aaaacc')
         .text(`VAT Reg: ${user.vat_number}`, textX, 55);
    }

    // Quote badge — amber colour to distinguish it from invoices (blue) and receipts (green)
    const badgeX = doc.page.width - 160;
    doc.fillColor(WARNING).rect(badgeX, 0, 160, 90).fill();
    doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold')
       .text('QUOTE', badgeX, 30, { width: 155, align: 'center' });
    doc.fontSize(13).font('Helvetica-Bold')
       .text(quote.document_number, badgeX, 48, { width: 155, align: 'center' });

    doc.y = 110;

    // ── QUOTED TO / DETAILS ───────────────────────────────────────────────────
    const detailsY = doc.y;

    doc.fillColor(MEDIUM).fontSize(8).font('Helvetica-Bold').text('QUOTED TO', col.left, detailsY);
    doc.fillColor(DARK).fontSize(11).font('Helvetica-Bold').text(quote.customer_name, col.left, detailsY + 14);
    if (quote.customer_email) {
      doc.fillColor(MEDIUM).fontSize(9).font('Helvetica').text(quote.customer_email, col.left, doc.y + 2);
    }
    if (quote.customer_billing_address) {
      doc.fillColor(MEDIUM).fontSize(9).font('Helvetica').text(quote.customer_billing_address, col.left, doc.y + 2, { width: 200 });
    }
    if (quote.customer_vat_number) {
      doc.fillColor(MEDIUM).fontSize(9).text(`VAT: ${quote.customer_vat_number}`, col.left, doc.y + 4);
    }

    // Right: quote meta — shows Valid Until instead of Due Date
    const metaX = col.mid + 20;
    const metaLabelW = 90;
    const metaValueX = metaX + metaLabelW + 5;

    const metaRows = [
      ['Issue Date:',  formatDate(quote.issue_date)],
      ['Valid Until:', formatDate(quote.valid_until)],
      quote.payment_terms != null ? ['Payment Terms:', `${quote.payment_terms} days`] : null,
      quote.purchase_order_ref ? ['PO / Ref:', quote.purchase_order_ref] : null,
    ].filter(Boolean);

    let metaY = detailsY;
    for (const [label, value] of metaRows) {
      doc.fillColor(MEDIUM).fontSize(9).font('Helvetica-Bold').text(label, metaX, metaY, { width: metaLabelW });
      const valueWidth = col.right - metaValueX;
      doc.fillColor(DARK).fontSize(9).font('Helvetica').text(value, metaValueX, metaY, { width: valueWidth });
      metaY += Math.max(16, doc.heightOfString(String(value), { width: valueWidth }) + 3);
    }

    doc.y = Math.max(doc.y, metaY) + 20;

    // ── LINE ITEMS TABLE ──────────────────────────────────────────────────────
    let rowY = layout.table(items, doc.y, fmt);

    const totalsLabelX = col.right - 200;
    const totalsValueX = col.right - 100;
    const totalsW      = 95;

    const totalsRows = [
      ['Subtotal', fmt(quote.subtotal),   DARK, false],
      ['VAT',      fmt(quote.vat_amount), DARK, false],
      ['TOTAL',    fmt(quote.total),      DARK, true ],
    ];

    rowY = layout.ensureSpace(rowY, totalsRows.length * 24 + 16);
    for (const [label, value, color, bold] of totalsRows) {
      if (bold) {
        const bannerX = totalsLabelX - 8;
        doc.rect(bannerX, rowY - 2, col.right - bannerX, 22).fill(WARNING);
        doc.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold').text(label, totalsLabelX, rowY + 3, { width: 90 });
        doc.font('Courier-Bold').text(value, totalsValueX, rowY + 3, { width: totalsW, align: 'right' });
        rowY += 24;
      } else {
        doc.fillColor(MEDIUM).fontSize(9).font('Helvetica').text(label, totalsLabelX, rowY, { width: 90 });
        doc.fillColor(color).font('Courier').text(value, totalsValueX, rowY, { width: totalsW, align: 'right' });
        rowY += 18;
      }
    }

    rowY += 16;

    // ── NOTES & TERMS ─────────────────────────────────────────────────────────
    if (quote.notes) {
      rowY = layout.section('NOTES', quote.notes, rowY);
    }
    if (quote.delivery_details) rowY = layout.section('DELIVERY DETAILS', quote.delivery_details, rowY);
    if (quote.terms_conditions) {
      rowY = layout.section('TERMS & CONDITIONS', quote.terms_conditions, rowY);
    }

    // ── FOOTER ────────────────────────────────────────────────────────────────
    layout.finish();

    doc.end();
  });
}

/**
 * Build a PDF receipt buffer for a paid invoice.
 * @param {object} invoice  - Full invoice row (documents JOIN customers)
 * @param {Array}  items    - document_items rows
 * @param {object} user     - users row (company info)
 * @param {Array}  payments - payments rows for this invoice
 * @returns {Promise<Buffer>}
 */
function buildReceiptPdf(invoice, items, user, payments) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4', bufferPages: true });
    const layout = createPdfLayout(doc, user, 'Receipt', invoice.document_number);
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end',  ()    => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth = doc.page.width - 100;
    const col = {
      left:  50,
      right: doc.page.width - 50,
      mid:   doc.page.width / 2
    };

    const formatDate = (d) => formatDisplayDate(d);

    const currSym = invoice.currency_symbol || 'R';
    const fmt = (n) => `${currSym} ${parseFloat(n).toLocaleString('en-ZA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

    // ── HEADER ────────────────────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 90).fill(DARK);

    const LOGO_MAX_W = 120;
    const LOGO_MAX_H = 70;
    let textX = col.left;

    if (user.logo_path) {
      try {
        doc.image(user.logo_path, col.left, 10, { fit: [LOGO_MAX_W, LOGO_MAX_H] });
        textX = col.left + LOGO_MAX_W + 14;
      } catch (err) {
        // Still render the document without the logo, but leave a trace.
        console.warn(`PDF logo skipped (${user.logo_path}): ${err.message}`);
      }
    }

    const textW = 300 - (textX - col.left);
    doc.fillColor('#ffffff').fontSize(22).font('Helvetica-Bold')
       .text(user.company_name || 'Your Company', textX, 28, { width: textW });

    if (user.vat_number) {
      doc.fontSize(9).font('Helvetica').fillColor('#aaaacc')
         .text(`VAT Reg: ${user.vat_number}`, textX, 55);
    }

    const badgeX = doc.page.width - 160;
    doc.fillColor(SUCCESS).rect(badgeX, 0, 160, 90).fill();
    doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold')
       .text('RECEIPT', badgeX, 30, { width: 155, align: 'center' });
    doc.fontSize(13).font('Helvetica-Bold')
       .text(invoice.document_number, badgeX, 48, { width: 155, align: 'center' });

    doc.y = 110;

    // ── RECEIPT TO / DETAILS ──────────────────────────────────────────────────
    const detailsY = doc.y;

    doc.fillColor(MEDIUM).fontSize(8).font('Helvetica-Bold').text('RECEIPT TO', col.left, detailsY);
    doc.fillColor(DARK).fontSize(11).font('Helvetica-Bold').text(invoice.customer_name, col.left, detailsY + 14);
    if (invoice.customer_email) {
      doc.fillColor(MEDIUM).fontSize(9).font('Helvetica').text(invoice.customer_email, col.left, doc.y + 2);
    }
    if (invoice.customer_billing_address) {
      doc.fillColor(MEDIUM).fontSize(9).font('Helvetica').text(invoice.customer_billing_address, col.left, doc.y + 2, { width: 200 });
    }

    const metaX = col.mid + 20;
    const metaLabelW = 100;
    const metaValueX = metaX + metaLabelW + 5;

    const metaRows = [
      ['Invoice No:',   invoice.document_number],
      ['Issue Date:',   formatDate(invoice.issue_date)],
      ['Receipt Date:', formatDate(new Date())],
    ];

    let metaY = detailsY;
    for (const [label, value] of metaRows) {
      doc.fillColor(MEDIUM).fontSize(9).font('Helvetica-Bold').text(label, metaX, metaY, { width: metaLabelW });
      doc.fillColor(DARK).fontSize(9).font('Helvetica').text(value, metaValueX, metaY);
      metaY += 16;
    }

    doc.y = Math.max(doc.y, metaY) + 20;

    // ── PAID STAMP ────────────────────────────────────────────────────────────
    const stampY = doc.y;
    doc.save();
    doc.translate(doc.page.width / 2, doc.page.height / 2);
    doc.rotate(-45);
    doc.fillColor(SUCCESS).opacity(0.08).fontSize(120).font('Helvetica-Bold').text('PAID', -120, -60);
    doc.restore();
    doc.opacity(1);
    doc.y = stampY;

    // ── LINE ITEMS TABLE ──────────────────────────────────────────────────────
    let rowY = layout.table(items, doc.y, fmt);

    const totalsLabelX = col.right - 200;
    const totalsValueX = col.right - 100;
    const totalsW      = 95;

    const totalsRows = [
      ['Subtotal', fmt(invoice.subtotal),   DARK, false],
      ['VAT',      fmt(invoice.vat_amount), DARK, false],
      ['TOTAL',    fmt(invoice.total),      DARK, true ],
    ];

    if (Number(invoice.credit_total)>0) totalsRows.push(['Credit notes',fmt(-Number(invoice.credit_total)),DARK,false]);
    if (Number(invoice.refund_total)>0) totalsRows.push(['Refunded',fmt(invoice.refund_total),DARK,false]);
    if (invoice.amount_paid!==undefined) totalsRows.push(['Net paid',fmt(invoice.amount_paid),DARK,false]);
    rowY = layout.ensureSpace(rowY, totalsRows.length * 24 + 16);
    for (const [label, value, color, bold] of totalsRows) {
      if (bold) {
        const bannerX = totalsLabelX - 8;
        doc.rect(bannerX, rowY - 2, col.right - bannerX, 22).fill(SUCCESS);
        doc.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold').text(label, totalsLabelX, rowY + 3, { width: 90 });
        doc.font('Courier-Bold').text(value, totalsValueX, rowY + 3, { width: totalsW, align: 'right' });
        rowY += 24;
      } else {
        doc.fillColor(MEDIUM).fontSize(9).font('Helvetica').text(label, totalsLabelX, rowY, { width: 90 });
        doc.fillColor(color).font('Courier').text(value, totalsValueX, rowY, { width: totalsW, align: 'right' });
        rowY += 18;
      }
    }

    rowY += 16;

    // ── PAYMENT DETAILS ───────────────────────────────────────────────────────
    if (payments && payments.length > 0) {
      rowY = layout.ensureSpace(rowY, 52);
      doc.rect(col.left, rowY, pageWidth, 16).fill(SUCCESS);
      doc.fillColor('#ffffff').fontSize(8).font('Helvetica-Bold').text('PAYMENT DETAILS', col.left + 4, rowY + 4);
      rowY += 20;

      for (const payment of payments) {
        const paymentMethod = payment.payment_method.replace(/_/g, ' ');
        const fields = [
          `Date: ${formatDate(payment.payment_date)}`,
          `Method: ${paymentMethod}`,
          `Amount: ${fmt(payment.amount)}`,
          payment.transaction_reference ? `Ref: ${payment.transaction_reference}` : null,
        ].filter(Boolean).join('   ·   ');

        rowY = layout.text(fields, rowY) + 8;
      }
    }

    // ── FOOTER ────────────────────────────────────────────────────────────────
    layout.finish();

    doc.end();
  });
}

function buildCreditNotePdf(note, invoice, seller) {
  return new Promise((resolve,reject) => {
    const doc=new PDFDocument({margin:50,size:'A4',bufferPages:true});
    const layout=createPdfLayout(doc,seller,'Credit note',note.document_number);
    const chunks=[];
    doc.on('data',chunk=>chunks.push(chunk));
    doc.on('end',()=>resolve(Buffer.concat(chunks)));
    doc.on('error',reject);
    const fmt=value=>`${invoice.currency_symbol || 'R'} ${Number(value).toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
    doc.rect(0,0,doc.page.width,90).fill(DARK);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text(seller.company_name || 'Your Company',50,25,{width:320});
    doc.fontSize(11).text('CREDIT NOTE',doc.page.width-180,28,{width:130,align:'right'});
    doc.fontSize(10).text(note.document_number,doc.page.width-180,47,{width:130,align:'right'});
    let y=115;
    y=layout.section('SELLER',`${seller.company_name || ''}\n${seller.address || ''}\nVAT registration: ${seller.vat_number || 'Not supplied'}`,y);
    y=layout.section('CUSTOMER',`${invoice.customer_name || ''}\n${invoice.customer_billing_address || ''}`,y);
    y=layout.section('ISSUED',formatDisplayDate(note.issue_date),y);
    y=layout.section('ORIGINAL TAX INVOICE',`${invoice.document_number} · ${formatDisplayDate(invoice.issue_date)}`,y);
    y=layout.section('REASON',note.reason,y);
    y=layout.section('DESCRIPTION OF ADJUSTMENT',note.description,y);
    y=layout.section('VALUE REDUCED',fmt(note.subtotal),y);
    y=layout.section('VAT REDUCED',fmt(note.vat_amount),y);
    y=layout.section('TOTAL CREDIT',fmt(note.total),y);
    layout.finish();
    doc.end();
  });
}

function buildPaymentReceiptPdf(payment, invoice, seller) {
  return new Promise((resolve,reject)=>{
    const doc=new PDFDocument({margin:50,size:'A4',bufferPages:true});
    const layout=createPdfLayout(doc,seller,'Payment receipt',`RCPT-${payment.id}`);
    const chunks=[];
    doc.on('data',chunk=>chunks.push(chunk));
    doc.on('end',()=>resolve(Buffer.concat(chunks)));
    doc.on('error',reject);
    const fmt=value=>`${invoice.currency_symbol || 'R'} ${Number(value).toLocaleString('en-ZA',{minimumFractionDigits:2,maximumFractionDigits:2})}`;
    doc.rect(0,0,doc.page.width,90).fill(DARK);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(22).text(seller.company_name || 'Your Company',50,25,{width:320});
    doc.fontSize(11).text('PAYMENT RECEIPT',doc.page.width-200,28,{width:150,align:'right'});
    doc.fontSize(10).text(`RCPT-${payment.id}`,doc.page.width-200,47,{width:150,align:'right'});
    let y=115;
    y=layout.section('RECEIVED FROM',`${invoice.customer_name || ''}\n${invoice.customer_billing_address || ''}`,y);
    y=layout.section('FOR INVOICE',`${invoice.document_number} · ${formatDisplayDate(invoice.issue_date)}`,y);
    y=layout.section('PAYMENT DATE',formatDisplayDate(payment.payment_date),y);
    y=layout.section('METHOD',String(payment.payment_method || '').replace(/_/g,' '),y);
    if (payment.transaction_reference) y=layout.section('REFERENCE',payment.transaction_reference,y);
    y=layout.section('AMOUNT RECEIVED',fmt(payment.amount),y);
    layout.section('NOTE','This confirms the recorded payment only. The invoice and any later credits or refunds remain separate records.',y);
    layout.finish();
    doc.end();
  });
}

module.exports = { buildInvoicePdf, buildQuotePdf, buildReceiptPdf, buildCreditNotePdf, buildPaymentReceiptPdf };
