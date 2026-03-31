const PDFDocument = require('pdfkit');

// Colours
const PRIMARY   = '#4a90e2';
const DARK      = '#1a1a2e';
const MEDIUM    = '#6b7280';
const LIGHT_BG  = '#f3f4f6';
const DIVIDER   = '#e5e7eb';
const SUCCESS   = '#16a34a';

/**
 * Build a PDF invoice buffer.
 * @param {object} invoice  - Full invoice row (documents JOIN customers)
 * @param {Array}  items    - document_items rows
 * @param {object} user     - users row (company info + bank details)
 * @returns {Promise<Buffer>}
 */
function buildInvoicePdf(invoice, items, user) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.on('end',  ()    => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageWidth  = doc.page.width  - 100; // account for margins
    const col = {
      left:  50,
      right: doc.page.width - 50,
      mid:   doc.page.width / 2
    };

    // ── HEADER ────────────────────────────────────────────────────────────────
    doc.rect(0, 0, doc.page.width, 90).fill(DARK);

    doc.fillColor('#ffffff')
       .fontSize(22)
       .font('Helvetica-Bold')
       .text(user.company_name || 'Your Company', col.left, 28, { width: 300 });

    if (user.vat_number) {
      doc.fontSize(9).font('Helvetica').fillColor('#aaaacc')
         .text(`VAT Reg: ${user.vat_number}`, col.left, 55);
    }

    // Invoice badge (top-right of header) — flush to right edge, full header height
    const badgeX = doc.page.width - 160;
    doc.fillColor(PRIMARY)
       .rect(badgeX, 0, 160, 90)
       .fill();
    doc.fillColor('#ffffff')
       .fontSize(10).font('Helvetica-Bold')
       .text('INVOICE', badgeX, 30, { width: 155, align: 'center' });
    doc.fontSize(13).font('Helvetica-Bold')
       .text(invoice.document_number, badgeX, 48, { width: 155, align: 'center' });

    doc.moveDown(0.5);
    doc.y = 110;

    // ── BILLED TO / INVOICE DETAILS (two columns) ────────────────────────────
    const detailsY = doc.y;

    // Left: billed to
    doc.fillColor(MEDIUM).fontSize(8).font('Helvetica-Bold')
       .text('BILLED TO', col.left, detailsY);
    doc.fillColor(DARK).fontSize(11).font('Helvetica-Bold')
       .text(invoice.customer_name, col.left, detailsY + 14);
    if (invoice.customer_email) {
      doc.fillColor(MEDIUM).fontSize(9).font('Helvetica')
         .text(invoice.customer_email, col.left, doc.y + 2);
    }
    if (invoice.customer_billing_address) {
      doc.fillColor(MEDIUM).fontSize(9).font('Helvetica')
         .text(invoice.customer_billing_address, col.left, doc.y + 2, { width: 200 });
    }
    if (invoice.customer_vat_number) {
      doc.fillColor(MEDIUM).fontSize(9)
         .text(`VAT: ${invoice.customer_vat_number}`, col.left, doc.y + 4);
    }

    // Right: invoice meta
    const metaX = col.mid + 20;
    const metaLabelW = 90;
    const metaValueX = metaX + metaLabelW + 5;

    const formatDate = (d) => {
      if (!d) return '—';
      return new Date(d).toLocaleDateString('en-ZA', { day: '2-digit', month: 'short', year: 'numeric' });
    };

    const metaRows = [
      ['Issue Date:',    formatDate(invoice.issue_date)],
      ['Due Date:',      formatDate(invoice.due_date)],
      invoice.payment_terms != null
        ? ['Payment Terms:', `${invoice.payment_terms} days`]
        : null,
      ['Status:',        invoice.status],
    ].filter(Boolean);

    let metaY = detailsY;
    for (const [label, value] of metaRows) {
      doc.fillColor(MEDIUM).fontSize(9).font('Helvetica-Bold').text(label, metaX, metaY, { width: metaLabelW });
      const color = value === 'PAID' ? SUCCESS : value === 'OVERDUE' ? '#dc2626' : DARK;
      doc.fillColor(color).fontSize(9).font('Helvetica').text(value, metaValueX, metaY);
      metaY += 16;
    }

    doc.y = Math.max(doc.y, metaY) + 20;

    // ── LINE ITEMS TABLE ──────────────────────────────────────────────────────
    const tableTop = doc.y;
    // Columns must fit within col.left (50) → col.right (545) = 495px total
    const cols = {
      desc:     { x: col.left,       w: 220 },  // ends 270
      qty:      { x: col.left + 225, w: 45  },  // ends 320
      price:    { x: col.left + 275, w: 80  },  // ends 405
      vat:      { x: col.left + 360, w: 50  },  // ends 460
      total:    { x: col.left + 415, w: 80  }   // ends 545 ✓
    };

    // Header row
    doc.rect(col.left, tableTop, pageWidth, 22).fill(DARK);
    doc.fillColor('#ffffff').fontSize(9).font('Helvetica-Bold');
    doc.text('DESCRIPTION',  cols.desc.x  + 4, tableTop + 7, { width: cols.desc.w });
    doc.text('QTY',          cols.qty.x   + 4, tableTop + 7, { width: cols.qty.w,  align: 'right' });
    doc.text('UNIT PRICE',   cols.price.x + 4, tableTop + 7, { width: cols.price.w, align: 'right' });
    doc.text('VAT %',        cols.vat.x   + 4, tableTop + 7, { width: cols.vat.w,  align: 'right' });
    doc.text('TOTAL',        cols.total.x + 4, tableTop + 7, { width: cols.total.w, align: 'right' });

    let rowY = tableTop + 22;
    const fmt = (n) => `R ${parseFloat(n).toFixed(2)}`;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const bg = i % 2 === 0 ? '#ffffff' : LIGHT_BG;
      doc.rect(col.left, rowY, pageWidth, 20).fill(bg);

      doc.fillColor(DARK).fontSize(9).font('Helvetica');
      doc.text(item.description,                  cols.desc.x  + 4, rowY + 6, { width: cols.desc.w - 8 });
      doc.text(String(parseFloat(item.quantity)), cols.qty.x   + 4, rowY + 6, { width: cols.qty.w,  align: 'right' });
      doc.text(fmt(item.unit_price),              cols.price.x + 4, rowY + 6, { width: cols.price.w, align: 'right' });
      doc.text(`${parseFloat(item.vat_rate)}%`,   cols.vat.x   + 4, rowY + 6, { width: cols.vat.w,  align: 'right' });
      doc.text(fmt(item.total),                   cols.total.x + 4, rowY + 6, { width: cols.total.w, align: 'right' });

      rowY += 20;
    }

    // Border around entire table
    doc.rect(col.left, tableTop, pageWidth, rowY - tableTop).stroke(DIVIDER);

    rowY += 12;

    // ── TOTALS ────────────────────────────────────────────────────────────────
    const totalsLabelX = col.right - 200;
    const totalsValueX = col.right - 90;
    const totalsW      = 85;

    const totalsRows = [
      ['Subtotal',    fmt(invoice.subtotal),    DARK,    false],
      [`VAT`,         fmt(invoice.vat_amount),  DARK,    false],
      ['TOTAL',       fmt(invoice.total),       DARK,    true ],
    ];

    for (const [label, value, color, bold] of totalsRows) {
      if (bold) {
        doc.rect(totalsLabelX - 8, rowY - 2, 195, 22).fill(PRIMARY);
        doc.fillColor('#ffffff').fontSize(11).font('Helvetica-Bold')
           .text(label, totalsLabelX, rowY + 3, { width: 90 })
           .text(value, totalsValueX, rowY + 3, { width: totalsW, align: 'right' });
        rowY += 24;
      } else {
        doc.fillColor(MEDIUM).fontSize(9).font('Helvetica')
           .text(label, totalsLabelX, rowY, { width: 90 })
           .fillColor(color).font(bold ? 'Helvetica-Bold' : 'Helvetica')
           .text(value, totalsValueX, rowY, { width: totalsW, align: 'right' });
        rowY += 18;
      }
    }

    rowY += 16;

    // ── NOTES & TERMS ─────────────────────────────────────────────────────────
    if (invoice.notes) {
      doc.fillColor(MEDIUM).fontSize(8).font('Helvetica-Bold').text('NOTES', col.left, rowY);
      rowY += 12;
      doc.fillColor(DARK).fontSize(9).font('Helvetica').text(invoice.notes, col.left, rowY, { width: pageWidth });
      rowY = doc.y + 12;
    }
    if (invoice.terms_conditions) {
      doc.fillColor(MEDIUM).fontSize(8).font('Helvetica-Bold').text('TERMS & CONDITIONS', col.left, rowY);
      rowY += 12;
      doc.fillColor(DARK).fontSize(9).font('Helvetica').text(invoice.terms_conditions, col.left, rowY, { width: pageWidth });
      rowY = doc.y + 12;
    }

    // ── BANKING DETAILS ───────────────────────────────────────────────────────
    if (user.bank_name || user.bank_account_number) {
      rowY += 4;
      doc.rect(col.left, rowY, pageWidth, 16).fill(LIGHT_BG);
      doc.fillColor(MEDIUM).fontSize(8).font('Helvetica-Bold')
         .text('BANKING DETAILS', col.left + 4, rowY + 4);
      rowY += 20;

      const bankFields = [
        user.bank_name            && `Bank: ${user.bank_name}`,
        user.bank_account_number  && `Account: ${user.bank_account_number}`,
        user.bank_branch_code     && `Branch Code: ${user.bank_branch_code}`,
        user.bank_account_type    && `Account Type: ${user.bank_account_type}`,
      ].filter(Boolean);

      doc.fillColor(DARK).fontSize(9).font('Helvetica')
         .text(bankFields.join('   ·   '), col.left, rowY, { width: pageWidth });
      rowY = doc.y + 16;
    }

    // ── FOOTER ────────────────────────────────────────────────────────────────
    const pageHeight = doc.page.height;
    doc.rect(0, pageHeight - 36, doc.page.width, 36).fill(DARK);
    doc.fillColor('#aaaacc').fontSize(8).font('Helvetica')
       .text(
         `Generated by FreeVoices  ·  ${user.company_name || ''}  ·  ${user.email || ''}`,
         0, pageHeight - 23,
         { width: doc.page.width, align: 'center' }
       );

    doc.end();
  });
}

module.exports = { buildInvoicePdf };
