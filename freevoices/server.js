require('dotenv').config();
const axios = require('axios');
const cron = require('node-cron');

const EmailService = require('./src/services/email.service');
const { buildInvoicePdf, buildReceiptPdf } = require('./src/services/pdf.service');
// The pool, the logger and the query helpers live in db.service so that CLI
// tooling can share them without booting an HTTP listener.
const { logger, executeQuery, getConnection, withTransaction, closePool } = require('./src/services/db.service');
const { runMigrations, tableExists } = require('./src/services/migrations.service');
const { anonymiseExpiredAccounts } = require('./src/services/retention.service');
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bodyParser = require('body-parser');
const argon2 = require('argon2');
const { OAuth2Client } = require('google-auth-library');
const { randomUUID } = require('crypto');
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
    if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(file.mimetype)) {
      return cb(new Error('Only image files (JPEG, PNG, GIF, WebP) are allowed'));
    }
    cb(null, true);
  }
});

const app = express();

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
  // "Continue with Google" button on the web build.
  scriptSrc: ["'self'", 'https://www.google.com', 'https://www.gstatic.com', 'https://accounts.google.com'],
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

app.use(express.static(WEB_ROOT));

// The `tls` block that used to be passed here was silently discarded —
// EmailService built its own, weaker one. TLS policy now lives entirely in
// EmailService, so there is one place to look.
const emailService = new EmailService({
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: parseInt(process.env.SMTP_PORT),
  SMTP_SECURE: process.env.SMTP_SECURE === 'true',
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
});

function validate(validators) {
  return async (req, res, next) => {
    for (const v of validators) await v.run(req);
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(422).json({ message: errors.array()[0].msg, errors: errors.array() });
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
      [token, SESSION_MAX_DAYS]
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
        [SESSION_IDLE_HOURS, SESSION_MAX_DAYS, token, SESSION_IDLE_HOURS - 1]
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
  await executeQuery('INSERT INTO sessions (userId, token, expires) VALUES (?, ?, ?)', [user.id, token, newSessionExpiry()]);
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

    const users = await executeQuery('SELECT * FROM users WHERE email = ?', [email]);
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
    await executeQuery('DELETE FROM sessions WHERE token = ?', [token]);
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
      [email, password_hash, company_name, company_registration, vat_number, contact_person, phone, address, bank_name, bank_account_number, bank_branch_code, bank_account_type]
    );
    const token = randomUUID();
    await executeQuery('INSERT INTO sessions (userId, token, expires) VALUES (?, ?, ?)', [result.insertId, token, newSessionExpiry()]);
    const user = await executeQuery('SELECT id, email, company_name FROM users WHERE id = ?', [result.insertId]);
    const verificationToken = randomUUID();
    const verificationExpires = new Date();
    verificationExpires.setHours(verificationExpires.getHours() + 24);
    await executeQuery('UPDATE users SET email_verification_token = ?, email_verification_expires = ? WHERE id = ?', [verificationToken, verificationExpires, result.insertId]);
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

    let users = await executeQuery('SELECT * FROM users WHERE google_id = ?', [claims.sub]);

    // Same person, already registered with a password. Link the Google account
    // onto the existing row instead of creating a duplicate they would then be
    // unable to reach their invoices from. Safe only because verifyGoogleIdToken
    // refuses tokens whose email_verified is not true.
    if (users.length === 0) {
      const byEmail = await executeQuery('SELECT * FROM users WHERE email = ?', [claims.email]);
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
      [claims.email, claims.sub, company_name, company_registration || null, vat_number || null,
       contact_person, phone, address, bank_name || null, bank_account_number || null,
       bank_branch_code || null, bank_account_type || null]
    );

    const token = randomUUID();
    await executeQuery('INSERT INTO sessions (userId, token, expires) VALUES (?, ?, ?)', [result.insertId, token, newSessionExpiry()]);
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
    const { token } = req.query;
    const result = await executeQuery('UPDATE users SET email_verified = true, email_verification_token = NULL, email_verification_expires = NULL WHERE email_verification_token = ? AND email_verification_expires > NOW()', [token]);
    if (result.affectedRows === 0) return res.status(400).json({ message: 'Invalid or expired verification token' });
    res.json({ message: 'Email verified successfully' });
  } catch (error) { logger.error('Email verification error:', error); res.status(500).json({ message: 'Verification failed' }); }
});

app.post('/api/auth/forgot-password', passwordLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required' });
    const users = await executeQuery('SELECT id FROM users WHERE email = ? AND email_verified = 1', [email]);
    if (users.length === 0) return res.json({ message: 'If that email is registered you will receive a reset link shortly.' });
    const token = randomUUID();
    await executeQuery('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))', [users[0].id, token]);
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
    const tokens = await executeQuery('SELECT id, user_id FROM password_reset_tokens WHERE token = ? AND expires_at > NOW() AND used = 0', [token]);
    if (tokens.length === 0) return res.status(400).json({ message: 'Invalid or expired reset token' });
    const { id: tokenId, user_id } = tokens[0];
    const passwordHash = await argon2.hash(password);
    await executeQuery('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, user_id]);
    await executeQuery('UPDATE password_reset_tokens SET used = 1 WHERE id = ?', [tokenId]);
    res.json({ message: 'Password updated successfully' });
  } catch (error) { logger.error('Reset password error:', error); res.status(500).json({ message: 'Failed to reset password' }); }
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
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;
    let sql = 'SELECT * FROM customers WHERE user_id = ? AND active = 1';
    let cntSql = 'SELECT COUNT(*) AS total FROM customers WHERE user_id = ? AND active = 1';
    const params = [req.user.id], cntParams = [req.user.id];
    if (search) { const clause = ' AND (name LIKE ? OR email LIKE ?)'; sql += clause; cntSql += clause; params.push(`%${search}%`, `%${search}%`); cntParams.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY name ASC LIMIT ? OFFSET ?'; params.push(limit, offset);
    const [customers, countResult] = await Promise.all([executeQuery(sql, params), executeQuery(cntSql, cntParams)]);
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
    const result = await executeQuery('INSERT INTO customers (user_id, name, email, phone, vat_number, billing_address, shipping_address, payment_terms, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [req.user.id, name, email, phone || null, vat_number || null, billing_address, shipping_address || null, payment_terms || null, notes || null]);
    res.status(201).json((await executeQuery('SELECT * FROM customers WHERE id = ?', [result.insertId]))[0]);
  } catch (error) { logger.error('Error creating customer:', error); res.status(500).json({ message: 'Failed to create customer' }); }
});

