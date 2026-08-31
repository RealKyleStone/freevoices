#!/usr/bin/env node
/**
 * Assemble exactly what the server needs, and nothing else.
 *
 *   npm run build            # produce www/ first
 *   node scripts/build-deploy-bundle.js
 *
 * Produces deploy/freevoices-server.tar.gz plus an unpacked deploy/bundle/.
 *
 * Why this exists rather than uploading the repo:
 *
 *  - package.json carries the entire Angular toolchain. cPanel's "Run NPM
 *    Install" runs a plain `npm install`, which would pull ~500 MB of build
 *    tooling the server never executes, and can trip a disk quota. The bundle
 *    ships a trimmed package.json with only the 15 modules the server actually
 *    requires, with versions copied from the real one so they cannot drift.
 *  - src/app, src/assets and src/environments are Angular *source*. They are
 *    already compiled into www/; shipping them again just publishes your source.
 *  - .env is deliberately NOT included. Put secrets in the cPanel Node.js
 *    "Environment variables" panel, or upload .env by hand once.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'deploy');
const STAGE = path.join(OUT, 'bundle');

// Modules server.js and src/services/* actually require. Keep in sync with
// `node scripts/build-deploy-bundle.js --audit`.
const RUNTIME_DEPS = [
  'argon2', 'axios', 'body-parser', 'cors', 'dotenv', 'express',
  'express-rate-limit', 'express-validator', 'helmet', 'multer', 'mysql2',
  'node-cron', 'nodemailer', 'pdfkit', 'winston',
];

// [source, destination] — destination defaults to the same relative path.
const INCLUDE = [
  'server.js',
  'src/services/db.service.js',
  'src/services/migrations.service.js',
  'src/services/email.service.js',
  'src/services/pdf.service.js',
  'scripts/migrate.js',
  'scripts/seed-legal.js',
  'scripts/backup-db.js',
  'scripts/doctor.js',
  'legal',
  'www',
  '.env.example',
];

function copyRecursive(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) {
      copyRecursive(path.join(src, entry), path.join(dest, entry));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function dirSize(dir) {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    total += entry.isDirectory() ? dirSize(p) : fs.statSync(p).size;
  }
  return total;
}

const appPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Fail loudly rather than shipping a bundle that cannot install.
const undeclared = RUNTIME_DEPS.filter((d) => !appPkg.dependencies[d]);
if (undeclared.length) {
  console.error(`\nThese runtime modules are not in package.json dependencies: ${undeclared.join(', ')}`);
  console.error('Run `npm install <name> --save` for each, then retry.\n');
  process.exit(1);
}

if (!fs.existsSync(path.join(ROOT, 'www', 'index.html'))) {
  console.error('\nwww/index.html is missing. Run `npm run build` before building the bundle.\n');
  process.exit(1);
}

fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

console.log('\nStaging:');
for (const rel of INCLUDE) {
  const src = path.join(ROOT, rel);
  if (!fs.existsSync(src)) {
    console.log(`  skip    ${rel} (not present)`);
    continue;
  }
  copyRecursive(src, path.join(STAGE, rel));
  console.log(`  include ${rel}`);
}

const serverPkg = {
  name: 'freevoices-server',
  version: appPkg.version,
  private: true,
  description: 'FreeVoices API and static host',
  main: 'server.js',
  // helmet@8 requires >=18, and 16.x is end-of-life. cPanel defaults its
  // Node.js selector to an old version, so state the floor explicitly.
  engines: { node: '>=18.0.0' },
  scripts: {
    start: 'node server.js',
    doctor: 'node scripts/doctor.js',
    migrate: 'node scripts/migrate.js',
    'migrate:status': 'node scripts/migrate.js --status',
    'migrate:dry-run': 'node scripts/migrate.js --dry-run',
    'seed:legal': 'node scripts/seed-legal.js',
    'seed:legal:check': 'node scripts/seed-legal.js --check',
    backup: 'node scripts/backup-db.js',
  },
  dependencies: Object.fromEntries(
    RUNTIME_DEPS.sort().map((d) => [d, appPkg.dependencies[d]])
  ),
};

fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify(serverPkg, null, 2) + '\n', 'utf8');
console.log('  write   package.json (trimmed to 15 runtime deps)');

// Passenger needs this to exist to trigger a restart via `touch tmp/restart.txt`.
fs.mkdirSync(path.join(STAGE, 'tmp'), { recursive: true });
fs.writeFileSync(path.join(STAGE, 'tmp', 'restart.txt'), '', 'utf8');
console.log('  write   tmp/restart.txt (Passenger restart trigger)');

/**
 * Always tar.gz, never PowerShell's Compress-Archive.
 *
 * Compress-Archive writes ZIP entry names using the platform separator, i.e.
 * backslashes on Windows. That violates the ZIP spec (4.4.17: paths use '/'),
 * and Linux extractors therefore treat "www\index.html" as a single filename
 * rather than a path — silently flattening the whole tree into the target
 * directory. The app then starts and 404s on everything, which is a miserable
 * thing to debug. bsdtar ships in System32 on Windows 10+, so prefer it and
 * fail loudly rather than falling back to something broken.
 */
const TAR_CANDIDATES = [
  'tar',
  process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'tar.exe') : null,
].filter(Boolean);

let archive = path.join(OUT, 'freevoices-server.tar.gz');
fs.rmSync(archive, { force: true });

let tarUsed = null;
for (const tarBin of TAR_CANDIDATES) {
  try {
    execFileSync(tarBin, ['-czf', archive, '-C', STAGE, '.'], { stdio: 'pipe' });
    tarUsed = tarBin;
    break;
  } catch {
    /* try the next candidate */
  }
}

if (!tarUsed) {
  archive = null;
  console.log('\n  WARNING: no working tar found. Upload the deploy/bundle/ directory');
  console.log('  contents directly. Do NOT zip it with PowerShell Compress-Archive —');
  console.log('  it writes backslash paths that flatten when extracted on Linux.');
} else {
  // Verify rather than trust: a single backslash in an entry name means the
  // archive would flatten on extraction.
  const listing = execFileSync(tarUsed, ['-tzf', archive], { encoding: 'utf8' });
  const bad = listing.split('\n').filter((l) => l.includes('\\'));
  if (bad.length) {
    console.error(`\nArchive contains ${bad.length} backslash path(s), e.g. ${bad[0]} — refusing to ship it.\n`);
    process.exit(1);
  }
  console.log(`\n  archive verified: ${listing.split('\n').filter(Boolean).length} entries, all forward-slash paths`);
}

console.log(`\nBundle: ${STAGE}`);
console.log(`  unpacked size: ${(dirSize(STAGE) / 1024 / 1024).toFixed(1)} MB`);
if (archive) {
  console.log(`  archive:       ${archive} (${(fs.statSync(archive).size / 1024 / 1024).toFixed(1)} MB)`);
}
console.log(`\nExcluded on purpose: node_modules, .env, android/, src/app, src/assets,`);
console.log(`src/environments, database/, *.md, .angular/\n`);
