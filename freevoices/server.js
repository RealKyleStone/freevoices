require('dotenv').config();
const axios = require('axios');
const cron = require('node-cron');

const EmailService = require('./src/services/email.service');
const { buildInvoicePdf, buildQuotePdf, buildReceiptPdf, buildCreditNotePdf, buildPaymentReceiptPdf } = require('./src/services/pdf.service');
// The pool, the logger and the query helpers live in db.service so that CLI
// tooling can share them without booting an HTTP listener.
const { logger, executeQuery, getConnection, queryOn, withTransaction, closePool } = require('./src/services/db.service');
const { reportCurrency, report } = require('./src/services/reporting.service');
const { shareDocument } = require('./src/services/document-share.service');
const { actualImageType } = require('./src/services/image-upload.service');
const { TEMPLATES, previewCatalogueCsv } = require('./src/services/catalogue-import.service');
const { HEADER: BANK_HEADER, previewBankCsv } = require('./src/services/bank-import.service');
const { createDocument } = require('./src/services/document-create.service');
const { money: adjustmentMoney, validDate: validAdjustmentDate, settlement: adjustmentSettlement, invoiceSettlement } = require('./src/services/invoice-adjustments.service');
const { advanceDate, prepareDocument } = require('./src/services/billing-rules');
const { captureDocumentSnapshot, hydrateDocumentSnapshots, documentSeller } = require('./src/services/document-snapshot.service');
const { getNextDocumentNumber, lockDocumentOwner } = require('./src/services/document-number.service');
const { runMigrations, tableExists } = require('./src/services/migrations.service');
const { anonymiseExpiredAccounts } = require('./src/services/retention.service');
const {
  computeDocumentTotals, todayIso, normaliseTerms, resolveDueDate, formatDisplayDate,
  SETTLED_TOLERANCE,
} = require('./src/services/document-math');
const {
  decryptUserRow, encryptField, decryptField, isEncryptionConfigured, verifyCanary,
  decryptCustomerRow, decryptPaymentRow, decryptTrackingRow,
  decryptCustomerJoin, decryptAliasedRow, hashToken,
} = require('./src/services/encrypted-fields');
const {
  buildPaymentForm, isPayfastEligible, payfastUrls, PAYFAST_MIN_AMOUNT, PAYFAST_CURRENCY,
  isPayfastIp, verifyItnSignature, itnParamStringFromRaw, validateItnWithPayfast,
} = require('./src/services/payfast.service');
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bodyParser = require('body-parser');
const argon2 = require('argon2');
const { OAuth2Client } = require('google-auth-library');
const { randomUUID, timingSafeEqual } = require('crypto');
const multer = require('multer');
const { body, validationResult } = require('express-validator');

// Multer setup for company logo uploads (5 MB limit, jpg/png only)
const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'logos');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // Unguessable name: /uploads is a public static mount, and the previous
    // `logo_<userId>_<timestamp>` scheme made every logo enumerable.
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `logo_${randomUUID().replace(/-/g, '')}${ext}`);
  }
});
const logoUpload = multer({
  storage: logoStorage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    // pdfkit can only embed PNG and JPEG. A GIF or WebP logo uploaded fine,
    // showed in settings, then was silently missing from every PDF.
    if (!['image/jpeg', 'image/png'].includes(file.mimetype)) {
      return cb(new Error('Logo must be a PNG or JPEG image'));
    }
    cb(null, true);
  }
});

const app = express();
const adjustmentsEnabled = () => process.env.INVOICE_ADJUSTMENTS_ENABLED === 'true'
  && ['development','test'].includes(process.env.NODE_ENV);

async function withInvoiceFinancials(q, invoice) {
  if (!invoice?.id) return invoice;
  const state=await invoiceSettlement(q,invoice.id);
  return { ...invoice,amount_paid:state.netPaid.toFixed(2),credit_total:state.creditTotal.toFixed(2),refund_total:state.refundTotal.toFixed(2),
    adjusted_total:state.adjustedTotal.toFixed(2),balance_due:state.balanceDue.toFixed(2),refund_due:state.refundDue.toFixed(2) };
}

// Angular builds to `www` (angular.json outputPath, and capacitor.config.ts webDir).
const WEB_ROOT = path.join(__dirname, 'www');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// ─── Middleware ───────────────────────────────────────────────────────────────

// Required for req.ip to be the real client behind nginx/Cloudflare. Without it
// every IP recorded in document_tracking, consent records and security logs is
// the proxy's — an audit trail made of a constant.
app.set('trust proxy', parseInt(process.env.TRUST_PROXY_HOPS, 10) || 1);

// Angular emits no inline scripts or styles in index.html, so script-src can
// stay strict. style-src needs 'unsafe-inline' because Ionic injects component
// styles at runtime. If this ever breaks the app, CSP_REPORT_ONLY=true turns it
// into reporting without a redeploy — but do not leave it there.
const cspDirectives = {
  defaultSrc: ["'self'"],
  // accounts.google.com serves the Google Identity Services client used by the
  // "Continue with Google" button on the web build. pagead2.googlesyndication.com
  // serves the AdSense loader script in index.html.
  scriptSrc: ["'self'", 'https://www.google.com', 'https://www.gstatic.com', 'https://accounts.google.com', 'https://pagead2.googlesyndication.com'],
  // No font CDN entries: Poppins is self-hosted from src/assets/fonts, so the
  // only external origin the app touches is Google — reCAPTCHA (currently off)
  // and Google Sign-In. That is what the privacy policy discloses; keep the two
  // in step whenever this list changes.
  styleSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com'],
  imgSrc: ["'self'", 'data:', 'blob:'],
  fontSrc: ["'self'", 'data:'],
  // blob: covers the PDF/receipt downloads, which build an object URL.
  connectSrc: ["'self'", 'blob:', 'https://www.google.com', 'https://accounts.google.com'],
  // reCAPTCHA challenge iframe, and the Google Sign-In prompt/popup.
  frameSrc: ['https://www.google.com', 'https://accounts.google.com'],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  formAction: ["'self'"],
  frameAncestors: ["'none'"],
};
if (IS_PRODUCTION) cspDirectives.upgradeInsecureRequests = [];

app.use(helmet({
  contentSecurityPolicy: process.env.CSP_ENABLED === 'false'
    ? false
    : { directives: cspDirectives, reportOnly: process.env.CSP_REPORT_ONLY === 'true' },
  // Would block reCAPTCHA and cross-origin images without buying anything here.
  crossOriginEmbedderPolicy: false,
  // Helmet's default 'same-origin' cuts off window.postMessage - need this to allow the google sign in popup to work
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  hsts: IS_PRODUCTION ? { maxAge: 31536000, includeSubDomains: true, preload: false } : false,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  // Match the CSP's frame-ancestors 'none' for pre-CSP browsers.
  frameguard: { action: 'deny' },
}));

// A bearer token read from localStorage means any origin that can call the API
// can use a stolen token, so the wide-open cors() had to go. Capacitor serves
// the app from https://localhost (Android) or capacitor://localhost (iOS).
const DEFAULT_ORIGINS = [
  'https://freevoices.co.za',
  'https://www.freevoices.co.za',
  'https://api.freevoices.co.za',
  'https://localhost',
  'capacitor://localhost',
  'ionic://localhost',
];
const DEV_ORIGINS = ['http://localhost:4200', 'http://localhost:8100', 'http://localhost:3000', 'http://localhost:8080'];

const allowedOrigins = new Set(
  process.env.CORS_ALLOWED_ORIGINS
    ? process.env.CORS_ALLOWED_ORIGINS.split(',').map(o => o.trim()).filter(Boolean)
    : [...DEFAULT_ORIGINS, ...(IS_PRODUCTION ? [] : DEV_ORIGINS)]
);

app.use(cors({
  origin: (origin, callback) => {
    // No Origin header: curl, native HTTP clients, server-to-server, and
    // same-origin navigations. There is no cross-origin risk to police here.
    if (!origin) return callback(null, true);
    if (allowedOrigins.has(origin)) return callback(null, true);
    logger.warn('CORS: rejected origin', { origin });
    return callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));

// Turn the CORS rejection into an honest 403 instead of letting the thrown
// Error fall through to the generic 500 handler.
app.use((err, req, res, next) => {
  if (err && err.message === 'Not allowed by CORS') {
    return res.status(403).json({ message: 'Origin not allowed' });
  }
  return next(err);
});

app.use(bodyParser.json({ limit: '1mb' }));

// ─── Rate limiting ────────────────────────────────────────────────────────────
// With no throttle, /api/auth/login was both a brute-force target and a
// CPU-exhaustion vector, because every attempt runs an expensive argon2 verify.

const limiter = (windowMinutes, limit, message) => rateLimit({
  windowMs: windowMinutes * 60 * 1000,
  limit,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message },
  skip: () => process.env.RATE_LIMIT_DISABLED === 'true',
});

const loginLimiter = limiter(15, 10, 'Too many sign-in attempts. Please wait a few minutes and try again.');
const registerLimiter = limiter(60, 5, 'Too many accounts created from this network. Please try again later.');
const passwordLimiter = limiter(60, 5, 'Too many password reset requests. Please try again later.');
const portalLimiter = limiter(15, 60, 'Too many requests. Please try again shortly.');
const apiLimiter = limiter(15, 1000, 'Too many requests. Please slow down.');

app.use('/api', apiLimiter);

app.get('/api/health/live', (req, res) => res.json({ status: 'live' }));
app.get('/api/health/ready', async (req, res) => {
  try {
    await executeQuery('SELECT 1 AS ok');
    res.set('Cache-Control', 'no-store').json({ status: 'ready' });
  } catch (error) {
    logger.error('Readiness check failed', error);
    res.set('Cache-Control', 'no-store').status(503).json({ status: 'unavailable' });
  }
});
const schedulerStatus = Object.fromEntries(['recurring','notifications','overdue','retention'].map(name=>[name,{last_success:null,last_failure:null}]));
async function runTrackedJob(name, work) {
  try { await work(); schedulerStatus[name].last_success=new Date().toISOString(); }
  catch(error) { schedulerStatus[name].last_failure=new Date().toISOString(); logger.error(`${name} job failed`,error); }
}
app.get('/api/ops/metrics',async(req,res)=>{
  const expected=process.env.OPERATIONS_TOKEN;
  if (!expected) return res.status(404).json({message:'Not found'});
  const supplied=req.get('x-operations-token') || '';
  const left=Buffer.from(expected),right=Buffer.from(supplied);
  if (left.length!==right.length || !timingSafeEqual(left,right)) return res.status(403).json({message:'Forbidden'});
  try {
    const [outbox,recurring,bankRows]=await Promise.all([
      executeQuery('SELECT status,COUNT(*) AS count FROM email_outbox GROUP BY status'),
      executeQuery("SELECT COUNT(*) AS count FROM documents WHERE is_recurring=1 AND recurrence_next_date IS NOT NULL AND recurrence_next_date<=?",[todayIso()]),
      executeQuery("SELECT COUNT(*) AS count FROM bank_import_rows WHERE status='PENDING'")
    ]);
    res.set('Cache-Control','no-store').json({checked_at:new Date().toISOString(),scheduler:schedulerStatus,outbox:Object.fromEntries(outbox.map(row=>[row.status,row.count])),recurring_due:recurring[0].count,bank_rows_pending:bankRows[0].count});
  } catch(error) { logger.error('Operations metrics failed',error);res.status(503).json({message:'Metrics unavailable'}); }
});

app.use(express.static(WEB_ROOT));

// The `tls` block that used to be passed here was silently discarded —
// EmailService built its own, weaker one. TLS policy now lives entirely in
// EmailService, so there is one place to look.
const { queueEmail, deliverEmail, processOutbox, captureEmail } = require('./src/services/outbox.service');
const { processBillingNotifications, parseReminderDays } = require('./src/services/billing-notifications.service');
const { processRecurring } = require('./src/services/recurring.service');
const emailService = new EmailService({
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: parseInt(process.env.SMTP_PORT),
  SMTP_SECURE: process.env.SMTP_SECURE === 'true',
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
});

/**
 * executeQuery, then decrypt at the database boundary.
 *
 * Decryption happens HERE and nowhere deeper: pdf.service and email.service
 * stay pure renderers that receive plaintext, because the failure mode of
 * getting that wrong is a customer being emailed an invoice with the seller's
 * bank account rendered as base64 — and `bankFields.filter(Boolean)` is happy
 * to print it, so nothing errors.
 *
 * Pick the mapper that matches the table the columns actually came from.
 * `phone`, `vat_number` and `notes` exist on more than one table, and the AAD
 * binds the table name, so the wrong mapper throws rather than quietly
 * returning ciphertext.
 */
const queryDecrypted = async (mapper, sql, params) =>
  hydrateDocumentSnapshots(executeQuery, (await executeQuery(sql, params)).map(mapper));

async function issueDocument(id, userId, type, { requireEmail = false, allowFinal = false } = {}) {
  return withTransaction(async (q) => {
    const [document] = await q('SELECT * FROM documents WHERE id = ? AND user_id = ? AND type = ? FOR UPDATE', [id, userId, type]);
    if (!document) throw Object.assign(new Error('Document not found'), { status: 404 });
    if (!allowFinal && !['DRAFT', 'SENT', 'OVERDUE'].includes(document.status)) {
      throw Object.assign(new Error(`Cannot issue a document with status ${document.status}`), { status: 400 });
    }
    const snapshot = await captureDocumentSnapshot(q, id);
    if (requireEmail && !snapshot.buyer.email) {
      throw Object.assign(new Error('This document has no customer email address'), { status: 400 });
    }
    if (document.status === 'DRAFT') {
      await q("UPDATE documents SET status = 'SENT', updated_at = NOW() WHERE id = ?", [id]);
      await q("INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'SENT')", [id]);
    }
  });
}


/**
 * Encrypt one value on its way into the database.
 *
 * Deliberately called inline in the parameter arrays rather than by
 * transforming an object first: these INSERTs and UPDATEs list their columns
 * positionally, so encrypting at the exact position the column occupies is the
 * only form that cannot drift out of step with the SQL above it.
 */
const encUser = (column, value) => encryptField('users', column, value);
const encCustomer = (column, value) => encryptField('customers', column, value);
const encTracking = (column, value) => encryptField('document_tracking', column, value);

function validate(validators, options = {}) {
  // express-validator includes the REJECTED VALUE in every field error. For an
  // ordinary field that is helpful; for a secret it means the passphrase a user
  // just typed comes straight back in the 422 body, into the browser console,
  // and into any client-side error reporting. Name those fields in
  // `options.redact` and they are replaced before the response is built.
  const redact = new Set(options.redact || []);
  return async (req, res, next) => {
    for (const v of validators) await v.run(req);
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      const safe = errors.array().map((e) =>
        // `path` is express-validator 7; `param` is 6. Check both so a version
        // bump cannot silently turn redaction off.
        (redact.has(e.path) || redact.has(e.param)) ? { ...e, value: '[redacted]' } : e
      );
      return res.status(422).json({ message: safe[0].msg, errors: safe });
    }
    next();
  };
}

/**
 * Session lifetime. A flat 12-hour *absolute* cap would sign mobile users out
 * twice a day, because there is no refresh-token mechanism — so the 12 hours is
 * an idle window that slides on use, bounded by a hard 7-day ceiling measured
 * from when the session was created.
 */
const SESSION_IDLE_HOURS = parseInt(process.env.SESSION_IDLE_HOURS, 10) || 12;
const SESSION_MAX_DAYS = parseInt(process.env.SESSION_MAX_DAYS, 10) || 7;

/** Expiry for a freshly minted session. */
function newSessionExpiry() {
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + SESSION_IDLE_HOURS);
  return expiresAt;
}

const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ message: 'No token provided' });

    // Joined to users so a closed account stops authenticating immediately.
    // Previously this checked only the sessions table, so a closed account kept
    // working until its token happened to expire.
    const sessions = await executeQuery(
      `SELECT s.userId, u.status
         FROM sessions s
         JOIN users u ON u.id = s.userId
        WHERE s.token = ?
          AND s.expires > NOW()
          AND s.created_at > DATE_SUB(NOW(), INTERVAL ? DAY)`,
      [hashToken(token), SESSION_MAX_DAYS]
    );
    if (sessions.length === 0) return res.status(401).json({ message: 'Invalid or expired token' });

    if (sessions[0].status !== 'ACTIVE') {
      // 403 with a code, not 401: the credentials were fine, the account is
      // closed. The client uses this to route to the reactivation screen rather
      // than looping through the login form.
      return res.status(403).json({ message: 'This account is closed.', code: 'ACCOUNT_CLOSED' });
    }

    req.user = { id: sessions[0].userId };

    // Slide the idle window, clamped to the absolute ceiling. The guard on
    // `expires` means this only writes once the window has actually moved by
    // more than an hour, rather than on every single request.
    try {
      await executeQuery(
        `UPDATE sessions
            SET expires = LEAST(DATE_ADD(NOW(), INTERVAL ? HOUR), DATE_ADD(created_at, INTERVAL ? DAY))
          WHERE token = ?
            AND expires < DATE_ADD(NOW(), INTERVAL ? HOUR)`,
        [SESSION_IDLE_HOURS, SESSION_MAX_DAYS, hashToken(token), SESSION_IDLE_HOURS - 1]
      );
    } catch (slideError) {
      // A failed renewal must not fail an otherwise authenticated request.
      logger.error('Session renewal failed', slideError);
    }

    next();
  } catch (error) {
    logger.error('Authentication error:', error);
    res.status(500).json({ message: 'Authentication error' });
  }
};

async function verifyCaptcha(token) {
  try {
    if (!token) return false;
    const params = new URLSearchParams();
    params.append('secret', process.env.RECAPTCHA_SECRET_KEY);
    params.append('response', token);
    const response = await axios.post('https://www.google.com/recaptcha/api/siteverify', params, { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    if (!response.data.success) logger.warn('CAPTCHA verification failed', { errors: response.data['error-codes'] });
    return response.data.success;
  } catch (error) { logger.error('CAPTCHA verification error:', error); return false; }
}

/**
 * Verify a reCAPTCHA token when one is supplied, and reject a bad one.
 *
 * This replaces `!req.headers['user-agent']?.includes('Mobile')`, which skipped
 * verification for any request claiming to be mobile — forgeable with a single
 * header, so it protected nothing while appearing to. reCAPTCHA v2 Invisible
 * cannot run in the native shell, so native clients legitimately send no token
 * and the server has no trustworthy way to tell them from a bot pretending to be
 * one.
 *
 * The honest position: CAPTCHA is bot friction for the web, not a security
 * boundary. The actual brute-force controls are the rate limiter and the
 * per-account lockout below. Accepted residual risk — closing it properly means
 * native attestation (Play Integrity / App Attest), which is its own project.
 *
 * Returns true to continue; if it returns false it has already sent a response.
 */
async function enforceCaptcha(req, res) {
  if (!IS_PRODUCTION || process.env.CAPTCHA_DISABLED === 'true') return true;
  const token = req.body?.captchaToken;
  if (!token) return true;
  if (await verifyCaptcha(token)) return true;
  res.status(400).json({ message: 'Security verification failed. Please try again.' });
  return false;
}

// Per-account brute-force lockout, using the failed_login_attempts and
// last_failed_attempt columns that have existed unused since the first schema.
const LOGIN_MAX_FAILURES = parseInt(process.env.LOGIN_MAX_FAILURES, 10) || 10;
const LOGIN_LOCKOUT_MINUTES = parseInt(process.env.LOGIN_LOCKOUT_MINUTES, 10) || 15;

/** Days between closing an account and its personal information being erased. */
const ACCOUNT_GRACE_DAYS = parseInt(process.env.ACCOUNT_GRACE_DAYS, 10) || 30;

/**
 * Append to security_events. Never throws — an audit write must not be able to
 * fail the operation it is describing, and losing one row is preferable to
 * refusing a user's account closure.
 */
async function recordSecurityEvent(req, eventType, userId = null, detail = null) {
  try {
    await executeQuery(
      `INSERT INTO security_events (user_id, event_type, ip_address, user_agent, detail)
       VALUES (?, ?, ?, ?, ?)`,
      [
        userId,
        eventType,
        req.ip || null,
        (req.get('user-agent') || '').slice(0, 512) || null,
        detail ? String(detail).slice(0, 512) : null,
      ]
    );
  } catch (err) {
    logger.error('Failed to record security event', { eventType, message: err.message });
  }
}

/** Log a POPIA data-subject request so we can show it was honoured. */
async function recordSubjectRequest(req, type, userId, status = 'COMPLETED', notes = null) {
  try {
    await executeQuery(
      `INSERT INTO data_subject_requests (user_id, request_type, channel, status, notes, ip_address, completed_at)
       VALUES (?, ?, 'IN_APP', ?, ?, ?, ${status === 'COMPLETED' ? 'NOW()' : 'NULL'})`,
      [userId, type, status, notes ? String(notes).slice(0, 512) : null, req.ip || null]
    );
  } catch (err) {
    logger.error('Failed to record subject request', { type, message: err.message });
  }
}

// ─── Google Sign-In ───────────────────────────────────────────────────────────

/**
 * Accepted `aud` values for an incoming Google ID token.
 *
 * The web build receives a token minted for the Web client ID. The Android
 * build asks for one via the plugin's `serverClientId`, which is *also* the Web
 * client ID — that is Google's documented pattern, not a misconfiguration. The
 * separate Android OAuth client still has to exist in the same Cloud project
 * (it is what ties the app's signing certificate to the project), but its ID
 * never appears in an `aud` claim, so it is not listed here.
 *
 * Unset means the feature is off: every Google endpoint answers 503 rather than
 * falling back to something weaker.
 */
const GOOGLE_AUDIENCES = (process.env.GOOGLE_OAUTH_CLIENT_ID || '')
  .split(',').map(s => s.trim()).filter(Boolean);
const googleClient = GOOGLE_AUDIENCES.length ? new OAuth2Client() : null;

if (!googleClient) {
  logger.warn('Google sign-in disabled: GOOGLE_OAUTH_CLIENT_ID is not set');
}

/**
 * Verify a Google ID token, returning only claims we are willing to trust, or
 * null if the token is not usable. Never throws.
 *
 * verifyIdToken checks the signature, `iss`, `aud` and expiry. It does NOT care
 * whether the address is verified, and that check matters more than it looks:
 * an unverified Google email is an address the account holder has not proven
 * they own, and we use the address to link into an existing password account.
 * Without this, anyone able to create a Google account naming someone else's
 * address could take over the matching FreeVoices account.
 */
async function verifyGoogleIdToken(idToken) {
  if (!googleClient) return null;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken, audience: GOOGLE_AUDIENCES });
    const payload = ticket.getPayload();
    if (!payload || !payload.email || payload.email_verified !== true) return null;
    return {
      sub: payload.sub,
      email: String(payload.email).trim().toLowerCase(),
      name: payload.name || null,
    };
  } catch (error) {
    // Expired and tampered tokens both land here and are indistinguishable to
    // the caller on purpose.
    logger.warn('Google ID token rejected', { message: error.message });
    return null;
  }
}

/**
 * The tail end of a successful sign-in, shared by the password and Google
 * paths, so session issuance exists in one place rather than two.
 *
 * The status guards are the real check for the Google path. The password path
 * has already made the same checks by the time it gets here — it has to, since
 * an ANONYMISED account's password_hash is NULL and argon2.verify would throw
 * before we ever reached this function — so for that caller they are simply
 * defence in depth.
 *
 * Returns false when it has already sent a response.
 */
async function completeSignIn(req, res, user, eventType) {
  // Indistinguishable from a non-existent account, deliberately.
  if (user.status === 'ANONYMISED') {
    res.status(401).json({ message: 'Invalid credentials' });
    return false;
  }

  // A closed account inside its grace period can still be recovered, but only
  // by the reactivation endpoint, which verifies the password itself.
  if (user.status === 'CLOSED') {
    await recordSecurityEvent(req, 'LOGIN_BLOCKED_CLOSED', user.id);
    res.status(403).json({
      message: 'This account is closed. You can reactivate it within the grace period.',
      code: 'ACCOUNT_CLOSED',
      closed_at: user.closed_at,
      anonymise_due_at: user.anonymise_after,
    });
    return false;
  }

  if (user.failed_login_attempts > 0) {
    await executeQuery('UPDATE users SET failed_login_attempts = 0, last_failed_attempt = NULL WHERE id = ?', [user.id]);
  }

  const token = randomUUID();
  await executeQuery('INSERT INTO sessions (userId, token, expires) VALUES (?, ?, ?)', [user.id, hashToken(token), newSessionExpiry()]);
  await executeQuery('UPDATE users SET last_login_at = NOW() WHERE id = ?', [user.id]);
  await recordSecurityEvent(req, eventType, user.id);
  logger.info('User logged in successfully', { userId: user.id });
  res.json({ token, user: { id: user.id, email: user.email, company_name: user.company_name } });
  return true;
}

/**
 * Prove the person driving an authenticated session is still the account
 * holder, before something destructive happens.
 *
 * A password account proves it with the password. A Google-only account has no
 * password to give, so a fresh ID token for the *same* Google account is the
 * equivalent proof — checked against the stored `sub`, not the email, so a
 * token for some other Google account is no good. Without that branch a Google
 * user could never close their account, and erasure is a POPIA right rather
 * than a feature we get to withhold from some sign-in methods.
 *
 * Returns false when it has already sent a response.
 */
async function reauthenticateForSensitiveAction(req, res, user, failureEvent) {
  if (user.password_hash) {
    if (!req.body.password) {
      res.status(422).json({ message: 'Your password is required to confirm this.' });
      return false;
    }
    if (!(await argon2.verify(user.password_hash, req.body.password))) {
      await recordSecurityEvent(req, failureEvent, user.id);
      res.status(401).json({ message: 'That password is not correct' });
      return false;
    }
    return true;
  }

  if (user.google_id) {
    if (!req.body.idToken) {
      res.status(422).json({
        message: 'Confirm with Google to continue.',
        code: 'GOOGLE_REAUTH_REQUIRED',
      });
      return false;
    }
    const claims = await verifyGoogleIdToken(req.body.idToken);
    if (!claims || claims.sub !== user.google_id) {
      await recordSecurityEvent(req, failureEvent, user.id);
      res.status(401).json({ message: 'That Google sign-in does not match this account.' });
      return false;
    }
    return true;
  }

  // No credential of either kind: an already-anonymised row, or data we do not
  // understand. Refuse rather than treat "nothing to check" as "check passed".
  res.status(403).json({ message: 'This account cannot be confirmed.' });
  return false;
}

