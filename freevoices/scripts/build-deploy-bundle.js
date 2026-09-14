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

// The runtime dependency list is DERIVED from the staged files further down,
// never hand-maintained. A hardcoded list silently went stale twice — once
// missing retention.service.js, once missing google-auth-library — and each time
// the result was a server that died at require time before any logger existed,
// returning 500 for every route with nothing written to error.log.

// [source, destination] — destination defaults to the same relative path.
const INCLUDE = [
  'server.js',
  // The whole directory, not a hand-maintained list of four files. Enumerating
  // them meant that adding retention.service.js — required by server.js at line
  // 11 — silently produced a bundle that threw MODULE_NOT_FOUND before winston
  // was even constructed, taking the site down with no log line to explain it.
  'src/services',
  'scripts/migrate.js',
  'scripts/seed-legal.js',
  'scripts/backup-db.js',
  'scripts/doctor.js',
  'scripts/payfast-check.js',
  'legal',
  'www',
  '.env.example',
];

function copyRecursive(src, dest) {
  // src/services/ holds Node services next to an Angular .ts service. The .ts
  // is compiled into www/ already, and the server never requires it.
  if (src.endsWith('.ts')) return;
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

/** Every .js file in the staged bundle (www/ is browser output, not Node). */
function walkJs(dir, found = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'www' && entry.name !== 'node_modules') walkJs(p, found);
    } else if (entry.name.endsWith('.js')) {
      found.push(p);
    }
  }
  return found;
}

const STAGED_JS = walkJs(STAGE);
const BUILTINS = new Set(require('module').builtinModules);

/**
 * Derive the runtime dependencies by reading the code that will actually ship.
 *
 * Never hardcode this. Node resolves a missing module by walking UP the
 * directory tree, so on a dev machine `require('google-auth-library')` quietly
 * finds freevoices/node_modules and everything looks fine — while the server,
 * whose node_modules contains only what this package.json lists, dies at
 * require time with MODULE_NOT_FOUND before winston is constructed. No log
 * line, 500 on every route, including static files.
 */
const usedPackages = new Set();
for (const file of STAGED_JS) {
  const contents = fs.readFileSync(file, 'utf8');
  for (const m of contents.matchAll(/require\(\s*['"]([^.'"][^'"]*)['"]\s*\)/g)) {
    const spec = m[1];
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (!BUILTINS.has(name)) usedPackages.add(name);
  }
}

const RUNTIME_DEPS = [...usedPackages].sort();
const undeclared = RUNTIME_DEPS.filter((d) => !appPkg.dependencies[d]);
if (undeclared.length) {
  console.error(`\nThe shipped code requires modules that are not in package.json dependencies:`);
  for (const d of undeclared) console.error(`  ${d}`);
  console.error('\nRun `npm install <name> --save` for each, then rebuild. Shipping this');
  console.error('would install a node_modules without them and crash the server on boot.\n');
  process.exit(1);
}
console.log(`  derived ${RUNTIME_DEPS.length} runtime dependencies from the staged code`);

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
    'check:payfast': 'node scripts/payfast-check.js',
  },
  dependencies: Object.fromEntries(
    RUNTIME_DEPS.sort().map((d) => [d, appPkg.dependencies[d]])
  ),
};

fs.writeFileSync(path.join(STAGE, 'package.json'), JSON.stringify(serverPkg, null, 2) + '\n', 'utf8');
console.log('  write   package.json (trimmed to the derived runtime deps)');

/**
 * Resolve every RELATIVE require inside the staged bundle (the npm ones were
 * validated above). A missing local file is a build failure, not an outage.
 */
const unresolved = [];
for (const file of STAGED_JS) {
  const contents = fs.readFileSync(file, 'utf8');
  for (const m of contents.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const spec = m[1];
    const base = path.resolve(path.dirname(file), spec);
    const candidates = [base, base + '.js', base + '.json', path.join(base, 'index.js')];
    if (!candidates.some((c) => fs.existsSync(c) && fs.statSync(c).isFile())) {
      unresolved.push(path.relative(STAGE, file).split(path.sep).join('/') + ' -> ' + spec);
    }
  }
}

if (unresolved.length) {
  console.error('\nBundle is incomplete — ' + unresolved.length + ' relative require(s) do not resolve inside it:\n');
  for (const u of unresolved) console.error('  ' + u);
  console.error('\nAdd the missing path to INCLUDE. Shipping this would take the site down');
  console.error('with MODULE_NOT_FOUND at require time, before any logger exists.\n');
  process.exit(1);
}
console.log('  verified: every relative require resolves inside the bundle');

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
