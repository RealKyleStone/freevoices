const fs = require('fs');

function actualImageType(filePath) {
  const fd = fs.openSync(filePath, 'r');
  const head = Buffer.alloc(12);
  try { fs.readSync(fd, head, 0, head.length, 0); }
  finally { fs.closeSync(fd); }
  if (head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  return null;
}

module.exports = { actualImageType };