// Login endpoint
app.post('/api/auth/login', loginLimiter, validate([
  body('email').isEmail().withMessage('A valid email address is required'),
  body('password').notEmpty().withMessage('Password is required'),
]), async (req, res) => {
  try {
    const { email, password } = req.body;
    // Deliberately no email in the log line — see the security_events table for
    // auditable, retention-bounded authentication logging.
    if (!(await enforceCaptcha(req, res))) return;

    const users = await queryDecrypted(decryptUserRow, 'SELECT * FROM users WHERE email = ?', [email]);
    if (users.length === 0) return res.status(401).json({ message: 'Invalid credentials' });
    const user = users[0];

    // An anonymised account has no usable password hash and nothing to return
    // to; it is indistinguishable from a non-existent one, deliberately.
    if (user.status === 'ANONYMISED') return res.status(401).json({ message: 'Invalid credentials' });

    // A closed account inside its grace period can still be recovered, but only
    // by the reactivation endpoint, which verifies the password itself. We do
    // NOT auto-reactivate on a successful login: that would let anyone holding
    // the password undo a closure silently, which defeats the exact abuse cases
    // the feature exists for.
    if (user.status === 'CLOSED') {
      await recordSecurityEvent(req, 'LOGIN_BLOCKED_CLOSED', user.id);
      return res.status(403).json({
        message: 'This account is closed. You can reactivate it within the grace period.',
        code: 'ACCOUNT_CLOSED',
        closed_at: user.closed_at,
        anonymise_due_at: user.anonymise_after,
      });
    }

    // Lockout only bites once the failure count is reached AND the most recent
    // failure is still inside the window, so it unlocks itself with time.
    if (user.failed_login_attempts >= LOGIN_MAX_FAILURES && user.last_failed_attempt) {
      const unlocksAt = new Date(new Date(user.last_failed_attempt).getTime() + LOGIN_LOCKOUT_MINUTES * 60000);
      if (unlocksAt > new Date()) {
        const minutes = Math.max(1, Math.ceil((unlocksAt - Date.now()) / 60000));
        logger.warn('Login blocked by lockout', { userId: user.id });
        return res.status(429).json({
          message: `Too many failed sign-in attempts. Please try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`
        });
      }
    }

    // A Google-only account has no hash to verify against. argon2.verify(null)
    // throws, which without this guard surfaces as a 500 on an ordinary typo of
    // a path a user can reach just by using the wrong button.
    if (!user.password_hash) {
      await recordSecurityEvent(req, 'LOGIN_FAILED_NO_PASSWORD', user.id);
      return res.status(401).json({
        message: 'This account signs in with Google. Use the “Continue with Google” button.',
        code: 'USE_GOOGLE_SIGNIN',
      });
    }

    const validPassword = await argon2.verify(user.password_hash, password);
    if (!validPassword) {
      // Restart the count if the previous failure fell outside the window,
      // otherwise increment it.
      await executeQuery(
        `UPDATE users
            SET failed_login_attempts = CASE
                  WHEN last_failed_attempt IS NULL
                    OR last_failed_attempt < DATE_SUB(NOW(), INTERVAL ? MINUTE) THEN 1
                  ELSE failed_login_attempts + 1 END,
                last_failed_attempt = NOW()
          WHERE id = ?`,
        [LOGIN_LOCKOUT_MINUTES, user.id]
      );
      await recordSecurityEvent(req, 'LOGIN_FAILED', user.id);
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    await completeSignIn(req, res, user, 'LOGIN_SUCCESS');
  } catch (error) { logger.error('Login error:', error); res.status(500).json({ message: 'Login failed. Please try again.' }); }
});

// Logout endpoint
app.post('/api/logout', authenticateToken, async (req, res) => {
  try {
    const token = req.headers.authorization.split(' ')[1];
    await executeQuery('DELETE FROM sessions WHERE token = ?', [hashToken(token)]);
    res.json({ message: 'Logged out successfully' });
  } catch (error) { logger.error('Logout error:', error); res.status(500).json({ message: 'Logout error' }); }
});

process.on('SIGINT', () => {
  closePool().then(() => process.exit(0));
});

// Registration endpoint
app.post('/api/auth/register', registerLimiter, validate([
  body('email').isEmail().normalizeEmail().withMessage('A valid email address is required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('company_name').trim().notEmpty().withMessage('Company name is required'),
  body('contact_person').trim().notEmpty().withMessage('Contact person is required'),
  body('phone').trim().notEmpty().withMessage('Phone number is required'),
  body('address').trim().notEmpty().withMessage('Address is required'),
]), async (req, res) => {
  try {
    const { email, password, company_name, company_registration, vat_number, contact_person, phone, address, bank_name, bank_account_number, bank_branch_code, bank_account_type } = req.body;
    if (!(await enforceCaptcha(req, res))) return;

    const existingUser = await executeQuery('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser.length > 0) return res.status(400).json({ message: 'Email already registered' });
    const password_hash = await argon2.hash(password);
    const result = await executeQuery(
      'INSERT INTO users (email, password_hash, company_name, company_registration, vat_number, contact_person, phone, address, bank_name, bank_account_number, bank_branch_code, bank_account_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [email, password_hash, company_name,
       encUser('company_registration', company_registration), encUser('vat_number', vat_number),
       contact_person, encUser('phone', phone), encUser('address', address), bank_name,
       encUser('bank_account_number', bank_account_number), encUser('bank_branch_code', bank_branch_code),
       encUser('bank_account_type', bank_account_type)]
    );
    const token = randomUUID();
    await executeQuery('INSERT INTO sessions (userId, token, expires) VALUES (?, ?, ?)', [result.insertId, hashToken(token), newSessionExpiry()]);
    const user = await executeQuery('SELECT id, email, company_name FROM users WHERE id = ?', [result.insertId]);
    const verificationToken = randomUUID();
    const verificationExpires = new Date();
    verificationExpires.setHours(verificationExpires.getHours() + 24);
    await executeQuery('UPDATE users SET email_verification_token = ?, email_verification_expires = ? WHERE id = ?', [hashToken(verificationToken), verificationExpires, result.insertId]);
    try { await emailService.sendVerificationEmail(email, verificationToken); } catch (emailError) { logger.error('Failed to send verification email:', emailError); }
    logger.info('User registered successfully', { userId: result.insertId });
    res.status(201).json({ token, user: user[0] });
  } catch (error) { logger.error('Registration error:', error); res.status(500).json({ message: 'Registration failed. Please try again.' }); }
});

/**
 * Sign in with a Google ID token.
 *
 * Three outcomes:
 *   - the Google account is already known           -> signed in
 *   - its verified email matches a password account -> linked, then signed in
 *   - neither                                       -> { needsRegistration }, and
 *     the client collects the business details we need and posts them to
 *     /api/auth/google/register
 *
 * Rate-limited with loginLimiter: this is an unauthenticated endpoint that hits
 * both Google and the database.
 */
app.post('/api/auth/google', loginLimiter, validate([
  body('idToken').notEmpty().withMessage('A Google credential is required'),
]), async (req, res) => {
  try {
    if (!googleClient) return res.status(503).json({ message: 'Google sign-in is not available.' });

    const claims = await verifyGoogleIdToken(req.body.idToken);
    if (!claims) return res.status(401).json({ message: 'We could not verify that Google sign-in. Please try again.' });

    let users = await queryDecrypted(decryptUserRow, 'SELECT * FROM users WHERE google_id = ?', [claims.sub]);

    // Same person, already registered with a password. Link the Google account
    // onto the existing row instead of creating a duplicate they would then be
    // unable to reach their invoices from. Safe only because verifyGoogleIdToken
    // refuses tokens whose email_verified is not true.
    if (users.length === 0) {
      const byEmail = await queryDecrypted(decryptUserRow, 'SELECT * FROM users WHERE email = ?', [claims.email]);
      if (byEmail.length > 0) {
        await executeQuery('UPDATE users SET google_id = ?, email_verified = 1 WHERE id = ?', [claims.sub, byEmail[0].id]);
        await recordSecurityEvent(req, 'GOOGLE_ACCOUNT_LINKED', byEmail[0].id);
        logger.info('Linked Google account to existing user', { userId: byEmail[0].id });
        users = byEmail;
      }
    }

    if (users.length === 0) {
      // Not an error: the client shows the "complete your details" step. No
      // account exists yet and nothing has been written.
      return res.json({ needsRegistration: true, email: claims.email, name: claims.name });
    }

    await completeSignIn(req, res, users[0], 'LOGIN_SUCCESS_GOOGLE');
  } catch (error) {
    logger.error('Google sign-in error:', error);
    res.status(500).json({ message: 'Sign-in failed. Please try again.' });
  }
});

/**
 * Finish creating an account that started from Google sign-in.
 *
 * Takes the ID token again rather than trusting anything the /api/auth/google
 * call returned: that response travelled to the client and back, so treating it
 * as authoritative would let a caller register any address they cared to name.
 * Google ID tokens last about an hour, which is far longer than it takes to
 * fill in three fields.
 */
app.post('/api/auth/google/register', registerLimiter, validate([
  body('idToken').notEmpty().withMessage('A Google credential is required'),
  body('company_name').trim().notEmpty().withMessage('Company name is required'),
  body('contact_person').trim().notEmpty().withMessage('Contact person is required'),
  body('phone').trim().notEmpty().withMessage('Phone number is required'),
  body('address').trim().notEmpty().withMessage('Address is required'),
]), async (req, res) => {
  try {
    if (!googleClient) return res.status(503).json({ message: 'Google sign-in is not available.' });

    const claims = await verifyGoogleIdToken(req.body.idToken);
    if (!claims) return res.status(401).json({ message: 'We could not verify that Google sign-in. Please try again.' });

    const { company_name, company_registration, vat_number, contact_person, phone, address,
            bank_name, bank_account_number, bank_branch_code, bank_account_type } = req.body;

    // Someone else may have finished registering this address between the two
    // calls — or the user may have double-submitted. Either way, sign them into
    // the row that exists rather than failing on the UNIQUE index.
    const existing = await executeQuery(
      'SELECT * FROM users WHERE google_id = ? OR email = ?', [claims.sub, claims.email]
    );
    if (existing.length > 0) {
      if (!existing[0].google_id) {
        await executeQuery('UPDATE users SET google_id = ? WHERE id = ?', [claims.sub, existing[0].id]);
      }
      return void await completeSignIn(req, res, existing[0], 'LOGIN_SUCCESS_GOOGLE');
    }

    // password_hash stays NULL: there is no password to hash, and a sentinel
    // would be a value argon2.verify might one day be persuaded to accept.
    // email_verified is 1 because Google has already proven the address, which
    // is also why no verification email goes out here.
    const result = await executeQuery(
      `INSERT INTO users (email, password_hash, google_id, email_verified, company_name, company_registration,
                          vat_number, contact_person, phone, address, bank_name, bank_account_number,
                          bank_branch_code, bank_account_type)
       VALUES (?, NULL, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [claims.email, claims.sub, company_name,
       encUser('company_registration', company_registration || null), encUser('vat_number', vat_number || null),
       contact_person, encUser('phone', phone), encUser('address', address), bank_name || null,
       encUser('bank_account_number', bank_account_number || null),
       encUser('bank_branch_code', bank_branch_code || null),
       encUser('bank_account_type', bank_account_type || null)]
    );

    const token = randomUUID();
    await executeQuery('INSERT INTO sessions (userId, token, expires) VALUES (?, ?, ?)', [result.insertId, hashToken(token), newSessionExpiry()]);
    await executeQuery('UPDATE users SET last_login_at = NOW() WHERE id = ?', [result.insertId]);
    await recordSecurityEvent(req, 'REGISTER_SUCCESS_GOOGLE', result.insertId);
    const user = await executeQuery('SELECT id, email, company_name FROM users WHERE id = ?', [result.insertId]);
    logger.info('User registered via Google', { userId: result.insertId });
    res.status(201).json({ token, user: user[0] });
  } catch (error) {
    logger.error('Google registration error:', error);
    res.status(500).json({ message: 'Registration failed. Please try again.' });
  }
});

app.get('/api/verify-email', passwordLimiter, async (req, res) => {
  try {
    const token = hashToken(String(req.query.token || ''));
    const result = await withTransaction(async q => {
      const [pending] = await q('SELECT id,pending_email FROM users WHERE pending_email_token=? AND pending_email_expires>NOW() FOR UPDATE', [token]);
      if (pending) {
        if ((await q('SELECT id FROM users WHERE email=? AND id<>?', [pending.pending_email,pending.id])).length) throw Object.assign(new Error('That email address is already registered'), { status:409 });
        await q('UPDATE users SET email=pending_email,email_verified=1,pending_email=NULL,pending_email_token=NULL,pending_email_expires=NULL,email_verification_token=NULL,email_verification_expires=NULL WHERE id=?', [pending.id]);
        await q('DELETE FROM sessions WHERE userId=?', [pending.id]);
        await q('DELETE FROM password_reset_tokens WHERE user_id=?', [pending.id]);
        return 'Email changed and verified. Sign in with your new address.';
      }
      const verified = await q('UPDATE users SET email_verified=1,email_verification_token=NULL,email_verification_expires=NULL WHERE email_verification_token=? AND email_verification_expires>NOW()', [token]);
      if (!verified.affectedRows) throw Object.assign(new Error('Invalid or expired verification link'), { status:400 });
      return 'Email verified successfully';
    });
    res.json({ message:result });
  } catch(error) { res.status(error.status || (error.code==='ER_DUP_ENTRY' ? 409 : 500)).json({ message:error.status ? error.message : 'Verification failed' }); }
});

app.post('/api/auth/forgot-password', passwordLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required' });
    const users = await executeQuery('SELECT id FROM users WHERE email = ? AND email_verified = 1', [email]);
    if (users.length === 0) return res.json({ message: 'If that email is registered you will receive a reset link shortly.' });
    const token = randomUUID();
    await executeQuery('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))', [users[0].id, hashToken(token)]);
    await emailService.sendPasswordResetEmail(email, token);
    res.json({ message: 'If that email is registered you will receive a reset link shortly.' });
  } catch (error) { logger.error('Forgot password error:', error); res.status(500).json({ message: 'Failed to process request' }); }
});

app.post('/api/auth/reset-password', passwordLimiter, validate([
  body('token').trim().notEmpty().withMessage('Reset token is required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
]), async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ message: 'Token and new password are required' });
    if (password.length < 8) return res.status(400).json({ message: 'Password must be at least 8 characters' });
    const passwordHash = await argon2.hash(password);
    await withTransaction(async q => {
      const [candidate] = await executeQuery('SELECT user_id FROM password_reset_tokens WHERE token=?', [hashToken(token)]);
      if (!candidate) throw Object.assign(new Error('Invalid or expired reset token'), { status:400 });
      await q('SELECT id FROM users WHERE id=? FOR UPDATE', [candidate.user_id]);
      const [saved] = await q('SELECT id,user_id FROM password_reset_tokens WHERE token=? AND expires_at>NOW() AND used=0 FOR UPDATE', [hashToken(token)]);
      if (!saved) throw Object.assign(new Error('Invalid or expired reset token'), { status:400 });
      await q('UPDATE users SET password_hash=? WHERE id=?', [passwordHash,saved.user_id]);
      await q('UPDATE password_reset_tokens SET used=1 WHERE user_id=?', [saved.user_id]);
      await q('DELETE FROM sessions WHERE userId=?', [saved.user_id]);
    });
    res.json({ message: 'Password updated successfully' });
  } catch (error) { logger.error('Reset password error:', error); res.status(error.status || 500).json({ message: error.status ? error.message : 'Failed to reset password' }); }
});

app.get('/api/banks', async (req, res) => {
  try {
    const activeOnly = req.query.active === 'true';
    const sql = 'SELECT * FROM banks WHERE 1=1' + (activeOnly ? ' AND is_active = true' : '') + ' ORDER BY name';
    res.json(await executeQuery(sql));
  } catch (error) { logger.error('Error fetching banks:', error); res.status(500).json({ message: 'Failed to fetch banks' }); }
});

// ─── Customer endpoints ───────────────────────────────────────────────────────

app.get('/api/customers', authenticateToken, async (req, res) => {
  try {
    const search = req.query.search || '';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20));
    const offset = (page - 1) * limit;
    let sql = 'SELECT * FROM customers WHERE user_id = ? AND active = 1';
    let cntSql = 'SELECT COUNT(*) AS total FROM customers WHERE user_id = ? AND active = 1';
    const params = [req.user.id], cntParams = [req.user.id];
    if (search) { const clause = ' AND (name LIKE ? OR email LIKE ?)'; sql += clause; cntSql += clause; params.push(`%${search}%`, `%${search}%`); cntParams.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY name ASC, id ASC LIMIT ? OFFSET ?'; params.push(limit, offset);
    const [customers, countResult] = await Promise.all([queryDecrypted(decryptCustomerRow, sql, params), executeQuery(cntSql, cntParams)]);
    res.json({ data: customers, total: countResult[0].total, page, limit });
  } catch (error) { logger.error('Error fetching customers:', error); res.status(500).json({ message: 'Failed to fetch customers' }); }
});

app.post('/api/customers', authenticateToken, validate([
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().normalizeEmail().withMessage('A valid email address is required'),
  body('billing_address').trim().notEmpty().withMessage('Billing address is required'),
  body('phone').optional().trim(),
  body('vat_number').optional().trim(),
  body('payment_terms').optional().isInt({ min: 0 }).withMessage('Payment terms must be a positive number'),
]), async (req, res) => {
  try {
    const { name, email, phone, vat_number, billing_address, shipping_address, payment_terms, notes } = req.body;
    if (!name || !email || !billing_address) return res.status(400).json({ message: 'Name, email, and billing address are required' });
    const result = await executeQuery('INSERT INTO customers (user_id, name, email, phone, vat_number, billing_address, shipping_address, payment_terms, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [req.user.id, name, email, encCustomer('phone', phone || null), encCustomer('vat_number', vat_number || null), encCustomer('billing_address', billing_address), encCustomer('shipping_address', shipping_address || null), payment_terms ?? null, encCustomer('notes', notes || null)]);
    res.status(201).json((await queryDecrypted(decryptCustomerRow, 'SELECT * FROM customers WHERE id = ?', [result.insertId]))[0]);
  } catch (error) { logger.error('Error creating customer:', error); res.status(500).json({ message: 'Failed to create customer' }); }
});

app.get('/api/customers/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const customers = await queryDecrypted(decryptCustomerRow, 'SELECT * FROM customers WHERE id = ? AND user_id = ? AND active = 1', [id, req.user.id]);
    if (customers.length === 0) return res.status(404).json({ message: 'Customer not found' });
    if (req.query.include_documents === 'false') return res.json(customers[0]);
    const documents = await executeQuery('SELECT d.*,cur.code AS currency_code FROM documents d LEFT JOIN currencies cur ON cur.id=d.currency_id WHERE d.customer_id=? AND d.user_id=? ORDER BY d.created_at DESC', [id, req.user.id]);
    res.json({ ...customers[0], documents });
  } catch (error) { logger.error('Error fetching customer:', error); res.status(500).json({ message: 'Failed to fetch customer' }); }
});

app.put('/api/customers/:id', authenticateToken, validate([
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().normalizeEmail().withMessage('A valid email address is required'),
  body('billing_address').trim().notEmpty().withMessage('Billing address is required'),
  body('phone').optional().trim(),
  body('vat_number').optional().trim(),
  body('payment_terms').optional().isInt({ min: 0 }).withMessage('Payment terms must be a positive number'),
]), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, vat_number, billing_address, shipping_address, payment_terms, notes } = req.body;
    if (!name || !email || !billing_address) return res.status(400).json({ message: 'Name, email, and billing address are required' });
    const existing = await executeQuery('SELECT id FROM customers WHERE id = ? AND user_id = ? AND active = 1', [id, req.user.id]);
    if (existing.length === 0) return res.status(404).json({ message: 'Customer not found' });
    await executeQuery('UPDATE customers SET name=?, email=?, phone=?, vat_number=?, billing_address=?, shipping_address=?, payment_terms=?, notes=?, updated_at=NOW() WHERE id = ? AND user_id = ?', [name, email, encCustomer('phone', phone || null), encCustomer('vat_number', vat_number || null), encCustomer('billing_address', billing_address), encCustomer('shipping_address', shipping_address || null), payment_terms ?? null, encCustomer('notes', notes || null), id, req.user.id]);
    res.json((await queryDecrypted(decryptCustomerRow, 'SELECT * FROM customers WHERE id = ?', [id]))[0]);
  } catch (error) { logger.error('Error updating customer:', error); res.status(500).json({ message: 'Failed to update customer' }); }
});

app.delete('/api/customers/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await executeQuery('SELECT id FROM customers WHERE id = ? AND user_id = ? AND active = 1', [id, req.user.id]);
    if (existing.length === 0) return res.status(404).json({ message: 'Customer not found' });
    await executeQuery('UPDATE customers SET active = 0, updated_at = NOW() WHERE id = ? AND user_id = ?', [id, req.user.id]);
    res.json({ message: 'Customer deleted successfully' });
  } catch (error) { logger.error('Error deleting customer:', error); res.status(500).json({ message: 'Failed to delete customer' }); }
});

// ─── Invoices ─────────────────────────────────────────────────────────────────

app.get('/api/invoices', authenticateToken, async (req, res) => {
  try {
    const search = req.query.search || '', status = req.query.status || '';
    const page = Math.max(1, parseInt(req.query.page) || 1), limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20)), offset = (page - 1) * limit;
    let sql = `SELECT d.id, d.document_number, d.status, d.issue_date, d.due_date, d.subtotal, d.vat_amount, d.total, d.created_at, d.notifications_muted,
      (SELECT code FROM currencies WHERE id=d.currency_id) AS currency_code,c.name AS customer_name,
      (SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.document_id=d.id)
        -(SELECT COALESCE(SUM(r.amount),0) FROM payment_refunds r WHERE r.invoice_id=d.id) AS amount_paid,
      (SELECT COALESCE(SUM(cn.total),0) FROM credit_notes cn WHERE cn.invoice_id=d.id) AS credit_total
      FROM documents d JOIN customers c ON c.id=d.customer_id WHERE d.user_id=? AND d.type='INVOICE'`;
    let cntSql = `SELECT COUNT(*) AS total FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.user_id = ? AND d.type = 'INVOICE'`;
    const params = [req.user.id], cntParams = [req.user.id];
    if (status) { sql += ' AND d.status = ?'; cntSql += ' AND d.status = ?'; params.push(status); cntParams.push(status); }
    if (search) { const clause = ' AND (d.document_number LIKE ? OR c.name LIKE ?)'; sql += clause; cntSql += clause; params.push(`%${search}%`, `%${search}%`); cntParams.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY d.created_at DESC LIMIT ? OFFSET ?'; params.push(limit, offset);
    const [invoices, countResult] = await Promise.all([executeQuery(sql, params), executeQuery(cntSql, cntParams)]);
    res.json({ data: await hydrateDocumentSnapshots(executeQuery, invoices), total: countResult[0].total, page, limit });
  } catch (error) { logger.error('Error fetching invoices:', error); res.status(500).json({ message: 'Failed to fetch invoices' }); }
});

// Shared by invoice and quote create/update.
//
// optional({ values: 'falsy' }) because '' is what an empty date or number
// input submits. optional({ nullable: true }) only skips null/undefined, so a
// blank due date used to fail as "Due date must be a valid date" while the
// convert route, which never sends one, sailed through.
const documentRules = [
  body('customer_id').isInt({ min: 1 }).withMessage('A valid customer is required'),
  body('issue_date').isDate().withMessage('A valid issue date is required'),
  body('payment_terms').optional({ values: 'falsy' }).isInt({ min: 0 }).withMessage('Payment terms must be a positive number'),
  body('items').isArray({ min: 1 }).withMessage('At least one line item is required'),
  body('items.*.description').trim().notEmpty().withMessage('Each item must have a description'),
  body('items.*.quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be greater than 0'),
  body('items.*.unit_price').isFloat({ min: 0 }).withMessage('Unit price must be a positive number'),
  body('items.*.vat_inclusive').optional().isBoolean().withMessage('VAT-inclusive mode must be true or false').toBoolean(),
  body('items.*.product_id').optional({ nullable: true }).isInt({ min: 1 }).withMessage('Invalid product'),
  body('items.*.vat_rate').optional().isFloat({ min: 0, max: 100 }).withMessage('VAT rate must be between 0 and 100'),
  body('items.*.discount_percent').optional().isFloat({ min: 0, max: 100 }).withMessage('Discount must be between 0 and 100 percent'),
  body('items.*.unit_label').optional().isString().trim().isLength({ min: 1, max: 20 }).withMessage('Unit must be 1 to 20 characters'),
  body('purchase_order_ref').optional({ values: 'falsy' }).isString().trim().isLength({ max: 100 }),
  body('delivery_details').optional({ values: 'falsy' }).isString().trim().isLength({ max: 1000 }),
];
const invoiceRules = [
  ...documentRules,
  body('is_recurring').optional().isBoolean().toBoolean(),
  body('auto_send').optional().isBoolean().toBoolean(),
  body('recurrence_end_date').optional({ values: 'falsy' }).isDate(),
  body('due_date').optional({ values: 'falsy' }).isDate().withMessage('Due date must be a valid date')
    .custom((value, { req }) => !req.body.issue_date || value >= req.body.issue_date)
    .withMessage('Due date cannot be before the issue date'),
];
const quoteRules = [
  ...documentRules,
  body('valid_until').optional({ values: 'falsy' }).isDate().withMessage('Valid until must be a valid date'),
];

app.post('/api/invoices', authenticateToken, validate(invoiceRules), async (req, res) => {
  try {
    res.status(201).json(await createDocument(req.user.id, 'INVOICE', req.body));
  } catch (error) { logger.error('Document creation failed:', error); res.status(error.status || 500).json({ message: error.status ? error.message : 'Failed to create document' }); }
});

app.post('/api/invoices/preview', authenticateToken, validate(invoiceRules), async (req, res) => {
  try {
    const data = await prepareDocument(executeQuery, req.user.id, 'INVOICE', req.body);
    const [customers, users, currencies, logoRows] = await Promise.all([
      queryDecrypted(decryptCustomerRow, 'SELECT * FROM customers WHERE id=? AND user_id=? AND active=1', [req.body.customer_id, req.user.id]),
      queryDecrypted(decryptUserRow, 'SELECT * FROM users WHERE id=?', [req.user.id]),
      executeQuery('SELECT symbol FROM currencies WHERE id=?', [data.currencyId]),
      executeQuery("SELECT setting_value FROM settings WHERE user_id=? AND setting_key='company_logo'", [req.user.id]),
    ]);
    if (!customers.length || !users.length) return res.status(404).json({ message: 'Customer or account not found' });
    const customer = customers[0], logo = logoRows[0]?.setting_value;
    const invoice = {
      document_number: 'PREVIEW', status: 'DRAFT', issue_date: req.body.issue_date,
      due_date: data.due_date, payment_terms: data.payment_terms,
      customer_name: customer.name, customer_email: customer.email,
      customer_billing_address: customer.billing_address, customer_vat_number: customer.vat_number,
      currency_symbol: currencies[0]?.symbol || 'R',
      subtotal: data.subtotal, vat_amount: data.vat_amount, total: data.total, amount_paid: 0,
      notes: data.notes, terms_conditions: data.terms_conditions,
      purchase_order_ref: req.body.purchase_order_ref || null, delivery_details: req.body.delivery_details || null,
    };
    const seller = { ...users[0], logo_path: logo ? path.join(__dirname, logo) : null };
    const pdf = await buildInvoicePdf(invoice, data.lines, seller);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="invoice-preview.pdf"', 'Cache-Control': 'no-store' });
    res.send(pdf);
  } catch (error) { logger.error('Invoice preview failed:', error); res.status(error.status || 500).json({ message: error.status ? error.message : 'Failed to preview invoice' }); }
});

app.get('/api/invoices/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [invoices, items, tracking, payments, deliveries, settlement, credits, refunds] = await Promise.all([
      queryDecrypted(decryptCustomerJoin, `SELECT d.*, d.notifications_muted, c.name AS customer_name, c.email AS customer_email, c.billing_address AS customer_billing_address, c.vat_number AS customer_vat_number, cur.symbol AS currency_symbol, cur.code AS currency_code, q.document_number AS source_quote_number FROM documents d JOIN customers c ON c.id = d.customer_id LEFT JOIN currencies cur ON cur.id = d.currency_id LEFT JOIN documents q ON q.id = d.source_quote_id AND q.user_id = d.user_id WHERE d.id = ? AND d.user_id = ? AND d.type = 'INVOICE'`, [id, req.user.id]),
      executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]),
      executeQuery('SELECT id, document_id, event_type, event_date FROM document_tracking WHERE document_id = ? ORDER BY event_date ASC', [id]),
      queryDecrypted(decryptPaymentRow, 'SELECT * FROM payments WHERE document_id = ? ORDER BY payment_date DESC', [id]),
      executeQuery('SELECT id,kind,status,attempts,last_error,created_at,accepted_at FROM email_outbox WHERE document_id=? AND user_id=? ORDER BY id DESC LIMIT 30',[id,req.user.id]),
      invoiceSettlement(executeQuery,id),
      executeQuery('SELECT id,document_number,issue_date,reason,description,subtotal,vat_amount,total FROM credit_notes WHERE invoice_id=? ORDER BY id',[id]),
      executeQuery('SELECT id,payment_id,amount,refund_date,method,reference,reason FROM payment_refunds WHERE invoice_id=? ORDER BY id',[id])
    ]);
    if (invoices.length === 0) return res.status(404).json({ message: 'Invoice not found' });
    // Computed here rather than in the client so every screen agrees on what
    // is still owed.
    res.json({
      ...invoices[0], notifications_muted: !!invoices[0].notifications_muted, items, tracking, payments, email_deliveries: deliveries,credits,
      adjustments_available:adjustmentsEnabled(),
      refunds:refunds.map(row=>({...row,reference:decryptField('payment_refunds','reference',row.reference)})),
      amount_paid: settlement.netPaid.toFixed(2), credit_total:settlement.creditTotal.toFixed(2),refund_total:settlement.refundTotal.toFixed(2),
      adjusted_total:settlement.adjustedTotal.toFixed(2),balance_due:settlement.balanceDue.toFixed(2),refund_due:settlement.refundDue.toFixed(2),
    });
  } catch (error) { logger.error('Error fetching invoice:', error); res.status(500).json({ message: 'Failed to fetch invoice' }); }
});

app.get('/api/invoices/:id/pdf', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const markSent = req.query.markSent === 'true';
    if (markSent) await issueDocument(id, req.user.id, 'INVOICE', { allowFinal: true });
    const [invoices, items, users, logoRows] = await Promise.all([
      queryDecrypted(decryptCustomerJoin, `SELECT d.*, (SELECT COALESCE(SUM(pp.amount), 0) FROM payments pp WHERE pp.document_id = d.id) AS amount_paid, c.name AS customer_name, c.email AS customer_email, c.billing_address AS customer_billing_address, c.vat_number AS customer_vat_number, cur.symbol AS currency_symbol, cur.code AS currency_code FROM documents d JOIN customers c ON c.id = d.customer_id LEFT JOIN currencies cur ON cur.id = d.currency_id WHERE d.id = ? AND d.user_id = ? AND d.type = 'INVOICE'`, [id, req.user.id]),
      executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]),
      queryDecrypted(decryptUserRow, 'SELECT * FROM users WHERE id = ?', [req.user.id]),
      executeQuery("SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'company_logo'", [req.user.id])
    ]);
    if (invoices.length === 0) return res.status(404).json({ message: 'Invoice not found' });
    const logoRelPath = logoRows[0]?.setting_value || null;
    const user = await documentSeller(executeQuery, id, { ...decryptUserRow(users[0]), logo_path: logoRelPath ? path.join(__dirname, logoRelPath) : null });
    // markSent is about to promote a DRAFT, so judge eligibility on the status
    // this invoice will have by the time a customer reads the PDF.
    const effectiveStatus = markSent && invoices[0].status === 'DRAFT' ? 'SENT' : invoices[0].status;
    const pay_url = await resolvePayUrl({ ...invoices[0], status: effectiveStatus }, user);
    const pdfBuffer = await buildInvoicePdf({ ...await withInvoiceFinancials(executeQuery,invoices[0]), pay_url }, items, user);
    await executeQuery(`INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'DOWNLOADED')`, [id]);

    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${invoices[0].document_number}.pdf"`, 'Content-Length': pdfBuffer.length });
    res.send(pdfBuffer);
  } catch (error) { logger.error('Error generating invoice PDF:', error); res.status(error.status || 500).json({ message: error.status ? error.message : 'Failed to generate PDF' }); }
});

