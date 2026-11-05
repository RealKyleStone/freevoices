#!/usr/bin/env node
// Run all backend checks against an explicitly supplied, empty local test DB.
// Database settings must come from the environment, never a .env fallback.
// This runner never creates databases, drops tables or reuses data.
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const mysql = require('mysql2/promise');

const ROOT = path.resolve(__dirname, '..');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

function validateDatabase(env) {
  if (!['localhost', '127.0.0.1', '::1'].includes(env.DB_HOST)) throw new Error('DB_HOST must explicitly name a local database');
  if (!/^freevoices_test(?:_[a-z0-9_]+)?$/.test(env.DB_NAME || '')) throw new Error('DB_NAME must be freevoices_test or freevoices_test_<suffix>');
  if (!env.DB_USER || env.DB_PASSWORD === undefined) throw new Error('Supply DB_USER and DB_PASSWORD explicitly (an empty password is allowed locally)');
  if (env.NODE_ENV === 'production') throw new Error('Integration checks cannot run in production');
}

async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

function runTests(env) {
  const files = fs.readdirSync(path.join(ROOT, 'test')).filter(file => file.endsWith('.test.js')).sort().map(file => path.join(ROOT, 'test', file));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--test', '--test-reporter=tap', ...files], { cwd: ROOT, env, windowsHide: true });
    let output = '';
    child.stdout.on('data', data => { output += data; process.stdout.write(data); });
    child.stderr.on('data', data => process.stderr.write(data));
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0) return reject(new Error(`Backend checks failed (exit ${code})`));
      const summaries = [...output.matchAll(/^# skipped (\d+)\s*$/gm)];
      if (!summaries.length || summaries.some(match => Number(match[1]) !== 0)) return reject(new Error('Integration checks must report zero skipped tests'));
      resolve();
    });
  });
}

function verifyEncryptedSchema(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['scripts/encrypt-backfill.js', '--verify'],
      { cwd: ROOT, env, windowsHide: true });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { output += data; });
    child.once('error', reject);
    child.once('exit', code => {
      if (code !== 0 || !output.includes('All registered columns are fully encrypted.'))
        return reject(new Error(`Encryption preflight failed on fresh schema: ${output.slice(-2000)}`));
      console.log('Fresh-schema encryption preflight passed.');
      resolve();
    });
  });
}

async function main() {
  validateDatabase(process.env);
  const port = await unusedPort();
  const env = { ...process.env, NODE_ENV: 'test', INVOICE_ADJUSTMENTS_ENABLED:'true', DB_SSL: 'disabled',
    BOOKKEEPER_INVITE_DELIVERY: 'preview',
    DATA_ENCRYPTION_KEYS: `ci:${randomBytes(32).toString('base64')}`, DATA_ENCRYPTION_KEY_ACTIVE: 'ci',
    PORT: String(port), APP_URL: `http://127.0.0.1:${port}`, FREEVOICES_TEST_API_URL: `http://127.0.0.1:${port}/api`,
    SMTP_HOST: '127.0.0.1', SMTP_PORT: '1', SMTP_SECURE: 'false', SMTP_USER: 'test@example.test', SMTP_PASS: 'test-only',
    SMTP_FROM: 'test@example.test', SMTP_FROM_ADDRESS: 'test@example.test', SMTP_DEBUG: 'false',
    RATE_LIMIT_DISABLED: 'false', TRUST_PROXY_HOPS: '0', PAYFAST_MODE: 'sandbox', GOOGLE_OAUTH_CLIENT_ID: '',
  };
  const connection = await mysql.createConnection({ host: env.DB_HOST, user: env.DB_USER, password: env.DB_PASSWORD, database: env.DB_NAME, multipleStatements: true });
  try {
    const [tables] = await connection.query('SHOW FULL TABLES');
    if (tables.length) throw new Error('Test database must be empty; existing tables will not be replaced');
    await connection.query(fs.readFileSync(path.join(ROOT, 'database/schema.sql'), 'utf8'));
    await connection.query("INSERT INTO currencies(id,code,name,symbol) VALUES(1,'ZAR','South African Rand','R'),(2,'USD','US Dollar','$')");
  } finally { await connection.end(); }

  const server = spawn(process.execPath, ['server.js'], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let bootOutput = '';
  server.stdout.on('data', data => { bootOutput = (bootOutput + data).slice(-16000); });
  server.stderr.on('data', data => { bootOutput = (bootOutput + data).slice(-16000); });
  let spawnError;
  server.once('error', error => { spawnError = error; });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 120; attempt++) {
      if (spawnError) throw spawnError;
      if (server.exitCode !== null) throw new Error(`Test API stopped during startup (exit ${server.exitCode})`);
      try {
        const response = await fetch(`${env.FREEVOICES_TEST_API_URL}/banks`, { signal: AbortSignal.timeout(1000) });
        if (response.ok) { ready = true; break; }
      } catch { /* The API only starts listening after migrations and the encryption canary. */ }
      await pause(250);
    }
    if (!ready) throw new Error('Test API did not become ready');
    await verifyEncryptedSchema(env);
    console.log(`Fresh schema migrated; running backend checks against ${env.DB_NAME}.`);
    await runTests(env);
  } catch (error) {
    process.stderr.write(bootOutput);
    throw error;
  } finally {
    if (server.exitCode === null && !spawnError) {
      const stopped = new Promise(resolve => server.once('exit', resolve));
      server.kill('SIGTERM');
      const timer = setTimeout(() => server.kill('SIGKILL'), 5000);
      await stopped;
      clearTimeout(timer);
    }
  }
}

if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { validateDatabase };