app.get('/api/customers/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const customers = await executeQuery('SELECT * FROM customers WHERE id = ? AND user_id = ? AND active = 1', [id, req.user.id]);
    if (customers.length === 0) return res.status(404).json({ message: 'Customer not found' });
    const documents = await executeQuery('SELECT * FROM documents WHERE customer_id = ? AND user_id = ? ORDER BY created_at DESC', [id, req.user.id]);
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
    await executeQuery('UPDATE customers SET name=?, email=?, phone=?, vat_number=?, billing_address=?, shipping_address=?, payment_terms=?, notes=?, updated_at=NOW() WHERE id = ? AND user_id = ?', [name, email, phone || null, vat_number || null, billing_address, shipping_address || null, payment_terms || null, notes || null, id, req.user.id]);
    res.json((await executeQuery('SELECT * FROM customers WHERE id = ?', [id]))[0]);
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

async function getNextDocumentNumber(userId, type) {
  const prefix = type === 'INVOICE' ? 'INV' : 'QUO';
  const year = new Date().getFullYear();
  const rows = await executeQuery('SELECT document_number FROM documents WHERE user_id = ? AND type = ? AND document_number LIKE ? ORDER BY id DESC LIMIT 1', [userId, type, `${prefix}-${year}-%`]);
  if (rows.length === 0) return `${prefix}-${year}-0001`;
  const seq = parseInt(rows[0].document_number.split('-')[2], 10) + 1;
  return `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
}

function advanceDate(dateStr, interval) {
  const [year, month, day] = dateStr.split('-').map(Number);
  const d = new Date(Date.UTC(year, month - 1, day));
  switch (interval) {
    case 'WEEKLY':    d.setUTCDate(d.getUTCDate() + 7); break;
    case 'MONTHLY':   d.setUTCMonth(d.getUTCMonth() + 1); break;
    case 'QUARTERLY': d.setUTCMonth(d.getUTCMonth() + 3); break;
    case 'YEARLY':    d.setUTCFullYear(d.getUTCFullYear() + 1); break;
  }
  return d.toISOString().split('T')[0];
}

app.get('/api/invoices', authenticateToken, async (req, res) => {
  try {
    const search = req.query.search || '', status = req.query.status || '';
    const page = Math.max(1, parseInt(req.query.page) || 1), limit = Math.min(100, parseInt(req.query.limit) || 20), offset = (page - 1) * limit;
    let sql = `SELECT d.id, d.document_number, d.status, d.issue_date, d.due_date, d.subtotal, d.vat_amount, d.total, d.created_at, d.notifications_muted, c.name AS customer_name FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.user_id = ? AND d.type = 'INVOICE'`;
    let cntSql = `SELECT COUNT(*) AS total FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.user_id = ? AND d.type = 'INVOICE'`;
    const params = [req.user.id], cntParams = [req.user.id];
    if (status) { sql += ' AND d.status = ?'; cntSql += ' AND d.status = ?'; params.push(status); cntParams.push(status); }
    if (search) { const clause = ' AND (d.document_number LIKE ? OR c.name LIKE ?)'; sql += clause; cntSql += clause; params.push(`%${search}%`, `%${search}%`); cntParams.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY d.created_at DESC LIMIT ? OFFSET ?'; params.push(limit, offset);
    const [invoices, countResult] = await Promise.all([executeQuery(sql, params), executeQuery(cntSql, cntParams)]);
    res.json({ data: invoices, total: countResult[0].total, page, limit });
  } catch (error) { logger.error('Error fetching invoices:', error); res.status(500).json({ message: 'Failed to fetch invoices' }); }
});

app.post('/api/invoices', authenticateToken, validate([
  body('customer_id').isInt({ min: 1 }).withMessage('A valid customer is required'),
  body('issue_date').isDate().withMessage('A valid issue date is required'),
  body('due_date').optional({ nullable: true }).isDate().withMessage('Due date must be a valid date'),
  body('payment_terms').optional({ nullable: true }).isInt({ min: 0 }).withMessage('Payment terms must be a positive number'),
  body('items').isArray({ min: 1 }).withMessage('At least one line item is required'),
  body('items.*.description').trim().notEmpty().withMessage('Each item must have a description'),
  body('items.*.quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be greater than 0'),
  body('items.*.unit_price').isFloat({ min: 0 }).withMessage('Unit price must be a positive number'),
  body('items.*.vat_rate').isFloat({ min: 0, max: 100 }).withMessage('VAT rate must be between 0 and 100'),
]), async (req, res) => {
  try {
    const { customer_id, issue_date, due_date, payment_terms, notes, terms_conditions, items, currency_id: reqCurrencyId, is_recurring, recurrence_interval, recurrence_end_date, auto_send } = req.body;
    if (!customer_id || !issue_date || !items || items.length === 0) return res.status(400).json({ message: 'Customer, issue date, and at least one line item are required' });
    const customers = await executeQuery('SELECT id FROM customers WHERE id = ? AND user_id = ? AND active = 1', [customer_id, req.user.id]);
    if (customers.length === 0) return res.status(400).json({ message: 'Invalid customer' });
    let subtotal = 0, vat_amount = 0, total = 0;
    const lineItems = items.map(item => {
      const qty = parseFloat(item.quantity) || 0, price = parseFloat(item.unit_price) || 0, rate = parseFloat(item.vat_rate) ?? 15;
      const itemSubtotal = qty * price, itemVat = itemSubtotal * rate / 100, itemTotal = itemSubtotal + itemVat;
      subtotal += itemSubtotal; vat_amount += itemVat; total += itemTotal;
      return { ...item, quantity: qty, unit_price: price, vat_rate: rate, subtotal: itemSubtotal, vat_amount: itemVat, total: itemTotal };
    });
    const document_number = await getNextDocumentNumber(req.user.id, 'INVOICE');
    let currency_id = 1;
    if (reqCurrencyId) { const currRows = await executeQuery('SELECT id FROM currencies WHERE id = ? AND is_active = 1', [reqCurrencyId]); if (currRows.length > 0) currency_id = reqCurrencyId; }
    else { const defRows = await executeQuery("SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'default_currency_id'", [req.user.id]); if (defRows.length > 0 && defRows[0].setting_value) currency_id = parseInt(defRows[0].setting_value, 10) || 1; }
    const conn = await getConnection();
    try {
      await new Promise((resolve, reject) => conn.beginTransaction(err => err ? reject(err) : resolve()));
      const recurringFlag = is_recurring ? 1 : 0, recurInterval = recurringFlag && recurrence_interval ? recurrence_interval : null;
      const recurNextDate = recurringFlag && recurInterval ? advanceDate(issue_date, recurInterval) : null;
      const recurEndDate = recurringFlag && recurrence_end_date ? recurrence_end_date : null, autoSendFlag = recurringFlag && auto_send ? 1 : 0;
      const docResult = await new Promise((resolve, reject) => conn.query(
        `INSERT INTO documents (user_id, customer_id, type, document_number, currency_id, status, issue_date, due_date, payment_terms, subtotal, vat_amount, total, notes, terms_conditions, is_recurring, recurrence_interval, recurrence_next_date, recurrence_end_date, auto_send) VALUES (?, ?, 'INVOICE', ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.user.id, customer_id, document_number, currency_id, issue_date, due_date || null, payment_terms || null, subtotal.toFixed(2), vat_amount.toFixed(2), total.toFixed(2), notes || null, terms_conditions || null, recurringFlag, recurInterval, recurNextDate, recurEndDate, autoSendFlag],
        (err, result) => err ? reject(err) : resolve(result)
      ));
      const docId = docResult.insertId;
      for (const item of lineItems) { await new Promise((resolve, reject) => conn.query('INSERT INTO document_items (document_id, product_id, description, quantity, unit_price, vat_rate, vat_amount, subtotal, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [docId, item.product_id || null, item.description, item.quantity, item.unit_price, item.vat_rate, item.vat_amount.toFixed(2), item.subtotal.toFixed(2), item.total.toFixed(2)], (err, r) => err ? reject(err) : resolve(r))); }
      await new Promise((resolve, reject) => conn.query(`INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'CREATED')`, [docId], (err, r) => err ? reject(err) : resolve(r)));
      await new Promise((resolve, reject) => conn.commit(err => err ? reject(err) : resolve()));
      conn.release();
      const invoice = await executeQuery(`SELECT d.*, c.name AS customer_name FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.id = ?`, [docId]);
      const itemsResult = await executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [docId]);
      res.status(201).json({ ...invoice[0], items: itemsResult });
    } catch (txError) { await new Promise(resolve => conn.rollback(resolve)); conn.release(); throw txError; }
  } catch (error) { logger.error('Error creating invoice:', error); res.status(500).json({ message: 'Failed to create invoice' }); }
});

app.get('/api/invoices/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [invoices, items, tracking, payments] = await Promise.all([
      executeQuery(`SELECT d.*, d.notifications_muted, c.name AS customer_name, c.email AS customer_email, c.billing_address AS customer_billing_address, c.vat_number AS customer_vat_number, cur.symbol AS currency_symbol, cur.code AS currency_code FROM documents d JOIN customers c ON c.id = d.customer_id LEFT JOIN currencies cur ON cur.id = d.currency_id WHERE d.id = ? AND d.user_id = ? AND d.type = 'INVOICE'`, [id, req.user.id]),
      executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]),
      executeQuery('SELECT * FROM document_tracking WHERE document_id = ? ORDER BY event_date ASC', [id]),
      executeQuery('SELECT * FROM payments WHERE document_id = ? ORDER BY payment_date DESC', [id])
    ]);
    if (invoices.length === 0) return res.status(404).json({ message: 'Invoice not found' });
    res.json({ ...invoices[0], notifications_muted: !!invoices[0].notifications_muted, items, tracking, payments });
  } catch (error) { logger.error('Error fetching invoice:', error); res.status(500).json({ message: 'Failed to fetch invoice' }); }
});

app.get('/api/invoices/:id/pdf', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const markSent = req.query.markSent === 'true';
    const [invoices, items, users, logoRows] = await Promise.all([
      executeQuery(`SELECT d.*, c.name AS customer_name, c.email AS customer_email, c.billing_address AS customer_billing_address, c.vat_number AS customer_vat_number, cur.symbol AS currency_symbol, cur.code AS currency_code FROM documents d JOIN customers c ON c.id = d.customer_id LEFT JOIN currencies cur ON cur.id = d.currency_id WHERE d.id = ? AND d.user_id = ? AND d.type = 'INVOICE'`, [id, req.user.id]),
      executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]),
      executeQuery('SELECT * FROM users WHERE id = ?', [req.user.id]),
      executeQuery("SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'company_logo'", [req.user.id])
    ]);
    if (invoices.length === 0) return res.status(404).json({ message: 'Invoice not found' });
    const logoRelPath = logoRows[0]?.setting_value || null;
    const user = { ...users[0], logo_path: logoRelPath ? path.join(__dirname, logoRelPath) : null };
    const pdfBuffer = await buildInvoicePdf(invoices[0], items, user);
    await executeQuery(`INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'DOWNLOADED')`, [id]);
    if (markSent && invoices[0].status === 'DRAFT') {
      await executeQuery(`UPDATE documents SET status = 'SENT', updated_at = NOW() WHERE id = ? AND user_id = ?`, [id, req.user.id]);
      await executeQuery(`INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'SENT')`, [id]);
    }
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${invoices[0].document_number}.pdf"`, 'Content-Length': pdfBuffer.length });
    res.send(pdfBuffer);
  } catch (error) { logger.error('Error generating invoice PDF:', error); res.status(500).json({ message: 'Failed to generate PDF' }); }
});