app.get('/api/invoices/:id/payments/:paymentId/receipt',authenticateToken,async(req,res)=>{
  try {
    const [invoice]=await queryDecrypted(decryptCustomerJoin,`SELECT d.id,d.document_number,d.issue_date,c.name AS customer_name,c.billing_address AS customer_billing_address,cur.symbol AS currency_symbol
      FROM documents d JOIN customers c ON c.id=d.customer_id JOIN currencies cur ON cur.id=d.currency_id
      WHERE d.id=? AND d.user_id=? AND d.type='INVOICE'`,[req.params.id,req.user.id]);
    if (!invoice) return res.status(404).json({message:'Invoice not found'});
    const [payment]=await queryDecrypted(decryptPaymentRow,'SELECT id,amount,payment_date,payment_method,transaction_reference FROM payments WHERE id=? AND document_id=?',[req.params.paymentId,invoice.id]);
    if (!payment) return res.status(404).json({message:'Payment not found'});
    const [user]=await queryDecrypted(decryptUserRow,'SELECT * FROM users WHERE id=?',[req.user.id]);
    const seller=await documentSeller(executeQuery,invoice.id,user);
    const [historical]=await hydrateDocumentSnapshots(executeQuery,[invoice]);
    const pdf=await buildPaymentReceiptPdf(payment,historical,seller);
    res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="RCPT-${payment.id}.pdf"`,'Content-Length':pdf.length,'Cache-Control':'no-store'}).send(pdf);
  } catch(error) { logger.error('Payment receipt failed:',error); res.status(500).json({message:'Could not generate payment receipt'}); }
});

app.get('/api/invoices/:id/receipt', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [invoices, items, users, logoRows, payments] = await Promise.all([
      queryDecrypted(decryptCustomerJoin, `SELECT d.*, (SELECT COALESCE(SUM(pp.amount), 0) FROM payments pp WHERE pp.document_id = d.id) AS amount_paid, c.name AS customer_name, c.email AS customer_email, c.billing_address AS customer_billing_address, c.vat_number AS customer_vat_number, cur.symbol AS currency_symbol, cur.code AS currency_code FROM documents d JOIN customers c ON c.id = d.customer_id LEFT JOIN currencies cur ON cur.id = d.currency_id WHERE d.id = ? AND d.user_id = ? AND d.type = 'INVOICE'`, [id, req.user.id]),
      executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]),
      queryDecrypted(decryptUserRow, 'SELECT * FROM users WHERE id = ?', [req.user.id]),
      executeQuery("SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'company_logo'", [req.user.id]),
      queryDecrypted(decryptPaymentRow, 'SELECT * FROM payments WHERE document_id = ? ORDER BY payment_date DESC', [id])
    ]);
    if (invoices.length === 0) return res.status(404).json({ message: 'Invoice not found' });
    const invoice=await withInvoiceFinancials(executeQuery,invoices[0]);
    if (invoice.status !== 'PAID' || Number(invoice.amount_paid)<=0) return res.status(400).json({ message: 'A paid invoice with a recorded payment is required for a full receipt' });
    const logoRelPath = logoRows[0]?.setting_value || null;
    const user = await documentSeller(executeQuery, id, { ...decryptUserRow(users[0]), logo_path: logoRelPath ? path.join(__dirname, logoRelPath) : null });
    const pdfBuffer = await buildReceiptPdf(invoice, items, user, payments);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="RECEIPT-${invoices[0].document_number}.pdf"`, 'Content-Length': pdfBuffer.length });
    res.send(pdfBuffer);
  } catch (error) { logger.error('Error generating receipt PDF:', error); res.status(500).json({ message: 'Failed to generate receipt' }); }
});

app.post('/api/invoices/:id/send-receipt', authenticateToken, validate([body('resend_key').optional().isUUID()]), async (req, res) => {
  try {
    const { id } = req.params;
    const [invoices, items, users, logoRows, payments] = await Promise.all([
      queryDecrypted(decryptCustomerJoin, `SELECT d.*, (SELECT COALESCE(SUM(pp.amount), 0) FROM payments pp WHERE pp.document_id = d.id) AS amount_paid, c.name AS customer_name, c.email AS customer_email, c.billing_address AS customer_billing_address, c.vat_number AS customer_vat_number, cur.symbol AS currency_symbol, cur.code AS currency_code FROM documents d JOIN customers c ON c.id = d.customer_id LEFT JOIN currencies cur ON cur.id = d.currency_id WHERE d.id = ? AND d.user_id = ? AND d.type = 'INVOICE'`, [id, req.user.id]),
      executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]),
      queryDecrypted(decryptUserRow, 'SELECT * FROM users WHERE id = ?', [req.user.id]),
      executeQuery("SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'company_logo'", [req.user.id]),
      queryDecrypted(decryptPaymentRow, 'SELECT * FROM payments WHERE document_id = ? ORDER BY payment_date DESC', [id])
    ]);
    if (invoices.length === 0) return res.status(404).json({ message: 'Invoice not found' });
    const invoice = await withInvoiceFinancials(executeQuery,invoices[0]);
    if (invoice.status !== 'PAID' || Number(invoice.amount_paid)<=0) return res.status(400).json({ message: 'A paid invoice with a recorded payment is required for a full receipt' });
    if (!invoice.customer_email) return res.status(400).json({ message: 'This customer has no email address on file' });
    const logoRelPath = logoRows[0]?.setting_value || null;
    const user = await documentSeller(executeQuery, id, { ...decryptUserRow(users[0]), logo_path: logoRelPath ? path.join(__dirname, logoRelPath) : null });
    const pdfBuffer = await buildReceiptPdf(invoice, items, user, payments);
    const mail=await captureEmail(emailService,'sendReceiptEmail',invoice.customer_email,{...invoice,company_name:user.company_name},pdfBuffer);
    const [previous]=await executeQuery("SELECT dedupe_key FROM email_outbox WHERE user_id=? AND document_id=? AND kind='RECEIPT' ORDER BY id DESC LIMIT 1",[req.user.id,id]);
    const key=req.body.resend_key ? `receipt:${id}:resend:${req.body.resend_key}` : previous?.dedupe_key || `receipt:${id}:full`;
    const job=await queueEmail({userId:req.user.id,documentId:id,kind:'RECEIPT',key,mail});
    return emailResult(res,await deliverEmail(job.id,emailService.transporter,{retry:true}));
  } catch (error) { logger.error('Error sending receipt:', error); res.status(500).json({ message: 'Failed to send receipt' }); }
});

app.put('/api/invoices/:id', authenticateToken, validate(invoiceRules), async (req, res) => {
  try {
    const { id } = req.params;
    const { customer_id, issue_date, due_date: reqDueDate, payment_terms: reqTerms, notes, terms_conditions, items, currency_id: reqCurrencyId, is_recurring, recurrence_interval, recurrence_end_date, auto_send } = req.body;
    const existing = await executeQuery(`SELECT id, status, currency_id, issue_date, is_recurring, recurrence_interval, (SELECT COUNT(*) FROM payments p WHERE p.document_id = documents.id) AS payment_count FROM documents WHERE id = ? AND user_id = ? AND type = 'INVOICE'`, [id, req.user.id]);
    if (existing.length === 0) return res.status(404).json({ message: 'Invoice not found' });
    if (existing[0].status !== 'DRAFT') return res.status(400).json({ message: 'Only DRAFT invoices can be edited' });
    // A payment is evidence the customer was billed these amounts. Letting the
    // lines change underneath it could leave the total below what was paid.
    if (Number(existing[0].payment_count) > 0) return res.status(400).json({ message: 'This invoice has payments recorded against it and can no longer be edited' });
    if (!customer_id || !issue_date || !items || items.length === 0) return res.status(400).json({ message: 'Customer, issue date, and at least one line item are required' });
    const customers = await executeQuery('SELECT id FROM customers WHERE id = ? AND user_id = ? AND active = 1', [customer_id, req.user.id]);
    if (customers.length === 0) return res.status(400).json({ message: 'Invalid customer' });
    const prepared = await prepareDocument(executeQuery, req.user.id, 'INVOICE', { ...req.body, currency_id: reqCurrencyId ?? existing[0].currency_id });
    const { lines: lineItems, subtotal, vat_amount, total, notes: effectiveNotes } = prepared;
    const payment_terms = prepared.payment_terms;
    const due_date = resolveDueDate(issue_date, reqDueDate, payment_terms);
    const conn = await getConnection();
    try {
      await new Promise((resolve, reject) => conn.beginTransaction(err => err ? reject(err) : resolve()));
      const locked = await queryOn(conn, `SELECT d.status, EXISTS(SELECT 1 FROM document_snapshots s WHERE s.document_id=d.id) AS frozen
        FROM documents d WHERE d.id=? AND d.user_id=? FOR UPDATE`, [id, req.user.id]);
      if (!locked.length || locked[0].status !== 'DRAFT' || locked[0].frozen) {
        throw Object.assign(new Error('Issued documents can no longer be edited'), { status: 400 });
      }

      let newCurrencyId = existing[0].currency_id;
      if (reqCurrencyId) { const currRows = await executeQuery('SELECT id FROM currencies WHERE id = ? AND is_active = 1', [reqCurrencyId]); if (currRows.length > 0) newCurrencyId = reqCurrencyId; }
      // An edit that leaves out is_recurring is not touching the schedule, so the
      // stored recurrence columns are kept rather than reset to a one-off.
      let recurSql = '';
      const recurParams = [];
      if (is_recurring !== undefined) {
        const recurringFlag = is_recurring ? 1 : 0, recurInterval = recurringFlag && recurrence_interval ? recurrence_interval : null;
        const recurEndDate = recurringFlag && recurrence_end_date ? recurrence_end_date : null, autoSendFlag = recurringFlag && auto_send ? 1 : 0;
        recurSql = ', is_recurring=?, recurrence_interval=?, recurrence_end_date=?, auto_send=?';
        recurParams.push(recurringFlag, recurInterval, recurEndDate, autoSendFlag);
        // A source invoice stays DRAFT while the cron generates copies from it, so
        // its next run may already be past issue_date. Recomputing from issue_date
        // when the schedule itself is unchanged would rewind it and duplicate a run.
        const scheduleUnchanged = recurringFlag && existing[0].is_recurring && existing[0].recurrence_interval === recurInterval && existing[0].issue_date === issue_date;
        if (!scheduleUnchanged) {
          recurSql += ', recurrence_anchor_date=?, recurrence_next_date=?';
          recurParams.push(recurringFlag ? issue_date : null);
          recurParams.push(recurringFlag && recurInterval ? advanceDate(issue_date, recurInterval, issue_date) : null);
        }
      }
      await new Promise((resolve, reject) => conn.query(
        `UPDATE documents SET customer_id=?, issue_date=?, due_date=?, payment_terms=?, currency_id=?, subtotal=?, vat_amount=?, total=?, notes=?, terms_conditions=?, purchase_order_ref=?, delivery_details=?${recurSql}, updated_at=NOW() WHERE id=? AND user_id=?`,
        [customer_id, issue_date, due_date, payment_terms, newCurrencyId, subtotal.toFixed(2), vat_amount.toFixed(2), total.toFixed(2), effectiveNotes || null, terms_conditions || null, req.body.purchase_order_ref || null, req.body.delivery_details || null, ...recurParams, id, req.user.id],
        (err, r) => err ? reject(err) : resolve(r)
      ));
      await new Promise((resolve, reject) => conn.query('DELETE FROM document_items WHERE document_id = ?', [id], (err, r) => err ? reject(err) : resolve(r)));
      for (const item of lineItems) { await new Promise((resolve, reject) => conn.query('INSERT INTO document_items (document_id, product_id, description, quantity, unit_label, unit_price, discount_percent, vat_rate, vat_inclusive, vat_amount, subtotal, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, item.product_id || null, item.description, item.quantity, item.unit_label, item.unit_price, item.discount_percent, item.vat_rate, item.vat_inclusive ? 1 : 0, item.vat_amount.toFixed(2), item.subtotal.toFixed(2), item.total.toFixed(2)], (err, r) => err ? reject(err) : resolve(r))); }
      await new Promise((resolve, reject) => conn.commit(err => err ? reject(err) : resolve()));
      conn.release();
      const invoice = await executeQuery(`SELECT d.*, c.name AS customer_name FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.id = ?`, [id]);
      const itemsResult = await executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]);
      res.json({ ...invoice[0], items: itemsResult });
    } catch (txError) { await new Promise(resolve => conn.rollback(resolve)); conn.release(); throw txError; }
  } catch (error) { logger.error('Error updating invoice:', error); res.status(error.status || 500).json({ message: error.status ? error.message : 'Failed to update invoice' }); }
});

async function queueInvoiceEmail(id,userId,key=`invoice:${id}:initial`) {
    await issueDocument(id, userId, 'INVOICE', { requireEmail: true });
    const [invoices, items, users, logoRows] = await Promise.all([
      queryDecrypted(decryptCustomerJoin, `SELECT d.*, (SELECT COALESCE(SUM(pp.amount), 0) FROM payments pp WHERE pp.document_id = d.id) AS amount_paid, c.name AS customer_name, c.email AS customer_email, c.billing_address AS customer_billing_address, c.vat_number AS customer_vat_number, cur.symbol AS currency_symbol, cur.code AS currency_code FROM documents d JOIN customers c ON c.id = d.customer_id LEFT JOIN currencies cur ON cur.id = d.currency_id WHERE d.id = ? AND d.user_id = ? AND d.type = 'INVOICE'`, [id, userId]),
      executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]),
      queryDecrypted(decryptUserRow, 'SELECT * FROM users WHERE id = ?', [userId]),
      executeQuery("SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'company_logo'", [userId])
    ]);
    if (invoices.length === 0) throw Object.assign(new Error('Invoice not found'),{status:404});
    const invoice = await withInvoiceFinancials(executeQuery,invoices[0]);
    const logoRelPath = logoRows[0]?.setting_value || null;
    const user = await documentSeller(executeQuery, id, { ...decryptUserRow(users[0]), logo_path: logoRelPath ? path.join(__dirname, logoRelPath) : null });
    if (!['SENT','OVERDUE'].includes(invoice.status)) throw Object.assign(new Error('Only unpaid issued invoices can be emailed'),{status:400});
    if (!invoice.customer_email) throw Object.assign(new Error('This customer has no email address on file'),{status:400});
    // The invoice is SENT by the end of this request, so eligibility is judged
    // on that rather than on the DRAFT it may still be right now.
    const pay_url = await resolvePayUrl({ ...invoice, status: 'SENT' }, user);
    const pdfBuffer = await buildInvoicePdf({ ...invoice, pay_url }, items, user);
    const mail=await captureEmail(emailService,'sendInvoiceEmail',invoice.customer_email,
      {...invoice,pay_url,company_name:user.company_name,bank_name:user.bank_name,bank_account_number:user.bank_account_number,bank_branch_code:user.bank_branch_code},pdfBuffer);
    return queueEmail({userId,documentId:id,kind:'INVOICE',key,mail});
}

function emailResult(res,result) {
  const accepted=result.status==='ACCEPTED';
  return res.status(accepted ? 200 : result.status==='SENDING' || result.status==='QUEUED' ? 202 : 207).json({
    message:accepted ? 'Email accepted by the email provider.' : result.error || (result.status==='UNCERTAIN' ? 'Email acceptance is uncertain. Check your email provider before resending.' : 'Email queued for delivery.'),
    delivery_status:result.status,emailFailed:['FAILED','UNCERTAIN'].includes(result.status)});
}

app.post('/api/invoices/:id/send',authenticateToken,validate([
  body('resend_key').optional().isUUID(),
]),async(req,res)=>{
  try {
    const id=req.params.id;
    const [previous]=await executeQuery("SELECT dedupe_key FROM email_outbox WHERE user_id=? AND document_id=? AND kind='INVOICE' ORDER BY id DESC LIMIT 1",[req.user.id,id]);
    const key=req.body.resend_key ? `invoice:${id}:resend:${req.body.resend_key}` : previous?.dedupe_key || `invoice:${id}:initial`;
    const job=await queueInvoiceEmail(id,req.user.id,key);
    return emailResult(res,await deliverEmail(job.id,emailService.transporter,{retry:true}));
  } catch(error) {logger.error('Error queueing invoice email:',error);res.status(error.status || 500).json({message:error.status ? error.message : 'Failed to queue invoice email'});}
});

app.post('/api/invoices/:id/mark-paid', authenticateToken, validate([
  body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than 0'),
  body('payment_date').isDate().withMessage('A valid payment date is required'),
  body('payment_method').isIn(['PAYFLEX','PAYFAST','CARDANO','BANK_TRANSFER','OTHER']).withMessage('Choose a valid payment method'),
  body('transaction_reference').optional().trim(),
  body('notes').optional().trim(),
]), async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, payment_date, payment_method, transaction_reference, notes } = req.body;
    if (!amount || !payment_date || !payment_method) return res.status(400).json({ message: 'Amount, payment date, and payment method are required' });
    const invoices = await executeQuery(`SELECT id, total, status FROM documents WHERE id = ? AND user_id = ? AND type = 'INVOICE'`, [id, req.user.id]);
    if (invoices.length === 0) return res.status(404).json({ message: 'Invoice not found' });
    if (invoices[0].status === 'CANCELLED') return res.status(400).json({ message: 'Cannot record payment on a cancelled invoice' });
    if (['PAID','CREDITED'].includes(invoices[0].status)) return res.status(400).json({ message: 'This invoice is already settled' });
    // Ownership was established by the SELECT above, so the shared helper does
    // not re-check user_id. It runs all three writes in one transaction, which
    // this route previously did not.
    const outcome = await recordInvoicePayment({
      invoiceId: id,
      amount: Number(amount).toFixed(2),
      paymentDate: payment_date,
      method: payment_method,
      reference: transaction_reference || null,
      notes: notes || null,
      // A manual entry is a typo until proven otherwise. PayFast cannot be
      // refused — that money has already moved — so only this path rejects.
      rejectOverpayment: true,
    });
    if (outcome.overpayment) {
      return res.status(400).json({ message: `Amount exceeds the outstanding balance of ${Number(outcome.balanceBefore).toFixed(2)}`, balance_due: Number(outcome.balanceBefore).toFixed(2) });
    }
    res.status(201).json({
      message: outcome.settled ? 'Payment recorded — invoice paid in full' : `Payment recorded — ${outcome.balanceAfter.toFixed(2)} still outstanding`,
      settled: outcome.settled,
      balance_due: outcome.balanceAfter.toFixed(2),
    });
  } catch (error) { logger.error('Error recording payment:', error); res.status(error.status || 500).json({ message: error.status ? error.message : 'Failed to record payment' }); }
});

// Allow local settlement review while production acceptance is pending.
const adjustmentGate = (_req,res,next) => adjustmentsEnabled()
  ? next() : res.status(503).json({message:'Invoice adjustments are not available yet'});
const validAdjustmentKey = value => typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

app.get('/api/invoices/:id/adjustments', authenticateToken, adjustmentGate, async (req,res) => {
  try {
    const [invoice] = await executeQuery("SELECT id FROM documents WHERE id=? AND user_id=? AND type='INVOICE'",[req.params.id,req.user.id]);
    if (!invoice) return res.status(404).json({message:'Invoice not found'});
    const [credits,refunds,summary] = await Promise.all([
      executeQuery('SELECT id,document_number,issue_date,reason,description,subtotal,vat_amount,total,created_at FROM credit_notes WHERE invoice_id=? ORDER BY id',[invoice.id]),
      executeQuery('SELECT id,payment_id,amount,refund_date,method,reference,reason,created_at FROM payment_refunds WHERE invoice_id=? ORDER BY id',[invoice.id]),
      invoiceSettlement(executeQuery,invoice.id),
    ]);
    res.json({credits,refunds:refunds.map(row=>({...row,reference:decryptField('payment_refunds','reference',row.reference)})),summary});
  } catch(error) { logger.error('Error loading invoice adjustments:',error); res.status(500).json({message:'Could not load adjustments'}); }
});

app.get('/api/invoices/:id/credit-notes/:noteId/pdf',authenticateToken,adjustmentGate,async(req,res)=>{
  try {
    const [row]=await queryDecrypted(decryptCustomerJoin,`SELECT cn.*,d.document_number AS invoice_number,d.issue_date AS invoice_issue_date,
      c.name AS customer_name,c.billing_address AS customer_billing_address,cur.symbol AS currency_symbol
      FROM credit_notes cn JOIN documents d ON d.id=cn.invoice_id JOIN customers c ON c.id=d.customer_id
      JOIN currencies cur ON cur.id=d.currency_id WHERE cn.id=? AND cn.invoice_id=? AND cn.user_id=? AND d.user_id=?`,[req.params.noteId,req.params.id,req.user.id,req.user.id]);
    if (!row) return res.status(404).json({message:'Credit note not found'});
    const [user]=await queryDecrypted(decryptUserRow,'SELECT * FROM users WHERE id=?',[req.user.id]);
    const seller=await documentSeller(executeQuery,req.params.id,user);
    const [invoice]=await hydrateDocumentSnapshots(executeQuery,[{id:Number(req.params.id),document_number:row.invoice_number,issue_date:row.invoice_issue_date,customer_name:row.customer_name,customer_billing_address:row.customer_billing_address,currency_symbol:row.currency_symbol}]);
    const pdf=await buildCreditNotePdf(row,invoice,seller);
    res.set({'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${row.document_number}.pdf"`,'Content-Length':pdf.length,'Cache-Control':'no-store'}).send(pdf);
  } catch(error) { logger.error('Error generating credit note PDF:',error); res.status(500).json({message:'Could not generate credit note'}); }
});

app.post('/api/invoices/:id/credit-notes', authenticateToken, adjustmentGate, async (req,res) => {
  try {
    if (!validAdjustmentKey(req.body.request_key)) return res.status(422).json({message:'A request key is required'});
    const result=await withTransaction(async q => {
      const [invoice]=await q("SELECT id,status,subtotal,vat_amount,total FROM documents WHERE id=? AND user_id=? AND type='INVOICE' FOR UPDATE",[req.params.id,req.user.id]);
      if (!invoice) throw Object.assign(new Error('Invoice not found'),{status:404});
      if (['DRAFT','CANCELLED'].includes(invoice.status)) throw Object.assign(new Error('Issue the invoice before crediting it'),{status:422});
      const subtotal=adjustmentMoney(req.body.subtotal,'Subtotal');
      const vat=adjustmentMoney(req.body.vat_amount,'VAT');
      const total=adjustmentMoney(req.body.total,'Total');
      if (total<=0 || Math.round((subtotal+vat)*100)!==Math.round(total*100)) throw Object.assign(new Error('Subtotal plus VAT must equal a positive total'),{status:422});
      const reason=String(req.body.reason || '').trim();
      const description=String(req.body.description || '').trim();
      if (!reason || reason.length>500 || !description || description.length>1000) throw Object.assign(new Error('A reason and description are required'),{status:422});
      const [existing]=await q('SELECT id,invoice_id,document_number,subtotal,vat_amount,total,reason,description FROM credit_notes WHERE user_id=? AND request_key=?',[req.user.id,req.body.request_key]);
      if (existing) {
        if (Number(existing.invoice_id)!==Number(invoice.id) || Number(existing.subtotal)!==subtotal || Number(existing.vat_amount)!==vat || Number(existing.total)!==total || existing.reason!==reason || existing.description!==description) throw Object.assign(new Error('Request key was used for a different credit note'),{status:409});
        return {id:existing.id,document_number:existing.document_number,summary:await invoiceSettlement(q,invoice.id),replayed:true};
      }
      const [prior]=await q('SELECT COALESCE(SUM(subtotal),0) AS subtotal,COALESCE(SUM(vat_amount),0) AS vat,COALESCE(SUM(total),0) AS total FROM credit_notes WHERE invoice_id=?',[invoice.id]);
      if (subtotal+Number(prior.subtotal)>Number(invoice.subtotal)+0.001 || vat+Number(prior.vat)>Number(invoice.vat_amount)+0.001 || total+Number(prior.total)>Number(invoice.total)+0.001) throw Object.assign(new Error('Credit exceeds the original invoice amounts'),{status:422});
      await captureDocumentSnapshot(q,invoice.id);
      const issued=await q('INSERT INTO credit_notes(user_id,invoice_id,request_key,issue_date,reason,description,subtotal,vat_amount,total) VALUES(?,?,?,?,?,?,?,?,?)',[req.user.id,invoice.id,req.body.request_key,todayIso(),reason,description,subtotal.toFixed(2),vat.toFixed(2),total.toFixed(2)]);
      const number=`CN-${String(issued.insertId).padStart(8,'0')}`;
      await q('UPDATE credit_notes SET document_number=? WHERE id=?',[number,issued.insertId]);
      await q("INSERT INTO document_tracking(document_id,event_type) VALUES(?,'CREDIT_NOTE')",[invoice.id]);
      const summary=await invoiceSettlement(q,invoice.id);
      await q("UPDATE documents SET status=CASE WHEN ?=0 AND ?=0 THEN 'CREDITED' WHEN ?=0 THEN 'PAID' WHEN due_date<CURDATE() THEN 'OVERDUE' ELSE 'SENT' END,updated_at=NOW() WHERE id=?",[summary.balanceDue,summary.adjustedTotal,summary.balanceDue,invoice.id]);
      return {id:issued.insertId,document_number:number,summary};
    });
    res.status(result.replayed ? 200 : 201).json(result);
  } catch(error) { logger.error('Error issuing credit note:',error); res.status(error.status || 500).json({message:error.status ? error.message : 'Could not issue credit note'}); }
});

app.post('/api/invoices/:id/refunds', authenticateToken, adjustmentGate, async (req,res) => {
  try {
    if (!validAdjustmentKey(req.body.request_key)) return res.status(422).json({message:'A request key is required'});
    const result=await withTransaction(async q => {
      const [invoice]=await q("SELECT id,status FROM documents WHERE id=? AND user_id=? AND type='INVOICE' FOR UPDATE",[req.params.id,req.user.id]);
      if (!invoice) throw Object.assign(new Error('Invoice not found'),{status:404});
      const [payment]=await q('SELECT id,amount FROM payments WHERE id=? AND document_id=?',[req.body.payment_id,invoice.id]);
      if (!payment) throw Object.assign(new Error('Payment not found on this invoice'),{status:404});
      const amount=adjustmentMoney(req.body.amount,'Refund');
      const reason=String(req.body.reason || '').trim();
      const method=String(req.body.method || '').trim();
      const reference=String(req.body.reference || '').trim();
      if (!reason || reason.length>500 || !['BANK_TRANSFER','PAYFAST','CARD','CASH','OTHER'].includes(method) || reference.length>255) throw Object.assign(new Error('A reason and valid refund method are required'),{status:422});
      const date=String(req.body.refund_date || '');
      if (!validAdjustmentDate(date)) throw Object.assign(new Error('A valid refund date is required'),{status:422});
      const [existing]=await q("SELECT id,invoice_id,payment_id,amount,DATE_FORMAT(refund_date,'%Y-%m-%d') AS refund_date,method,reference,reason FROM payment_refunds WHERE user_id=? AND request_key=?",[req.user.id,req.body.request_key]);
      if (existing) {
        if (Number(existing.invoice_id)!==Number(invoice.id) || Number(existing.payment_id)!==Number(payment.id) || Number(existing.amount)!==amount || existing.refund_date!==date || existing.method!==method || (decryptField('payment_refunds','reference',existing.reference) || '')!==reference || existing.reason!==reason) throw Object.assign(new Error('Request key was used for a different refund'),{status:409});
        return {id:existing.id,summary:await invoiceSettlement(q,invoice.id),replayed:true};
      }
      const [prior]=await q('SELECT COALESCE(SUM(amount),0) AS amount FROM payment_refunds WHERE payment_id=?',[payment.id]);
      if (amount<=0 || amount+Number(prior.amount)>Number(payment.amount)+0.001) throw Object.assign(new Error('Refund exceeds the unrefunded payment'),{status:422});
      const inserted=await q('INSERT INTO payment_refunds(user_id,invoice_id,payment_id,request_key,amount,refund_date,method,reference,reason) VALUES(?,?,?,?,?,?,?,?,?)',[req.user.id,invoice.id,payment.id,req.body.request_key,amount.toFixed(2),date,method,encryptField('payment_refunds','reference',reference || null),reason]);
      await q("INSERT INTO document_tracking(document_id,event_type) VALUES(?,'REFUND')",[invoice.id]);
      const summary=await invoiceSettlement(q,invoice.id);
      await q("UPDATE documents SET status=CASE WHEN ?=0 AND ?=0 THEN 'CREDITED' WHEN ?=0 THEN 'PAID' WHEN due_date<CURDATE() THEN 'OVERDUE' ELSE 'SENT' END,updated_at=NOW() WHERE id=?",[summary.balanceDue,summary.adjustedTotal,summary.balanceDue,invoice.id]);
      return {id:inserted.insertId,summary};
    });
    res.status(result.replayed ? 200 : 201).json(result);
  } catch(error) { logger.error('Error recording refund:',error); res.status(error.status || 500).json({message:error.status ? error.message : 'Could not record refund'}); }
});

app.post('/api/invoices/:id/cancel', authenticateToken, async (req, res) => {
  try {
    await withTransaction(async q => {
      const [invoice] = await q("SELECT id,status FROM documents WHERE id=? AND user_id=? AND type='INVOICE' FOR UPDATE", [req.params.id, req.user.id]);
      if (!invoice) throw Object.assign(new Error('Invoice not found'), { status: 404 });
      const [{ paid }] = await q('SELECT COALESCE(SUM(amount),0) AS paid FROM payments WHERE document_id=?', [invoice.id]);
      if (Number(paid)>0 || ['PAID','CREDITED'].includes(invoice.status)) throw Object.assign(new Error('This invoice has payments or credits and cannot be cancelled'), { status: 400 });
      const [{ credits }] = await q('SELECT COUNT(*) AS credits FROM credit_notes WHERE invoice_id=?',[invoice.id]);
      if (Number(credits)>0) throw Object.assign(new Error('This invoice has issued credit notes and cannot be cancelled'),{status:400});
      if (invoice.status==='CANCELLED') throw Object.assign(new Error('Invoice is already cancelled'), { status: 400 });
      await q("UPDATE documents SET status='CANCELLED',is_recurring=0,recurrence_next_date=NULL,updated_at=NOW() WHERE id=?", [invoice.id]);
      await q("INSERT INTO document_tracking(document_id,event_type) VALUES(?,'CANCELLED')", [invoice.id]);
    });
    res.json({ message: 'Invoice cancelled successfully' });
  } catch(error) { res.status(error.status || 500).json({ message: error.status ? error.message : 'Cancellation failed' }); }
});

app.put('/api/invoices/:id/notifications', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { muted } = req.body;
    if (typeof muted !== 'boolean') return res.status(400).json({ message: 'muted must be a boolean' });
    const invoices = await executeQuery(`SELECT id FROM documents WHERE id = ? AND user_id = ? AND type = 'INVOICE'`, [id, req.user.id]);
    if (invoices.length === 0) return res.status(404).json({ message: 'Invoice not found' });
    await executeQuery(`UPDATE documents SET notifications_muted = ?, updated_at = NOW() WHERE id = ? AND user_id = ?`, [muted ? 1 : 0, id, req.user.id]);
    res.json({ message: muted ? 'Notifications muted for this invoice' : 'Notifications enabled for this invoice', notifications_muted: muted });
  } catch (error) { logger.error('Error updating invoice notifications:', error); res.status(500).json({ message: 'Failed to update notification settings' }); }
});

