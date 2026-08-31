/**
 * Single owner of the MySQL pool and the Winston logger.
 *
 * Extracted from server.js so that CLI tooling (the migration runner, the
 * retention job, the encryption backfill) can share one code path without
 * requiring server.js, which would start an HTTP listener as a side effect.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2');
const winston = require('winston');

// Log files live at the app root regardless of the caller's cwd, so a script
// run from freevoices/scripts/ writes to the same files as the server.
const APP_ROOT = path.join(__dirname, '..', '..');

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    // Rotation is a retention control, not just housekeeping: these files have
    // held user email addresses and SMTP traffic. Cap total on-disk history.
    new winston.transports.File({ filename: path.join(APP_ROOT, 'error.log'), level: 'error', maxsize: 5 * 1024 * 1024, maxFiles: 5, tailable: true }),
    new winston.transports.File({ filename: path.join(APP_ROOT, 'combined.log'), maxsize: 5 * 1024 * 1024, maxFiles: 5, tailable: true }),
    new winston.transports.Console({ format: winston.format.simple() }),
  ],
});

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1'];

/**
 * Transport encryption for the MySQL connection.
 *
 *   DB_SSL = disabled | required | verify
 *     disabled  no TLS. Only defensible when the database is on this machine.
 *     required  encrypt, but do not authenticate the server. Stops passive
 *               sniffing; does NOT stop an active man-in-the-middle.
 *     verify    encrypt and authenticate. Needs DB_SSL_CA unless the server
 *               presents a certificate signed by a public CA.
 *   DB_SSL_CA             path to a PEM to trust (enables verification)
 *   DB_SSL_SKIP_HOSTNAME  trust the pinned CA but skip the hostname check
 *
 * Default is `disabled` for a local host and `required` for anything remote.
 *
 * Note for this deployment: the server presents MariaDB's auto-generated
 * self-signed certificate (CN="MariaDB Server", no subjectAltNames), so
 * hostname verification can never succeed for any host string. Genuine
 * verification therefore needs either a real certificate on the server, or
 * DB_SSL_CA pinning that certificate plus DB_SSL_SKIP_HOSTNAME=true. The best
 * answer is to run the API on the database host so the traffic never leaves it.
 */
function buildSslConfig() {
  const host = process.env.DB_HOST || '';
  const isLocal = LOCAL_HOSTS.includes(host);
  const mode = (process.env.DB_SSL || (isLocal ? 'disabled' : 'required')).toLowerCase();

  if (mode === 'disabled') {
    if (!isLocal) {
      logger.error(
        'DB_SSL=disabled with a remote DB_HOST — credentials and personal data cross the network in cleartext. ' +
        'Set DB_SSL=required (or better, run the API on the database host).',
        { host }
      );
    }
    return undefined;
  }

  const ssl = { minVersion: 'TLSv1.2' };

  if (process.env.DB_SSL_CA) {
    ssl.ca = fs.readFileSync(path.resolve(process.env.DB_SSL_CA), 'utf8');
    ssl.rejectUnauthorized = true;
    if (process.env.DB_SSL_SKIP_HOSTNAME === 'true') {
      // The pinned CA is the authentication; the hostname cannot be checked
      // because the certificate carries no usable identity.
      ssl.checkServerIdentity = () => undefined;
    }
    logger.info('Database TLS: verifying against pinned CA', {
      ca: process.env.DB_SSL_CA,
      hostnameChecked: process.env.DB_SSL_SKIP_HOSTNAME !== 'true',
    });
  } else if (mode === 'verify') {
    ssl.rejectUnauthorized = true;
    logger.info('Database TLS: verifying against system roots');
  } else {
    ssl.rejectUnauthorized = false;
    logger.warn(
      'Database TLS: encrypted but UNAUTHENTICATED (DB_SSL=required, no DB_SSL_CA) — ' +
      'protects against passive interception only, not an active man-in-the-middle.'
    );
  }

  return ssl;
}

const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT, 10),
  queueLimit: parseInt(process.env.DB_QUEUE_LIMIT, 10),
  enableKeepAlive: process.env.DB_ENABLE_KEEP_ALIVE === 'true',
  keepAliveInitialDelay: parseInt(process.env.DB_KEEP_ALIVE_INITIAL_DELAY, 10),
  ssl: buildSslConfig(),
};

// Never log dbConfig wholesale — it carries DB_PASSWORD.
logger.info('Database configured', {
  host: dbConfig.host,
  database: dbConfig.database,
  connectionLimit: dbConfig.connectionLimit,
});

let pool;

function handleDisconnect() {
  pool = mysql.createPool(dbConfig);
  pool.on('connection', (connection) => {
    logger.info('New connection established');
    connection.on('error', (err) => {
      logger.error('Database connection error', err);
      if (err.code === 'PROTOCOL_CONNECTION_LOST') handleDisconnect();
    });
  });
  pool.on('error', (err) => {
    logger.error('Pool error', err);
    if (err.code === 'PROTOCOL_CONNECTION_LOST') handleDisconnect();
  });
}

handleDisconnect();

/** Run a query on a pooled connection, releasing it afterwards. */
function executeQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    pool.getConnection((err, connection) => {
      if (err) { logger.error('Error getting connection from pool:', err); reject(err); return; }
      connection.query(sql, params, (error, results) => {
        connection.release();
        if (error) { logger.error('Query error:', error); reject(error); } else { resolve(results); }
      });
    });
  });
}

/**
 * Check out a connection for work that must stay on one connection —
 * transactions, and anything using GET_LOCK (which is connection-scoped).
 * The caller owns releasing it.
 */
function getConnection() {
  return new Promise((resolve, reject) => {
    pool.getConnection((err, connection) => (err ? reject(err) : resolve(connection)));
  });
}

/** Promisified query against a specific connection. */
function queryOn(connection, sql, params = []) {
  return new Promise((resolve, reject) => {
    connection.query(sql, params, (error, results) => (error ? reject(error) : resolve(results)));
  });
}

/**
 * Run `fn` inside a transaction, committing on success and rolling back on
 * throw. `fn` receives a `q(sql, params)` bound to the transaction's
 * connection. Replaces seven hand-rolled copies of this dance in server.js.
 */
async function withTransaction(fn) {
  const conn = await getConnection();
  try {
    await new Promise((resolve, reject) => conn.beginTransaction(err => (err ? reject(err) : resolve())));
  } catch (err) {
    conn.release();
    throw err;
  }
  try {
    const result = await fn((sql, params) => queryOn(conn, sql, params), conn);
    await new Promise((resolve, reject) => conn.commit(err => (err ? reject(err) : resolve())));
    conn.release();
    return result;
  } catch (err) {
    await new Promise(resolve => conn.rollback(resolve));
    conn.release();
    throw err;
  }
}

function closePool() {
  return new Promise((resolve) => {
    pool.end((err) => {
      if (err) logger.error('Error closing pool during shutdown', err);
      else logger.info('Pool has ended');
      resolve();
    });
  });
}

module.exports = { logger, dbConfig, executeQuery, getConnection, queryOn, withTransaction, closePool };