app.get('/api/invoices/:id/receipt', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [invoices, items, users, logoRows, payments] = await Promise.all([
      executeQuery(`SELECT d.*, c.name AS customer_name, c.email AS customer_email, c.billing_address AS customer_billing_address, c.vat_number AS customer_vat_number, cur.symbol AS currency_symbol, cur.code AS currency_code FROM documents d JOIN customers c ON c.id = d.customer_id LEFT JOIN currencies cur ON cur.id = d.currency_id WHERE d.id = ? AND d.user_id = ? AND d.type = 'INVOICE'`, [id, req.user.id]),
      executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]),
      executeQuery('SELECT * FROM users WHERE id = ?', [req.user.id]),
      executeQuery("SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'company_logo'", [req.user.id]),
      executeQuery('SELECT * FROM payments WHERE document_id = ? ORDER BY payment_date DESC', [id])
    ]);
    if (invoices.length === 0) return res.status(404).json({ message: 'Invoice not found' });
    if (invoices[0].status !== 'PAID') return res.status(400).json({ message: 'Receipt is only available for paid invoices' });
    const logoRelPath = logoRows[0]?.setting_value || null;
    const user = { ...users[0], logo_path: logoRelPath ? path.join(__dirname, logoRelPath) : null };
    const pdfBuffer = await buildReceiptPdf(invoices[0], items, user, payments);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="RECEIPT-${invoices[0].document_number}.pdf"`, 'Content-Length': pdfBuffer.length });
    res.send(pdfBuffer);
  } catch (error) { logger.error('Error generating receipt PDF:', error); res.status(500).json({ message: 'Failed to generate receipt' }); }
});

app.post('/api/invoices/:id/send-receipt', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [invoices, items, users, logoRows, payments] = await Promise.all([
      executeQuery(`SELECT d.*, c.name AS customer_name, c.email AS customer_email, c.billing_address AS customer_billing_address, c.vat_number AS customer_vat_number, cur.symbol AS currency_symbol, cur.code AS currency_code FROM documents d JOIN customers c ON c.id = d.customer_id LEFT JOIN currencies cur ON cur.id = d.currency_id WHERE d.id = ? AND d.user_id = ? AND d.type = 'INVOICE'`, [id, req.user.id]),
      executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]),
      executeQuery('SELECT * FROM users WHERE id = ?', [req.user.id]),
      executeQuery("SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'company_logo'", [req.user.id]),
      executeQuery('SELECT * FROM payments WHERE document_id = ? ORDER BY payment_date DESC', [id])
    ]);
    if (invoices.length === 0) return res.status(404).json({ message: 'Invoice not found' });
    const invoice = invoices[0];
    if (invoice.status !== 'PAID') return res.status(400).json({ message: 'Receipt can only be sent for paid invoices' });
    if (!invoice.customer_email) return res.status(400).json({ message: 'This customer has no email address on file' });
    const logoRelPath = logoRows[0]?.setting_value || null;
    const user = { ...users[0], logo_path: logoRelPath ? path.join(__dirname, logoRelPath) : null };
    const pdfBuffer = await buildReceiptPdf(invoice, items, user, payments);
    let emailWarning = null;
    try { await emailService.sendReceiptEmail(invoice.customer_email, { ...invoice, company_name: user.company_name }, pdfBuffer); }
    catch (emailError) { logger.error('Receipt email delivery failed:', emailError); emailWarning = `Receipt could not be delivered: ${emailError.message}`; }
    if (emailWarning) return res.status(207).json({ message: emailWarning, emailFailed: true });
    res.json({ message: `Receipt emailed to ${invoice.customer_email}` });
  } catch (error) { logger.error('Error sending receipt:', error); res.status(500).json({ message: 'Failed to send receipt' }); }
});

app.put('/api/invoices/:id', authenticateToken, validate([
  body('customer_id').isInt({ min: 1 }).withMessage('A valid customer is required'),
  body('issue_date').isDate().withMessage('A valid issue date is required'),
  body('due_date').optional({ nullable: true }).isDate().withMessage('Due date must be a valid date'),
  body('payment_terms').optional({ nullable: true }).isInt({ min: 0 }).withMessage('Payment terms must be a positive number'),
  body('items').isArray({ min: 1 }).withMessage('At least one line item is required'),
  body('items.*.description').trim().notEmpty().withMessage('Each item must have a description'),
  body('items.*.quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be greater than 0'),
  body('items.*.unit_price').isFloat({ min: 0 }).withMessage('Unit price must be a positive number'),
  body('items.*.vat_rate').isFloat({ min: 0, max: 100 }).withMessage('VAT rate must be between 0 and 100'),
]), async (req, res) => {
  try {
    const { id } = req.params;
    const { customer_id, issue_date, due_date, payment_terms, notes, terms_conditions, items, currency_id: reqCurrencyId, is_recurring, recurrence_interval, recurrence_end_date, auto_send } = req.body;
    const existing = await executeQuery(`SELECT id, status, currency_id FROM documents WHERE id = ? AND user_id = ? AND type = 'INVOICE'`, [id, req.user.id]);
    if (existing.length === 0) return res.status(404).json({ message: 'Invoice not found' });
    if (existing[0].status !== 'DRAFT') return res.status(400).json({ message: 'Only DRAFT invoices can be edited' });
    if (!customer_id || !issue_date || !items || items.length === 0) return res.status(400).json({ message: 'Customer, issue date, and at least one line item are required' });
    const customers = await executeQuery('SELECT id FROM customers WHERE id = ? AND user_id = ? AND active = 1', [customer_id, req.user.id]);
    if (customers.length === 0) return res.status(400).json({ message: 'Invalid customer' });
    let subtotal = 0, vat_amount = 0, total = 0;
    const lineItems = items.map(item => {
      const qty = parseFloat(item.quantity) || 0, price = parseFloat(item.unit_price) || 0, rate = parseFloat(item.vat_rate) ?? 15;
      const itemSubtotal = qty * price, itemVat = itemSubtotal * rate / 100, itemTotal = itemSubtotal + itemVat;
      subtotal += itemSubtotal; vat_amount += itemVat; total += itemTotal;
      return { ...item, quantity: qty, unit_price: price, vat_rate: rate, subtotal: itemSubtotal, vat_amount: itemVat, total: itemTotal };
    });
    const conn = await getConnection();
    try {
      await new Promise((resolve, reject) => conn.beginTransaction(err => err ? reject(err) : resolve()));
      let newCurrencyId = existing[0].currency_id;
      if (reqCurrencyId) { const currRows = await executeQuery('SELECT id FROM currencies WHERE id = ? AND is_active = 1', [reqCurrencyId]); if (currRows.length > 0) newCurrencyId = reqCurrencyId; }
      const recurringFlag = is_recurring ? 1 : 0, recurInterval = recurringFlag && recurrence_interval ? recurrence_interval : null;
      const recurNextDate = recurringFlag && recurInterval ? advanceDate(issue_date, recurInterval) : null;
      const recurEndDate = recurringFlag && recurrence_end_date ? recurrence_end_date : null, autoSendFlag = recurringFlag && auto_send ? 1 : 0;
      await new Promise((resolve, reject) => conn.query(
        `UPDATE documents SET customer_id=?, issue_date=?, due_date=?, payment_terms=?, currency_id=?, subtotal=?, vat_amount=?, total=?, notes=?, terms_conditions=?, is_recurring=?, recurrence_interval=?, recurrence_next_date=?, recurrence_end_date=?, auto_send=?, updated_at=NOW() WHERE id=? AND user_id=?`,
        [customer_id, issue_date, due_date || null, payment_terms || null, newCurrencyId, subtotal.toFixed(2), vat_amount.toFixed(2), total.toFixed(2), notes || null, terms_conditions || null, recurringFlag, recurInterval, recurNextDate, recurEndDate, autoSendFlag, id, req.user.id],
        (err, r) => err ? reject(err) : resolve(r)
      ));
      await new Promise((resolve, reject) => conn.query('DELETE FROM document_items WHERE document_id = ?', [id], (err, r) => err ? reject(err) : resolve(r)));
      for (const item of lineItems) { await new Promise((resolve, reject) => conn.query('INSERT INTO document_items (document_id, product_id, description, quantity, unit_price, vat_rate, vat_amount, subtotal, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, item.product_id || null, item.description, item.quantity, item.unit_price, item.vat_rate, item.vat_amount.toFixed(2), item.subtotal.toFixed(2), item.total.toFixed(2)], (err, r) => err ? reject(err) : resolve(r))); }
      await new Promise((resolve, reject) => conn.commit(err => err ? reject(err) : resolve()));
      conn.release();
      const invoice = await executeQuery(`SELECT d.*, c.name AS customer_name FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.id = ?`, [id]);
      const itemsResult = await executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]);
      res.json({ ...invoice[0], items: itemsResult });
    } catch (txError) { await new Promise(resolve => conn.rollback(resolve)); conn.release(); throw txError; }
  } catch (error) { logger.error('Error updating invoice:', error); res.status(500).json({ message: 'Failed to update invoice' }); }
});

app.post('/api/invoices/:id/send', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [invoices, items, users, logoRows] = await Promise.all([
      executeQuery(`SELECT d.*, c.name AS customer_name, c.email AS customer_email, c.billing_address AS customer_billing_address, c.vat_number AS customer_vat_number, cur.symbol AS currency_symbol, cur.code AS currency_code FROM documents d JOIN customers c ON c.id = d.customer_id LEFT JOIN currencies cur ON cur.id = d.currency_id WHERE d.id = ? AND d.user_id = ? AND d.type = 'INVOICE'`, [id, req.user.id]),
      executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]),
      executeQuery('SELECT * FROM users WHERE id = ?', [req.user.id]),
      executeQuery("SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'company_logo'", [req.user.id])
    ]);
    if (invoices.length === 0) return res.status(404).json({ message: 'Invoice not found' });
    const invoice = invoices[0];
    const logoRelPath = logoRows[0]?.setting_value || null;
    const user = { ...users[0], logo_path: logoRelPath ? path.join(__dirname, logoRelPath) : null };
    if (!['DRAFT', 'SENT'].includes(invoice.status)) return res.status(400).json({ message: `Cannot send an invoice with status ${invoice.status}` });
    if (!invoice.customer_email) return res.status(400).json({ message: 'This customer has no email address on file' });
    const pdfBuffer = await buildInvoicePdf(invoice, items, user);
    let emailWarning = null;
    try { await emailService.sendInvoiceEmail(invoice.customer_email, { ...invoice, company_name: user.company_name, bank_name: user.bank_name, bank_account_number: user.bank_account_number, bank_branch_code: user.bank_branch_code }, pdfBuffer); }
    catch (emailError) { logger.error('Email delivery failed:', emailError); emailWarning = `Invoice marked as sent, but the email could not be delivered: ${emailError.message}`; }
    await executeQuery(`UPDATE documents SET status = 'SENT', updated_at = NOW() WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    await executeQuery(`INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'SENT')`, [id]);
    if (emailWarning) return res.status(207).json({ message: emailWarning, emailFailed: true });
    res.json({ message: `Invoice emailed to ${invoice.customer_email}` });
  } catch (error) { logger.error('Error sending invoice:', error); res.status(500).json({ message: 'Failed to send invoice' }); }
});