app.post('/api/invoices/:id/share', authenticateToken, validate([body('rotate').optional().isBoolean().toBoolean()]), async (req,res) => {
  try {
    await issueDocument(req.params.id,req.user.id,'INVOICE',{allowFinal:true});
    const link = await shareDocument(req.user.id,req.params.id,{rotate:req.body.rotate===true});
    const origin = (process.env.APP_URL || 'http://localhost:4200').replace(/\/$/,'');
    res.json({...link,share_url:`${origin}/portal/invoice/${link.token}`});
  } catch(error) { res.status(error.status || 500).json({message:error.status ? error.message : 'Failed to create share link'}); }
});
app.delete('/api/invoices/:id/share',authenticateToken,async(req,res)=>{
  try { res.json(await shareDocument(req.user.id,req.params.id,{revoke:true})); }
  catch(error) { res.status(error.status || 500).json({message:error.status ? error.message : 'Failed to revoke share link'}); }
});

app.get('/api/quotes', authenticateToken, async (req, res) => {
  try {
    const search = req.query.search || '', status = req.query.status || '';
    const page = Math.max(1, parseInt(req.query.page) || 1), limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20)), offset = (page - 1) * limit;
    const currentDay = todayIso();
    let sql = `SELECT d.id, d.document_number, CASE WHEN d.status='SENT' AND d.valid_until < ? THEN 'EXPIRED' ELSE d.status END AS status, d.issue_date, d.due_date, d.valid_until, d.subtotal, d.vat_amount, d.total, d.created_at, (SELECT code FROM currencies WHERE id=d.currency_id) AS currency_code, c.name AS customer_name FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.user_id = ? AND d.type = 'QUOTE'`;
    let cntSql = `SELECT COUNT(*) AS total FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.user_id = ? AND d.type = 'QUOTE'`;
    const params = [currentDay, req.user.id], cntParams = [req.user.id];
    if (status) {
      const clause = status === 'EXPIRED' ? " AND d.status='SENT' AND d.valid_until < ?" : status === 'SENT' ? " AND d.status='SENT' AND (d.valid_until IS NULL OR d.valid_until >= ?)" : ' AND d.status = ?';
      sql += clause; cntSql += clause;
      params.push(status === 'EXPIRED' || status === 'SENT' ? currentDay : status);
      cntParams.push(status === 'EXPIRED' || status === 'SENT' ? currentDay : status);
    }
    if (search) { const clause = ' AND (d.document_number LIKE ? OR c.name LIKE ?)'; sql += clause; cntSql += clause; params.push(`%${search}%`, `%${search}%`); cntParams.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY d.created_at DESC LIMIT ? OFFSET ?'; params.push(limit, offset);
    const [quotes, countResult] = await Promise.all([executeQuery(sql, params), executeQuery(cntSql, cntParams)]);
    res.json({ data: await hydrateDocumentSnapshots(executeQuery, quotes), total: countResult[0].total, page, limit });
  } catch (error) { logger.error('Error fetching quotes:', error); res.status(500).json({ message: 'Failed to fetch quotes' }); }
});

app.post('/api/quotes', authenticateToken, validate(quoteRules), async (req, res) => {
  try {
    res.status(201).json(await createDocument(req.user.id, 'QUOTE', req.body));
  } catch (error) { logger.error('Document creation failed:', error); res.status(error.status || 500).json({ message: error.status ? error.message : 'Failed to create document' }); }
});

app.get('/api/quotes/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [quotes, items, tracking, converted_invoices] = await Promise.all([
      queryDecrypted(decryptCustomerJoin, `SELECT d.*, DATE_FORMAT(d.valid_until,'%Y-%m-%d') AS valid_until_iso, c.name AS customer_name, c.email AS customer_email, c.billing_address AS customer_billing_address, c.vat_number AS customer_vat_number, cur.symbol AS currency_symbol, cur.code AS currency_code FROM documents d JOIN customers c ON c.id = d.customer_id LEFT JOIN currencies cur ON cur.id = d.currency_id WHERE d.id = ? AND d.user_id = ? AND d.type = 'QUOTE'`, [id, req.user.id]),
      executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]),
      executeQuery('SELECT id, document_id, event_type, event_date FROM document_tracking WHERE document_id = ? ORDER BY event_date ASC', [id]),
      executeQuery(`SELECT id, document_number, status, created_at FROM documents WHERE source_quote_id = ? AND user_id = ? AND type = 'INVOICE' ORDER BY id ASC`, [id, req.user.id])
    ]);
    if (quotes.length === 0) return res.status(404).json({ message: 'Quote not found' });
    const quote = quotes[0];
    res.json({ ...quote, status: quote.status === 'SENT' && quote.valid_until_iso && quote.valid_until_iso < todayIso() ? 'EXPIRED' : quote.status, items, tracking, converted_invoices });
  } catch (error) { logger.error('Error fetching quote:', error); res.status(500).json({ message: 'Failed to fetch quote' }); }
});

app.get('/api/quotes/:id/pdf', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [quotes, items, users, logoRows] = await Promise.all([
      queryDecrypted(decryptCustomerJoin, `SELECT d.*, c.name AS customer_name, c.email AS customer_email, c.billing_address AS customer_billing_address, c.vat_number AS customer_vat_number, cur.symbol AS currency_symbol, cur.code AS currency_code FROM documents d JOIN customers c ON c.id = d.customer_id LEFT JOIN currencies cur ON cur.id = d.currency_id WHERE d.id = ? AND d.user_id = ? AND d.type = 'QUOTE'`, [id, req.user.id]),
      executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]),
      queryDecrypted(decryptUserRow, 'SELECT * FROM users WHERE id = ?', [req.user.id]),
      executeQuery("SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'company_logo'", [req.user.id])
    ]);
    if (quotes.length === 0) return res.status(404).json({ message: 'Quote not found' });
    const logoRelPath = logoRows[0]?.setting_value || null;
    const user = await documentSeller(executeQuery, id, { ...decryptUserRow(users[0]), logo_path: logoRelPath ? path.join(__dirname, logoRelPath) : null });
    const pdfBuffer = await buildQuotePdf(quotes[0], items, user);
    await executeQuery(`INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'DOWNLOADED')`, [id]);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${quotes[0].document_number}.pdf"`, 'Content-Length': pdfBuffer.length });
    res.send(pdfBuffer);
  } catch (error) { logger.error('Error generating quote PDF:', error); res.status(500).json({ message: 'Failed to generate PDF' }); }
});

