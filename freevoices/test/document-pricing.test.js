const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const { computeLine, computeDocumentTotals } = require('../src/services/document-math');

// Run the actual client helper too: a matching preview is part of the pricing
// contract, and a server-only arithmetic test would miss client drift.
const frontend = {};
const source = fs.readFileSync(require.resolve('../src/app/shared/utils/document-math.ts'), 'utf8');
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
  { exports: frontend });

const cases = [
  ['inclusive sticker price', { quantity: 1, unit_price: 115, vat_rate: 15, vat_inclusive: true }, [100, 15, 115]],
  ['inclusive quantity', { quantity: 2, unit_price: 115, vat_rate: 15, vat_inclusive: true }, [200, 30, 230]],
  ['fractional inclusive quantity', { quantity: 1.5, unit_price: 99.99, vat_rate: 15, vat_inclusive: true }, [130.43, 19.56, 149.99]],
  ['zero VAT', { quantity: 1, unit_price: 115, vat_rate: 0, vat_inclusive: true }, [115, 0, 115]],
  ['small inclusive amounts round per line', { quantity: 3, unit_price: 0.01, vat_rate: 15, vat_inclusive: true }, [0.03, 0, 0.03]],
  ['exclusive price', { quantity: 1, unit_price: 100, vat_rate: 15, vat_inclusive: false }, [100, 15, 115]],
  ['legacy omitted mode', { quantity: 1, unit_price: 100, vat_rate: 15 }, [100, 15, 115]],
  ['numeric DB flag', { quantity: 1, unit_price: 115, vat_rate: 15, vat_inclusive: 1 }, [100, 15, 115]],
  ['false string is not truthy inclusive', { quantity: 1, unit_price: 100, vat_rate: 15, vat_inclusive: 'false' }, [100, 15, 115]],
];
for (const [name, item, expected] of cases) {
  test(`pricing: ${name} reconciles in API and client preview`, () => {
    const server = computeLine(item);
    const client = frontend.lineTotals(item);
    assert.deepEqual([server.subtotal, server.vat_amount, server.total], expected);
    assert.deepEqual([client.subtotal, client.vat, client.total], expected);
  });
}
test('mixed exclusive and inclusive lines reconcile to the document total', () => {
  const result = computeDocumentTotals([cases[0][1], cases[5][1]]);
  assert.deepEqual([result.subtotal, result.vat_amount, result.total], [200, 30, 230]);
});