app.post('/api/invoices/:id/mark-paid', authenticateToken, validate([
  body('amount').isFloat({ min: 0.01 }).withMessage('Amount must be greater than 0'),
  body('payment_date').isDate().withMessage('A valid payment date is required'),
  body('payment_method').trim().notEmpty().withMessage('Payment method is required'),
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
    await executeQuery('INSERT INTO payments (document_id, amount, payment_date, payment_method, transaction_reference, notes) VALUES (?, ?, ?, ?, ?, ?)', [id, amount, payment_date, payment_method, transaction_reference || null, notes || null]);
    await executeQuery(`UPDATE documents SET status = 'PAID', updated_at = NOW() WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    await executeQuery(`INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'PAID')`, [id]);
    res.status(201).json({ message: 'Payment recorded successfully' });
  } catch (error) { logger.error('Error recording payment:', error); res.status(500).json({ message: 'Failed to record payment' }); }
});

app.post('/api/invoices/:id/cancel', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const invoices = await executeQuery(`SELECT id, status FROM documents WHERE id = ? AND user_id = ? AND type = 'INVOICE'`, [id, req.user.id]);
    if (invoices.length === 0) return res.status(404).json({ message: 'Invoice not found' });
    const { status } = invoices[0];
    if (status === 'CANCELLED') return res.status(400).json({ message: 'Invoice is already cancelled' });
    if (status === 'PAID') return res.status(400).json({ message: 'Cannot cancel a paid invoice' });
    await executeQuery(`UPDATE documents SET status = 'CANCELLED', is_recurring = 0, recurrence_next_date = NULL, updated_at = NOW() WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    await executeQuery(`INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'CANCELLED')`, [id]);
    res.json({ message: 'Invoice cancelled successfully' });
  } catch (error) { logger.error('Error cancelling invoice:', error); res.status(500).json({ message: 'Failed to cancel invoice' }); }
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

app.post('/api/invoices/:id/share', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await executeQuery(`SELECT id FROM documents WHERE id = ? AND user_id = ? AND type = 'INVOICE'`, [id, req.user.id]);
    if (existing.length === 0) return res.status(404).json({ message: 'Invoice not found' });
    const token = randomUUID().replace(/-/g, '');
    await executeQuery('UPDATE documents SET share_token = ?, share_token_expires_at = DATE_ADD(NOW(), INTERVAL 30 DAY) WHERE id = ?', [token, id]);
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    res.json({ token, share_url: `${baseUrl}/portal/invoice/${token}` });
  } catch (error) { logger.error('Error generating share link:', error); res.status(500).json({ message: 'Failed to generate share link' }); }
});

// ─── Quotes ───────────────────────────────────────────────────────────────────