app.put('/api/quotes/:id', authenticateToken, validate(quoteRules), async (req, res) => {
  try {
    const { id } = req.params;
    const { customer_id, issue_date, valid_until, payment_terms: reqTerms, notes, terms_conditions, items, currency_id: reqCurrencyId } = req.body;
    const existing = await executeQuery(`SELECT id, status, currency_id FROM documents WHERE id = ? AND user_id = ? AND type = 'QUOTE'`, [id, req.user.id]);
    if (existing.length === 0) return res.status(404).json({ message: 'Quote not found' });
    if (existing[0].status !== 'DRAFT') return res.status(400).json({ message: 'Only DRAFT quotes can be edited' });
    if (!customer_id || !issue_date || !items || items.length === 0) return res.status(400).json({ message: 'Customer, issue date, and at least one line item are required' });
    const customers = await executeQuery('SELECT id FROM customers WHERE id = ? AND user_id = ? AND active = 1', [customer_id, req.user.id]);
    if (customers.length === 0) return res.status(400).json({ message: 'Invalid customer' });
    const prepared = await prepareDocument(executeQuery, req.user.id, 'QUOTE', { ...req.body, currency_id: reqCurrencyId ?? existing[0].currency_id });
    const { lines: lineItems, subtotal, vat_amount, total, notes: effectiveNotes } = prepared;
    const payment_terms = prepared.payment_terms;
    const conn = await getConnection();
    try {
      await new Promise((resolve, reject) => conn.beginTransaction(err => err ? reject(err) : resolve()));
      const locked = await queryOn(conn, `SELECT d.status, EXISTS(SELECT 1 FROM document_snapshots s WHERE s.document_id=d.id) AS frozen
        FROM documents d WHERE d.id=? AND d.user_id=? FOR UPDATE`, [id, req.user.id]);
      if (!locked.length || locked[0].status !== 'DRAFT' || locked[0].frozen) {
        throw Object.assign(new Error('Issued documents can no longer be edited'), { status: 400 });
      }

      let newCurrencyId = existing[0].currency_id;
      if (reqCurrencyId) { const currRows = await executeQuery('SELECT id FROM currencies WHERE id = ? AND is_active = 1', [reqCurrencyId]); if (currRows.length > 0) newCurrencyId = reqCurrencyId; }
      await new Promise((resolve, reject) => conn.query(
        `UPDATE documents SET customer_id=?, issue_date=?, valid_until=?, payment_terms=?, currency_id=?, subtotal=?, vat_amount=?, total=?, notes=?, terms_conditions=?, purchase_order_ref=?, delivery_details=?, updated_at=NOW() WHERE id=? AND user_id=?`,
        [customer_id, issue_date, valid_until || null, payment_terms, newCurrencyId, subtotal.toFixed(2), vat_amount.toFixed(2), total.toFixed(2), effectiveNotes || null, terms_conditions || null, req.body.purchase_order_ref || null, req.body.delivery_details || null, id, req.user.id],
        (err, r) => err ? reject(err) : resolve(r)
      ));
      await new Promise((resolve, reject) => conn.query('DELETE FROM document_items WHERE document_id = ?', [id], (err, r) => err ? reject(err) : resolve(r)));
      for (const item of lineItems) { await new Promise((resolve, reject) => conn.query('INSERT INTO document_items (document_id, product_id, description, quantity, unit_label, unit_price, discount_percent, vat_rate, vat_inclusive, vat_amount, subtotal, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, item.product_id || null, item.description, item.quantity, item.unit_label, item.unit_price, item.discount_percent, item.vat_rate, item.vat_inclusive ? 1 : 0, item.vat_amount.toFixed(2), item.subtotal.toFixed(2), item.total.toFixed(2)], (err, r) => err ? reject(err) : resolve(r))); }
      await new Promise((resolve, reject) => conn.commit(err => err ? reject(err) : resolve()));
      conn.release();
      const quote = await executeQuery(`SELECT d.*, c.name AS customer_name FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.id = ?`, [id]);
      const itemsResult = await executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]);
      res.json({ ...quote[0], items: itemsResult });
    } catch (txError) { await new Promise(resolve => conn.rollback(resolve)); conn.release(); throw txError; }
  } catch (error) { logger.error('Error updating quote:', error); res.status(error.status || 500).json({ message: error.status ? error.message : 'Failed to update quote' }); }
});

app.post('/api/quotes/:id/send', authenticateToken, async (req, res) => {
  try {
    await issueDocument(req.params.id, req.user.id, 'QUOTE');
    res.json({ message: 'Quote marked as sent' });
  } catch (error) { logger.error('Error sending quote:', error); res.status(error.status || 500).json({ message: error.status ? error.message : 'Failed to send quote' }); }
});

app.post('/api/quotes/:id/share', authenticateToken, validate([body('rotate').optional().isBoolean().toBoolean()]), async (req, res) => {
  try {
    const [date] = await executeQuery("SELECT status,DATE_FORMAT(valid_until,'%Y-%m-%d') AS valid_until FROM documents WHERE id=? AND user_id=? AND type='QUOTE'", [req.params.id,req.user.id]);
    if (!date) return res.status(404).json({ message:'Quote not found' });
    if (date?.valid_until && date.valid_until < todayIso()) return res.status(400).json({ message:'Cannot share an expired quote' });
    if (!['DRAFT','SENT','ACCEPTED'].includes(date.status)) return res.status(400).json({ message:'This quote can no longer be shared' });
    if (date.status !== 'ACCEPTED') await issueDocument(req.params.id, req.user.id, 'QUOTE');
    const link = await shareDocument(req.user.id, req.params.id, { rotate: req.body.rotate === true, type: 'QUOTE' });
    const origin = (process.env.APP_URL || 'http://localhost:4200').replace(/\/$/, '');
    res.json({ ...link, share_url: `${origin}/portal/quote/${link.token}` });
  } catch (error) { res.status(error.status || 500).json({ message: error.status ? error.message : 'Failed to create quote link' }); }
});
app.delete('/api/quotes/:id/share', authenticateToken, async (req, res) => {
  try { res.json(await shareDocument(req.user.id, req.params.id, { revoke: true, type: 'QUOTE' })); }
  catch (error) { res.status(error.status || 500).json({ message: error.status ? error.message : 'Failed to revoke quote link' }); }
});

app.post('/api/quotes/:id/convert-to-invoice', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const outcome = await withTransaction(async (q) => {
      await lockDocumentOwner(q, req.user.id);
      // Locked so a double-click, or a retry after a dropped connection, waits
      // for the first conversion to commit and then sees its invoice.
      const quotes = await q(`SELECT d.*, DATE_FORMAT(d.valid_until,'%Y-%m-%d') AS valid_until_iso FROM documents d WHERE d.id = ? AND d.user_id = ? AND d.type = 'QUOTE' FOR UPDATE`, [id, req.user.id]);
      if (quotes.length === 0) return { status: 404, body: { message: 'Quote not found' } };
      const quote = quotes[0];
      if (['CANCELLED', 'DECLINED'].includes(quote.status)) return { status: 400, body: { message: 'Cannot convert a cancelled or declined quote' } };
      if (quote.valid_until_iso && quote.valid_until_iso < todayIso()) return { status: 400, body: { message: 'Cannot convert an expired quote' } };

      // One live invoice per quote. Converting again is allowed only once
      // every earlier invoice from it has been cancelled.
      const existing = await q(`SELECT id, document_number FROM documents WHERE source_quote_id = ? AND user_id = ? AND type = 'INVOICE' AND status <> 'CANCELLED' ORDER BY id ASC LIMIT 1`, [id, req.user.id]);
      if (existing.length > 0) {
        return { status: 409, body: { message: `This quote was already converted to invoice ${existing[0].document_number}`, invoice_id: existing[0].id, document_number: existing[0].document_number } };
      }

      await captureDocumentSnapshot(q, id);
      const quoteItems = await q('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]);
      const invoice_number = await getNextDocumentNumber(q, req.user.id, 'INVOICE');
      const issue_date = todayIso();
      const due_date = resolveDueDate(issue_date, null, quote.payment_terms);
      const docResult = await q(
        `INSERT INTO documents (user_id, customer_id, type, document_number, currency_id, status, issue_date, due_date, payment_terms, subtotal, vat_amount, total, notes, terms_conditions, purchase_order_ref, delivery_details, source_quote_id) VALUES (?, ?, 'INVOICE', ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.user.id, quote.customer_id, invoice_number, quote.currency_id, issue_date, due_date, quote.payment_terms, quote.subtotal, quote.vat_amount, quote.total, quote.notes || null, quote.terms_conditions || null, quote.purchase_order_ref, quote.delivery_details, quote.id]
      );
      const invoiceId = docResult.insertId;
      await q("UPDATE documents SET delivery_status='NOT_SENT' WHERE id=?",[invoiceId]);
      for (const item of quoteItems) {
        await q('INSERT INTO document_items (document_id, product_id, description, quantity, unit_label, unit_price, discount_percent, vat_rate, vat_inclusive, vat_amount, subtotal, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [invoiceId, item.product_id || null, item.description, item.quantity, item.unit_label, item.unit_price, item.discount_percent, item.vat_rate, item.vat_inclusive ? 1 : 0, item.vat_amount, item.subtotal, item.total]);
      }
      await q(`INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'CREATED')`, [invoiceId]);
      // CONVERTED, not SENT: conversion says nothing about whether the
      // customer ever received the quote.
      await q(`UPDATE documents SET status = 'CONVERTED', updated_at = NOW() WHERE id = ?`, [id]);
      await q(`INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'CONVERTED')`, [id]);
      return { status: 201, body: { message: `Quote converted to invoice ${invoice_number}`, invoice_id: invoiceId, document_number: invoice_number } };
    });
    res.status(outcome.status).json(outcome.body);
  } catch (error) { logger.error('Error converting quote to invoice:', error); res.status(500).json({ message: 'Failed to convert quote to invoice' }); }
});

// ─── Currencies ───────────────────────────────────────────────────────────────

app.get('/api/currencies', authenticateToken, async (req, res) => {
  try { res.json(await executeQuery('SELECT * FROM currencies WHERE is_active = 1 ORDER BY code ASC')); }
  catch (error) { logger.error('Error fetching currencies:', error); res.status(500).json({ message: 'Failed to fetch currencies' }); }
});

// ─── Products ─────────────────────────────────────────────────────────────────

app.get('/api/products', authenticateToken, async (req, res) => {
  try {
    const search = req.query.search || '';
    const page = Math.max(1, parseInt(req.query.page) || 1), limit = Math.max(1, Math.min(100, parseInt(req.query.limit) || 20)), offset = (page - 1) * limit;
    let sql = 'SELECT * FROM products WHERE user_id = ? AND is_active = 1', cntSql = 'SELECT COUNT(*) AS total FROM products WHERE user_id = ? AND is_active = 1';
    const params = [req.user.id], cntParams = [req.user.id];
    if (search) { const clause = ' AND (name LIKE ? OR description LIKE ?)'; sql += clause; cntSql += clause; params.push(`%${search}%`, `%${search}%`); cntParams.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY name ASC, id ASC LIMIT ? OFFSET ?'; params.push(limit, offset);
    const [products, countResult] = await Promise.all([executeQuery(sql, params), executeQuery(cntSql, cntParams)]);
    res.json({ data: products, total: countResult[0].total, page, limit });
  } catch (error) { logger.error('Error fetching products:', error); res.status(500).json({ message: 'Failed to fetch products' }); }
});

app.post('/api/products', authenticateToken, validate([
  body('name').trim().notEmpty().withMessage('Product name is required'),
  body('price').isFloat({ min: 0 }).withMessage('Price must be a positive number'),
  body('description').optional().trim(),
  body('vat_inclusive').optional().isBoolean().withMessage('vat_inclusive must be true or false').toBoolean(),
]), async (req, res) => {
  try {
    const { name, description, price, vat_inclusive } = req.body;
    if (!name || price == null) return res.status(400).json({ message: 'Name and price are required' });
    const result = await executeQuery('INSERT INTO products (user_id, name, description, price, vat_inclusive) VALUES (?, ?, ?, ?, ?)', [req.user.id, name, description || null, price, vat_inclusive ? 1 : 0]);
    res.status(201).json((await executeQuery('SELECT * FROM products WHERE id = ?', [result.insertId]))[0]);
  } catch (error) { logger.error('Error creating product:', error); res.status(500).json({ message: 'Failed to create product' }); }
});

app.get('/api/products/:id', authenticateToken, async (req, res) => {
  try {
    const product = await executeQuery('SELECT * FROM products WHERE id = ? AND user_id = ? AND is_active = 1', [req.params.id, req.user.id]);
    if (product.length === 0) return res.status(404).json({ message: 'Product not found' });
    res.json(product[0]);
  } catch (error) { logger.error('Error fetching product:', error); res.status(500).json({ message: 'Failed to fetch product' }); }
});

app.put('/api/products/:id', authenticateToken, validate([
  body('name').trim().notEmpty().withMessage('Product name is required'),
  body('price').isFloat({ min: 0 }).withMessage('Price must be a positive number'),
  body('description').optional().trim(),
  body('vat_inclusive').optional().isBoolean().withMessage('vat_inclusive must be true or false').toBoolean(),
]), async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, price, vat_inclusive } = req.body;
    if (!name || price == null) return res.status(400).json({ message: 'Name and price are required' });
    const existing = await executeQuery('SELECT id FROM products WHERE id = ? AND user_id = ? AND is_active = 1', [id, req.user.id]);
    if (existing.length === 0) return res.status(404).json({ message: 'Product not found' });
    await executeQuery('UPDATE products SET name = ?, description = ?, price = ?, vat_inclusive = ?, updated_at = NOW() WHERE id = ? AND user_id = ?', [name, description || null, price, vat_inclusive ? 1 : 0, id, req.user.id]);
    res.json((await executeQuery('SELECT * FROM products WHERE id = ?', [id]))[0]);
  } catch (error) { logger.error('Error updating product:', error); res.status(500).json({ message: 'Failed to update product' }); }
});

app.delete('/api/products/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await executeQuery('SELECT id FROM products WHERE id = ? AND user_id = ? AND is_active = 1', [id, req.user.id]);
    if (existing.length === 0) return res.status(404).json({ message: 'Product not found' });
    await executeQuery('UPDATE products SET is_active = 0, updated_at = NOW() WHERE id = ? AND user_id = ?', [id, req.user.id]);
    res.json({ message: 'Product deleted successfully' });
  } catch (error) { logger.error('Error deleting product:', error); res.status(500).json({ message: 'Failed to delete product' }); }
});

async function reviewCatalogueImport(q, userId, kind, csv) {
  const preview = previewCatalogueCsv(kind,csv);
  const [prior] = await q('SELECT created_count FROM catalogue_import_batches WHERE user_id=? AND kind=? AND content_hash=?',[userId,preview.kind,preview.hash]);
  if (prior) return { ...preview,valid:false,replayed:true,previous_count:prior.created_count };
  for (const row of preview.rows) {
    if (row.errors.length) continue;
    const duplicate = kind === 'customers'
      ? await q('SELECT id FROM customers WHERE user_id=? AND active=1 AND LOWER(email)=? LIMIT 1',[userId,row.data.email.toLowerCase()])
      : await q('SELECT id FROM products WHERE user_id=? AND is_active=1 AND LOWER(name)=? LIMIT 1',[userId,row.data.name.toLowerCase()]);
    if (duplicate.length) row.errors.push(`Already exists: ${kind === 'customers' ? row.data.email : row.data.name}`);
  }
  preview.valid = preview.rows.length > 0 && preview.rows.every(row => row.errors.length === 0);
  return preview;
}

app.get('/api/imports/:kind/template',authenticateToken,(req,res)=>{
  const columns = TEMPLATES[req.params.kind];
  if (!columns) return res.status(404).json({message:'Import template not found'});
  res.set({ 'Content-Type':'text/csv; charset=utf-8','Content-Disposition':`attachment; filename="freevoices-${req.params.kind}-template.csv"` }).send(columns.join(',')+'\r\n');
});
app.post('/api/imports/preview',authenticateToken,async(req,res)=>{
  try { res.json(await reviewCatalogueImport(executeQuery,req.user.id,req.body?.kind,req.body?.csv)); }
  catch(error) { res.status(error.status || 500).json({message:error.status ? error.message : 'Import preview failed'}); }
});
app.post('/api/imports/commit',authenticateToken,async(req,res)=>{
  try {
    const outcome = await withTransaction(async q => {
      await lockDocumentOwner(q,req.user.id);
      const parsed = previewCatalogueCsv(req.body?.kind,req.body?.csv);
      const [prior] = await q('SELECT created_count FROM catalogue_import_batches WHERE user_id=? AND kind=? AND content_hash=?',[req.user.id,parsed.kind,parsed.hash]);
      if (prior) return { count:prior.created_count,replayed:true };
      const preview = await reviewCatalogueImport(q,req.user.id,req.body.kind,req.body.csv);
      if (!preview.valid) return { errors:preview.rows.filter(row => row.errors.length),status:422 };
      for (const row of preview.rows) {
        const d = row.data;
        if (preview.kind === 'customers') await q('INSERT INTO customers(user_id,name,email,billing_address,phone,payment_terms) VALUES(?,?,?,?,?,?)',
          [req.user.id,d.name,d.email.toLowerCase(),encCustomer('billing_address',d.billing_address),encCustomer('phone',d.phone || null),d.payment_terms ? Number(d.payment_terms) : null]);
        else await q('INSERT INTO products(user_id,name,price,description,vat_inclusive) VALUES(?,?,?,?,?)',
          [req.user.id,d.name,Number(d.price).toFixed(2),d.description || null,['true','1'].includes(d.vat_inclusive.toLowerCase()) ? 1 : 0]);
      }
      await q('INSERT INTO catalogue_import_batches(user_id,kind,content_hash,created_count) VALUES(?,?,?,?)',[req.user.id,preview.kind,preview.hash,preview.rows.length]);
      return { count:preview.rows.length,replayed:false };
    });
    res.status(outcome.status || 201).json(outcome.status ? {message:'Fix import errors before saving',errors:outcome.errors} : outcome);
  } catch(error) { logger.error('Catalogue import failed:',error); res.status(error.status || 500).json({message:error.status ? error.message : 'Import failed'}); }
});

async function reviewBankImport(q,userId,csv) {
  const preview=previewBankCsv(csv);
  const currencies=await q('SELECT id,code FROM currencies WHERE is_active=1');
  const byCode=new Map(currencies.map(row=>[row.code,row.id]));
  for (const row of preview.rows) {
    row.currency_id=byCode.get(row.data.currency) || null;
    if (!row.currency_id) row.errors.push('Choose an active currency');
    const [prior]=await q('SELECT id,status FROM bank_import_rows WHERE user_id=? AND source_hash=?',[userId,row.source_hash]);
    row.duplicate=prior ? { id:prior.id,status:prior.status } : null;
  }
  preview.valid=preview.rows.length>0 && preview.rows.every(row=>row.errors.length===0);
  return preview;
}

app.get('/api/bank-imports/template',authenticateToken,(req,res)=>{
  res.set({'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="freevoices-bank-template.csv"'}).send(BANK_HEADER.join(',')+'\r\n');
});
app.post('/api/bank-imports/preview',authenticateToken,async(req,res)=>{
  try { res.json(await reviewBankImport(executeQuery,req.user.id,req.body?.csv)); }
  catch(error) { res.status(error.status || 500).json({message:error.status ? error.message : 'Bank preview failed'}); }
});
app.post('/api/bank-imports/commit',authenticateToken,async(req,res)=>{
  try {
    const outcome=await withTransaction(async q=>{
      await lockDocumentOwner(q,req.user.id);
      const preview=await reviewBankImport(q,req.user.id,req.body?.csv);
      if (!preview.valid) return {status:422,errors:preview.rows.filter(row=>row.errors.length)};
      let created=0,duplicates=0;
      for (const row of preview.rows) {
        if (row.duplicate) {duplicates++;continue;}
        const d=row.data;
        await q(`INSERT INTO bank_import_rows(user_id,currency_id,transaction_date,amount,description,reference,account_label,source_hash)
          VALUES(?,?,?,?,?,?,?,?)`,[req.user.id,row.currency_id,d.date,Number(d.amount).toFixed(2),encryptField('bank_import_rows','description',d.description || null),encryptField('bank_import_rows','reference',d.reference || null),encryptField('bank_import_rows','account_label',d.account || null),row.source_hash]);
        created++;
      }
      return {created,duplicates};
    });
    res.status(outcome.status || 201).json(outcome.status ? {message:'Fix bank CSV errors',errors:outcome.errors} : outcome);
  } catch(error) { logger.error('Bank CSV import failed:',error);res.status(error.status || 500).json({message:error.status ? error.message : 'Bank import failed'}); }
});
app.get('/api/bank-imports',authenticateToken,async(req,res)=>{
  try {
    const status=['PENDING','MATCHED','IGNORED'].includes(req.query.status) ? req.query.status : 'PENDING';
    const rows=await executeQuery(`SELECT b.id,DATE_FORMAT(b.transaction_date,'%Y-%m-%d') AS transaction_date,b.amount,b.description,b.reference,b.account_label,b.status,b.invoice_id,b.payment_id,b.created_at,c.code AS currency_code
      FROM bank_import_rows b JOIN currencies c ON c.id=b.currency_id WHERE b.user_id=? AND b.status=? ORDER BY b.transaction_date DESC,b.id DESC LIMIT 200`,[req.user.id,status]);
    res.set('Cache-Control','no-store').json(rows.map(row=>({ ...row,description:decryptField('bank_import_rows','description',row.description),reference:decryptField('bank_import_rows','reference',row.reference),account_label:decryptField('bank_import_rows','account_label',row.account_label) })));
  } catch(error) { logger.error('Bank review list failed:',error);res.status(500).json({message:'Could not load bank transactions'}); }
});
app.get('/api/bank-imports/:id/suggestions',authenticateToken,async(req,res)=>{
  try {
    const [row]=await executeQuery('SELECT id,currency_id,amount,reference,description,status FROM bank_import_rows WHERE id=? AND user_id=?',[req.params.id,req.user.id]);
    if (!row) return res.status(404).json({message:'Bank transaction not found'});
    if (row.status!=='PENDING' || Number(row.amount)<=0) return res.json([]);
    const reference=decryptField('bank_import_rows','reference',row.reference) || '';
    const description=decryptField('bank_import_rows','description',row.description) || '';
    const invoices=await executeQuery(`SELECT d.id,d.document_number,d.total,c.name AS customer_name,
      COALESCE(p.paid,0)-COALESCE(r.refunded,0) AS amount_paid,COALESCE(cn.credited,0) AS credited
      FROM documents d JOIN customers c ON c.id=d.customer_id LEFT JOIN (SELECT document_id,SUM(amount) AS paid FROM payments GROUP BY document_id) p ON p.document_id=d.id
      LEFT JOIN (SELECT invoice_id,SUM(total) AS credited FROM credit_notes GROUP BY invoice_id) cn ON cn.invoice_id=d.id
      LEFT JOIN (SELECT invoice_id,SUM(amount) AS refunded FROM payment_refunds GROUP BY invoice_id) r ON r.invoice_id=d.id
      WHERE d.user_id=? AND d.currency_id=? AND d.type='INVOICE' AND d.status IN ('SENT','OVERDUE','DRAFT') AND d.total-COALESCE(cn.credited,0)>COALESCE(p.paid,0)-COALESCE(r.refunded,0)
      ORDER BY d.id DESC LIMIT 500`,[req.user.id,row.currency_id]);
    const suggestions=invoices.map(invoice=>{
      const balance=Number(invoice.total)-Number(invoice.credited)-Number(invoice.amount_paid);
      const match=(reference+' '+description).toLowerCase().includes(invoice.document_number.toLowerCase());
      const exact=Math.abs(balance-Number(row.amount))<0.005;
      return { invoice_id:invoice.id,document_number:invoice.document_number,customer_name:invoice.customer_name,balance_due:balance.toFixed(2),reason:match && exact ? 'Reference and amount' : match ? 'Invoice reference' : exact ? 'Exact balance' : null,score:(match ? 2 : 0)+(exact ? 1 : 0) };
    }).filter(item=>item.reason).sort((a,b)=>b.score-a.score).slice(0,5);
    res.set('Cache-Control','no-store').json(suggestions);
  } catch(error) { logger.error('Bank match suggestions failed:',error);res.status(500).json({message:'Could not find suggestions'}); }
});
app.post('/api/bank-imports/:id/match',authenticateToken,validate([body('invoice_id').isInt({min:1})]),async(req,res)=>{
  try {
    const outcome=await withTransaction(async q=>{
      const [row]=await q(`SELECT id,currency_id,DATE_FORMAT(transaction_date,'%Y-%m-%d') AS day,amount,reference,status
        FROM bank_import_rows WHERE id=? AND user_id=? FOR UPDATE`,[req.params.id,req.user.id]);
      if (!row) return {status:404,message:'Bank transaction not found'};
      if (row.status!=='PENDING') return {status:409,message:'This transaction was already reviewed'};
      if (Number(row.amount)<=0) return {status:422,message:'Only incoming payments can match an invoice'};
      const [invoice]=await q("SELECT id,status,currency_id FROM documents WHERE id=? AND user_id=? AND type='INVOICE'",[req.body.invoice_id,req.user.id]);
      if (!invoice) return {status:404,message:'Invoice not found'};
      if (invoice.currency_id!==row.currency_id || ['CANCELLED','PAID'].includes(invoice.status)) return {status:422,message:'Choose an open invoice in the same currency'};
      const result=await recordInvoicePayment({invoiceId:invoice.id,amount:Number(row.amount).toFixed(2),paymentDate:row.day,method:'BANK_TRANSFER',reference:decryptField('bank_import_rows','reference',row.reference) || `bank-import-${row.id}`,notes:`Matched from bank import row ${row.id}`,rejectOverpayment:true},q);
      if (result.overpayment || result.duplicate) return {status:422,message:'Amount exceeds the remaining balance or payment already exists'};
      await q("UPDATE bank_import_rows SET status='MATCHED',invoice_id=?,payment_id=?,decided_at=NOW() WHERE id=?",[invoice.id,result.paymentId,row.id]);
      return {status:200,message:'Payment matched',invoice_id:invoice.id,payment_id:result.paymentId,balance_due:result.balanceAfter.toFixed(2)};
    });
    res.status(outcome.status).json(outcome);
  } catch(error) { logger.error('Bank match failed:',error);res.status(error.status || 500).json({message:error.status ? error.message : 'Could not match transaction'}); }
});
app.post('/api/bank-imports/:id/ignore',authenticateToken,async(req,res)=>{
  try {
    const result=await executeQuery("UPDATE bank_import_rows SET status='IGNORED',decided_at=NOW() WHERE id=? AND user_id=? AND status='PENDING'",[req.params.id,req.user.id]);
    res.status(result.affectedRows ? 200 : 409).json({message:result.affectedRows ? 'Transaction ignored' : 'Transaction not pending'});
  } catch(error) { res.status(500).json({message:'Could not ignore transaction'}); }
});

// ─── Dashboard summary ────────────────────────────────────────────────────────

app.get('/api/dashboard/summary', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const currency = await reportCurrency(executeQuery,userId,req.query.currency,true);
    const dashboardDate = todayIso();
    const [revenueRows, customersRows, openRows, overdueRows, recentRows, logoRows, ageingRows, actionRows] = await Promise.all([
      // Money actually received this month, by payment date. Summing PAID
      // invoice totals counted a R1,150 invoice as R1,150 of revenue after
      // only R400 had come in, and ignored part payments entirely.
      executeQuery(`SELECT
        (SELECT COALESCE(SUM(p.amount),0) FROM payments p JOIN documents d ON d.id=p.document_id WHERE d.user_id=? AND d.type='INVOICE' AND d.currency_id=? AND p.payment_date>=DATE_FORMAT(?,'%Y-%m-01') AND p.payment_date<=?)
        -(SELECT COALESCE(SUM(r.amount),0) FROM payment_refunds r JOIN documents d ON d.id=r.invoice_id WHERE d.user_id=? AND d.type='INVOICE' AND d.currency_id=? AND r.refund_date>=DATE_FORMAT(?,'%Y-%m-01') AND r.refund_date<=?) AS monthRevenue`,[userId,currency.id,dashboardDate,dashboardDate,userId,currency.id,dashboardDate,dashboardDate]),
      executeQuery('SELECT COUNT(*) AS total FROM customers WHERE user_id = ? AND active = 1', [userId]),
      executeQuery(`SELECT COUNT(*) AS total FROM documents d WHERE user_id = ? AND type = 'INVOICE' AND (status IN ('SENT','OVERDUE') OR (status='DRAFT' AND EXISTS(SELECT 1 FROM payments p WHERE p.document_id=d.id)))`, [userId]),
      executeQuery(`SELECT COUNT(*) AS total FROM documents WHERE user_id = ? AND type = 'INVOICE' AND status = 'OVERDUE' AND notifications_muted = 0`, [userId]),
      // FIX: changed c.company_name to c.name — customers table has 'name' not 'company_name'
      executeQuery(`SELECT dt.event_type, dt.event_date, d.document_number, d.type AS document_type, c.name AS customer_name FROM document_tracking dt JOIN documents d ON dt.document_id = d.id JOIN customers c ON d.customer_id = c.id WHERE d.user_id = ? ORDER BY dt.event_date DESC LIMIT 5`, [userId]),
      // Logo for the dashboard identity. The setup checklist separately
      // checks the authenticated owner's saved business settings.
      executeQuery("SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'company_logo'", [userId]),
      executeQuery(`SELECT
        COALESCE(SUM(balance),0) AS outstanding,
        COALESCE(SUM(CASE WHEN due_date IS NULL OR due_date >= ? THEN balance ELSE 0 END),0) AS current_balance,
        COALESCE(SUM(CASE WHEN due_date < ? AND due_date >= DATE_SUB(?, INTERVAL 30 DAY) THEN balance ELSE 0 END),0) AS days_1_30,
        COALESCE(SUM(CASE WHEN due_date < DATE_SUB(?, INTERVAL 30 DAY) AND due_date >= DATE_SUB(?, INTERVAL 60 DAY) THEN balance ELSE 0 END),0) AS days_31_60,
        COALESCE(SUM(CASE WHEN due_date < DATE_SUB(?, INTERVAL 60 DAY) THEN balance ELSE 0 END),0) AS days_61_plus
        FROM (SELECT d.due_date, GREATEST(d.total
          -(SELECT COALESCE(SUM(cn.total),0) FROM credit_notes cn WHERE cn.invoice_id=d.id)
          -(SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.document_id=d.id)
          +(SELECT COALESCE(SUM(r.amount),0) FROM payment_refunds r WHERE r.invoice_id=d.id),0) AS balance
          FROM documents d WHERE d.user_id=? AND d.type='INVOICE' AND d.currency_id=? AND (d.status IN ('SENT','OVERDUE') OR (d.status='DRAFT' AND EXISTS(SELECT 1 FROM payments p WHERE p.document_id=d.id)))) balances`,
        [dashboardDate,dashboardDate,dashboardDate,dashboardDate,dashboardDate,dashboardDate,userId,currency.id]),
      executeQuery(`SELECT d.id,d.document_number,c.name AS customer_name,d.due_date,
        GREATEST(d.total-(SELECT COALESCE(SUM(cn.total),0) FROM credit_notes cn WHERE cn.invoice_id=d.id)
          -(SELECT COALESCE(SUM(p.amount),0) FROM payments p WHERE p.document_id=d.id)
          +(SELECT COALESCE(SUM(r.amount),0) FROM payment_refunds r WHERE r.invoice_id=d.id),0) AS balance_due
        FROM documents d JOIN customers c ON c.id=d.customer_id
        WHERE d.user_id=? AND d.type='INVOICE' AND d.currency_id=? AND (d.status IN ('SENT','OVERDUE') OR (d.status='DRAFT' AND EXISTS(SELECT 1 FROM payments p WHERE p.document_id=d.id)))
        HAVING balance_due>0 ORDER BY d.due_date IS NULL,d.due_date ASC,d.id ASC LIMIT 5`,[userId,currency.id])
    ]);
    const ageing=ageingRows[0];
    res.json({ currency_code:currency.code, monthRevenue: parseFloat(revenueRows[0].monthRevenue), totalCustomers: customersRows[0].total, openInvoices: openRows[0].total, overdueInvoices: overdueRows[0].total, recentActivity: recentRows, companyLogo: logoRows[0]?.setting_value || null,
      outstanding:Number(ageing.outstanding), ageing:{current:Number(ageing.current_balance),days1to30:Number(ageing.days_1_30),days31to60:Number(ageing.days_31_60),days61plus:Number(ageing.days_61_plus)}, actionInvoices:actionRows.map(row=>({...row,balance_due:Number(row.balance_due)})) });
  } catch (error) { logger.error('Error fetching dashboard summary:', error); res.status(error.status || 500).json({ message: error.status ? error.message : 'Failed to fetch dashboard summary' }); }
});

// ─── Settings ─────────────────────────────────────────────────────────────────

// Stays public: the customer portal returns company_logo as a URL and
// buildInvoicePdf reads it off disk. Filenames are now unguessable (see multer
// config above), so hardening is about how it's served, not who can reach it.
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  index: false,
  dotfiles: 'deny',
  maxAge: '7d',
  setHeaders: (res) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Disposition', 'inline');
  }
}));

app.get('/api/settings', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const [userRows, settingRows] = await Promise.all([
      // The merchant key and passphrase are deliberately NOT selected. Asking
      // the database for a boolean instead of fetching-then-deleting means the
      // ciphertext never enters this process at all, so it cannot be leaked by
      // a later refactor, an error handler, or a stray log line.
      executeQuery(`SELECT email, pending_email, company_name, company_registration, vat_number, contact_person, phone, address,
                           bank_name, bank_account_number, bank_branch_code, bank_account_type,
                           payfast_enabled, payfast_merchant_id,
                           (payfast_merchant_key IS NOT NULL) AS payfast_merchant_key_set,
                           (payfast_passphrase IS NOT NULL) AS payfast_passphrase_set
                      FROM users WHERE id = ?`, [userId]),
      executeQuery('SELECT setting_key, setting_value FROM settings WHERE user_id = ?', [userId])
    ]);
    if (userRows.length === 0) return res.status(404).json({ message: 'User not found' });
    const kvSettings = {};
    for (const row of settingRows) kvSettings[row.setting_key] = row.setting_value;
    const user = decryptUserRow(userRows[0]);
    const nextNumber=await withTransaction(q=>getNextDocumentNumber(q,userId,'INVOICE'));
    kvSettings.invoice_next_number=String(BigInt(nextNumber.split('-').at(-1)));
    res.json({
      ...user,
      ...kvSettings,
      // MySQL hands back 1/0 for both the tinyint and the IS NOT NULL tests.
      payfast_enabled: !!user.payfast_enabled,
      payfast_merchant_key_set: !!user.payfast_merchant_key_set,
      payfast_passphrase_set: !!user.payfast_passphrase_set,
    });
  } catch (error) { logger.error('Error fetching settings:', error); res.status(500).json({ message: 'Failed to fetch settings' }); }
});

app.put('/api/settings/profile', authenticateToken, validate([
  body('contact_person').trim().notEmpty(), body('email').isEmail().normalizeEmail(),
  body('phone').optional().trim(), body('new_password').optional().isLength({ min: 8 }),
]), async (req, res) => {
  try {
    const { contact_person, email, phone, current_password, new_password } = req.body;
    const verificationToken = randomUUID();
    const changed = await withTransaction(async q => {
      const [user] = await q('SELECT email,password_hash FROM users WHERE id=? FOR UPDATE', [req.user.id]);
      const changingEmail = email.toLowerCase() !== user.email.toLowerCase();
      if (changingEmail || new_password) {
        if (!user.password_hash) throw Object.assign(new Error('Google sign-in accounts must manage their sign-in email through Google.'), { status: 400 });
        if (!current_password || !await argon2.verify(user.password_hash, current_password)) throw Object.assign(new Error('Confirm your current password to change email or password'), { status: 400 });
      }
      if (changingEmail && (await q('SELECT id FROM users WHERE email=? AND id<>?', [email, req.user.id])).length) throw Object.assign(new Error('That email address is already registered'), { status: 409 });
      await q('UPDATE users SET contact_person=?, phone=? WHERE id=?', [contact_person, encUser('phone', phone || null), req.user.id]);
      if (new_password) {
        await q('UPDATE users SET password_hash=? WHERE id=?', [await argon2.hash(new_password), req.user.id]);
        await q('DELETE FROM sessions WHERE userId=? AND token<>?', [req.user.id, hashToken(req.headers.authorization.split(' ')[1])]);
        await q('DELETE FROM password_reset_tokens WHERE user_id=?', [req.user.id]);
      }
      if (changingEmail) await q(`UPDATE users SET pending_email=?,pending_email_token=?,pending_email_expires=DATE_ADD(NOW(),INTERVAL 24 HOUR) WHERE id=?`, [email, hashToken(verificationToken), req.user.id]);
      return changingEmail;
    });
    if (changed) {
      try { await emailService.sendVerificationEmail(email, verificationToken); }
      catch (error) { return res.status(207).json({ message: 'Your sign-in email is unchanged. Verification email could not be sent; retry once email service is available.', pending_email: email, emailFailed: true }); }
      return res.json({ message: 'Check the new address to confirm the change. Your current email works until verification.', pending_email: email });
    }
    res.json({ message: 'Profile updated successfully' });
  } catch(error) { logger.error('Profile update failed:', error); res.status(error.status || 500).json({ message: error.status ? error.message : 'Profile update failed' }); }
});

app.put('/api/settings/company', authenticateToken, validate([
  body('company_name').optional().trim(),
  body('company_registration').optional().trim(),
  body('vat_number').optional().trim(),
  body('address').optional().trim(),
]), async (req, res) => {
  try {
    const userId = req.user.id;
    const { company_name, company_registration, vat_number, address } = req.body;
    await executeQuery('UPDATE users SET company_name = ?, company_registration = ?, vat_number = ?, address = ?, updated_at = NOW() WHERE id = ?', [company_name || null, encUser('company_registration', company_registration || null),
       encUser('vat_number', vat_number || null), encUser('address', address || null), userId]);
    res.json({ message: 'Company details updated successfully' });
  } catch (error) { logger.error('Error updating company settings:', error); res.status(500).json({ message: 'Failed to update company details' }); }
});

app.post('/api/settings/logo', authenticateToken, (req, res) => {
  logoUpload.single('logo')(req, res, async (err) => {
    if (err) { if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ message: 'Logo must be 5 MB or smaller' }); return res.status(400).json({ message: err.message || 'Upload failed' }); }
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    try {
      const extension = path.extname(req.file.filename).toLowerCase();
      const expectedType = extension === '.png' ? 'image/png' : extension === '.jpg' || extension === '.jpeg' ? 'image/jpeg' : null;
      if (!expectedType || req.file.mimetype !== expectedType || actualImageType(req.file.path) !== expectedType) {
        fs.unlink(req.file.path, () => {});
        return res.status(400).json({ message: 'Logo content must match its PNG or JPEG file type' });
      }
      const userId = req.user.id;
      const logoPath = `/uploads/logos/${req.file.filename}`;
      const existing = await executeQuery("SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'company_logo'", [userId]);
      await executeQuery(`INSERT INTO settings (user_id, setting_key, setting_value, updated_at) VALUES (?, 'company_logo', ?, NOW()) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = NOW()`, [userId, logoPath]);
      if (existing.length > 0 && existing[0].setting_value) fs.unlink(path.join(__dirname, existing[0].setting_value), () => {});
      res.json({ message: 'Logo uploaded successfully', logo_url: logoPath });
    } catch (error) { fs.unlink(req.file.path, () => {}); logger.error('Error saving logo path:', error); res.status(500).json({ message: 'Failed to save logo' }); }
  });
});

app.delete('/api/settings/logo', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const existing = await executeQuery("SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'company_logo'", [userId]);
    if (existing.length > 0 && existing[0].setting_value) fs.unlink(path.join(__dirname, existing[0].setting_value), () => {});
    await executeQuery("DELETE FROM settings WHERE user_id = ? AND setting_key = 'company_logo'", [userId]);
    res.json({ message: 'Logo removed successfully' });
  } catch (error) { logger.error('Error removing logo:', error); res.status(500).json({ message: 'Failed to remove logo' }); }
});

app.put('/api/settings/invoice', authenticateToken, validate([
  body('invoice_prefix').trim().toUpperCase().matches(/^[A-Z0-9]{1,12}$/).withMessage('Prefix must be 1 to 12 letters or digits'),
  body('invoice_next_number').isInt({min:1,max:999999999}).withMessage('Next number must be a positive whole number'),
  body('invoice_payment_terms').isInt({min:0,max:3650}),
  body('invoice_vat_rate').isFloat({min:0,max:100}),
  body('invoice_notes').optional().isString().isLength({max:10000}),
  body('default_currency_id').isInt({min:1}),
]), async (req, res) => {
  try {
    const keys = ['invoice_prefix','invoice_next_number','invoice_payment_terms','invoice_vat_rate','invoice_notes','default_currency_id'];
    await withTransaction(async q => {
      await lockDocumentOwner(q, req.user.id);
      if (!(await q('SELECT id FROM currencies WHERE id=? AND is_active=1',[req.body.default_currency_id])).length)
        throw Object.assign(new Error('Select an active currency'),{status:422});
      for (const key of keys) await q(`INSERT INTO settings(user_id,setting_key,setting_value) VALUES(?,?,?)
        ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value),updated_at=NOW()`,[req.user.id,key,String(req.body[key] ?? '')]);
    });
    res.json({message:'Invoice defaults updated successfully'});
  } catch(error) { logger.error('Error updating invoice settings:',error); res.status(error.status || 500).json({message:error.status ? error.message : 'Failed to update invoice defaults'}); }
});

app.put('/api/settings/payment', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { bank_name, bank_account_number, bank_branch_code, bank_account_type } = req.body;
    await executeQuery('UPDATE users SET bank_name = ?, bank_account_number = ?, bank_branch_code = ?, bank_account_type = ?, updated_at = NOW() WHERE id = ?', [bank_name || null, encUser('bank_account_number', bank_account_number || null),
       encUser('bank_branch_code', bank_branch_code || null),
       encUser('bank_account_type', bank_account_type || null), userId]);
    res.json({ message: 'Payment details updated successfully' });
  } catch (error) { logger.error('Error updating payment settings:', error); res.status(500).json({ message: 'Failed to update payment details' }); }
});

/**
 * The seller's own PayFast credentials.
 *
 * Kept separate from /api/settings/payment, which is a plain four-column
 * overwrite of the banking details and should stay that way. This one needs
 * write-only secret handling, conditional required-ness, and a 503 when
 * encryption is unavailable.
 *
 * -- The sentinel contract --
 *
 * The client is never given the stored secrets, so it cannot round-trip them
 * and "send everything back" is not an option. Therefore, per field:
 *
 *   absent or null  leave whatever is stored unchanged
 *   ""              clear it
 *   a value         set it
 *
 * The Angular form relies on this: it shows a masked placeholder when the
 * matching *_set flag is true, and only sends a field the user actually edited.
 */
app.put('/api/settings/payfast', authenticateToken, validate([
  body('payfast_merchant_id').optional({ nullable: true }).trim()
    .custom((v) => v === '' || /^[0-9]{5,15}$/.test(v))
    .withMessage('PayFast merchant ID must be 5 to 15 digits'),
  // Deliberately loose bounds: PayFast issues 13-character keys today, and a
  // tighter rule would lock out every user the day they change that.
  body('payfast_merchant_key').optional({ nullable: true }).trim()
    .custom((v) => v === '' || /^[A-Za-z0-9]{10,64}$/.test(v))
    .withMessage('PayFast merchant key must be 10 to 64 letters and digits'),
  body('payfast_passphrase').optional({ nullable: true }).trim()
    .custom((v) => v === '' || (v.length >= 8 && v.length <= 100))
    .withMessage('PayFast passphrase must be 8 to 100 characters'),
  body('payfast_enabled').optional().isBoolean().withMessage('payfast_enabled must be true or false'),
], { redact: ['payfast_merchant_key', 'payfast_passphrase'] }), async (req, res) => {
  try {
    const userId = req.user.id;
    const { payfast_merchant_id, payfast_merchant_key, payfast_passphrase, payfast_enabled } = req.body;

    const rows = await executeQuery(
      'SELECT payfast_merchant_id, payfast_merchant_key, payfast_passphrase, payfast_enabled FROM users WHERE id = ?',
      [userId]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'User not found' });
    const current = decryptUserRow(rows[0]);

    // absent/null -> keep, '' -> clear, value -> set.
    const resolve = (incoming, stored) => {
      if (incoming === undefined || incoming === null) return stored || null;
      return incoming === '' ? null : incoming;
    };
    const nextMerchantId = resolve(payfast_merchant_id, current.payfast_merchant_id);
    const nextMerchantKey = resolve(payfast_merchant_key, current.payfast_merchant_key);
    const nextPassphrase = resolve(payfast_passphrase, current.payfast_passphrase);
    const nextEnabled = payfast_enabled === undefined ? !!current.payfast_enabled : !!payfast_enabled;

    // Storing a signing key in plaintext is not an option, so refuse rather
    // than silently degrade. An unset keyring is a deployment problem, not a
    // user error - hence 503 and a code the UI can branch on.
    if ((nextMerchantId || nextMerchantKey || nextPassphrase) && !isEncryptionConfigured()) {
      return res.status(503).json({
        message: 'Online payments cannot be configured because encryption is not set up on this server.',
        code: 'ENCRYPTION_UNAVAILABLE',
      });
    }

    // The passphrase is not optional polish. It is the shared secret that
    // proves a payment notification genuinely came from PayFast for THIS
    // seller. Without it, anyone with their own PayFast account could post a
    // notification that passes PayFast's own validation and mark this seller's
    // invoices paid. See verifyItnSignature in payfast.service.js.
    if (nextEnabled && !(nextMerchantId && nextMerchantKey && nextPassphrase)) {
      return res.status(422).json({
        message: 'A merchant ID, merchant key and security passphrase are all required before online payments can be switched on. Set the passphrase in your PayFast dashboard under Settings, then enter the same value here.',
        code: 'PAYFAST_INCOMPLETE',
      });
    }

    await executeQuery(
      `UPDATE users SET payfast_merchant_id = ?, payfast_merchant_key = ?, payfast_passphrase = ?,
                        payfast_enabled = ?, updated_at = NOW()
        WHERE id = ?`,
      [
        encryptField('users', 'payfast_merchant_id', nextMerchantId),
        encryptField('users', 'payfast_merchant_key', nextMerchantKey),
        encryptField('users', 'payfast_passphrase', nextPassphrase),
        nextEnabled ? 1 : 0,
        userId,
      ]
    );

    // Echo the same write-only shape GET /api/settings returns, so the client
    // can update its state without a refetch and without ever holding a secret.
    res.json({
      message: nextEnabled ? 'Online payments are switched on' : 'PayFast settings saved',
      payfast_enabled: nextEnabled,
      payfast_merchant_id: nextMerchantId,
      payfast_merchant_key_set: !!nextMerchantKey,
      payfast_passphrase_set: !!nextPassphrase,
    });
  } catch (error) {
    // Never log the body - it carries the merchant key and the passphrase.
    logger.error('Error updating PayFast settings:', { message: error.message, code: error.code });
    res.status(500).json({ message: 'Failed to update PayFast settings' });
  }
});

app.put('/api/settings/notifications', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { notify_invoice_sent, notify_payment_received, notify_invoice_overdue, customer_reminders_enabled, customer_reminder_days } = req.body;
    let reminderDays;
    try { reminderDays=parseReminderDays(customer_reminder_days); }
    catch { return res.status(422).json({message:'Choose 1 to 5 unique reminder days between 1 and 365'}); }
    const pairs = [['notify_invoice_sent', notify_invoice_sent === true ? '1' : '0'], ['notify_payment_received', notify_payment_received === true ? '1' : '0'], ['notify_invoice_overdue', notify_invoice_overdue === true ? '1' : '0'], ['customer_reminders_enabled', customer_reminders_enabled === true ? '1' : '0']];
    pairs.push(['customer_reminder_days',reminderDays.join(',')]);
    for (const [key, value] of pairs) await executeQuery(`INSERT INTO settings (user_id, setting_key, setting_value, updated_at) VALUES (?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = NOW()`, [userId, key, value]);
    res.json({ message: 'Notification preferences updated successfully' });
  } catch (error) { logger.error('Error updating notification settings:', error); res.status(500).json({ message: 'Failed to update notification preferences' }); }
});

// ─── Reports ──────────────────────────────────────────────────────────────────

app.get('/api/reports/revenue-by-month',authenticateToken,async(req,res)=>{
  try { res.json(await report(executeQuery,req.user.id,req.query.currency,'revenue')); }
  catch(error) { res.status(error.status || 500).json({message:error.status ? error.message : 'Report could not be loaded'}); }
});
app.get('/api/reports/invoice-status',authenticateToken,async(req,res)=>{
  try { res.json(await report(executeQuery,req.user.id,req.query.currency,'status')); }
  catch(error) { res.status(error.status || 500).json({message:error.status ? error.message : 'Report could not be loaded'}); }
});
app.get('/api/reports/top-customers',authenticateToken,async(req,res)=>{
  try { res.json(await report(executeQuery,req.user.id,req.query.currency,'customers')); }
  catch(error) { res.status(error.status || 500).json({message:error.status ? error.message : 'Report could not be loaded'}); }
});
app.get('/api/reports/vat-summary',authenticateToken,async(req,res)=>{
  try { res.json(await report(executeQuery,req.user.id,req.query.currency,'vat')); }
  catch(error) { res.status(error.status || 500).json({message:error.status ? error.message : 'Report could not be loaded'}); }
});
app.get('/api/reports/payments-ledger',authenticateToken,async(req,res)=>{
  try {
    const { from, to, customer_id } = req.query;
    const validDate = value => !value || (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value);
    if (!validDate(from) || !validDate(to) || (from && to && from > to))
      return res.status(422).json({message:'Choose a valid date range'});
    if (customer_id && !/^[1-9]\d*$/.test(String(customer_id))) return res.status(422).json({message:'Choose a valid customer'});
    const currency = await reportCurrency(executeQuery,req.user.id,req.query.currency);
    if (customer_id) {
      const owned = await executeQuery('SELECT id FROM customers WHERE id=? AND user_id=?',[customer_id,req.user.id]);
      if (!owned.length) return res.status(404).json({message:'Customer not found'});
    }
    let sql = `SELECT cash.id,cash.kind,cash.payment_date,cash.amount,cash.payment_method,cash.transaction_reference,d.id AS invoice_id,d.document_number,c.id AS customer_id,c.name AS customer_name
      FROM (SELECT p.id,'PAYMENT' AS kind,p.document_id AS invoice_id,p.payment_date,p.amount,p.payment_method,p.transaction_reference FROM payments p
        UNION ALL SELECT r.id,'REFUND' AS kind,r.invoice_id,r.refund_date AS payment_date,-r.amount AS amount,r.method AS payment_method,r.reference AS transaction_reference FROM payment_refunds r) cash
      JOIN documents d ON d.id=cash.invoice_id JOIN customers c ON c.id=d.customer_id
      WHERE d.user_id=? AND d.type='INVOICE' AND d.currency_id=?`;
    const params = [req.user.id,currency.id];
    if (from) { sql += ' AND cash.payment_date>=?'; params.push(from); }
    if (to) { sql += ' AND cash.payment_date<=?'; params.push(to); }
    if (customer_id) { sql += ' AND c.id=?'; params.push(customer_id); }
    sql += ' ORDER BY cash.payment_date ASC,cash.kind ASC,cash.id ASC LIMIT 1001';
    const rows = await executeQuery(sql,params);
    if (rows.length > 1000) return res.status(422).json({message:'Too many cash movements. Narrow the date or customer filter.'});
    res.set('Cache-Control','no-store').json({ currency_code:currency.code, from:from || null,to:to || null,
      rows:rows.map(row=>row.kind==='REFUND' ? {...row,transaction_reference:decryptField('payment_refunds','reference',row.transaction_reference)} : decryptPaymentRow(row)) });
  } catch(error) { logger.error('Error fetching payments ledger:',error); res.status(error.status || 500).json({message:error.status ? error.message : 'Report could not be loaded'}); }
});

app.get('/api/reports/ageing',authenticateToken,async(req,res)=>{
  try {
    const currency = await reportCurrency(executeQuery,req.user.id,req.query.currency);
    const customerId = req.query.customer_id;
    if (customerId && !/^[1-9]\d*$/.test(String(customerId))) return res.status(422).json({message:'Choose a valid customer'});
    let sql = `SELECT d.id AS invoice_id,d.document_number,d.due_date,d.total,c.id AS customer_id,c.name AS customer_name,
      COALESCE(p.paid,0)-COALESCE(r.refunded,0) AS amount_paid,COALESCE(cn.credited,0) AS credit_total,
      ROUND(GREATEST(d.total-COALESCE(cn.credited,0)-COALESCE(p.paid,0)+COALESCE(r.refunded,0),0),2) AS balance_due,
      CASE WHEN d.due_date IS NULL OR d.due_date>=? THEN 'current' WHEN DATEDIFF(?,d.due_date)<=30 THEN 'days1to30'
           WHEN DATEDIFF(?,d.due_date)<=60 THEN 'days31to60' ELSE 'days61plus' END AS band
      FROM documents d JOIN customers c ON c.id=d.customer_id
      LEFT JOIN (SELECT document_id,SUM(amount) AS paid FROM payments GROUP BY document_id) p ON p.document_id=d.id
      LEFT JOIN (SELECT invoice_id,SUM(total) AS credited FROM credit_notes GROUP BY invoice_id) cn ON cn.invoice_id=d.id
      LEFT JOIN (SELECT invoice_id,SUM(amount) AS refunded FROM payment_refunds GROUP BY invoice_id) r ON r.invoice_id=d.id
      WHERE d.user_id=? AND d.currency_id=? AND d.type='INVOICE' AND
        (d.status IN ('SENT','OVERDUE') OR (d.status='DRAFT' AND COALESCE(p.paid,0)>0)) AND d.total-COALESCE(cn.credited,0)>COALESCE(p.paid,0)-COALESCE(r.refunded,0)`;
    const day = todayIso();
    const params = [day,day,day,req.user.id,currency.id];
    if (customerId) { sql += ' AND c.id=?'; params.push(customerId); }
    sql += ' ORDER BY d.due_date ASC,d.id ASC LIMIT 1001';
    const rows = await executeQuery(sql,params);
    if (rows.length>1000) return res.status(422).json({message:'Too many open invoices. Choose a customer.'});
    const totals = { current:0,days1to30:0,days31to60:0,days61plus:0 };
    for (const row of rows) totals[row.band] += Number(row.balance_due);
    res.set('Cache-Control','no-store').json({ currency_code:currency.code,as_of:day,totals,rows });
  } catch(error) { logger.error('Error fetching ageing report:',error); res.status(error.status || 500).json({message:error.status ? error.message : 'Ageing report could not be loaded'}); }
});

app.get('/api/reports/customer-statement',authenticateToken,async(req,res)=>{
  try {
    const customerId = req.query.customer_id;
    if (!/^[1-9]\d*$/.test(String(customerId || ''))) return res.status(422).json({message:'Choose a customer'});
    const { from, to } = req.query;
    const validDate = value => !value || (typeof value==='string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value);
    if (!validDate(from) || !validDate(to) || (from && to && from>to)) return res.status(422).json({message:'Choose a valid date range'});
    const currency = await reportCurrency(executeQuery,req.user.id,req.query.currency);
    const [customer] = await queryDecrypted(decryptCustomerRow,'SELECT id,name FROM customers WHERE id=? AND user_id=?',[customerId,req.user.id]);
    if (!customer) return res.status(404).json({message:'Customer not found'});
    const end = to || todayIso();
    const invoices = await executeQuery(`SELECT id,document_number,DATE_FORMAT(issue_date,'%Y-%m-%d') AS day,total,status FROM documents
      WHERE user_id=? AND customer_id=? AND currency_id=? AND type='INVOICE' AND issue_date<=? AND
      (status IN ('SENT','OVERDUE','PAID','CREDITED') OR EXISTS(SELECT 1 FROM payments p WHERE p.document_id=documents.id))
      ORDER BY issue_date,id LIMIT 1001`,[req.user.id,customerId,currency.id,end]);
    const payments = await executeQuery(`SELECT p.id,d.id AS invoice_id,d.document_number,DATE_FORMAT(p.payment_date,'%Y-%m-%d') AS day,p.amount
      FROM payments p JOIN documents d ON d.id=p.document_id WHERE d.user_id=? AND d.customer_id=? AND d.currency_id=? AND d.type='INVOICE' AND p.payment_date<=?
      ORDER BY p.payment_date,p.id LIMIT 1001`,[req.user.id,customerId,currency.id,end]);
    const credits = await executeQuery(`SELECT cn.id,cn.invoice_id,cn.document_number,DATE_FORMAT(cn.issue_date,'%Y-%m-%d') AS day,cn.total
      FROM credit_notes cn JOIN documents d ON d.id=cn.invoice_id WHERE d.user_id=? AND d.customer_id=? AND d.currency_id=? AND cn.issue_date<=?
      ORDER BY cn.issue_date,cn.id LIMIT 1001`,[req.user.id,customerId,currency.id,end]);
    const refunds = await executeQuery(`SELECT r.id,r.invoice_id,d.document_number,DATE_FORMAT(r.refund_date,'%Y-%m-%d') AS day,r.amount
      FROM payment_refunds r JOIN documents d ON d.id=r.invoice_id WHERE d.user_id=? AND d.customer_id=? AND d.currency_id=? AND r.refund_date<=?
      ORDER BY r.refund_date,r.id LIMIT 1001`,[req.user.id,customerId,currency.id,end]);
    if ([invoices,payments,credits,refunds].some(rows=>rows.length>1000)) return res.status(422).json({message:'Too many statement entries. Narrow the end date.'});
    const entries = [
      ...invoices.map(row => ({ day:row.day,kind:'INVOICE',invoice_id:row.id,document_number:row.document_number,debit:row.status==='CANCELLED' ? 0 : Number(row.total),credit:0,id:row.id })),
      ...payments.map(row => ({ day:row.day,kind:'PAYMENT',invoice_id:row.invoice_id,document_number:row.document_number,debit:0,credit:Number(row.amount),id:row.id })),
      ...credits.map(row => ({ day:row.day,kind:'CREDIT_NOTE',invoice_id:row.invoice_id,document_number:row.document_number,debit:0,credit:Number(row.total),id:row.id })),
      ...refunds.map(row => ({ day:row.day,kind:'REFUND',invoice_id:row.invoice_id,document_number:row.document_number,debit:Number(row.amount),credit:0,id:row.id }))
    ].sort((a,b)=>a.day.localeCompare(b.day) || ({INVOICE:0,PAYMENT:1,CREDIT_NOTE:2,REFUND:3}[a.kind]-{INVOICE:0,PAYMENT:1,CREDIT_NOTE:2,REFUND:3}[b.kind]) || a.id-b.id);
    let opening = 0,balance = 0;
    const rows = [];
    for (const entry of entries) {
      balance += entry.debit-entry.credit;
      if (from && entry.day<from) opening=balance;
      else rows.push({ ...entry,balance:Number(balance.toFixed(2)) });
    }
    res.set('Cache-Control','no-store').json({ customer_id:customer.id,customer_name:customer.name,currency_code:currency.code,from:from || null,to:end,opening_balance:Number(opening.toFixed(2)),closing_balance:Number(balance.toFixed(2)),rows });
  } catch(error) { logger.error('Error fetching customer statement:',error); res.status(error.status || 500).json({message:error.status ? error.message : 'Customer statement could not be loaded'}); }
});

app.get('/api/public/invoice/:token', portalLimiter, async (req, res) => {
  try {
    const { token } = req.params;
    const docs = await executeQuery(`SELECT d.id, d.document_number, d.type, d.status, d.issue_date, d.due_date, d.payment_terms, d.subtotal, d.vat_amount, d.total, d.notes, d.terms_conditions, c.name AS customer_name, c.email AS customer_email, c.billing_address AS customer_billing_address, c.vat_number AS customer_vat_number, cur.symbol AS currency_symbol, cur.code AS currency_code, u.company_name, u.vat_number AS company_vat_number, u.address AS company_address, u.email AS company_email, u.bank_name, u.bank_account_number, u.bank_branch_code, u.bank_account_type, u.payfast_enabled, u.payfast_merchant_id, u.payfast_merchant_key, u.payfast_passphrase FROM documents d JOIN customers c ON c.id = d.customer_id LEFT JOIN currencies cur ON cur.id = d.currency_id JOIN users u ON u.id = d.user_id WHERE d.share_token = ? AND EXISTS(SELECT 1 FROM users owner WHERE owner.id=d.user_id AND owner.status='ACTIVE') AND d.type = 'INVOICE' AND (d.share_token_expires_at IS NULL OR d.share_token_expires_at > NOW())`, [hashToken(token)]);
    if (docs.length === 0) return res.status(404).json({ message: 'Invoice not found or link has expired' });
    const items = await executeQuery('SELECT description, quantity, unit_price, vat_rate, vat_inclusive, vat_amount, subtotal, total FROM document_items WHERE document_id = ? ORDER BY id ASC', [docs[0].id]);
    const logoRows = await executeQuery("SELECT setting_value FROM settings WHERE user_id = (SELECT user_id FROM documents WHERE id = ?) AND setting_key = 'company_logo'", [docs[0].id]);
    const settlement = await invoiceSettlement(executeQuery,docs[0].id);
    await executeQuery(`INSERT INTO document_tracking (document_id, event_type, ip_address, user_agent) VALUES (?, 'VIEWED', ?, ?)`, [docs[0].id, encTracking('ip_address', req.ip || null), encTracking('user_agent', req.get('user-agent') || null)]);
    // The seller's PayFast credentials are only ever used to decide whether a
    // button can be shown; they are stripped before the row leaves the server.
    // This one row carries encrypted columns under three different naming
    // schemes: the seller's bank details unaliased (u.bank_account_number), the
    // seller's vat_number and address under `company_`, and the customer's
    // under `customer_`. Each mapper only touches the names it owns, so they
    // compose; the AAD still uses the real table and column either way.
    const [seller] = await hydrateDocumentSnapshots(executeQuery, [decryptCustomerJoin(
      decryptAliasedRow('users', decryptUserRow(docs[0]), 'company_')
    )], { includeLogo: true });
    const pay_url = await resolvePayUrl(seller, seller);
    const {
      payfast_enabled, payfast_merchant_id, payfast_merchant_key, payfast_passphrase, ...publicFields
    } = seller;
    res.json({
      ...publicFields, pay_url, company_logo: Object.hasOwn(seller, 'company_logo') ? seller.company_logo : logoRows[0]?.setting_value || null, items,
      amount_paid: settlement.netPaid.toFixed(2),credit_total:settlement.creditTotal.toFixed(2),adjusted_total:settlement.adjustedTotal.toFixed(2),
      balance_due: settlement.balanceDue.toFixed(2),refund_due:settlement.refundDue.toFixed(2),last_updated_at:seller.updated_at,
    });
  } catch (error) { logger.error('Error fetching public invoice:', error); res.status(500).json({ message: 'Failed to fetch invoice' }); }
});

app.get('/api/public/invoice/:token/pdf', portalLimiter, async (req, res) => {
  try {
    const { token } = req.params;
    const docs = await queryDecrypted(decryptCustomerJoin, `SELECT d.*, (SELECT COALESCE(SUM(pp.amount), 0) FROM payments pp WHERE pp.document_id = d.id) AS amount_paid, c.name AS customer_name, c.email AS customer_email, c.billing_address AS customer_billing_address, c.vat_number AS customer_vat_number, cur.symbol AS currency_symbol, cur.code AS currency_code FROM documents d JOIN customers c ON c.id = d.customer_id LEFT JOIN currencies cur ON cur.id = d.currency_id WHERE d.share_token = ? AND EXISTS(SELECT 1 FROM users owner WHERE owner.id=d.user_id AND owner.status='ACTIVE') AND d.type = 'INVOICE' AND (d.share_token_expires_at IS NULL OR d.share_token_expires_at > NOW())`, [hashToken(token)]);
    if (docs.length === 0) return res.status(404).json({ message: 'Invoice not found or link has expired' });
    const invoice = await withInvoiceFinancials(executeQuery,docs[0]);
    const [items, users, logoRows] = await Promise.all([
      executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [invoice.id]),
      queryDecrypted(decryptUserRow, 'SELECT * FROM users WHERE id = ?', [invoice.user_id]),
      executeQuery("SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'company_logo'", [invoice.user_id])
    ]);
    const logoRelPath = logoRows[0]?.setting_value || null;
    const user = await documentSeller(executeQuery, invoice.id, { ...decryptUserRow(users[0]), logo_path: logoRelPath ? path.join(__dirname, logoRelPath) : null });
    const pay_url = await resolvePayUrl(invoice, user);
    const pdfBuffer = await buildInvoicePdf({ ...invoice, pay_url }, items, user);
    await executeQuery(`INSERT INTO document_tracking (document_id, event_type, ip_address, user_agent) VALUES (?, 'DOWNLOADED', ?, ?)`, [invoice.id, encTracking('ip_address', req.ip || null), encTracking('user_agent', req.get('user-agent') || null)]);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${invoice.document_number}.pdf"`, 'Content-Length': pdfBuffer.length });
    res.send(pdfBuffer);
  } catch (error) { logger.error('Error generating public invoice PDF:', error); res.status(500).json({ message: 'Failed to generate PDF' }); }
});

