const DARK = '#1a1a2e';
const MEDIUM = '#6b7280';
const DIVIDER = '#e5e7eb';

/** Shared pagination for all three document types. Coordinates are kept within
 * the content area; PDFKit must never independently overflow one table cell.
 */
function createPdfLayout(doc, user, label, number) {
  const left = 50;
  const width = doc.page.width - 100;
  const bottom = () => doc.page.height - 70;

  function nextPage() {
    doc.addPage();
    doc.font('Helvetica-Bold').fontSize(9).fillColor(DARK)
      .text(`${label} ${number} - continued`, left, 40, { width, lineBreak: false });
    doc.moveTo(left, 58).lineTo(left + width, 58).strokeColor(DIVIDER).stroke();
    return 72;
  }

  function ensureSpace(y, height) {
    return y + height <= bottom() ? y : nextPage();
  }

  // Split only content taller than a page. Ordinary rows move intact. Prefer a
  // word boundary, but also support long unbroken references without truncation.
  function fittingPrefix(text, boxWidth, height) {
    if (doc.heightOfString(text, { width: boxWidth }) <= height) return text.length;
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (doc.heightOfString(text.slice(0, mid), { width: boxWidth }) <= height) lo = mid;
      else hi = mid - 1;
    }
    const boundary = text.slice(0, lo).search(/\s+\S*$/);
    return boundary > 0 ? boundary : lo;
  }

  function text(value, y, options = {}) {
    const { x = left, width: boxWidth = width, font = 'Helvetica', size = 9,
      color = DARK, ...textOptions } = options;
    let remaining = String(value ?? '');
    do {
      doc.font(font).fontSize(size);
      y = ensureSpace(y, doc.currentLineHeight(true) + 2);
      doc.font(font).fontSize(size).fillColor(color);
      const count = fittingPrefix(remaining, boxWidth, bottom() - y - 2);
      if (!count && remaining.length) throw new Error('PDF text cannot fit in content area');
      const part = remaining.slice(0, count);
      const height = doc.heightOfString(part, { width: boxWidth });
      doc.text(part, x, y, { width: boxWidth, ...textOptions });
      y += height;
      remaining = remaining.slice(count).trimStart();
      if (remaining) y = nextPage();
    } while (remaining);
    return y;
  }

  function section(title, value, y) {
    y = ensureSpace(y, 38);
    doc.fillColor(MEDIUM).font('Helvetica-Bold').fontSize(8)
      .text(title, left, y, { width, lineBreak: false });
    return text(value, y + 14) + 12;
  }

  function table(items, y, fmt) {
    const columns = [
      { title: 'DESCRIPTION', x: left, w: 200 },
      { title: 'QTY', x: left + 200, w: 50 },
      { title: 'UNIT PRICE', x: left + 250, w: 85 },
      { title: 'VAT %', x: left + 335, w: 55 },
      { title: 'TOTAL', x: left + 390, w: width - 390 },
    ];
    function header(top) {
      doc.rect(left, top, width, 22).fill(DARK);
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#ffffff');
      for (const [i, col] of columns.entries()) {
        doc.text(col.title, col.x + 4, top + 7,
          { width: col.w - 8, align: i ? 'right' : 'left', lineBreak: false });
      }
      return top + 22;
    }
    y = header(ensureSpace(y, 56));
    for (const [index, item] of items.entries()) {
      let description = String(item.description ?? '');
      const values = [String(Number(item.quantity)), fmt(item.unit_price), `${Number(item.vat_rate)}%`, fmt(item.total)];
      let firstPart = true;
      do {
        doc.font('Helvetica').fontSize(9);
        const fullHeight = Math.max(34, doc.heightOfString(description, { width: 192 }) + 12);
        if (y + fullHeight > bottom() && y > 94) y = header(nextPage());
        doc.font('Helvetica').fontSize(9);
        const count = fittingPrefix(description, 192, bottom() - y - 14);
        if (!count && description.length) throw new Error('PDF row cannot fit in content area');
        const part = description.slice(0, count);
        const height = Math.max(34, doc.heightOfString(part, { width: 192 }) + 12);
        doc.rect(left, y, width, height).fill(index % 2 ? '#f3f4f6' : '#ffffff');
        doc.fillColor(DARK).font('Helvetica').fontSize(9)
          .text(part, left + 4, y + 6, { width: 192 });
        if (firstPart) {
          for (const [i, value] of values.entries()) {
            const col = columns[i + 1];
            doc.font('Courier').fontSize(9);
            const size = Math.min(9, 9 * (col.w - 8) / Math.max(1, doc.widthOfString(value)));
            doc.fontSize(size).text(value, col.x + 4, y + 6,
              { width: col.w - 8, align: 'right', lineBreak: false });
            if (i === 1) {
              doc.font('Helvetica').fontSize(7).fillColor(MEDIUM)
                .text(item.vat_inclusive ? 'incl. VAT' : 'excl. VAT', col.x + 4, y + 19,
                  { width: col.w - 8, align: 'right', lineBreak: false });
              doc.fillColor(DARK);
            }
          }
        }
        y += height;
        doc.moveTo(left, y).lineTo(left + width, y).strokeColor(DIVIDER).stroke();
        description = description.slice(count).trimStart();
        firstPart = false;
        if (description) y = header(nextPage());
      } while (description);
    }
    return y + 12;
  }

  function finish() {
    const range = doc.bufferedPageRange();
    for (let index = range.start; index < range.start + range.count; index++) {
      doc.switchToPage(index);
      const pageHeight = doc.page.height;
      // Footer is inside the margin. Disable wrapping so drawing it cannot
      // accidentally create another page; restore the page margin afterwards.
      const margin = doc.page.margins.bottom;
      doc.page.margins.bottom = 0;
      doc.rect(0, pageHeight - 36, doc.page.width, 36).fill(DARK);
      doc.fillColor('#aaaacc').font('Helvetica').fontSize(7);
      doc.text(`Generated by FreeVoices | ${user.company_name || ''} | ${user.email || ''}`,
        left, pageHeight - 23, { width: width - 65, height: 12, ellipsis: true });
      doc.text(`${index + 1} / ${range.count}`, left + width - 60, pageHeight - 23,
        { width: 60, align: 'right', lineBreak: false });
      doc.page.margins.bottom = margin;
    }
  }

  return { nextPage, ensureSpace, text, section, table, finish };
}

module.exports = { createPdfLayout };