app.get('/api/quotes', authenticateToken, async (req, res) => {
  try {
    const search = req.query.search || '', status = req.query.status || '';
    const page = Math.max(1, parseInt(req.query.page) || 1), limit = Math.min(100, parseInt(req.query.limit) || 20), offset = (page - 1) * limit;
    let sql = `SELECT d.id, d.document_number, d.status, d.issue_date, d.due_date, d.valid_until, d.subtotal, d.vat_amount, d.total, d.created_at, c.name AS customer_name FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.user_id = ? AND d.type = 'QUOTE'`;
    let cntSql = `SELECT COUNT(*) AS total FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.user_id = ? AND d.type = 'QUOTE'`;
    const params = [req.user.id], cntParams = [req.user.id];
    if (status) { sql += ' AND d.status = ?'; cntSql += ' AND d.status = ?'; params.push(status); cntParams.push(status); }
    if (search) { const clause = ' AND (d.document_number LIKE ? OR c.name LIKE ?)'; sql += clause; cntSql += clause; params.push(`%${search}%`, `%${search}%`); cntParams.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY d.created_at DESC LIMIT ? OFFSET ?'; params.push(limit, offset);
    const [quotes, countResult] = await Promise.all([executeQuery(sql, params), executeQuery(cntSql, cntParams)]);
    res.json({ data: quotes, total: countResult[0].total, page, limit });
  } catch (error) { logger.error('Error fetching quotes:', error); res.status(500).json({ message: 'Failed to fetch quotes' }); }
});

app.post('/api/quotes', authenticateToken, validate([
  body('customer_id').isInt({ min: 1 }).withMessage('A valid customer is required'),
  body('issue_date').isDate().withMessage('A valid issue date is required'),
  body('valid_until').optional({ nullable: true }).isDate().withMessage('Valid until must be a valid date'),
  body('payment_terms').optional({ nullable: true }).isInt({ min: 0 }).withMessage('Payment terms must be a positive number'),
  body('items').isArray({ min: 1 }).withMessage('At least one line item is required'),
  body('items.*.description').trim().notEmpty().withMessage('Each item must have a description'),
  body('items.*.quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be greater than 0'),
  body('items.*.unit_price').isFloat({ min: 0 }).withMessage('Unit price must be a positive number'),
  body('items.*.vat_rate').isFloat({ min: 0, max: 100 }).withMessage('VAT rate must be between 0 and 100'),
]), async (req, res) => {
  try {
    const { customer_id, issue_date, valid_until, payment_terms, notes, terms_conditions, items, currency_id: reqCurrencyId } = req.body;
    if (!customer_id || !issue_date || !items || items.length === 0) return res.status(400).json({ message: 'Customer, issue date, and at least one line item are required' });
    const customers = await executeQuery('SELECT id FROM customers WHERE id = ? AND user_id = ? AND active = 1', [customer_id, req.user.id]);
    if (customers.length === 0) return res.status(400).json({ message: 'Invalid customer' });
    let subtotal = 0, vat_amount = 0, total = 0;
    const lineItems = items.map(item => {
      const qty = parseFloat(item.quantity) || 0, price = parseFloat(item.unit_price) || 0, rate = parseFloat(item.vat_rate) ?? 15;
      const itemSubtotal = qty * price, itemVat = itemSubtotal * rate / 100, itemTotal = itemSubtotal + itemVat;
      subtotal += itemSubtotal; vat_amount += itemVat; total += itemTotal;
      return { ...item, quantity: qty, unit_price: price, vat_rate: rate, subtotal: itemSubtotal, vat_amount: itemVat, total: itemTotal };
    });
    const document_number = await getNextDocumentNumber(req.user.id, 'QUOTE');
    let currency_id = 1;
    if (reqCurrencyId) { const currRows = await executeQuery('SELECT id FROM currencies WHERE id = ? AND is_active = 1', [reqCurrencyId]); if (currRows.length > 0) currency_id = reqCurrencyId; }
    else { const defRows = await executeQuery("SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'default_currency_id'", [req.user.id]); if (defRows.length > 0 && defRows[0].setting_value) currency_id = parseInt(defRows[0].setting_value, 10) || 1; }
    const conn = await getConnection();
    try {
      await new Promise((resolve, reject) => conn.beginTransaction(err => err ? reject(err) : resolve()));
      const docResult = await new Promise((resolve, reject) => conn.query(
        `INSERT INTO documents (user_id, customer_id, type, document_number, currency_id, status, issue_date, valid_until, payment_terms, subtotal, vat_amount, total, notes, terms_conditions) VALUES (?, ?, 'QUOTE', ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [req.user.id, customer_id, document_number, currency_id, issue_date, valid_until || null, payment_terms || null, subtotal.toFixed(2), vat_amount.toFixed(2), total.toFixed(2), notes || null, terms_conditions || null],
        (err, result) => err ? reject(err) : resolve(result)
      ));
      const docId = docResult.insertId;
      for (const item of lineItems) { await new Promise((resolve, reject) => conn.query('INSERT INTO document_items (document_id, product_id, description, quantity, unit_price, vat_rate, vat_amount, subtotal, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [docId, item.product_id || null, item.description, item.quantity, item.unit_price, item.vat_rate, item.vat_amount.toFixed(2), item.subtotal.toFixed(2), item.total.toFixed(2)], (err, r) => err ? reject(err) : resolve(r))); }
      await new Promise((resolve, reject) => conn.query(`INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'CREATED')`, [docId], (err, r) => err ? reject(err) : resolve(r)));
      await new Promise((resolve, reject) => conn.commit(err => err ? reject(err) : resolve()));
      conn.release();
      const quote = await executeQuery(`SELECT d.*, c.name AS customer_name FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.id = ?`, [docId]);
      const itemsResult = await executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [docId]);
      res.status(201).json({ ...quote[0], items: itemsResult });
    } catch (txError) { await new Promise(resolve => conn.rollback(resolve)); conn.release(); throw txError; }
  } catch (error) { logger.error('Error creating quote:', error); res.status(500).json({ message: 'Failed to create quote' }); }
});

app.get('/api/quotes/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [quotes, items, tracking] = await Promise.all([
      executeQuery(`SELECT d.*, c.name AS customer_name, c.email AS customer_email, c.billing_address AS customer_billing_address, c.vat_number AS customer_vat_number, cur.symbol AS currency_symbol, cur.code AS currency_code FROM documents d JOIN customers c ON c.id = d.customer_id LEFT JOIN currencies cur ON cur.id = d.currency_id WHERE d.id = ? AND d.user_id = ? AND d.type = 'QUOTE'`, [id, req.user.id]),
      executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]),
      executeQuery('SELECT * FROM document_tracking WHERE document_id = ? ORDER BY event_date ASC', [id])
    ]);
    if (quotes.length === 0) return res.status(404).json({ message: 'Quote not found' });
    res.json({ ...quotes[0], items, tracking });
  } catch (error) { logger.error('Error fetching quote:', error); res.status(500).json({ message: 'Failed to fetch quote' }); }
});

app.put('/api/quotes/:id', authenticateToken, validate([
  body('customer_id').isInt({ min: 1 }).withMessage('A valid customer is required'),
  body('issue_date').isDate().withMessage('A valid issue date is required'),
  body('valid_until').optional({ nullable: true }).isDate().withMessage('Valid until must be a valid date'),
  body('payment_terms').optional({ nullable: true }).isInt({ min: 0 }).withMessage('Payment terms must be a positive number'),
  body('items').isArray({ min: 1 }).withMessage('At least one line item is required'),
  body('items.*.description').trim().notEmpty().withMessage('Each item must have a description'),
  body('items.*.quantity').isFloat({ min: 0.01 }).withMessage('Quantity must be greater than 0'),
  body('items.*.unit_price').isFloat({ min: 0 }).withMessage('Unit price must be a positive number'),
  body('items.*.vat_rate').isFloat({ min: 0, max: 100 }).withMessage('VAT rate must be between 0 and 100'),
]), async (req, res) => {
  try {
    const { id } = req.params;
    const { customer_id, issue_date, valid_until, payment_terms, notes, terms_conditions, items, currency_id: reqCurrencyId } = req.body;
    const existing = await executeQuery(`SELECT id, status, currency_id FROM documents WHERE id = ? AND user_id = ? AND type = 'QUOTE'`, [id, req.user.id]);
    if (existing.length === 0) return res.status(404).json({ message: 'Quote not found' });
    if (existing[0].status !== 'DRAFT') return res.status(400).json({ message: 'Only DRAFT quotes can be edited' });
    if (!customer_id || !issue_date || !items || items.length === 0) return res.status(400).json({ message: 'Customer, issue date, and at least one line item are required' });
    const customers = await executeQuery('SELECT id FROM customers WHERE id = ? AND user_id = ? AND active = 1', [customer_id, req.user.id]);
    if (customers.length === 0) return res.status(400).json({ message: 'Invalid customer' });
    let subtotal = 0, vat_amount = 0, total = 0;
    const lineItems = items.map(item => {
      const qty = parseFloat(item.quantity) || 0, price = parseFloat(item.unit_price) || 0, rate = parseFloat(item.vat_rate) ?? 15;
      const itemSubtotal = qty * price, itemVat = itemSubtotal * rate / 100, itemTotal = itemSubtotal + itemVat;
      subtotal += itemSubtotal; vat_amount += itemVat; total += itemTotal;
      return { ...item, quantity: qty, unit_price: price, vat_rate: rate, subtotal: itemSubtotal, vat_amount: itemVat, total: itemTotal };
    });
    const conn = await getConnection();
    try {
      await new Promise((resolve, reject) => conn.beginTransaction(err => err ? reject(err) : resolve()));
      let newCurrencyId = existing[0].currency_id;
      if (reqCurrencyId) { const currRows = await executeQuery('SELECT id FROM currencies WHERE id = ? AND is_active = 1', [reqCurrencyId]); if (currRows.length > 0) newCurrencyId = reqCurrencyId; }
      await new Promise((resolve, reject) => conn.query(
        `UPDATE documents SET customer_id=?, issue_date=?, valid_until=?, payment_terms=?, currency_id=?, subtotal=?, vat_amount=?, total=?, notes=?, terms_conditions=?, updated_at=NOW() WHERE id=? AND user_id=?`,
        [customer_id, issue_date, valid_until || null, payment_terms || null, newCurrencyId, subtotal.toFixed(2), vat_amount.toFixed(2), total.toFixed(2), notes || null, terms_conditions || null, id, req.user.id],
        (err, r) => err ? reject(err) : resolve(r)
      ));
      await new Promise((resolve, reject) => conn.query('DELETE FROM document_items WHERE document_id = ?', [id], (err, r) => err ? reject(err) : resolve(r)));
      for (const item of lineItems) { await new Promise((resolve, reject) => conn.query('INSERT INTO document_items (document_id, product_id, description, quantity, unit_price, vat_rate, vat_amount, subtotal, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [id, item.product_id || null, item.description, item.quantity, item.unit_price, item.vat_rate, item.vat_amount.toFixed(2), item.subtotal.toFixed(2), item.total.toFixed(2)], (err, r) => err ? reject(err) : resolve(r))); }
      await new Promise((resolve, reject) => conn.commit(err => err ? reject(err) : resolve()));
      conn.release();
      const quote = await executeQuery(`SELECT d.*, c.name AS customer_name FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.id = ?`, [id]);
      const itemsResult = await executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]);
      res.json({ ...quote[0], items: itemsResult });
    } catch (txError) { await new Promise(resolve => conn.rollback(resolve)); conn.release(); throw txError; }
  } catch (error) { logger.error('Error updating quote:', error); res.status(500).json({ message: 'Failed to update quote' }); }
});

app.post('/api/quotes/:id/send', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await executeQuery(`SELECT id, status FROM documents WHERE id = ? AND user_id = ? AND type = 'QUOTE'`, [id, req.user.id]);
    if (existing.length === 0) return res.status(404).json({ message: 'Quote not found' });
    if (!['DRAFT', 'SENT'].includes(existing[0].status)) return res.status(400).json({ message: `Cannot send a quote with status ${existing[0].status}` });
    await executeQuery(`UPDATE documents SET status = 'SENT', updated_at = NOW() WHERE id = ? AND user_id = ?`, [id, req.user.id]);
    await executeQuery(`INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'SENT')`, [id]);
    res.json({ message: 'Quote marked as sent' });
  } catch (error) { logger.error('Error sending quote:', error); res.status(500).json({ message: 'Failed to send quote' }); }
});

app.post('/api/quotes/:id/convert-to-invoice', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const quotes = await executeQuery(`SELECT d.*, c.id AS cust_id FROM documents d JOIN customers c ON c.id = d.customer_id WHERE d.id = ? AND d.user_id = ? AND d.type = 'QUOTE'`, [id, req.user.id]);
    if (quotes.length === 0) return res.status(404).json({ message: 'Quote not found' });
    if (quotes[0].status === 'CANCELLED') return res.status(400).json({ message: 'Cannot convert a cancelled quote' });
    const quoteItems = await executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]);
    const invoice_number = await getNextDocumentNumber(req.user.id, 'INVOICE');
    const today = new Date().toISOString().split('T')[0];
    const conn = await getConnection();
    try {
      await new Promise((resolve, reject) => conn.beginTransaction(err => err ? reject(err) : resolve()));
      const docResult = await new Promise((resolve, reject) => conn.query(
        `INSERT INTO documents (user_id, customer_id, type, document_number, currency_id, status, issue_date, payment_terms, subtotal, vat_amount, total, notes, terms_conditions) VALUES (?, ?, 'INVOICE', ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?)`,
        [req.user.id, quotes[0].customer_id, invoice_number, quotes[0].currency_id, today, quotes[0].payment_terms, quotes[0].subtotal, quotes[0].vat_amount, quotes[0].total, quotes[0].notes || null, quotes[0].terms_conditions || null],
        (err, result) => err ? reject(err) : resolve(result)
      ));
      const invoiceId = docResult.insertId;
      for (const item of quoteItems) { await new Promise((resolve, reject) => conn.query('INSERT INTO document_items (document_id, product_id, description, quantity, unit_price, vat_rate, vat_amount, subtotal, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [invoiceId, item.product_id || null, item.description, item.quantity, item.unit_price, item.vat_rate, item.vat_amount, item.subtotal, item.total], (err, r) => err ? reject(err) : resolve(r))); }
      await new Promise((resolve, reject) => conn.query(`INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'CREATED')`, [invoiceId], (err, r) => err ? reject(err) : resolve(r)));
      await new Promise((resolve, reject) => conn.query(`UPDATE documents SET status = 'SENT', updated_at = NOW() WHERE id = ? AND status = 'DRAFT'`, [id], (err, r) => err ? reject(err) : resolve(r)));
      await new Promise((resolve, reject) => conn.commit(err => err ? reject(err) : resolve()));
      conn.release();
      res.status(201).json({ message: 'Quote converted to invoice', invoice_id: invoiceId });
    } catch (txError) { await new Promise(resolve => conn.rollback(resolve)); conn.release(); throw txError; }
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
    const page = Math.max(1, parseInt(req.query.page) || 1), limit = Math.min(100, parseInt(req.query.limit) || 20), offset = (page - 1) * limit;
    let sql = 'SELECT * FROM products WHERE user_id = ? AND is_active = 1', cntSql = 'SELECT COUNT(*) AS total FROM products WHERE user_id = ? AND is_active = 1';
    const params = [req.user.id], cntParams = [req.user.id];
    if (search) { const clause = ' AND (name LIKE ? OR description LIKE ?)'; sql += clause; cntSql += clause; params.push(`%${search}%`, `%${search}%`); cntParams.push(`%${search}%`, `%${search}%`); }
    sql += ' ORDER BY name ASC LIMIT ? OFFSET ?'; params.push(limit, offset);
    const [products, countResult] = await Promise.all([executeQuery(sql, params), executeQuery(cntSql, cntParams)]);
    res.json({ data: products, total: countResult[0].total, page, limit });
  } catch (error) { logger.error('Error fetching products:', error); res.status(500).json({ message: 'Failed to fetch products' }); }
});

app.post('/api/products', authenticateToken, validate([
  body('name').trim().notEmpty().withMessage('Product name is required'),
  body('price').isFloat({ min: 0 }).withMessage('Price must be a positive number'),
  body('description').optional().trim(),
  body('vat_inclusive').optional().isBoolean().withMessage('vat_inclusive must be true or false'),
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
  body('vat_inclusive').optional().isBoolean().withMessage('vat_inclusive must be true or false'),
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

// ─── Dashboard summary ────────────────────────────────────────────────────────

app.get('/api/dashboard/summary', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const [revenueRows, customersRows, openRows, overdueRows, recentRows] = await Promise.all([
      executeQuery(`SELECT COALESCE(SUM(total), 0) AS monthRevenue, COALESCE(SUM(CASE WHEN YEAR(issue_date) = YEAR(CURDATE()) THEN total ELSE 0 END), 0) AS yearRevenue FROM documents WHERE user_id = ? AND type = 'INVOICE' AND status = 'PAID' AND YEAR(issue_date) = YEAR(CURDATE()) AND MONTH(issue_date) = MONTH(CURDATE())`, [userId]),
      executeQuery('SELECT COUNT(*) AS total FROM customers WHERE user_id = ? AND active = 1', [userId]),
      executeQuery(`SELECT COUNT(*) AS total FROM documents WHERE user_id = ? AND type = 'INVOICE' AND status = 'SENT'`, [userId]),
      executeQuery(`SELECT COUNT(*) AS total FROM documents WHERE user_id = ? AND type = 'INVOICE' AND status = 'OVERDUE' AND notifications_muted = 0`, [userId]),
      // FIX: changed c.company_name to c.name — customers table has 'name' not 'company_name'
      executeQuery(`SELECT dt.event_type, dt.event_date, d.document_number, d.type AS document_type, c.name AS customer_name FROM document_tracking dt JOIN documents d ON dt.document_id = d.id JOIN customers c ON d.customer_id = c.id WHERE d.user_id = ? ORDER BY dt.event_date DESC LIMIT 5`, [userId])
    ]);
    res.json({ monthRevenue: parseFloat(revenueRows[0].monthRevenue), totalCustomers: customersRows[0].total, openInvoices: openRows[0].total, overdueInvoices: overdueRows[0].total, recentActivity: recentRows });
  } catch (error) { logger.error('Error fetching dashboard summary:', error); res.status(500).json({ message: 'Failed to fetch dashboard summary' }); }
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
      executeQuery('SELECT email, company_name, company_registration, vat_number, contact_person, phone, address, bank_name, bank_account_number, bank_branch_code, bank_account_type FROM users WHERE id = ?', [userId]),
      executeQuery('SELECT setting_key, setting_value FROM settings WHERE user_id = ?', [userId])
    ]);
    if (userRows.length === 0) return res.status(404).json({ message: 'User not found' });
    const kvSettings = {};
    for (const row of settingRows) kvSettings[row.setting_key] = row.setting_value;
    res.json({ ...userRows[0], ...kvSettings });
  } catch (error) { logger.error('Error fetching settings:', error); res.status(500).json({ message: 'Failed to fetch settings' }); }
});

app.put('/api/settings/profile', authenticateToken, validate([
  body('contact_person').trim().notEmpty().withMessage('Name is required'),
  body('email').isEmail().normalizeEmail().withMessage('A valid email address is required'),
  body('phone').optional().trim(),
  body('new_password').optional().isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
]), async (req, res) => {
  try {
    const userId = req.user.id;
    const { contact_person, email, phone, current_password, new_password } = req.body;
    if (!contact_person || !email) return res.status(400).json({ message: 'Name and email are required' });
    if (new_password) {
      if (!current_password) return res.status(400).json({ message: 'Current password is required to set a new password' });
      const userRows = await executeQuery('SELECT password_hash FROM users WHERE id = ?', [userId]);
      if (userRows.length === 0) return res.status(404).json({ message: 'User not found' });
      // No stored hash means a Google-only account. There is no current
      // password to check, and argon2.verify(null) would throw — so say what is
      // actually going on instead of returning a 500 on a legitimate request.
      if (!userRows[0].password_hash) {
        return res.status(400).json({
          message: 'This account signs in with Google, so it has no password to change.',
          code: 'USE_GOOGLE_SIGNIN',
        });
      }
      const valid = await argon2.verify(userRows[0].password_hash, current_password);
      if (!valid) return res.status(400).json({ message: 'Current password is incorrect' });
      const newHash = await argon2.hash(new_password);
      await executeQuery('UPDATE users SET contact_person = ?, email = ?, phone = ?, password_hash = ?, updated_at = NOW() WHERE id = ?', [contact_person, email, phone || null, newHash, userId]);
    } else {
      await executeQuery('UPDATE users SET contact_person = ?, email = ?, phone = ?, updated_at = NOW() WHERE id = ?', [contact_person, email, phone || null, userId]);
    }
    res.json({ message: 'Profile updated successfully' });
  } catch (error) { logger.error('Error updating profile:', error); res.status(500).json({ message: 'Failed to update profile' }); }
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
    await executeQuery('UPDATE users SET company_name = ?, company_registration = ?, vat_number = ?, address = ?, updated_at = NOW() WHERE id = ?', [company_name || null, company_registration || null, vat_number || null, address || null, userId]);
    res.json({ message: 'Company details updated successfully' });
  } catch (error) { logger.error('Error updating company settings:', error); res.status(500).json({ message: 'Failed to update company details' }); }
});

app.post('/api/settings/logo', authenticateToken, (req, res) => {
  logoUpload.single('logo')(req, res, async (err) => {
    if (err) { if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ message: 'Logo must be 5 MB or smaller' }); return res.status(400).json({ message: err.message || 'Upload failed' }); }
    if (!req.file) return res.status(400).json({ message: 'No file uploaded' });
    try {
      const userId = req.user.id;
      const logoPath = `/uploads/logos/${req.file.filename}`;
      const existing = await executeQuery("SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'company_logo'", [userId]);
      if (existing.length > 0 && existing[0].setting_value) fs.unlink(path.join(__dirname, existing[0].setting_value), () => {});
      await executeQuery(`INSERT INTO settings (user_id, setting_key, setting_value, updated_at) VALUES (?, 'company_logo', ?, NOW()) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = NOW()`, [userId, logoPath]);
      res.json({ message: 'Logo uploaded successfully', logo_url: logoPath });
    } catch (error) { logger.error('Error saving logo path:', error); res.status(500).json({ message: 'Failed to save logo' }); }
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

app.put('/api/settings/invoice', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { invoice_prefix, invoice_next_number, invoice_payment_terms, invoice_vat_rate, invoice_notes, default_currency_id } = req.body;
    const pairs = [['invoice_prefix', invoice_prefix ?? 'INV'], ['invoice_next_number', String(invoice_next_number ?? 1)], ['invoice_payment_terms', String(invoice_payment_terms ?? 30)], ['invoice_vat_rate', String(invoice_vat_rate ?? 15)], ['invoice_notes', invoice_notes ?? ''], ['default_currency_id', String(default_currency_id ?? 1)]];
    for (const [key, value] of pairs) await executeQuery(`INSERT INTO settings (user_id, setting_key, setting_value, updated_at) VALUES (?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = NOW()`, [userId, key, value]);
    res.json({ message: 'Invoice defaults updated successfully' });
  } catch (error) { logger.error('Error updating invoice settings:', error); res.status(500).json({ message: 'Failed to update invoice defaults' }); }
});

app.put('/api/settings/payment', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { bank_name, bank_account_number, bank_branch_code, bank_account_type } = req.body;
    await executeQuery('UPDATE users SET bank_name = ?, bank_account_number = ?, bank_branch_code = ?, bank_account_type = ?, updated_at = NOW() WHERE id = ?', [bank_name || null, bank_account_number || null, bank_branch_code || null, bank_account_type || null, userId]);
    res.json({ message: 'Payment details updated successfully' });
  } catch (error) { logger.error('Error updating payment settings:', error); res.status(500).json({ message: 'Failed to update payment details' }); }
});

app.put('/api/settings/notifications', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { notify_invoice_sent, notify_payment_received, notify_invoice_overdue } = req.body;
    const pairs = [['notify_invoice_sent', notify_invoice_sent ? '1' : '0'], ['notify_payment_received', notify_payment_received ? '1' : '0'], ['notify_invoice_overdue', notify_invoice_overdue ? '1' : '0']];
    for (const [key, value] of pairs) await executeQuery(`INSERT INTO settings (user_id, setting_key, setting_value, updated_at) VALUES (?, ?, ?, NOW()) ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = NOW()`, [userId, key, value]);
    res.json({ message: 'Notification preferences updated successfully' });
  } catch (error) { logger.error('Error updating notification settings:', error); res.status(500).json({ message: 'Failed to update notification preferences' }); }
});

// ─── Reports ──────────────────────────────────────────────────────────────────

app.get('/api/reports/revenue-by-month', authenticateToken, async (req, res) => {
  try { res.json(await executeQuery(`SELECT DATE_FORMAT(issue_date, '%Y-%m') AS month, SUM(total) AS revenue FROM documents WHERE user_id = ? AND type = 'INVOICE' AND status = 'PAID' AND issue_date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH) GROUP BY DATE_FORMAT(issue_date, '%Y-%m') ORDER BY month ASC`, [req.user.id])); }
  catch (error) { logger.error('Error fetching revenue by month:', error); res.status(500).json({ message: 'Failed to fetch revenue report' }); }
});

app.get('/api/reports/invoice-status', authenticateToken, async (req, res) => {
  try { res.json(await executeQuery(`SELECT status, COUNT(*) AS count, COALESCE(SUM(total), 0) AS total FROM documents WHERE user_id = ? AND type = 'INVOICE' GROUP BY status`, [req.user.id])); }
  catch (error) { logger.error('Error fetching invoice status:', error); res.status(500).json({ message: 'Failed to fetch invoice status report' }); }
});

app.get('/api/reports/top-customers', authenticateToken, async (req, res) => {
  try { res.json(await executeQuery(`SELECT c.name, SUM(d.total) AS revenue, COUNT(d.id) AS invoice_count FROM documents d JOIN customers c ON d.customer_id = c.id WHERE d.user_id = ? AND d.type = 'INVOICE' AND d.status = 'PAID' GROUP BY c.id, c.name ORDER BY revenue DESC LIMIT 5`, [req.user.id])); }
  catch (error) { logger.error('Error fetching top customers:', error); res.status(500).json({ message: 'Failed to fetch top customers report' }); }
});

app.get('/api/reports/vat-summary', authenticateToken, async (req, res) => {
  try { res.json(await executeQuery(`SELECT DATE_FORMAT(issue_date, '%Y-%m') AS month, SUM(subtotal) AS subtotal, SUM(vat_amount) AS vat_amount, SUM(total) AS total FROM documents WHERE user_id = ? AND type = 'INVOICE' AND status IN ('SENT', 'PAID') AND YEAR(issue_date) = YEAR(CURDATE()) GROUP BY DATE_FORMAT(issue_date, '%Y-%m') ORDER BY month ASC`, [req.user.id])); }
  catch (error) { logger.error('Error fetching VAT summary:', error); res.status(500).json({ message: 'Failed to fetch VAT summary report' }); }
});

// ─── Public Customer Portal ───────────────────────────────────────────────────

app.get('/api/public/invoice/:token', portalLimiter, async (req, res) => {
  try {
    const { token } = req.params;
    const docs = await executeQuery(`SELECT d.id, d.document_number, d.type, d.status, d.issue_date, d.due_date, d.payment_terms, d.subtotal, d.vat_amount, d.total, d.notes, d.terms_conditions, c.name AS customer_name, c.email AS customer_email, c.billing_address AS customer_billing_address, c.vat_number AS customer_vat_number, cur.symbol AS currency_symbol, cur.code AS currency_code, u.company_name, u.vat_number AS company_vat_number, u.address AS company_address, u.email AS company_email, u.bank_name, u.bank_account_number, u.bank_branch_code, u.bank_account_type FROM documents d JOIN customers c ON c.id = d.customer_id LEFT JOIN currencies cur ON cur.id = d.currency_id JOIN users u ON u.id = d.user_id WHERE d.share_token = ? AND d.type = 'INVOICE' AND (d.share_token_expires_at IS NULL OR d.share_token_expires_at > NOW())`, [token]);
    if (docs.length === 0) return res.status(404).json({ message: 'Invoice not found or link has expired' });
    const items = await executeQuery('SELECT description, quantity, unit_price, vat_rate, vat_amount, subtotal, total FROM document_items WHERE document_id = ? ORDER BY id ASC', [docs[0].id]);
    const logoRows = await executeQuery("SELECT setting_value FROM settings WHERE user_id = (SELECT user_id FROM documents WHERE id = ?) AND setting_key = 'company_logo'", [docs[0].id]);
    await executeQuery(`INSERT INTO document_tracking (document_id, event_type, ip_address, user_agent) VALUES (?, 'VIEWED', ?, ?)`, [docs[0].id, req.ip || null, req.get('user-agent') || null]);
    res.json({ ...docs[0], company_logo: logoRows[0]?.setting_value || null, items });
  } catch (error) { logger.error('Error fetching public invoice:', error); res.status(500).json({ message: 'Failed to fetch invoice' }); }
});

app.get('/api/public/invoice/:token/pdf', portalLimiter, async (req, res) => {
  try {
    const { token } = req.params;
    const docs = await executeQuery(`SELECT d.*, c.name AS customer_name, c.email AS customer_email, c.billing_address AS customer_billing_address, c.vat_number AS customer_vat_number, cur.symbol AS currency_symbol, cur.code AS currency_code FROM documents d JOIN customers c ON c.id = d.customer_id LEFT JOIN currencies cur ON cur.id = d.currency_id WHERE d.share_token = ? AND d.type = 'INVOICE' AND (d.share_token_expires_at IS NULL OR d.share_token_expires_at > NOW())`, [token]);
    if (docs.length === 0) return res.status(404).json({ message: 'Invoice not found or link has expired' });
    const invoice = docs[0];
    const [items, users, logoRows] = await Promise.all([
      executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [invoice.id]),
      executeQuery('SELECT * FROM users WHERE id = ?', [invoice.user_id]),
      executeQuery("SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'company_logo'", [invoice.user_id])
    ]);
    const logoRelPath = logoRows[0]?.setting_value || null;
    const user = { ...users[0], logo_path: logoRelPath ? path.join(__dirname, logoRelPath) : null };
    const pdfBuffer = await buildInvoicePdf(invoice, items, user);
    await executeQuery(`INSERT INTO document_tracking (document_id, event_type, ip_address, user_agent) VALUES (?, 'DOWNLOADED', ?, ?)`, [invoice.id, req.ip || null, req.get('user-agent') || null]);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${invoice.document_number}.pdf"`, 'Content-Length': pdfBuffer.length });
    res.send(pdfBuffer);
  } catch (error) { logger.error('Error generating public invoice PDF:', error); res.status(500).json({ message: 'Failed to generate PDF' }); }
});