app.get('/api/public/quote/:token', portalLimiter, async (req, res) => {
  try {
    const docs = await executeQuery(`SELECT d.id,d.document_number,d.status,d.issue_date,d.valid_until,d.payment_terms,d.subtotal,d.vat_amount,d.total,d.notes,d.terms_conditions,d.purchase_order_ref,d.delivery_details,
      DATE_FORMAT(d.valid_until,'%Y-%m-%d') AS valid_until_iso,
      c.name AS customer_name,c.email AS customer_email,c.billing_address AS customer_billing_address,
      cur.symbol AS currency_symbol,cur.code AS currency_code,u.company_name,u.vat_number AS company_vat_number,u.address AS company_address,u.email AS company_email
      FROM documents d JOIN customers c ON c.id=d.customer_id LEFT JOIN currencies cur ON cur.id=d.currency_id JOIN users u ON u.id=d.user_id
      WHERE d.share_token=? AND d.type='QUOTE' AND u.status='ACTIVE' AND (d.share_token_expires_at IS NULL OR d.share_token_expires_at>NOW())`, [hashToken(req.params.token)]);
    if (!docs.length) return res.status(404).json({ message: 'Quote not found or link has expired' });
    const quote = docs[0];
    const items = await executeQuery('SELECT description,quantity,unit_label,unit_price,discount_percent,vat_rate,vat_inclusive,vat_amount,subtotal,total FROM document_items WHERE document_id=? ORDER BY id', [quote.id]);
    await executeQuery("INSERT INTO document_tracking(document_id,event_type,ip_address,user_agent) VALUES(?,'VIEWED',?,?)", [quote.id,encTracking('ip_address',req.ip || null),encTracking('user_agent',req.get('user-agent') || null)]);
    const [publicQuote] = await hydrateDocumentSnapshots(executeQuery, [decryptCustomerJoin(decryptAliasedRow('users',decryptUserRow(quote),'company_'))], { includeLogo:true });
    res.set('Cache-Control','no-store').json({ ...publicQuote, status: quote.status === 'SENT' && quote.valid_until_iso && quote.valid_until_iso < todayIso() ? 'EXPIRED' : quote.status, items });
  } catch (error) { logger.error('Error fetching public quote:',error); res.status(500).json({ message:'Failed to fetch quote' }); }
});

app.get('/api/public/quote/:token/pdf', portalLimiter, async (req, res) => {
  try {
    const docs = await queryDecrypted(decryptCustomerJoin, `SELECT d.*,c.name AS customer_name,c.email AS customer_email,c.billing_address AS customer_billing_address,c.vat_number AS customer_vat_number,cur.symbol AS currency_symbol,cur.code AS currency_code
      FROM documents d JOIN customers c ON c.id=d.customer_id LEFT JOIN currencies cur ON cur.id=d.currency_id JOIN users u ON u.id=d.user_id
      WHERE d.share_token=? AND d.type='QUOTE' AND u.status='ACTIVE' AND (d.share_token_expires_at IS NULL OR d.share_token_expires_at>NOW())`, [hashToken(req.params.token)]);
    if (!docs.length) return res.status(404).json({ message:'Quote not found or link has expired' });
    const quote = docs[0];
    const [items, users, logoRows] = await Promise.all([
      executeQuery('SELECT * FROM document_items WHERE document_id=? ORDER BY id',[quote.id]),
      queryDecrypted(decryptUserRow,'SELECT * FROM users WHERE id=?',[quote.user_id]),
      executeQuery("SELECT setting_value FROM settings WHERE user_id=? AND setting_key='company_logo'",[quote.user_id])
    ]);
    const logo = logoRows[0]?.setting_value || null;
    const seller = await documentSeller(executeQuery,quote.id,{ ...users[0],logo_path:logo ? path.join(__dirname,logo) : null });
    const pdf = await buildQuotePdf(quote,items,seller);
    await executeQuery("INSERT INTO document_tracking(document_id,event_type,ip_address,user_agent) VALUES(?,'DOWNLOADED',?,?)",[quote.id,encTracking('ip_address',req.ip || null),encTracking('user_agent',req.get('user-agent') || null)]);
    res.set({ 'Content-Type':'application/pdf','Content-Disposition':`attachment; filename="${quote.document_number}.pdf"`,'Content-Length':pdf.length,'Cache-Control':'no-store' }).send(pdf);
  } catch(error) { logger.error('Error generating public quote PDF:',error); res.status(500).json({ message:'Failed to generate quote PDF' }); }
});

app.post('/api/public/quote/:token/decision', portalLimiter, validate([body('decision').isIn(['ACCEPTED','DECLINED'])]), async (req,res) => {
  try {
    const outcome = await withTransaction(async q => {
      const [quote] = await q(`SELECT d.id,d.status,DATE_FORMAT(d.valid_until,'%Y-%m-%d') AS valid_until_iso FROM documents d JOIN users u ON u.id=d.user_id
        WHERE d.share_token=? AND d.type='QUOTE' AND u.status='ACTIVE' AND (d.share_token_expires_at IS NULL OR d.share_token_expires_at>NOW()) FOR UPDATE`,[hashToken(req.params.token)]);
      if (!quote) return { status:404,message:'Quote not found or link has expired' };
      if (quote.status === req.body.decision) return { status:200,message:`Quote already ${req.body.decision.toLowerCase()}` };
      if (quote.status !== 'SENT') return { status:409,message:'This quote can no longer be decided' };
      if (quote.valid_until_iso && quote.valid_until_iso < todayIso()) return { status:410,message:'This quote has expired' };
      await q('UPDATE documents SET status=?,updated_at=NOW() WHERE id=?',[req.body.decision,quote.id]);
      await q('INSERT INTO document_tracking(document_id,event_type,ip_address,user_agent) VALUES(?,?,?,?)',[quote.id,req.body.decision,encTracking('ip_address',req.ip || null),encTracking('user_agent',req.get('user-agent') || null)]);
      return { status:200,message:`Quote ${req.body.decision.toLowerCase()}` };
    });
    res.set('Cache-Control','no-store').status(outcome.status).json({ message:outcome.message });
  } catch(error) { logger.error('Error recording quote decision:',error); res.status(500).json({ message:'Failed to record quote decision' }); }
});

// ─── Recurring invoice cron — runs daily at 00:05 ─────────────────────────────

async function processRecurringInvoices() {
  await processRecurring({onCreated:async created=>{
    if(created.autoSend) await queueInvoiceEmail(created.id,created.userId);
  },onError:(error,id)=>logger.error(`Recurring source #${id} failed`,error)});
  // Recover a crash between committing the occurrence and queueing its email.
  const pending=await executeQuery(`SELECT d.id,d.user_id FROM documents d JOIN documents source ON source.id=d.source_recurring_id
    JOIN users u ON u.id=d.user_id WHERE source.auto_send=1 AND u.status='ACTIVE' AND d.status IN ('DRAFT','SENT','OVERDUE')
    AND d.delivery_status='NOT_SENT' ORDER BY d.id LIMIT 100`);
  for(const row of pending) {
    try {await queueInvoiceEmail(row.id,row.user_id);}catch(error){logger.error(`Recurring email #${row.id} could not be queued`,error);}
  }
}
cron.schedule('5 * * * *',()=>runTrackedJob('recurring',processRecurringInvoices),{timezone:'Africa/Johannesburg'});
cron.schedule('* * * * *',()=>runTrackedJob('notifications',async()=>{await processBillingNotifications();await processOutbox(emailService.transporter);}),{timezone:'Africa/Johannesburg'});

