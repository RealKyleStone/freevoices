const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { actualImageType } = require('../src/services/image-upload.service');

test('logo content type is detected from file bytes', () => {
  const file = path.join(os.tmpdir(), `freevoices-logo-check-${process.pid}`);
  try {
    fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
    assert.equal(actualImageType(file), 'image/png');
    fs.writeFileSync(file, Buffer.from('ffd8ffe00000000000000000', 'hex'));
    assert.equal(actualImageType(file), 'image/jpeg');
    fs.writeFileSync(file, '<script>alert(1)</script>');
    assert.equal(actualImageType(file), null);
  } finally { if (fs.existsSync(file)) fs.unlinkSync(file); }
});