// ─── Recurring invoice cron — runs daily at 00:05 ─────────────────────────────

async function processRecurringInvoices() {
  logger.info('Recurring invoice cron: starting');
  try {
    const due = await executeQuery(`SELECT * FROM documents WHERE is_recurring = 1 AND recurrence_next_date <= CURDATE() AND type = 'INVOICE' AND status != 'CANCELLED'`);
    logger.info(`Recurring invoice cron: ${due.length} invoice(s) due`);
    for (const source of due) {
      try {
        const sourceItems = await executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [source.id]);
        const today = new Date().toISOString().split('T')[0];
        const document_number = await getNextDocumentNumber(source.user_id, 'INVOICE');
        let due_date = null;
        if (source.payment_terms) { const d = new Date(); d.setUTCDate(d.getUTCDate() + source.payment_terms); due_date = d.toISOString().split('T')[0]; }
        const nextDate = advanceDate(source.recurrence_next_date, source.recurrence_interval);
        const endReached = source.recurrence_end_date && nextDate > source.recurrence_end_date.toISOString?.().split('T')[0] || (typeof source.recurrence_end_date === 'string' && nextDate > source.recurrence_end_date);
        const conn = await getConnection();
        let newDocId;
        try {
          await new Promise((resolve, reject) => conn.beginTransaction(err => err ? reject(err) : resolve()));
          const docResult = await new Promise((resolve, reject) => conn.query(
            `INSERT INTO documents (user_id, customer_id, type, document_number, currency_id, status, issue_date, due_date, payment_terms, subtotal, vat_amount, total, notes, terms_conditions) VALUES (?, ?, 'INVOICE', ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?)`,
            [source.user_id, source.customer_id, document_number, source.currency_id, today, due_date, source.payment_terms, source.subtotal, source.vat_amount, source.total, source.notes, source.terms_conditions],
            (err, r) => err ? reject(err) : resolve(r)
          ));
          newDocId = docResult.insertId;
          for (const item of sourceItems) { await new Promise((resolve, reject) => conn.query('INSERT INTO document_items (document_id, product_id, description, quantity, unit_price, vat_rate, vat_amount, subtotal, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [newDocId, item.product_id, item.description, item.quantity, item.unit_price, item.vat_rate, item.vat_amount, item.subtotal, item.total], (err, r) => err ? reject(err) : resolve(r))); }
          await new Promise((resolve, reject) => conn.query(`INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'CREATED')`, [newDocId], (err, r) => err ? reject(err) : resolve(r)));
          await new Promise((resolve, reject) => conn.query('UPDATE documents SET recurrence_next_date = ?, is_recurring = ? WHERE id = ?', [endReached ? null : nextDate, endReached ? 0 : 1, source.id], (err, r) => err ? reject(err) : resolve(r)));
          await new Promise((resolve, reject) => conn.commit(err => err ? reject(err) : resolve()));
          conn.release();
          logger.info(`Recurring invoice created: ${document_number} (from source #${source.id})`);
        } catch (txError) { await new Promise(resolve => conn.rollback(resolve)); conn.release(); throw txError; }
        if (source.auto_send && newDocId) {
          try {
            const [invoices, newItems, users, logoRows] = await Promise.all([
              executeQuery(`SELECT d.*, c.name AS customer_name, c.email AS customer_email, c.billing_address AS customer_billing_address, c.vat_number AS customer_vat_number, cur.symbol AS currency_symbol, cur.code AS currency_code FROM documents d JOIN customers c ON c.id = d.customer_id LEFT JOIN currencies cur ON cur.id = d.currency_id WHERE d.id = ?`, [newDocId]),
              executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [newDocId]),
              executeQuery('SELECT * FROM users WHERE id = ?', [source.user_id]),
              executeQuery("SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'company_logo'", [source.user_id])
            ]);
            const invoice = invoices[0];
            if (!invoice.customer_email) { logger.warn(`Recurring invoice ${document_number}: auto-send skipped - customer has no email`); }
            else {
              const logoRelPath = logoRows[0]?.setting_value || null;
              const user = { ...users[0], logo_path: logoRelPath ? path.join(__dirname, logoRelPath) : null };
              const pdfBuffer = await buildInvoicePdf(invoice, newItems, user);
              await emailService.sendInvoiceEmail(invoice.customer_email, { ...invoice, company_name: user.company_name, bank_name: user.bank_name, bank_account_number: user.bank_account_number, bank_branch_code: user.bank_branch_code }, pdfBuffer);
              await executeQuery(`UPDATE documents SET status = 'SENT', updated_at = NOW() WHERE id = ?`, [newDocId]);
              await executeQuery(`INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'SENT')`, [newDocId]);
              await executeQuery(`INSERT INTO email_log (document_id, recipient_email, subject, email_type, status, sent_at) VALUES (?, ?, ?, 'INVOICE', 'SENT', NOW())`, [newDocId, invoice.customer_email, `Invoice ${invoice.document_number}`]);
              logger.info(`Recurring invoice auto-sent: ${document_number} to ${invoice.customer_email}`);
            }
          } catch (sendError) {
            logger.error(`Recurring invoice auto-send failed:`, sendError);
            await executeQuery(`INSERT INTO email_log (document_id, recipient_email, subject, email_type, status, error_message) VALUES (?, '', ?, 'INVOICE', 'FAILED', ?)`, [newDocId, `Invoice ${document_number}`, sendError.message]).catch(() => {});
          }
        }
      } catch (itemError) { logger.error(`Recurring invoice cron: failed to process source #${source.id}:`, itemError); }
    }
  } catch (error) { logger.error('Recurring invoice cron: fatal error:', error); }
}

cron.schedule('5 0 * * *', processRecurringInvoices);

// ─── Overdue invoice cron — runs daily at 00:10 ───────────────────────────────

async function processOverdueInvoices() {
  logger.info('Overdue invoice cron: starting');
  try {
    const overdueInvoices = await executeQuery(`SELECT id, document_number, user_id FROM documents WHERE type = 'INVOICE' AND status = 'SENT' AND due_date IS NOT NULL AND due_date < CURDATE()`);
    logger.info(`Overdue invoice cron: ${overdueInvoices.length} invoice(s) to mark overdue`);
    for (const invoice of overdueInvoices) {
      try {
        await executeQuery(`UPDATE documents SET status = 'OVERDUE', updated_at = NOW() WHERE id = ?`, [invoice.id]);
        await executeQuery(`INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'OVERDUE')`, [invoice.id]);
        logger.info(`Overdue invoice cron: marked ${invoice.document_number} as OVERDUE`);
      } catch (itemError) { logger.error(`Overdue invoice cron: failed to process invoice #${invoice.id}:`, itemError); }
    }
    logger.info('Overdue invoice cron: completed');
  } catch (error) { logger.error('Overdue invoice cron: fatal error:', error); }
}

cron.schedule('10 0 * * *', processOverdueInvoices);

// ─── Account anonymisation cron — runs daily at 00:20 ─────────────────────────
// The erasure that /api/account/close promises and, until now, nothing
// delivered: closure set anonymise_after and opened a DELETION request that no
// code ever completed. The job itself lives in retention.service.js — it is
// database work with no HTTP in it, and out there it can be run and tested
// without booting a server. See that file for what it deliberately leaves
// alone and why.
cron.schedule('20 0 * * *', () => {
  anonymiseExpiredAccounts().catch(error =>
    logger.error('Account anonymisation cron: fatal error:', error));
});

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

    const [user, settings, customers, products, documents, items, payments, tracking, emails, consents, requests] =
      await Promise.all([
        executeQuery(
          // google_id is the Google account identifier we hold about this
          // person, so a subject access request has to return it like any other
          // personal data. password_hash stays out — a credential, not data
          // about them.
          `SELECT id, email, google_id, company_name, company_registration, vat_number, contact_person,
                  phone, address, bank_name, bank_account_number, bank_branch_code, bank_account_type,
                  email_verified, status, created_at, updated_at, closed_at, last_login_at,
                  terms_accepted_at, terms_version, privacy_accepted_at, privacy_policy_version
             FROM users WHERE id = ?`, [uid]),
        executeQuery('SELECT setting_key, setting_value, updated_at FROM settings WHERE user_id = ?', [uid]),
        executeQuery('SELECT * FROM customers WHERE user_id = ?', [uid]),
        executeQuery('SELECT * FROM products WHERE user_id = ?', [uid]),
        executeQuery('SELECT * FROM documents WHERE user_id = ?', [uid]),
        executeQuery('SELECT i.* FROM document_items i JOIN documents d ON d.id = i.document_id WHERE d.user_id = ?', [uid]),
        executeQuery('SELECT p.* FROM payments p JOIN documents d ON d.id = p.document_id WHERE d.user_id = ?', [uid]),
        executeQuery('SELECT t.* FROM document_tracking t JOIN documents d ON d.id = t.document_id WHERE d.user_id = ?', [uid]),
        executeQuery('SELECT e.* FROM email_log e JOIN documents d ON d.id = e.document_id WHERE d.user_id = ?', [uid]),
        hasConsents
          ? executeQuery('SELECT channel, source, consented_at FROM marketing_consents WHERE user_id = ?', [uid])
          : Promise.resolve([]),
        executeQuery('SELECT request_type, status, requested_at, completed_at FROM data_subject_requests WHERE user_id = ?', [uid]),
      ]);

    if (user.length === 0) return res.status(404).json({ message: 'User not found' });

    // Share tokens are live capabilities — anyone holding one can read the
    // invoice and the seller's banking details without logging in. They must
    // not travel in an export file.
    const scrubbed = documents.map(({ share_token, ...rest }) => rest);

    const payload = {
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

// Must sit above the SPA catch-all, or it returns the Angular shell.
// /portal/ carries invoice share tokens — a crawled link would expose a full
// invoice, including the seller's banking details, to anyone.
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send([
    'User-agent: *',
    'Disallow: /portal/',
    'Disallow: /api/',
    'Disallow: /uploads/',
    'Allow: /legal/',
    'Allow: /$',
    '',
  ].join('\n'));
});

// Catch-all route for Angular app
app.get('*', (req, res) => {
  res.sendFile(path.join(WEB_ROOT, 'index.html'));
});

// Start server
const port = process.env.PORT || 3000;

runMigrations()
  .then(() => {
    if (!fs.existsSync(path.join(WEB_ROOT, 'index.html'))) {
      logger.error(`${path.join(WEB_ROOT, 'index.html')} is missing — run \`ng build\` before starting the server. API routes will work; the web app will 404.`);
    }
    app.listen(port, () => {
      logger.info(`Server is running on port ${port}`);
    });
  })
  .catch((err) => {
    // Deliberately fatal. Serving traffic against a half-migrated schema is how
    // you get silently truncated columns and unrecoverable data loss.
    logger.error('Migrations failed — refusing to start', { message: err.message, stack: err.stack });
    process.exitCode = 1;
    closePool();
  });

module.exports = app;