async function processOverdueInvoices() {
  logger.info('Overdue invoice cron: starting');
  try {
    const overdueInvoices = await executeQuery(`SELECT id, document_number, user_id FROM documents WHERE type = 'INVOICE' AND status = 'SENT' AND due_date IS NOT NULL AND due_date < ?`,[todayIso()]);
    logger.info(`Overdue invoice cron: ${overdueInvoices.length} invoice(s) to mark overdue`);
    for (const invoice of overdueInvoices) {
      try {
        const changed = await executeQuery(`UPDATE documents SET status='OVERDUE',updated_at=NOW() WHERE id=? AND status='SENT'`,[invoice.id]);
        if (!changed.affectedRows) continue;
        await executeQuery(`INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'OVERDUE')`, [invoice.id]);
        logger.info(`Overdue invoice cron: marked ${invoice.document_number} as OVERDUE`);
      } catch (itemError) { logger.error(`Overdue invoice cron: failed to process invoice #${invoice.id}:`, itemError); }
    }
    logger.info('Overdue invoice cron: completed');
  } catch (error) { logger.error('Overdue invoice cron: fatal error:', error); throw error; }
}

cron.schedule('10 * * * *',()=>runTrackedJob('overdue',processOverdueInvoices), {timezone:'Africa/Johannesburg'});

// ─── Account anonymisation cron — runs daily at 00:20 ─────────────────────────
// The erasure that /api/account/close promises and, until now, nothing
// delivered: closure set anonymise_after and opened a DELETION request that no
// code ever completed. The job itself lives in retention.service.js — it is
// database work with no HTTP in it, and out there it can be run and tested
// without booting a server. See that file for what it deliberately leaves
// alone and why.
cron.schedule('20 0 * * *',()=>runTrackedJob('retention',anonymiseExpiredAccounts));

// ─────────────────────────────────────────────────────────────────────────────

// ─── Account: POPIA data-subject rights ───────────────────────────────────────
// The privacy policy promises access, export and deletion. Publishing that
// policy without these endpoints would be a self-authored misrepresentation,
// and it is also what Google Play's "users can request that their data be
// deleted" declaration depends on.

const exportLimiter = limiter(60, 5, 'Too many export requests. Please try again later.');
const reactivateLimiter = limiter(15, 10, 'Too many attempts. Please wait a few minutes and try again.');

app.get('/api/account/status', authenticateToken, async (req, res) => {
  try {
    const rows = await executeQuery(
      `SELECT status, closed_at, anonymise_after AS anonymise_due_at, last_login_at,
              terms_accepted_at, privacy_accepted_at, privacy_policy_version
         FROM users WHERE id = ?`,
      [req.user.id]
    );
    if (rows.length === 0) return res.status(404).json({ message: 'User not found' });
    res.json({ ...rows[0], grace_days: ACCOUNT_GRACE_DAYS });
  } catch (error) {
    logger.error('Account status error:', error);
    res.status(500).json({ message: 'Failed to load account status' });
  }
});

/**
 * POPIA s23/s24 access right, in machine-readable form.
 *
 * Includes the user's customers and their documents, because the user is the
 * responsible party for that data and needs it to answer their own customers'
 * requests. Deliberately excludes password_hash and every token column — an
 * export is a file that gets emailed around and left in Downloads folders.
 */
app.get('/api/account/export', authenticateToken, exportLimiter, async (req, res) => {
  try {
    const uid = req.user.id;
    // Probed rather than try/caught, so a table that simply does not exist yet
    // doesn't fill error.log on every export.
    const hasConsents = await tableExists(executeQuery, 'marketing_consents');

    const [user, settings, customers, products, documents, items, payments, tracking, emails, consents, requests, bankRows, credits, refunds] =
      await Promise.all([
        queryDecrypted(decryptUserRow,
          // google_id is the Google account identifier we hold about this
          // person, so a subject access request has to return it like any other
          // personal data. password_hash stays out — a credential, not data
          // about them.
          //
          // This has to come back DECRYPTED: the point of the export is to tell
          // the person what we hold about them, and a page of base64 does not
          // discharge that duty.
          `SELECT id, email, google_id, company_name, company_registration, vat_number, contact_person,
                  phone, address, bank_name, bank_account_number, bank_branch_code, bank_account_type,
                  email_verified, status, created_at, updated_at, closed_at, last_login_at,
                  terms_accepted_at, terms_version, privacy_accepted_at, privacy_policy_version
             FROM users WHERE id = ?`, [uid]),
        executeQuery('SELECT setting_key, setting_value, updated_at FROM settings WHERE user_id = ?', [uid]),
        queryDecrypted(decryptCustomerRow, 'SELECT * FROM customers WHERE user_id = ?', [uid]),
        executeQuery('SELECT * FROM products WHERE user_id = ?', [uid]),
        executeQuery('SELECT * FROM documents WHERE user_id = ?', [uid]),
        executeQuery('SELECT i.* FROM document_items i JOIN documents d ON d.id = i.document_id WHERE d.user_id = ?', [uid]),
        queryDecrypted(decryptPaymentRow, 'SELECT p.* FROM payments p JOIN documents d ON d.id = p.document_id WHERE d.user_id = ?', [uid]),
        queryDecrypted(decryptTrackingRow, 'SELECT t.* FROM document_tracking t JOIN documents d ON d.id = t.document_id WHERE d.user_id = ?', [uid]),
        executeQuery('SELECT e.* FROM email_log e JOIN documents d ON d.id = e.document_id WHERE d.user_id = ?', [uid]),
        hasConsents
          ? executeQuery('SELECT channel, source, consented_at FROM marketing_consents WHERE user_id = ?', [uid])
          : Promise.resolve([]),
        executeQuery('SELECT request_type, status, requested_at, completed_at FROM data_subject_requests WHERE user_id = ?', [uid]),
        executeQuery('SELECT id,currency_id,transaction_date,amount,description,reference,account_label,status,invoice_id,payment_id,created_at,decided_at FROM bank_import_rows WHERE user_id=?',[uid]),
        executeQuery('SELECT id,invoice_id,document_number,issue_date,reason,description,subtotal,vat_amount,total,created_at FROM credit_notes WHERE user_id=?',[uid]),
        executeQuery('SELECT id,invoice_id,payment_id,amount,refund_date,method,reference,reason,created_at FROM payment_refunds WHERE user_id=?',[uid]),
      ]);

    if (user.length === 0) return res.status(404).json({ message: 'User not found' });

    // Share tokens are live capabilities — anyone holding one can read the
    // invoice and the seller's banking details without logging in. They must
    // not travel in an export file.
    const scrubbed = documents.map(({ share_token, ...rest }) => rest);
    const snapshots = await executeQuery(`SELECT s.document_id, s.payload FROM document_snapshots s
      JOIN documents d ON d.id=s.document_id WHERE d.user_id=?`, [uid]);

    const payload = {
      document_snapshots: snapshots.map(row => ({ document_id: row.document_id,
        ...JSON.parse(decryptField('document_snapshots', 'payload', row.payload)) })),
      export_format_version: 1,
      generated_at: new Date().toISOString(),
      about_this_export:
        'Personal information held by FreeVoices (Made On Chain) about this account, provided under ' +
        'section 23 of the Protection of Personal Information Act 4 of 2013. Customer records are ' +
        'included because you are the responsible party for them. Passwords and security tokens are ' +
        'deliberately excluded.',
      account: user[0],
      settings,
      customers,
      products,
      documents: scrubbed,
      document_items: items,
      payments,
      bank_import_rows: bankRows.map(row=>({ ...row,description:decryptField('bank_import_rows','description',row.description),reference:decryptField('bank_import_rows','reference',row.reference),account_label:decryptField('bank_import_rows','account_label',row.account_label) })),
      credit_notes: credits,
      payment_refunds: refunds.map(row=>({...row,reference:decryptField('payment_refunds','reference',row.reference)})),
      document_tracking: tracking,
      email_log: emails,
      marketing_consents: consents,
      data_subject_requests: requests,
    };

    await recordSubjectRequest(req, 'EXPORT', uid, 'COMPLETED', 'Self-service export downloaded');
    await recordSecurityEvent(req, 'DATA_EXPORTED', uid);

    const stamp = new Date().toISOString().slice(0, 10);
    res.set({
      'Content-Disposition': `attachment; filename="freevoices-export-${stamp}.json"`,
      'Cache-Control': 'no-store',
    });
    res.type('application/json').send(JSON.stringify(payload, null, 2));
  } catch (error) {
    logger.error('Account export error:', error);
    res.status(500).json({ message: 'Failed to build your export' });
  }
});

/**
 * Close the account. Does NOT delete: the 7-year statutory retention on issued
 * invoices forbids it, and the foreign keys make a cascade impossible anyway.
 * This sets the flags and revokes access; the retention job anonymises the
 * personal information after the grace period.
 */
app.post('/api/account/close', authenticateToken, validate([
  // The credential is not validated here: which one is required depends on how
  // the account signs in, which we only know after loading the row.
  body('confirm').equals('DELETE').withMessage('Type DELETE to confirm'),
]), async (req, res) => {
  try {
    const uid = req.user.id;
    const rows = await executeQuery('SELECT password_hash, google_id, email FROM users WHERE id = ?', [uid]);
    if (rows.length === 0) return res.status(404).json({ message: 'User not found' });

    const proven = await reauthenticateForSensitiveAction(
      req, res, { ...rows[0], id: uid }, 'ACCOUNT_CLOSE_BAD_PASSWORD'
    );
    if (!proven) return;

    await withTransaction(async (q) => {
      await q(
        `UPDATE users
            SET status = 'CLOSED', closed_at = NOW(), anonymise_after = DATE_ADD(NOW(), INTERVAL ? DAY)
          WHERE id = ?`,
        [ACCOUNT_GRACE_DAYS, uid]
      );
      // Stop the recurring-invoice cron from generating and emailing documents
      // on behalf of an account that has been closed.
      await q(
        `UPDATE documents SET is_recurring = 0, auto_send = 0, recurrence_next_date = NULL
          WHERE user_id = ? AND is_recurring = 1`,
        [uid]
      );
      await q('UPDATE users SET pending_email=NULL,pending_email_token=NULL,pending_email_expires=NULL WHERE id=?',[uid]);
      await q('UPDATE documents SET share_token=NULL,share_token_expires_at=NULL WHERE user_id=?',[uid]);
      await q('DELETE s FROM document_share_links s JOIN documents d ON d.id=s.document_id WHERE d.user_id=?',[uid]);
      await q("UPDATE email_outbox SET status='CANCELLED',last_error='Account closed' WHERE user_id=? AND status IN ('QUEUED','FAILED')",[uid]);
      // Revoke every session everywhere, not just this one.
      await q('DELETE FROM sessions WHERE userId = ?', [uid]);
    });

    // Outside the transaction and guarded, rather than swallowing an error
    // inside it: marketing_consents does not exist until the consent work
    // lands, and a statement failure mid-transaction is not something to hide.
    if (await tableExists(executeQuery, 'marketing_consents')) {
      await executeQuery('DELETE FROM marketing_consents WHERE user_id = ?', [uid]);
    }

    const status = await executeQuery(
      'SELECT closed_at, anonymise_after AS anonymise_due_at FROM users WHERE id = ?', [uid]
    );

    await recordSubjectRequest(req, 'DELETION', uid, 'IN_PROGRESS',
      `Account closed; anonymisation due after ${ACCOUNT_GRACE_DAYS} days`);
    await recordSecurityEvent(req, 'ACCOUNT_CLOSED', uid);
    logger.info('Account closed', { userId: uid });

    try {
      if (typeof emailService.sendAccountClosureEmail === 'function') {
        await emailService.sendAccountClosureEmail(rows[0].email, {
          closed_at: status[0].closed_at,
          anonymise_due_at: status[0].anonymise_due_at,
          grace_days: ACCOUNT_GRACE_DAYS,
        });
      }
    } catch (emailError) {
      // The closure has already happened and is the user's right; a failed
      // confirmation email must not roll it back or report failure.
      logger.error('Failed to send closure confirmation email:', emailError);
    }

    res.json({
      message: 'Your account is closed.',
      closed_at: status[0].closed_at,
      anonymise_due_at: status[0].anonymise_due_at,
      grace_days: ACCOUNT_GRACE_DAYS,
    });
  } catch (error) {
    logger.error('Account close error:', error);
    res.status(500).json({ message: 'Failed to close your account' });
  }
});

/**
 * Reactivate within the grace period. Unauthenticated by necessity — closing
 * destroyed every session and authenticateToken now rejects closed accounts —
 * so it verifies email and password itself, and is rate limited like login.
 *
 * Password, not an emailed link: a compromised mailbox must not be able to
 * reverse a closure and then reset the password.
 */
app.post('/api/account/reactivate', reactivateLimiter, validate([
  body('email').isEmail().withMessage('A valid email address is required'),
  // Not notEmpty: a Google-only account reactivates with an ID token instead,
  // and requiring a password here would strand it in CLOSED until erasure.
]), async (req, res) => {
  try {
    const { email, password } = req.body;
    const rows = await executeQuery(
      'SELECT id, password_hash, google_id, status, anonymise_after FROM users WHERE email = ?', [email]
    );
    // One generic response for every failure mode, so this cannot be used to
    // discover which addresses have closed accounts.
    const generic = { message: 'We could not reactivate that account. Check your details, or contact admin@madeoc.co.za.' };
    if (rows.length === 0) return res.status(400).json(generic);

    const user = rows[0];
    if (user.status !== 'CLOSED') return res.status(400).json(generic);

    // Whichever credential the account actually has. Matching on the stored
    // `sub` rather than the email means a token for a different Google account
    // proves nothing, even though the caller supplied the right address.
    let proven = false;
    if (user.password_hash) {
      proven = !!password && await argon2.verify(user.password_hash, password);
    } else if (user.google_id && req.body.idToken) {
      const claims = await verifyGoogleIdToken(req.body.idToken);
      proven = !!claims && claims.sub === user.google_id;
    }
    if (!proven) {
      await recordSecurityEvent(req, 'ACCOUNT_REACTIVATE_FAILED', user.id);
      return res.status(400).json(generic);
    }
    if (user.anonymise_after && new Date(user.anonymise_after) <= new Date()) {
      // Past the grace period the anonymisation may already have run, or is
      // imminent. Do not pretend it can be undone.
      return res.status(410).json({
        message: 'The grace period for this account has passed and it can no longer be reactivated.',
        code: 'GRACE_EXPIRED',
      });
    }

    await executeQuery(
      `UPDATE users SET status = 'ACTIVE', closed_at = NULL, anonymise_after = NULL,
              failed_login_attempts = 0, last_failed_attempt = NULL, last_login_at = NOW()
        WHERE id = ?`,
      [user.id]
    );

    const token = randomUUID();
    await executeQuery('INSERT INTO sessions (userId, token, expires) VALUES (?, ?, ?)',
      [user.id, token, newSessionExpiry()]);

    await recordSubjectRequest(req, 'DELETION', user.id, 'REFUSED', 'Withdrawn by the user — account reactivated');
    await recordSecurityEvent(req, 'ACCOUNT_REACTIVATED', user.id);
    logger.info('Account reactivated', { userId: user.id });

    const fresh = await executeQuery('SELECT id, email, company_name FROM users WHERE id = ?', [user.id]);
    res.json({ message: 'Your account has been reactivated.', token, user: fresh[0] });
  } catch (error) {
    logger.error('Account reactivate error:', error);
    res.status(500).json({ message: 'Failed to reactivate your account' });
  }
});

// ─── Legal documents ──────────────────────────────────────────────────────────
// Copy lives in the `legal_documents` table, seeded from legal/*.html by
// scripts/seed-legal.js. It is served from the database rather than the Angular
// bundle so that an installed app three months stale cannot show v1.0 while
// recording acceptance of v1.2 — and so a correction can ship without an app
// store release.

const LEGAL_SLUGS = {
  privacy: 'Privacy Policy',
  terms: 'Terms of Service',
  'delete-account': 'Delete Your Account',
};

// DATE_FORMAT rather than returning the raw DATE: mysql2 hands back a DATE as
// local midnight, so any UTC conversion downstream reports the previous day.
const LEGAL_COLUMNS = `slug, version, title, DATE_FORMAT(effective_date, '%Y-%m-%d') AS effective_date, summary_html`;

app.get('/api/legal', async (req, res) => {
  try {
    res.json(await executeQuery(
      `SELECT ${LEGAL_COLUMNS} FROM legal_documents WHERE is_current = 1 ORDER BY slug`
    ));
  } catch (error) {
    logger.error('Error listing legal documents:', error);
    res.status(500).json({ message: 'Failed to load legal documents' });
  }
});

app.get('/api/legal/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    if (!LEGAL_SLUGS[slug]) return res.status(404).json({ message: 'Unknown document' });
    const rows = await executeQuery(
      `SELECT ${LEGAL_COLUMNS}, content_html FROM legal_documents WHERE slug = ? AND is_current = 1 LIMIT 1`,
      [slug]
    );
    // 503, not 404: the document exists as a concept but no version is
    // published — which happens while placeholders are unresolved.
    if (rows.length === 0) return res.status(503).json({ message: 'This document has not been published yet' });
    res.json(rows[0]);
  } catch (error) {
    logger.error('Error fetching legal document:', error);
    res.status(500).json({ message: 'Failed to load document' });
  }
});

// ─── Public, server-rendered legal pages ──────────────────────────────────────
// These MUST be registered above the SPA catch-all. A Play reviewer, a crawler
// or anyone opening the URL directly has to receive real HTML, not a JS shell.

function renderLegalPage(doc) {
  const esc = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  // effective_date arrives as a 'YYYY-MM-DD' string; split it rather than
  // constructing a Date, to keep the timezone out of a published legal date.
  const [y, m, d] = String(doc.effective_date).split('-');
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const effective = `${d} ${MONTHS[parseInt(m, 10) - 1]} ${y}`;

  return `<!DOCTYPE html><html lang="en-ZA"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(doc.title)} · FreeVoices</title>
<meta name="description" content="${esc(doc.title)} for FreeVoices invoicing, operated by Made On Chain.">
<link rel="canonical" href="https://freevoices.co.za/legal/${esc(doc.slug)}">
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1a1a2e;--muted:#6b7280;--line:#e5e7eb;--th:#f3f4f6;--accent:#4a90e2}
@media(prefers-color-scheme:dark){:root{--bg:#12121c;--fg:#e5e7eb;--muted:#9ca3af;--line:#374151;--th:#1f2937}}
*{box-sizing:border-box}
body{margin:0;font:16px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--fg);background:var(--bg)}
header{background:#1a1a2e;padding:18px 20px}
header a{color:#fff;text-decoration:none;font-weight:600;font-size:1.05rem}
main{max-width:760px;margin:0 auto;padding:32px 20px 80px}
h1{font-size:1.75rem;line-height:1.25;margin:0 0 8px}
h2{font-size:1.2rem;margin:2.2em 0 .6em;padding-top:.4em;border-top:1px solid var(--line)}
h3{font-size:1.02rem;margin:1.6em 0 .5em;color:var(--muted)}
a{color:var(--accent)}
ul,ol{padding-left:1.3em}li{margin:.35em 0}
.meta{color:var(--muted);font-size:.9rem;border-bottom:1px solid var(--line);padding-bottom:14px;margin-bottom:28px}
.tw{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:1.1em 0}
table{width:100%;border-collapse:collapse;font-size:.92rem;min-width:420px}
th,td{border:1px solid var(--line);padding:9px 11px;text-align:left;vertical-align:top}
th{background:var(--th);font-weight:600}
footer{max-width:760px;margin:0 auto;padding:0 20px 60px;color:var(--muted);font-size:.88rem}
footer a{color:var(--accent)}
</style></head><body>
<header><a href="https://freevoices.co.za/">FreeVoices</a></header>
<main>
<h1>${esc(doc.title)}</h1>
<p class="meta">Version ${esc(doc.version)} &middot; Effective ${esc(effective)} &middot; Operated by Made On Chain</p>
${doc.content_html}
</main>
<footer>
<p><a href="/legal/privacy">Privacy Policy</a> &middot; <a href="/legal/terms">Terms of Service</a> &middot; <a href="/legal/delete-account">Delete your account</a></p>
<p>Already using FreeVoices? <a href="https://freevoices.co.za/">Open the app</a>.</p>
</footer>
</body></html>`;
}

app.get('/legal/:slug', async (req, res) => {
  const { slug } = req.params;
  if (!LEGAL_SLUGS[slug]) return res.status(404).type('html').send('<h1>Not found</h1>');
  try {
    const rows = await executeQuery(
      `SELECT ${LEGAL_COLUMNS}, content_html FROM legal_documents WHERE slug = ? AND is_current = 1 LIMIT 1`,
      [slug]
    );
    if (rows.length === 0) {
      logger.warn('Legal page requested but no version is published', { slug });
      return res.status(503).type('html').send(
        `<h1>${LEGAL_SLUGS[slug]}</h1><p>This document is being finalised and is not yet published. ` +
        `Please contact <a href="mailto:admin@madeoc.co.za">admin@madeoc.co.za</a> in the meantime.</p>`
      );
    }
    res.set({ 'Cache-Control': 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff' })
       .type('html').send(renderLegalPage(rows[0]));
  } catch (error) {
    logger.error('Legal page error:', error);
    res.status(500).type('html').send('<h1>Something went wrong</h1>');
  }
});

// Short aliases for store listings, email footers and PDFs.
app.get(['/privacy', '/privacy-policy'], (req, res) => res.redirect(301, '/legal/privacy'));
app.get(['/terms', '/terms-of-service'], (req, res) => res.redirect(301, '/legal/terms'));
app.get('/delete-account', (req, res) => res.redirect(301, '/legal/delete-account'));

// ─── Customer payment page ────────────────────────────────────────────────────
//
// Reached from a link in the invoice email and the invoice PDF. Neither of
// those can carry an HTML form, and PayFast's custom integration requires a
// signed POST — so this page is the bridge. It is server-rendered rather than
// an Angular route for three reasons: the SPA cannot produce a signature
// without another authenticated round trip, it would collide with the catch-all
// below, and a server route is what makes the tight per-route CSP possible.

const payLimiter = limiter(15, 60, 'Too many requests. Please try again shortly.');

/**
 * Where links that outlive their request should point.
 *
 * Always APP_URL, never derived from the request. buildInvoicePdf also runs
 * from the recurring-invoice cron where there is no request at all, and
 * req.get('host') is attacker-controlled — which would turn an emailed payment
 * link into a host-header injection.
 */
function appBaseUrl() {
  return (process.env.APP_URL || 'https://freevoices.co.za').replace(/\/+$/, '');
}

const payUrlFor = (token) => `${appBaseUrl()}/pay/${token}`;

/**
 * Give an invoice a payment token, once.
 *
 * Deliberately not share_token: POST /api/invoices/:id/share rotates that on
 * every call, so reusing it would break every pay link already sitting in a
 * customer's inbox the moment the seller pressed "Share" again.
 *
 * The row is re-read instead of trusting affectedRows, because a concurrent
 * send could have won the race — and both callers have to end up quoting the
 * same token.
 */
async function ensurePayToken(invoiceId) {
  const before = await executeQuery('SELECT pay_token FROM documents WHERE id = ?', [invoiceId]);
  if (before.length === 0) return null;
  if (before[0].pay_token) return before[0].pay_token;

  await executeQuery(
    'UPDATE documents SET pay_token = ? WHERE id = ? AND pay_token IS NULL',
    [randomUUID().replace(/-/g, ''), invoiceId]
  );
  const after = await executeQuery('SELECT pay_token FROM documents WHERE id = ?', [invoiceId]);
  return after.length ? after[0].pay_token : null;
}

/**
 * The pay URL for an invoice, or null when online payment is not available.
 *
 * Mints the token on first use, so an invoice never reaches a customer with a
 * button that has nowhere to point. isPayfastEligible is the single source of
 * truth here: if this returns null the pay page would refuse the invoice too,
 * and a button in a PDF outlives every chance to correct it.
 */
async function resolvePayUrl(invoice, seller) {
  if (!isPayfastEligible({ invoice, user: seller })) return null;
  const token = await ensurePayToken(invoice.id);
  return token ? payUrlFor(token) : null;
}

/**
 * A CSP for this route only.
 *
 * The global directives at the top of this file set form-action 'self', which
 * blocks a POST to payfast.co.za. Widening it globally would let every page in
 * the SPA post to PayFast, so instead this replaces the header for the pay page
 * alone — helmet writes with res.setHeader, so the later call wins.
 *
 * The page carries no JavaScript at all, which is what lets script-src be
 * 'none'. The stylesheet is nonced rather than 'unsafe-inline'; note that a
 * nonce does not cover style-src-attr, so the markup uses classes and never a
 * style="..." attribute.
 */
const PAYFAST_FORM_ORIGINS = [
  'https://www.payfast.co.za',
  'https://payfast.co.za',
  'https://sandbox.payfast.co.za',
];

const payPageCsp = (allowPayfastForm) => (req, res, next) => {
  res.locals.cspNonce = randomUUID().replace(/-/g, '');
  if (process.env.CSP_ENABLED === 'false') return next();
  return helmet.contentSecurityPolicy({
    useDefaults: false,
    directives: {
      defaultSrc: ["'none'"],
      scriptSrc: ["'none'"],
      styleSrc: ["'self'", `'nonce-${res.locals.cspNonce}'`],
      imgSrc: ["'self'", 'data:'],
      formAction: allowPayfastForm ? PAYFAST_FORM_ORIGINS : ["'none'"],
      baseUri: ["'none'"],
      frameAncestors: ["'none'"],
      ...(IS_PRODUCTION ? { upgradeInsecureRequests: [] } : {}),
    },
  })(req, res, next);
};

const escapeHtml = (value) => String(value ?? '').replace(
  /[<>&"']/g,
  (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c])
);

function formatMoney(symbol, amount) {
  const n = Number(amount || 0).toFixed(2);
  // Thin space as a thousands separator, the South African convention.
  const [whole, cents] = n.split('.');
  return `${symbol || 'R'} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')}.${cents}`;
}

function renderPayShell({ title, nonce, body }) {
  return `<!DOCTYPE html><html lang="en-ZA"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)} · FreeVoices</title>
<style nonce="${nonce}">
:root{color-scheme:light dark;--bg:#f3f4f6;--card:#fff;--fg:#1a1a2e;--muted:#6b7280;--line:#e5e7eb;--accent:#4a90e2}
@media(prefers-color-scheme:dark){:root{--bg:#0e0e16;--card:#12121c;--fg:#e5e7eb;--muted:#9ca3af;--line:#374151}}
*{box-sizing:border-box}
body{margin:0;font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:var(--fg);background:var(--bg)}
header{background:#1a1a2e;padding:18px 20px;color:#fff;font-weight:600}
main{max-width:520px;margin:0 auto;padding:28px 20px 80px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:24px;margin-bottom:18px}
h1{font-size:1.3rem;margin:0 0 6px}
.sub{color:var(--muted);font-size:.92rem;margin:0 0 20px}
dl{display:grid;grid-template-columns:auto 1fr;gap:8px 16px;margin:0 0 20px;font-size:.95rem}
dt{color:var(--muted)}
dd{margin:0;text-align:right;font-variant-numeric:tabular-nums}
.total{border-top:1px solid var(--line);margin-top:4px;padding-top:14px;display:flex;justify-content:space-between;align-items:baseline}
.total .label{color:var(--muted);font-size:.95rem}
.total .amount{font-size:1.5rem;font-weight:700;font-variant-numeric:tabular-nums}
button{width:100%;padding:15px 20px;font-size:1.02rem;font-weight:600;color:#fff;background:var(--accent);border:0;border-radius:8px;cursor:pointer;font-family:inherit}
button:hover{filter:brightness(1.07)}
.note{color:var(--muted);font-size:.85rem;margin:14px 0 0;text-align:center}
.bank{font-size:.92rem}
.bank h2{font-size:.95rem;margin:0 0 10px}
.bank div{display:flex;justify-content:space-between;gap:16px;padding:5px 0;border-bottom:1px solid var(--line)}
.bank div:last-child{border-bottom:0}
.bank span:first-child{color:var(--muted)}
footer{max-width:520px;margin:0 auto;padding:0 20px 50px;color:var(--muted);font-size:.82rem;text-align:center}
</style></head><body>
<header>FreeVoices</header>
<main>${body}</main>
<footer><p>Invoice delivered by FreeVoices. Payments are processed by Payfast (Pty) Ltd.</p></footer>
</body></html>`;
}

/** The seller's banking details, as a fallback whenever card payment is off. */
function renderBankBlock(seller) {
  const rows = [
    ['Bank', seller.bank_name],
    ['Account', seller.bank_account_number],
    ['Branch code', seller.bank_branch_code],
    ['Account type', seller.bank_account_type],
  ].filter(([, v]) => v);
  if (rows.length === 0) return '';
  return `<div class="card bank"><h2>Pay by bank transfer</h2>${
    rows.map(([k, v]) => `<div><span>${escapeHtml(k)}</span><span>${escapeHtml(v)}</span></div>`).join('')
  }</div>`;
}

/**
 * Every non-payable outcome. Wording avoids confirming whether a token exists
 * for an invoice that was not found.
 */
function renderPayNotice({ nonce, title, heading, message, seller }) {
  return renderPayShell({
    title, nonce,
    body: `<div class="card"><h1>${escapeHtml(heading)}</h1><p class="sub">${escapeHtml(message)}</p></div>`
      + (seller ? renderBankBlock(seller) : ''),
  });
}

app.get('/pay/:token', payLimiter, payPageCsp(true), async (req, res) => {
  // A payment page must never be cached: it shows live status and an amount.
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  const nonce = res.locals.cspNonce;

  try {
    const { token } = req.params;
    const rows = await executeQuery(
      `SELECT d.id, d.user_id, d.document_number, d.status, d.total, d.due_date,
              c.name AS customer_name, c.email AS customer_email,
              cur.code AS currency_code, cur.symbol AS currency_symbol,
              u.company_name, u.email AS company_email,
              u.bank_name, u.bank_account_number, u.bank_branch_code, u.bank_account_type,
              u.payfast_enabled, u.payfast_merchant_id, u.payfast_merchant_key, u.payfast_passphrase
         FROM documents d
         JOIN customers c ON c.id = d.customer_id
         LEFT JOIN currencies cur ON cur.id = d.currency_id
         JOIN users u ON u.id = d.user_id
        WHERE d.pay_token = ? AND d.type = 'INVOICE'`,
      [token]
    );

    if (rows.length === 0) {
      return res.status(404).type('html').send(renderPayNotice({
        nonce, title: 'Payment link not valid', heading: 'This payment link is not valid',
        message: 'The link may have been mistyped. Please check the invoice you were sent, or contact the sender.',
      }));
    }

    // The joined row carries the three encrypted users columns under their own
    // names, and nothing in documents or customers collides with them.
    const [row] = await hydrateDocumentSnapshots(executeQuery, [decryptUserRow(rows[0])]);
    const symbol = row.currency_symbol || 'R';
    const seller = row;

    if (row.status === 'CANCELLED') {
      return res.status(410).type('html').send(renderPayNotice({
        nonce, title: 'Invoice cancelled', heading: 'This invoice was cancelled',
        message: `Invoice ${row.document_number} is no longer payable. Please contact ${row.company_name || 'the sender'} if you believe this is a mistake.`,
      }));
    }
    if (row.status === 'DRAFT') {
      return res.status(410).type('html').send(renderPayNotice({
        nonce, title: 'Invoice not issued', heading: 'This invoice has not been issued yet',
        message: 'Please wait for the sender to finalise and send it.',
      }));
    }

    // A PDF is a frozen artifact: its link will keep pointing here for years,
    // long after the invoice is settled. "Already paid" is a normal outcome,
    // not an error.
    const financial = await invoiceSettlement(executeQuery,row.id);
    const alreadyPaid = ['PAID','CREDITED'].includes(row.status) || financial.settled;
    // What the buyer is asked for. A part payment already recorded comes off,
    // or a customer who paid a deposit would be charged the full total again.
    const balance = financial.balanceDue;

    if (alreadyPaid) {
      return res.type('html').send(renderPayNotice({
        nonce, title: 'Invoice settled', heading: 'This invoice is settled',
        message: `Invoice ${row.document_number} is settled. Nothing further is due — there is no need to pay again.`,
      }));
    }

    const currency = row.currency_code || PAYFAST_CURRENCY;
    if (currency !== PAYFAST_CURRENCY) {
      return res.type('html').send(renderPayNotice({
        nonce, title: 'Card payment unavailable', heading: 'Card payment is not available for this invoice',
        message: `Online card payment supports South African rand only, and this invoice is in ${currency}. You can still pay by bank transfer.`,
        seller,
      }));
    }
    if (balance < PAYFAST_MIN_AMOUNT) {
      return res.type('html').send(renderPayNotice({
        nonce, title: 'Amount below minimum', heading: 'This amount is below the online payment minimum',
        message: `PayFast cannot process payments under ${formatMoney('R', PAYFAST_MIN_AMOUNT)}. You can still pay by bank transfer.`,
        seller,
      }));
    }
    if (!isPayfastEligible({ invoice: { ...row, total: balance, currency_code: currency }, user: row })) {
      return res.type('html').send(renderPayNotice({
        nonce, title: 'Online payment unavailable', heading: 'Online payment is not available for this invoice',
        message: `${row.company_name || 'The sender'} has not switched on online card payments. You can pay by bank transfer instead.`,
        seller,
      }));
    }

    const urls = {
      returnUrl: `${appBaseUrl()}/pay/${token}/return`,
      cancelUrl: `${appBaseUrl()}/pay/${token}/cancelled`,
      notifyUrl: `${appBaseUrl()}/payfast/itn`,
    };
    const { action, fields } = buildPaymentForm({
      invoice: { ...row, total: balance },
      user: row,
      customer: { name: row.customer_name, email: row.customer_email },
      urls,
      mode: process.env.PAYFAST_MODE,
    });

    // Rendered as a one-click interstitial rather than an auto-submitting form.
    // That keeps the page JavaScript-free (so script-src can be 'none'), stops
    // link prefetchers and corporate mail scanners from opening PayFast
    // sessions on the buyer's behalf, and lets the buyer see what they are
    // paying before they leave this domain.
    const dueRow = row.due_date
      ? `<dt>Due</dt><dd>${escapeHtml(formatDisplayDate(row.due_date, { day: '2-digit', month: 'long', year: 'numeric' }))}</dd>`
      : '';

    const body = `<div class="card">
<h1>Pay invoice ${escapeHtml(row.document_number)}</h1>
<p class="sub">${escapeHtml(row.company_name || 'Invoice')}</p>
<dl>
<dt>Billed to</dt><dd>${escapeHtml(row.customer_name)}</dd>
${dueRow}
</dl>
<div class="total"><span class="label">Amount due</span><span class="amount">${escapeHtml(formatMoney(symbol, balance))}</span></div>
<form action="${escapeHtml(action)}" method="post">
${fields.map((f) => `<input type="hidden" name="${escapeHtml(f.name)}" value="${escapeHtml(f.value)}">`).join('\n')}
<p class="note">You will be taken to PayFast to complete the payment securely.</p>
<button type="submit">Pay ${escapeHtml(formatMoney(symbol, balance))} with PayFast</button>
</form>
</div>${renderBankBlock(seller)}`;

    res.type('html').send(renderPayShell({ title: `Pay invoice ${row.document_number}`, nonce, body }));
  } catch (error) {
    logger.error('Pay page error:', { message: error.message });
    res.status(500).type('html').send(renderPayNotice({
      nonce, title: 'Something went wrong', heading: 'Something went wrong',
      message: 'We could not load this payment page. Please try again shortly.',
    }));
  }
});

/**
 * Where PayFast returns the buyer.
 *
 * This page must NEVER mark anything paid. PayFast posts no transaction data to
 * return_url — everything of record arrives on the ITN endpoint, server to
 * server, and usually lands BEFORE the buyer gets back here. Treating a visit
 * to this URL as proof of payment would let anyone settle an invoice by typing
 * the address.
 */
app.get('/pay/:token/return', payLimiter, payPageCsp(false), async (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  const nonce = res.locals.cspNonce;
  try {
    const rows = await executeQuery(
      "SELECT document_number, status FROM documents WHERE pay_token = ? AND type = 'INVOICE'",
      [req.params.token]
    );
    const invoice = rows[0];
    const confirmed = invoice && invoice.status === 'PAID';
    res.type('html').send(renderPayNotice({
      nonce,
      title: confirmed ? 'Payment received' : 'Payment submitted',
      heading: confirmed ? 'Payment received — thank you' : 'Thank you — your payment is being confirmed',
      message: confirmed
        ? `Invoice ${invoice.document_number} is now marked as paid. A receipt will follow by email.`
        : 'PayFast is confirming your payment with us. This usually takes a few seconds. You can close this page — the invoice will update automatically, and you will receive a receipt by email.',
    }));
  } catch (error) {
    logger.error('Pay return page error:', { message: error.message });
    res.type('html').send(renderPayNotice({
      nonce, title: 'Payment submitted', heading: 'Thank you — your payment is being confirmed',
      message: 'You can close this page. The invoice will update automatically once PayFast confirms the payment.',
    }));
  }
});

app.get('/pay/:token/cancelled', payLimiter, payPageCsp(false), (req, res) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  res.type('html').send(renderPayNotice({
    nonce: res.locals.cspNonce,
    title: 'Payment cancelled',
    heading: 'Payment cancelled',
    message: 'No payment was taken and nothing has been charged. You can reopen the payment link from your invoice whenever you are ready.',
  }));
});

// ─── PayFast instant transaction notification ─────────────────────────────────
//
// PayFast posts here server-to-server as soon as a payment resolves, BEFORE the
// buyer is returned to the pay page. Nothing is posted to return_url, so this
// endpoint is the only record of a payment — if it stops working, money arrives
// and invoices silently stay unpaid.
//
// Mounted outside /api on purpose: the /api limiter allows 1000 requests per 15
// minutes keyed by IP, and PayFast posts from about five addresses. A 429 here
// makes PayFast give up retrying.

const itnLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { message: 'Too many notifications.' },
  // Never throttle a genuine PayFast address. The signature and the postback
  // are the real gate; this limiter exists only to stop someone else flooding
  // the endpoint.
  skip: (req) => process.env.RATE_LIMIT_DISABLED === 'true' || isPayfastIp(req.ip),
});

/**
 * Record a payment against an invoice and settle it, atomically.
 *
 * Shared by the PayFast notification and the manual "mark as paid" action so
 * the two cannot drift. The three writes used to run outside a transaction,
 * which meant a failure between them left a payment with no status change, or
 * a status change with no audit row.
 *
 * The invoice only becomes PAID once its payments cover the total. It used to
 * flip to PAID on any payment at all, so R400 against R1,150 read as settled
 * and the outstanding R750 vanished from every screen.
 *
 * Returns { duplicate, settled, cancelled, overpayment, balanceBefore, balanceAfter }.
 */
async function recordInvoicePayment({
  invoiceId, amount, paymentDate, method, reference = null, notes = null,
  provider = null, providerPaymentId = null, status = null,
  feeAmount = null, netAmount = null, rawPayload = null,
  ip = null, userAgent = null, rejectOverpayment = false,
}, transactionQuery = null) {
  const record = async (q) => {
    // Lock the invoice first, so two payments recorded at the same moment are
    // checked against the balance one after the other, not both against the
    // same stale figure.
    const [invoice] = await q('SELECT total, status FROM documents WHERE id = ? FOR UPDATE', [invoiceId]);
    if (rejectOverpayment && invoice.status === 'CANCELLED') throw Object.assign(new Error('Cannot record payment on a cancelled invoice'), { status: 400 });
    const before = await invoiceSettlement(q, invoiceId);
    const balanceBefore = before.balanceDue;
    if (rejectOverpayment && Number(amount) > balanceBefore + SETTLED_TOLERANCE) {
      return { duplicate: false, settled: false, cancelled: false, overpayment: true, balanceBefore, balanceAfter: balanceBefore };
    }

    await captureDocumentSnapshot(q, invoiceId);

    let paymentId;
    try {
      const inserted = await q(
        `INSERT INTO payments (document_id, amount, payment_date, payment_method, transaction_reference,
                               notes, provider, provider_payment_id, status, fee_amount, net_amount, raw_payload)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [invoiceId, amount, paymentDate, method,
         encryptField('payments', 'transaction_reference', reference), notes,
         provider, providerPaymentId, status, feeAmount, netAmount, rawPayload]
      );
      paymentId = inserted.insertId;
    } catch (err) {
      // PayFast re-sends a notification until it gets a 200, so the same
      // pf_payment_id legitimately arrives more than once. Caught explicitly
      // rather than using INSERT IGNORE, which would also swallow truncation
      // and foreign-key errors — that is how a payment goes missing unnoticed.
      if (err.code === 'ER_DUP_ENTRY') return { duplicate: true, settled: false, cancelled: invoice.status === 'CANCELLED', overpayment: false, balanceBefore, balanceAfter: balanceBefore };
      throw err;
    }

    const after = await invoiceSettlement(q, invoiceId);
    const settled = after.settled && after.adjustedTotal>0;
    const cancelled = invoice.status === 'CANCELLED';

    // A payment against a cancelled invoice must not resurrect it. The money
    // is still recorded — see the caller, which alerts the seller. A part
    // payment leaves the status alone: SENT stays SENT and OVERDUE stays
    // OVERDUE until the balance is cleared.
    if (settled && !cancelled && after.adjustedTotal>0) {
      await q(`UPDATE documents SET status = 'PAID', updated_at = NOW() WHERE id = ?`, [invoiceId]);
    }
    await q(
      `INSERT INTO document_tracking (document_id, event_type, ip_address, user_agent)
       VALUES (?, ?, ?, ?)`,
      [invoiceId, settled ? 'PAID' : 'PAYMENT', encTracking('ip_address', ip), encTracking('user_agent', userAgent)]
    );
    return { duplicate: false, settled, cancelled, overpayment: false, balanceBefore, balanceAfter: after.balanceDue, paymentId };
  };
  return transactionQuery ? record(transactionQuery) : withTransaction(record);
}

/**
 * Receipt to the buyer, and a warning to the seller when something needs a
 * human. Runs after the transaction has committed and never throws into the
 * request: a dead SMTP server must not turn into a non-200 and an endless
 * PayFast retry loop.
 */
async function sendPayfastFollowUps(invoice, posted, outcome) {
  const [items, users, logoRows, payments] = await Promise.all([
    executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [invoice.id]),
    queryDecrypted(decryptUserRow, 'SELECT * FROM users WHERE id = ?', [invoice.user_id]),
    executeQuery("SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'company_logo'", [invoice.user_id]),
    queryDecrypted(decryptPaymentRow, 'SELECT * FROM payments WHERE document_id = ? ORDER BY payment_date DESC', [invoice.id]),
  ]);

  const logoRelPath = logoRows[0] ? logoRows[0].setting_value : null;
  const user = await documentSeller(executeQuery, invoice.id, { ...decryptUserRow(users[0]), logo_path: logoRelPath ? path.join(__dirname, logoRelPath) : null });
  const full = await queryDecrypted(decryptCustomerJoin,
    `SELECT d.*, c.name AS customer_name, c.email AS customer_email,
            c.billing_address AS customer_billing_address, c.vat_number AS customer_vat_number,
            cur.symbol AS currency_symbol, cur.code AS currency_code
       FROM documents d
       JOIN customers c ON c.id = d.customer_id
       LEFT JOIN currencies cur ON cur.id = d.currency_id
      WHERE d.id = ?`,
    [invoice.id]
  );

  // A receipt says "paid in full", so a part payment does not get one. The pay
  // page charges the outstanding balance, so in practice only a race with a
  // manually recorded payment lands here unsettled.
  const paidInvoice=full.length ? await withInvoiceFinancials(executeQuery,full[0]) : null;
  if (outcome.settled && paidInvoice?.customer_email && Number(paidInvoice.amount_paid)>0 && Number(paidInvoice.adjusted_total)>0) {
    const pdf = await buildReceiptPdf(paidInvoice, items, user, payments);
    const mail=await captureEmail(emailService,'sendReceiptEmail',paidInvoice.customer_email,{...paidInvoice,company_name:user.company_name},pdf);
    await queueEmail({userId:invoice.user_id,documentId:invoice.id,kind:'RECEIPT',key:`receipt:${invoice.id}:full`,mail});
  }

  // The two cases a seller genuinely has to act on. Rejecting either payment
  // would be worse: the money is in their PayFast account either way, and an
  // unrecorded payment is far harder to reconcile than a flagged one.
  const alert = outcome.cancelled
    ? `a payment was received for invoice ${invoice.document_number}, but the invoice is CANCELLED`
    : (invoice.status === 'PAID'
      ? `a second payment was received for invoice ${invoice.document_number}, which was already marked paid`
      : (Number(posted.amount_gross) > outcome.balanceBefore + SETTLED_TOLERANCE
        ? `a payment was received for invoice ${invoice.document_number} that exceeds the ${outcome.balanceBefore.toFixed(2)} that was outstanding`
        : null));

  if (alert && user.email) {
    const mail=await captureEmail(emailService,'sendPaymentAlertEmail',user.email, {
      contact_person: user.contact_person,
      document_number: invoice.document_number,
      amount: Number(posted.amount_gross).toFixed(2),
      reference: posted.pf_payment_id,
      reason: alert,
    });
    await queueEmail({userId:invoice.user_id,documentId:invoice.id,kind:'ALERT',key:`payfast:alert:${posted.pf_payment_id}`,mail});
  }
}

app.post('/payfast/itn',
  itnLimiter,
  // The global parser is JSON-only; this body is form-urlencoded. The raw text
  // is kept because the signature must be rebuilt from the parameters exactly
  // as PayFast sent them — re-encoding a parsed object reintroduces every
  // escaping difference the signature helper exists to handle.
  express.urlencoded({
    extended: false,
    limit: '64kb',
    verify: (req, _res, buf) => { req.rawBody = buf.toString('latin1'); },
  }),
  async (req, res) => {
    const posted = req.body || {};
    const { sandbox } = payfastUrls(process.env.PAYFAST_MODE);

    // Logged three ways because a proxy misconfiguration is the most common
    // cause of a rejected notification, and TRUST_PROXY_HOPS cannot be tuned
    // without seeing what actually arrived.
    const source = {
      ip: req.ip,
      remoteAddress: req.socket.remoteAddress,
      forwardedFor: req.get('x-forwarded-for') || null,
    };

    // The raw body carries the buyer's name and email address, so it is only
    // kept verbatim in sandbox — where replaying it is how you iterate without
    // burning test transactions. Production logs the non-personal fields only.
    if (sandbox) {
      logger.info('PayFast ITN received (sandbox)', { source, rawBody: req.rawBody });
    } else {
      logger.info('PayFast ITN received', {
        source,
        m_payment_id: posted.m_payment_id,
        pf_payment_id: posted.pf_payment_id,
        payment_status: posted.payment_status,
        amount_gross: posted.amount_gross,
      });
    }

    // 200 means "received, and a final decision has been made"; a non-2xx asks
    // PayFast to try again. A forged or malformed notification can never become
    // valid, so it gets a 200 and the retries stop.
    const done = (reason, level = 'warn') => {
      logger[level]('PayFast ITN not actioned', {
        reason, m_payment_id: posted.m_payment_id, pf_payment_id: posted.pf_payment_id,
      });
      return res.sendStatus(200);
    };

    try {
      // 1. Shape.
      for (const field of ['m_payment_id', 'pf_payment_id', 'payment_status', 'amount_gross', 'merchant_id', 'signature']) {
        if (!posted[field]) return done(`missing field: ${field}`);
      }

      // 2. Source address. Free, no I/O, so it goes before anything expensive.
      if (!isPayfastIp(req.ip)) return done('source address is not in PayFast\'s published ranges');

      // 3. Resolve the invoice and the seller who owns it.
      const rows = await executeQuery(
        `SELECT d.id, d.user_id, d.document_number, d.status, d.total,
                u.payfast_merchant_id, u.payfast_passphrase
           FROM documents d
           JOIN users u ON u.id = d.user_id
          WHERE d.id = ? AND d.type = 'INVOICE'`,
        [posted.m_payment_id]
      );
      if (rows.length === 0) return done(`no invoice matches m_payment_id ${posted.m_payment_id}`);
      const invoice = decryptUserRow(rows[0]);

      // 4. Is this the seller's own merchant account?
      if (String(posted.merchant_id) !== String(invoice.payfast_merchant_id || '')) {
        return done('merchant_id does not match the invoice owner', 'error');
      }

      // 5. Signature, under THIS seller's passphrase.
      //
      //    Checks 4 and 5 together are what stop another PayFast merchant from
      //    forging a COMPLETE against someone else's invoice: the postback in
      //    check 7 would happily answer VALID, because for *their* account the
      //    transaction is genuine. This is why a seller cannot switch PayFast
      //    on without setting a passphrase.
      const sig = verifyItnSignature(req.rawBody, posted, invoice.payfast_passphrase);
      if (!sig.valid) return done(`signature check failed (${sig.source})`, 'error');
      if (sig.source !== 'raw') {
        // Worth knowing about: it means PayFast changed how they serialise the
        // body and the raw slice no longer matches. Still valid, but the
        // fallback is doing the work.
        logger.warn('PayFast ITN: signature matched only via the parsed fallback', { pf_payment_id: posted.pf_payment_id });
      }

      // 6. Amount. mysql2 hands decimal columns back as strings, so both sides
      //    are coerced and compared with a tolerance rather than ===.
      //
      //    The pay page charges what is still outstanding, not the invoice
      //    total, so that is what a genuine notification carries. This very
      //    transaction is excluded from the sum: PayFast re-sends until it gets
      //    a 200, and a repeat must reach the duplicate check further down
      //    rather than fail here against a balance it already reduced.
      //
      //    The full total is still accepted. A buyer with the pay page open in
      //    two tabs can pay twice; refusing the second notification would
      //    leave real money unrecorded. It is recorded and the seller alerted.
      const [{ paid: alreadyPaid }] = await executeQuery(
        `SELECT COALESCE(SUM(amount), 0) AS paid FROM payments
          WHERE document_id = ? AND NOT (provider <=> 'PAYFAST' AND provider_payment_id <=> ?)`,
        [invoice.id, String(posted.pf_payment_id)]
      );
      const [adjustments] = await executeQuery(`SELECT
        (SELECT COALESCE(SUM(total),0) FROM credit_notes WHERE invoice_id=?) AS credited,
        (SELECT COALESCE(SUM(amount),0) FROM payment_refunds WHERE invoice_id=?) AS refunded`,[invoice.id,invoice.id]);
      const expected = adjustmentSettlement(invoice.total,adjustments.credited,alreadyPaid,adjustments.refunded).balanceDue;
      const received = Number(posted.amount_gross);
      const matchesBalance = Math.abs(expected - received) <= 0.01;
      const matchesTotal = Math.abs(Number(invoice.total) - received) <= 0.01;
      if (!matchesBalance && !matchesTotal) {
        return done(`amount mismatch: expected ${expected.toFixed(2)}, received ${posted.amount_gross}`, 'error');
      }

      // 7. Ask PayFast whether they actually sent this. The only network call,
      //    and the only failure that justifies asking for a retry.
      let confirmed;
      try {
        confirmed = await validateItnWithPayfast(itnParamStringFromRaw(req.rawBody), process.env.PAYFAST_MODE);
      } catch (err) {
        logger.error('PayFast ITN: validation postback failed — asking PayFast to retry', { message: err.message });
        return res.sendStatus(500);
      }
      if (!confirmed) return done('PayFast did not confirm this notification', 'error');

      if (posted.payment_status !== 'COMPLETE') {
        // CANCELLED, and anything PayFast adds later. Deliberately no
        // document_tracking row: that enum's CANCELLED means the INVOICE was
        // cancelled, and writing it here would corrupt the audit trail.
        return done(`payment_status is ${posted.payment_status} — nothing recorded`, 'info');
      }

      const outcome = await recordInvoicePayment({
        invoiceId: invoice.id,
        amount: Number(posted.amount_gross).toFixed(2),
        // The notification carries no date, and payments.payment_date is NOT NULL.
        paymentDate: todayIso(),
        method: 'PAYFAST',
        reference: String(posted.pf_payment_id),
        provider: 'PAYFAST',
        providerPaymentId: String(posted.pf_payment_id),
        status: 'COMPLETE',
        feeAmount: posted.amount_fee !== undefined ? Number(posted.amount_fee).toFixed(2) : null,
        netAmount: posted.amount_net !== undefined ? Number(posted.amount_net).toFixed(2) : null,
        // Signature stripped: it is a shared-secret digest and has no value once verified.
        rawPayload: JSON.stringify({ ...posted, signature: undefined }),
        ip: req.ip,
        userAgent: 'PayFast ITN',
      });

      if (outcome.duplicate) {
        logger.info('PayFast ITN: already recorded, ignoring the repeat', { pf_payment_id: posted.pf_payment_id });
        return res.sendStatus(200);
      }

      logger.info('PayFast payment recorded', {
        invoice: invoice.document_number,
        pf_payment_id: posted.pf_payment_id,
        amount: posted.amount_gross,
        settled: outcome.settled,
        balanceAfter: outcome.balanceAfter,
      });

      // Best effort, and deliberately not awaited into the response.
      sendPayfastFollowUps(invoice, posted, outcome).catch((err) =>
        logger.error('PayFast follow-up email failed', { message: err.message })
      );

      return res.sendStatus(200);
    } catch (error) {
      // A database failure is genuinely undecided, so let PayFast retry.
      logger.error('PayFast ITN handler error', { message: error.message, stack: error.stack });
      return res.sendStatus(500);
    }
  }
);

// Must sit above the SPA catch-all, or it returns the Angular shell.
// /portal/ carries invoice share tokens — a crawled link would expose a full
// invoice, including the seller's banking details, to anyone.
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Disallow: /portal/',
    'Disallow: /pay/',
    'Disallow: /api/',
    'Disallow: /uploads/',
    'Allow: /legal/',
    'Allow: /$',
    '',
  ].join('\n'));
});

// An unknown API path must fail loudly. Falling through to the Angular shell
// answers 200 with HTML, which a download handler saves as a "corrupt" PDF.
app.all('/api/*', (req, res) => {
  res.status(404).json({ message: 'Not found' });
});

// Catch-all route for Angular app
app.get('*', (req, res) => {
  res.sendFile(path.join(WEB_ROOT, 'index.html'));
});

// Start server
const port = process.env.PORT || 3000;

/**
 * Transient connection faults, as opposed to a migration that genuinely failed.
 *
 * The distinction matters: refusing to start on a bad migration is correct, but
 * refusing to start because one TCP connection was reset takes the whole site
 * down until somebody notices and restarts it by hand. This host closes idle
 * connections aggressively (wait_timeout = 60), so a blip at boot is likely.
 */
const TRANSIENT_DB_ERRORS = new Set([
  'ECONNRESET', 'PROTOCOL_CONNECTION_LOST', 'ECONNREFUSED', 'ETIMEDOUT',
  'EPIPE', 'EHOSTUNREACH', 'ENOTFOUND', 'ER_LOCK_WAIT_TIMEOUT', 'ER_CON_COUNT_ERROR',
]);

const BOOT_MAX_ATTEMPTS = parseInt(process.env.BOOT_DB_MAX_ATTEMPTS, 10) || 5;

function startListening() {
  if (!fs.existsSync(path.join(WEB_ROOT, 'index.html'))) {
    logger.error(`${path.join(WEB_ROOT, 'index.html')} is missing — run \`ng build\` before starting the server. API routes will work; the web app will 404.`);
  }
  app.listen(port, () => {
    logger.info(`Server is running on port ${port}`);
  });
}

async function bootstrap(attempt = 1) {
  try {
    await runMigrations();
    // Must run after migrations (it needs crypto_canary) and before listening:
    // serving traffic on the wrong key means every encrypted read fails while
    // new rows are written under a key that cannot read the old ones.
    const canary = await verifyCanary();
    logger.info('Field encryption check', canary);
    startListening();
    processRecurringInvoices().then(()=>processOverdueInvoices()).then(()=>processOutbox(emailService.transporter)).catch(error=>logger.error('Billing recovery failed',error));
  } catch (err) {
    const transient = TRANSIENT_DB_ERRORS.has(err.code);

    if (transient && attempt < BOOT_MAX_ATTEMPTS) {
      // Back off: 2s, 4s, 8s, 16s. The migration runner is idempotent and holds
      // a lock, so retrying is safe.
      const delayMs = 2000 * Math.pow(2, attempt - 1);
      logger.warn('Database not ready during startup — retrying', {
        attempt, of: BOOT_MAX_ATTEMPTS, code: err.code, retryInMs: delayMs,
      });
      setTimeout(() => bootstrap(attempt + 1), delayMs);
      return;
    }

    // Still fatal for a real migration failure: serving traffic against a
    // half-migrated schema is how you get silently truncated columns and
    // unrecoverable data loss.
    logger.error('Startup checks failed — refusing to start', {
      attempts: attempt, code: err.code, message: err.message, stack: err.stack,
    });
    process.exitCode = 1;
    closePool();
  }
}

bootstrap();

module.exports = app;
