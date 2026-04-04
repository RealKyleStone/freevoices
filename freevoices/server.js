require('dotenv').config();
const axios = require('axios');

const EmailService = require('./src/services/email.service');
const { buildInvoicePdf } = require('./src/services/pdf.service');
const express = require('express');
const path = require('path');
const fs = require('fs');
const mysql = require('mysql2');
const cors = require('cors');
const bodyParser = require('body-parser');
const argon2 = require('argon2');
const winston = require('winston');
const { randomUUID } = require('crypto');
const multer = require('multer');

// Multer setup for company logo uploads (5 MB limit, jpg/png only)
const logoStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, 'uploads', 'logos');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `logo_${req.user.id}_${Date.now()}${ext}`);
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

RECAPTCHA_SECRET_KEY="6LecjacqAAAAAFG-2MsglDJzKcvfYBvEw4zkYepg"

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'dist/www')));

const emailService = new EmailService({
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: parseInt(process.env.SMTP_PORT),
  SMTP_SECURE: process.env.SMTP_SECURE === 'true',
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASS: process.env.SMTP_PASS,
  tls: {
    rejectUnauthorized: true,
    minVersion: 'TLSv1.2',
    maxVersion: 'TLSv1.3'
  }
});

// Configure Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({
      format: winston.format.simple(),
    }),
  ],
});

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: parseInt(process.env.DB_CONNECTION_LIMIT, 10),
  queueLimit: parseInt(process.env.DB_QUEUE_LIMIT, 10),
  enableKeepAlive: process.env.DB_ENABLE_KEEP_ALIVE === 'true',
  keepAliveInitialDelay: parseInt(process.env.DB_KEEP_ALIVE_INITIAL_DELAY, 10),
};

console.log(dbConfig);

let pool;

function handleDisconnect() {
  pool = mysql.createPool(dbConfig);

  pool.on('connection', (connection) => {
    logger.info('New connection established');

    connection.on('error', (err) => {
      logger.error('Database connection error', err);
      if (err.code === 'PROTOCOL_CONNECTION_LOST') {
        handleDisconnect();
      }
    });
  });

  pool.on('error', (err) => {
    logger.error('Pool error', err);
    if (err.code === 'PROTOCOL_CONNECTION_LOST') {
      handleDisconnect();
    }
  });
}

handleDisconnect();

// Query execution helper
function executeQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    pool.getConnection((err, connection) => {
      if (err) {
        logger.error('Error getting connection from pool:', err);
        reject(err);
        return;
      }

      connection.query(sql, params, (error, results) => {
        connection.release();
        if (error) {
          logger.error('Query error:', error);
          reject(error);
        } else {
          resolve(results);
        }
      });
    });
  });
}

// Authentication middleware
const authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
      return res.status(401).json({ message: 'No token provided' });
    }

    // Verify token from database
    const sql = 'SELECT * FROM sessions WHERE token = ? AND expires > NOW()';
    const sessions = await executeQuery(sql, [token]);

    if (sessions.length === 0) {
      return res.status(401).json({ message: 'Invalid or expired token' });
    }

    req.user = { id: sessions[0].userId };
    next();
  } catch (error) {
    logger.error('Authentication error:', error);
    res.status(500).json({ message: 'Authentication error' });
  }
};



// Verify CAPTCHA token
async function verifyCaptcha(token) {
  try {
    if (!token) {
      console.log('No CAPTCHA token provided');
      return false;
    }

    console.log('Verifying CAPTCHA token:', token);

    const params = new URLSearchParams();
    params.append('secret', process.env.RECAPTCHA_SECRET_KEY);
    params.append('response', token);

    const response = await axios.post(
      'https://www.google.com/recaptcha/api/siteverify',
      params,
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    console.log('CAPTCHA verification response:', response.data);

    if (!response.data.success) {
      console.log('CAPTCHA verification failed:', response.data['error-codes']);
    }

    return response.data.success;
  } catch (error) {
    console.error('CAPTCHA verification error:', error);
    return false;
  }
}



// Login endpoint
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password, captchaToken } = req.body;
    logger.info(`Login attempt for user: ${email}`);
    logger.info(`Captcha token: ${captchaToken}`);

    // Skip CAPTCHA in development or for mobile devices
    const isDev = process.env.NODE_ENV !== 'production';
    if (!isDev && !req.headers['user-agent']?.includes('Mobile')) {
      const captchaValid = await verifyCaptcha(captchaToken);
      if (!captchaValid) {
        logger.warn(`CAPTCHA verification failed for user: ${email}`);
        return res.status(400).json({ message: 'Security verification failed. Please try again.' });
      }
    }

    // Get user from database
    const sql = 'SELECT * FROM users WHERE email = ?';
    const users = await executeQuery(sql, [email]);

    if (users.length === 0) {
      logger.warn(`Login failed: User not found - ${email}`);
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const user = users[0];

    // Verify password
    const validPassword = await argon2.verify(user.password_hash, password);
    if (!validPassword) {
      logger.warn(`Login failed: Invalid password for user ${email}`);
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // Generate session token
    const token = randomUUID();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24); // Token expires in 24 hours

    // Store token in database
    const sessionSql = 'INSERT INTO sessions (userId, token, expires) VALUES (?, ?, ?)';
    await executeQuery(sessionSql, [user.id, token, expiresAt]);

    logger.info(`User logged in successfully: ${email}`);
    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        company_name: user.company_name
      }
    });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ message: 'Login failed. Please try again.' });
  }
});

// Logout endpoint
app.post('/api/logout', authenticateToken, async (req, res) => {
  try {
    const token = req.headers.authorization.split(' ')[1];
    await executeQuery('DELETE FROM sessions WHERE token = ?', [token]);
    logger.info(`User logged out successfully: ${req.user.id}`);
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    logger.error('Logout error:', error);
    res.status(500).json({ message: 'Logout error' });
  }
});

// Graceful shutdown handling
process.on('SIGINT', () => {
  pool.end((err) => {
    if (err) {
      logger.error('Error closing pool during shutdown', err);
    }
    logger.info('Pool has ended');
    process.exit(0);
  });
});

// Registration endpoint
app.post('/api/auth/register', async (req, res) => {
  try {
    const {
      email,
      password,
      company_name,
      company_registration,
      vat_number,
      contact_person,
      phone,
      address,
      bank_name,
      bank_account_number,
      bank_branch_code,
      bank_account_type,
      captchaToken
    } = req.body;

    // Skip CAPTCHA in development or for mobile devices
    const isDev = process.env.NODE_ENV !== 'production';
    if (!isDev && !req.headers['user-agent']?.includes('Mobile')) {
      const captchaValid = await verifyCaptcha(captchaToken);
      if (!captchaValid) {
        logger.warn(`CAPTCHA verification failed for registration: ${email}`);
        return res.status(400).json({ message: 'Security verification failed. Please try again.' });
      }
    }

    // Check if user exists
    const existingUser = await executeQuery('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUser.length > 0) {
      return res.status(400).json({ message: 'Email already registered' });
    }

    // Hash password
    const password_hash = await argon2.hash(password);

    // Create user
    const result = await executeQuery(
      `INSERT INTO users (
        email, password_hash, company_name, company_registration,
        vat_number, contact_person, phone, address,
        bank_name, bank_account_number, bank_branch_code, bank_account_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        email, password_hash, company_name, company_registration,
        vat_number, contact_person, phone, address,
        bank_name, bank_account_number, bank_branch_code, bank_account_type
      ]
    );

    // Generate session token
    const token = randomUUID();
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);

    // Create session
    await executeQuery('INSERT INTO sessions (userId, token, expires) VALUES (?, ?, ?)', 
      [result.insertId, token, expiresAt]);

    // Get created user
    const user = await executeQuery('SELECT id, email, company_name FROM users WHERE id = ?', [result.insertId]);

    // Generate email verification token
    const verificationToken = randomUUID();
    const verificationExpires = new Date();
    verificationExpires.setHours(verificationExpires.getHours() + 24);

    await executeQuery(
      'UPDATE users SET email_verification_token = ?, email_verification_expires = ? WHERE id = ?',
      [verificationToken, verificationExpires, result.insertId]
    );

    // Send verification email
    try {
      await emailService.sendVerificationEmail(email, verificationToken);
    } catch (emailError) {
      logger.error('Failed to send verification email:', emailError);
      // Continue with registration even if email fails
    }

    logger.info(`User registered successfully: ${email}`);
    res.status(201).json({
      token,
      user: user[0]
    });

  } catch (error) {
    logger.error('Registration error:', error);
    res.status(500).json({ message: 'Registration failed. Please try again.' });
  }
});

app.get('/api/verify-email', async (req, res) => {
  try {
    const { token } = req.query;
    
    const result = await executeQuery(
      `UPDATE users 
       SET email_verified = true, 
           email_verification_token = NULL, 
           email_verification_expires = NULL 
       WHERE email_verification_token = ? 
       AND email_verification_expires > NOW()`,
      [token]
    );

    if (result.affectedRows === 0) {
      return res.status(400).json({ message: 'Invalid or expired verification token' });
    }

    res.json({ message: 'Email verified successfully' });
  } catch (error) {
    logger.error('Email verification error:', error);
    res.status(500).json({ message: 'Verification failed' });
  }
});

// Forgot password — generate reset token and email link
app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }

    const users = await executeQuery(
      'SELECT id FROM users WHERE email = ? AND email_verified = 1',
      [email]
    );

    // Always respond with success to prevent email enumeration
    if (users.length === 0) {
      return res.json({ message: 'If that email is registered you will receive a reset link shortly.' });
    }

    const token = randomUUID();
    await executeQuery(
      `INSERT INTO password_reset_tokens (user_id, token, expires_at)
       VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))`,
      [users[0].id, token]
    );

    await emailService.sendPasswordResetEmail(email, token);
    res.json({ message: 'If that email is registered you will receive a reset link shortly.' });
  } catch (error) {
    logger.error('Forgot password error:', error);
    res.status(500).json({ message: 'Failed to process request' });
  }
});

// Reset password — validate token and update password
app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { token, password } = req.body;
    if (!token || !password) {
      return res.status(400).json({ message: 'Token and new password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ message: 'Password must be at least 8 characters' });
    }

    const tokens = await executeQuery(
      `SELECT id, user_id FROM password_reset_tokens
       WHERE token = ? AND expires_at > NOW() AND used = 0`,
      [token]
    );

    if (tokens.length === 0) {
      return res.status(400).json({ message: 'Invalid or expired reset token' });
    }

    const { id: tokenId, user_id } = tokens[0];
    const passwordHash = await argon2.hash(password);

    await executeQuery('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, user_id]);
    await executeQuery('UPDATE password_reset_tokens SET used = 1 WHERE id = ?', [tokenId]);

    res.json({ message: 'Password updated successfully' });
  } catch (error) {
    logger.error('Reset password error:', error);
    res.status(500).json({ message: 'Failed to reset password' });
  }
});

// Banks endpoint
app.get('/api/banks', async (req, res) => {
  try {
    const activeOnly = req.query.active === 'true';
    const sql = 'SELECT * FROM banks WHERE 1=1' + (activeOnly ? ' AND is_active = true' : '') + ' ORDER BY name';
    const banks = await executeQuery(sql);
    res.json(banks);
  } catch (error) {
    logger.error('Error fetching banks:', error);
    res.status(500).json({ message: 'Failed to fetch banks' });
  }
});

// ─── Customer endpoints ───────────────────────────────────────────────────────

// GET /api/customers — paginated list with optional search
app.get('/api/customers', authenticateToken, async (req, res) => {
  try {
    const search = req.query.search || '';
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;

    let sql    = 'SELECT * FROM customers WHERE user_id = ? AND active = 1';
    let cntSql = 'SELECT COUNT(*) AS total FROM customers WHERE user_id = ? AND active = 1';
    const params    = [req.user.id];
    const cntParams = [req.user.id];

    if (search) {
      const clause = ' AND (name LIKE ? OR email LIKE ?)';
      sql    += clause;
      cntSql += clause;
      params.push(`%${search}%`, `%${search}%`);
      cntParams.push(`%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY name ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const [customers, countResult] = await Promise.all([
      executeQuery(sql, params),
      executeQuery(cntSql, cntParams)
    ]);

    res.json({ data: customers, total: countResult[0].total, page, limit });
  } catch (error) {
    logger.error('Error fetching customers:', error);
    res.status(500).json({ message: 'Failed to fetch customers' });
  }
});

// POST /api/customers — create
app.post('/api/customers', authenticateToken, async (req, res) => {
  try {
    const { name, email, phone, vat_number, billing_address, shipping_address, payment_terms, notes } = req.body;

    if (!name || !email || !billing_address) {
      return res.status(400).json({ message: 'Name, email, and billing address are required' });
    }

    const result = await executeQuery(
      `INSERT INTO customers (user_id, name, email, phone, vat_number, billing_address, shipping_address, payment_terms, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [req.user.id, name, email, phone || null, vat_number || null, billing_address, shipping_address || null, payment_terms || null, notes || null]
    );

    const customer = await executeQuery('SELECT * FROM customers WHERE id = ?', [result.insertId]);
    res.status(201).json(customer[0]);
  } catch (error) {
    logger.error('Error creating customer:', error);
    res.status(500).json({ message: 'Failed to create customer' });
  }
});

// GET /api/customers/:id — single customer with document history
app.get('/api/customers/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const customers = await executeQuery(
      'SELECT * FROM customers WHERE id = ? AND user_id = ? AND active = 1',
      [id, req.user.id]
    );

    if (customers.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    const documents = await executeQuery(
      'SELECT * FROM documents WHERE customer_id = ? AND user_id = ? ORDER BY created_at DESC',
      [id, req.user.id]
    );

    res.json({ ...customers[0], documents });
  } catch (error) {
    logger.error('Error fetching customer:', error);
    res.status(500).json({ message: 'Failed to fetch customer' });
  }
});

// PUT /api/customers/:id — update
app.put('/api/customers/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, phone, vat_number, billing_address, shipping_address, payment_terms, notes } = req.body;

    if (!name || !email || !billing_address) {
      return res.status(400).json({ message: 'Name, email, and billing address are required' });
    }

    const existing = await executeQuery(
      'SELECT id FROM customers WHERE id = ? AND user_id = ? AND active = 1',
      [id, req.user.id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    await executeQuery(
      `UPDATE customers
       SET name=?, email=?, phone=?, vat_number=?, billing_address=?, shipping_address=?, payment_terms=?, notes=?, updated_at=NOW()
       WHERE id = ? AND user_id = ?`,
      [name, email, phone || null, vat_number || null, billing_address, shipping_address || null, payment_terms || null, notes || null, id, req.user.id]
    );

    const customer = await executeQuery('SELECT * FROM customers WHERE id = ?', [id]);
    res.json(customer[0]);
  } catch (error) {
    logger.error('Error updating customer:', error);
    res.status(500).json({ message: 'Failed to update customer' });
  }
});

// DELETE /api/customers/:id — soft delete
app.delete('/api/customers/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const existing = await executeQuery(
      'SELECT id FROM customers WHERE id = ? AND user_id = ? AND active = 1',
      [id, req.user.id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Customer not found' });
    }

    await executeQuery(
      'UPDATE customers SET active = 0, updated_at = NOW() WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );
    res.json({ message: 'Customer deleted successfully' });
  } catch (error) {
    logger.error('Error deleting customer:', error);
    res.status(500).json({ message: 'Failed to delete customer' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Invoices

async function getNextDocumentNumber(userId, type) {
  const prefix = type === 'INVOICE' ? 'INV' : 'QUO';
  const year = new Date().getFullYear();
  const rows = await executeQuery(
    `SELECT document_number FROM documents WHERE user_id = ? AND type = ? AND document_number LIKE ? ORDER BY id DESC LIMIT 1`,
    [userId, type, `${prefix}-${year}-%`]
  );
  if (rows.length === 0) return `${prefix}-${year}-0001`;
  const seq = parseInt(rows[0].document_number.split('-')[2], 10) + 1;
  return `${prefix}-${year}-${String(seq).padStart(4, '0')}`;
}

app.get('/api/invoices', authenticateToken, async (req, res) => {
  try {
    const search = req.query.search || '';
    const status = req.query.status || '';
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;

    let sql = `SELECT d.id, d.document_number, d.status, d.issue_date, d.due_date,
                      d.subtotal, d.vat_amount, d.total, d.created_at,
                      c.name AS customer_name
               FROM documents d
               JOIN customers c ON c.id = d.customer_id
               WHERE d.user_id = ? AND d.type = 'INVOICE'`;
    let cntSql = `SELECT COUNT(*) AS total
                  FROM documents d
                  JOIN customers c ON c.id = d.customer_id
                  WHERE d.user_id = ? AND d.type = 'INVOICE'`;
    const params    = [req.user.id];
    const cntParams = [req.user.id];

    if (status) {
      sql    += ' AND d.status = ?';
      cntSql += ' AND d.status = ?';
      params.push(status);
      cntParams.push(status);
    }

    if (search) {
      const clause = ' AND (d.document_number LIKE ? OR c.name LIKE ?)';
      sql    += clause;
      cntSql += clause;
      params.push(`%${search}%`, `%${search}%`);
      cntParams.push(`%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY d.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const [invoices, countResult] = await Promise.all([
      executeQuery(sql, params),
      executeQuery(cntSql, cntParams)
    ]);

    res.json({ data: invoices, total: countResult[0].total, page, limit });
  } catch (error) {
    logger.error('Error fetching invoices:', error);
    res.status(500).json({ message: 'Failed to fetch invoices' });
  }
});

app.post('/api/invoices', authenticateToken, async (req, res) => {
  try {
    const { customer_id, issue_date, due_date, payment_terms, notes, terms_conditions, items } = req.body;

    if (!customer_id || !issue_date || !items || items.length === 0) {
      return res.status(400).json({ message: 'Customer, issue date, and at least one line item are required' });
    }

    const customers = await executeQuery(
      'SELECT id FROM customers WHERE id = ? AND user_id = ? AND active = 1',
      [customer_id, req.user.id]
    );
    if (customers.length === 0) return res.status(400).json({ message: 'Invalid customer' });

    let subtotal = 0, vat_amount = 0, total = 0;
    const lineItems = items.map(item => {
      const qty   = parseFloat(item.quantity)   || 0;
      const price = parseFloat(item.unit_price)  || 0;
      const rate  = parseFloat(item.vat_rate)    ?? 15;
      const itemSubtotal = qty * price;
      const itemVat      = itemSubtotal * rate / 100;
      const itemTotal    = itemSubtotal + itemVat;
      subtotal   += itemSubtotal;
      vat_amount += itemVat;
      total      += itemTotal;
      return { ...item, quantity: qty, unit_price: price, vat_rate: rate,
               subtotal: itemSubtotal, vat_amount: itemVat, total: itemTotal };
    });

    const document_number = await getNextDocumentNumber(req.user.id, 'INVOICE');
    const currency_id = 1; // Default ZAR — Phase 3.3 adds multi-currency

    const conn = await new Promise((resolve, reject) =>
      pool.getConnection((err, c) => err ? reject(err) : resolve(c))
    );
    try {
      await new Promise((resolve, reject) =>
        conn.beginTransaction(err => err ? reject(err) : resolve())
      );

      const docResult = await new Promise((resolve, reject) =>
        conn.query(
          `INSERT INTO documents (user_id, customer_id, type, document_number, currency_id, status,
            issue_date, due_date, payment_terms, subtotal, vat_amount, total, notes, terms_conditions)
           VALUES (?, ?, 'INVOICE', ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?)`,
          [req.user.id, customer_id, document_number, currency_id,
           issue_date, due_date || null, payment_terms || null,
           subtotal.toFixed(2), vat_amount.toFixed(2), total.toFixed(2),
           notes || null, terms_conditions || null],
          (err, result) => err ? reject(err) : resolve(result)
        )
      );
      const docId = docResult.insertId;

      for (const item of lineItems) {
        await new Promise((resolve, reject) =>
          conn.query(
            `INSERT INTO document_items (document_id, product_id, description, quantity,
              unit_price, vat_rate, vat_amount, subtotal, total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [docId, item.product_id || null, item.description,
             item.quantity, item.unit_price, item.vat_rate,
             item.vat_amount.toFixed(2), item.subtotal.toFixed(2), item.total.toFixed(2)],
            (err, r) => err ? reject(err) : resolve(r)
          )
        );
      }

      await new Promise((resolve, reject) =>
        conn.query(
          `INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'CREATED')`,
          [docId],
          (err, r) => err ? reject(err) : resolve(r)
        )
      );

      await new Promise((resolve, reject) => conn.commit(err => err ? reject(err) : resolve()));
      conn.release();

      const invoice   = await executeQuery(
        `SELECT d.*, c.name AS customer_name FROM documents d
         JOIN customers c ON c.id = d.customer_id WHERE d.id = ?`, [docId]
      );
      const itemsResult = await executeQuery(
        'SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [docId]
      );
      res.status(201).json({ ...invoice[0], items: itemsResult });
    } catch (txError) {
      await new Promise(resolve => conn.rollback(resolve));
      conn.release();
      throw txError;
    }
  } catch (error) {
    logger.error('Error creating invoice:', error);
    res.status(500).json({ message: 'Failed to create invoice' });
  }
});

app.get('/api/invoices/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [invoices, items, tracking, payments] = await Promise.all([
      executeQuery(
        `SELECT d.*, c.name AS customer_name, c.email AS customer_email,
                c.billing_address AS customer_billing_address,
                c.vat_number AS customer_vat_number
         FROM documents d
         JOIN customers c ON c.id = d.customer_id
         WHERE d.id = ? AND d.user_id = ? AND d.type = 'INVOICE'`,
        [id, req.user.id]
      ),
      executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]),
      executeQuery('SELECT * FROM document_tracking WHERE document_id = ? ORDER BY event_date ASC', [id]),
      executeQuery('SELECT * FROM payments WHERE document_id = ? ORDER BY payment_date DESC', [id])
    ]);

    if (invoices.length === 0) return res.status(404).json({ message: 'Invoice not found' });
    res.json({ ...invoices[0], items, tracking, payments });
  } catch (error) {
    logger.error('Error fetching invoice:', error);
    res.status(500).json({ message: 'Failed to fetch invoice' });
  }
});

// PDF download
app.get('/api/invoices/:id/pdf', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const markSent = req.query.markSent === 'true';

    const [invoices, items, users, logoRows] = await Promise.all([
      executeQuery(
        `SELECT d.*, c.name AS customer_name, c.email AS customer_email,
                c.billing_address AS customer_billing_address,
                c.vat_number AS customer_vat_number
         FROM documents d
         JOIN customers c ON c.id = d.customer_id
         WHERE d.id = ? AND d.user_id = ? AND d.type = 'INVOICE'`,
        [id, req.user.id]
      ),
      executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]),
      executeQuery('SELECT * FROM users WHERE id = ?', [req.user.id]),
      executeQuery("SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'company_logo'", [req.user.id])
    ]);

    if (invoices.length === 0) return res.status(404).json({ message: 'Invoice not found' });

    const logoRelPath = logoRows[0]?.setting_value || null;
    const user = { ...users[0], logo_path: logoRelPath ? path.join(__dirname, logoRelPath) : null };
    const pdfBuffer = await buildInvoicePdf(invoices[0], items, user);

    await executeQuery(
      `INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'DOWNLOADED')`, [id]
    );

    // Optionally mark as sent if requested and currently DRAFT
    if (markSent && invoices[0].status === 'DRAFT') {
      await executeQuery(
        `UPDATE documents SET status = 'SENT', updated_at = NOW() WHERE id = ? AND user_id = ?`,
        [id, req.user.id]
      );
      await executeQuery(
        `INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'SENT')`, [id]
      );
    }

    res.set({
      'Content-Type':        'application/pdf',
      'Content-Disposition': `attachment; filename="${invoices[0].document_number}.pdf"`,
      'Content-Length':      pdfBuffer.length
    });
    res.send(pdfBuffer);
  } catch (error) {
    logger.error('Error generating invoice PDF:', error);
    res.status(500).json({ message: 'Failed to generate PDF' });
  }
});

app.put('/api/invoices/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { customer_id, issue_date, due_date, payment_terms, notes, terms_conditions, items } = req.body;

    const existing = await executeQuery(
      `SELECT id, status FROM documents WHERE id = ? AND user_id = ? AND type = 'INVOICE'`,
      [id, req.user.id]
    );
    if (existing.length === 0) return res.status(404).json({ message: 'Invoice not found' });
    if (existing[0].status !== 'DRAFT') {
      return res.status(400).json({ message: 'Only DRAFT invoices can be edited' });
    }

    if (!customer_id || !issue_date || !items || items.length === 0) {
      return res.status(400).json({ message: 'Customer, issue date, and at least one line item are required' });
    }

    const customers = await executeQuery(
      'SELECT id FROM customers WHERE id = ? AND user_id = ? AND active = 1', [customer_id, req.user.id]
    );
    if (customers.length === 0) return res.status(400).json({ message: 'Invalid customer' });

    let subtotal = 0, vat_amount = 0, total = 0;
    const lineItems = items.map(item => {
      const qty   = parseFloat(item.quantity)  || 0;
      const price = parseFloat(item.unit_price) || 0;
      const rate  = parseFloat(item.vat_rate)   ?? 15;
      const itemSubtotal = qty * price;
      const itemVat      = itemSubtotal * rate / 100;
      const itemTotal    = itemSubtotal + itemVat;
      subtotal   += itemSubtotal;
      vat_amount += itemVat;
      total      += itemTotal;
      return { ...item, quantity: qty, unit_price: price, vat_rate: rate,
               subtotal: itemSubtotal, vat_amount: itemVat, total: itemTotal };
    });

    const conn = await new Promise((resolve, reject) =>
      pool.getConnection((err, c) => err ? reject(err) : resolve(c))
    );
    try {
      await new Promise((resolve, reject) =>
        conn.beginTransaction(err => err ? reject(err) : resolve())
      );

      await new Promise((resolve, reject) =>
        conn.query(
          `UPDATE documents SET customer_id=?, issue_date=?, due_date=?, payment_terms=?,
            subtotal=?, vat_amount=?, total=?, notes=?, terms_conditions=?, updated_at=NOW()
           WHERE id=? AND user_id=?`,
          [customer_id, issue_date, due_date || null, payment_terms || null,
           subtotal.toFixed(2), vat_amount.toFixed(2), total.toFixed(2),
           notes || null, terms_conditions || null, id, req.user.id],
          (err, r) => err ? reject(err) : resolve(r)
        )
      );

      await new Promise((resolve, reject) =>
        conn.query('DELETE FROM document_items WHERE document_id = ?', [id],
          (err, r) => err ? reject(err) : resolve(r))
      );

      for (const item of lineItems) {
        await new Promise((resolve, reject) =>
          conn.query(
            `INSERT INTO document_items (document_id, product_id, description, quantity,
              unit_price, vat_rate, vat_amount, subtotal, total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, item.product_id || null, item.description,
             item.quantity, item.unit_price, item.vat_rate,
             item.vat_amount.toFixed(2), item.subtotal.toFixed(2), item.total.toFixed(2)],
            (err, r) => err ? reject(err) : resolve(r)
          )
        );
      }

      await new Promise((resolve, reject) => conn.commit(err => err ? reject(err) : resolve()));
      conn.release();

      const invoice = await executeQuery(
        `SELECT d.*, c.name AS customer_name FROM documents d
         JOIN customers c ON c.id = d.customer_id WHERE d.id = ?`, [id]
      );
      const itemsResult = await executeQuery(
        'SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]
      );
      res.json({ ...invoice[0], items: itemsResult });
    } catch (txError) {
      await new Promise(resolve => conn.rollback(resolve));
      conn.release();
      throw txError;
    }
  } catch (error) {
    logger.error('Error updating invoice:', error);
    res.status(500).json({ message: 'Failed to update invoice' });
  }
});

app.post('/api/invoices/:id/send', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const [invoices, items, users, logoRows] = await Promise.all([
      executeQuery(
        `SELECT d.*, c.name AS customer_name, c.email AS customer_email,
                c.billing_address AS customer_billing_address,
                c.vat_number AS customer_vat_number
         FROM documents d
         JOIN customers c ON c.id = d.customer_id
         WHERE d.id = ? AND d.user_id = ? AND d.type = 'INVOICE'`,
        [id, req.user.id]
      ),
      executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]),
      executeQuery('SELECT * FROM users WHERE id = ?', [req.user.id]),
      executeQuery("SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'company_logo'", [req.user.id])
    ]);

    if (invoices.length === 0) return res.status(404).json({ message: 'Invoice not found' });
    const invoice = invoices[0];
    const logoRelPath = logoRows[0]?.setting_value || null;
    const user = { ...users[0], logo_path: logoRelPath ? path.join(__dirname, logoRelPath) : null };

    if (!['DRAFT', 'SENT'].includes(invoice.status)) {
      return res.status(400).json({ message: `Cannot send an invoice with status ${invoice.status}` });
    }

    if (!invoice.customer_email) {
      return res.status(400).json({ message: 'This customer has no email address on file' });
    }

    // Generate PDF
    const pdfBuffer = await buildInvoicePdf(invoice, items, user);

    // Attempt to email — mark as sent regardless, but report email failures
    let emailWarning = null;
    try {
      await emailService.sendInvoiceEmail(
        invoice.customer_email,
        { ...invoice, company_name: user.company_name, bank_name: user.bank_name,
          bank_account_number: user.bank_account_number, bank_branch_code: user.bank_branch_code },
        pdfBuffer
      );
    } catch (emailError) {
      logger.error('Email delivery failed (invoice still marked sent):', emailError);
      emailWarning = `Invoice marked as sent, but the email could not be delivered: ${emailError.message}`;
    }

    await executeQuery(
      `UPDATE documents SET status = 'SENT', updated_at = NOW() WHERE id = ? AND user_id = ?`,
      [id, req.user.id]
    );
    await executeQuery(
      `INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'SENT')`, [id]
    );

    if (emailWarning) {
      return res.status(207).json({ message: emailWarning, emailFailed: true });
    }
    res.json({ message: `Invoice emailed to ${invoice.customer_email}` });
  } catch (error) {
    logger.error('Error sending invoice:', error);
    res.status(500).json({ message: 'Failed to send invoice' });
  }
});

app.post('/api/invoices/:id/mark-paid', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, payment_date, payment_method, transaction_reference, notes } = req.body;

    if (!amount || !payment_date || !payment_method) {
      return res.status(400).json({ message: 'Amount, payment date, and payment method are required' });
    }

    const invoices = await executeQuery(
      `SELECT id, total, status FROM documents WHERE id = ? AND user_id = ? AND type = 'INVOICE'`,
      [id, req.user.id]
    );
    if (invoices.length === 0) return res.status(404).json({ message: 'Invoice not found' });
    if (invoices[0].status === 'CANCELLED') {
      return res.status(400).json({ message: 'Cannot record payment on a cancelled invoice' });
    }

    await executeQuery(
      `INSERT INTO payments (document_id, amount, payment_date, payment_method, transaction_reference, notes)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, amount, payment_date, payment_method, transaction_reference || null, notes || null]
    );
    await executeQuery(
      `UPDATE documents SET status = 'PAID', updated_at = NOW() WHERE id = ? AND user_id = ?`,
      [id, req.user.id]
    );
    await executeQuery(
      `INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'PAID')`, [id]
    );
    res.status(201).json({ message: 'Payment recorded successfully' });
  } catch (error) {
    logger.error('Error recording payment:', error);
    res.status(500).json({ message: 'Failed to record payment' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Quotes

app.get('/api/quotes', authenticateToken, async (req, res) => {
  try {
    const search = req.query.search || '';
    const status = req.query.status || '';
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;

    let sql = `SELECT d.id, d.document_number, d.status, d.issue_date, d.due_date, d.valid_until,
                      d.subtotal, d.vat_amount, d.total, d.created_at,
                      c.name AS customer_name
               FROM documents d
               JOIN customers c ON c.id = d.customer_id
               WHERE d.user_id = ? AND d.type = 'QUOTE'`;
    let cntSql = `SELECT COUNT(*) AS total
                  FROM documents d
                  JOIN customers c ON c.id = d.customer_id
                  WHERE d.user_id = ? AND d.type = 'QUOTE'`;
    const params    = [req.user.id];
    const cntParams = [req.user.id];

    if (status) {
      sql    += ' AND d.status = ?';
      cntSql += ' AND d.status = ?';
      params.push(status);
      cntParams.push(status);
    }

    if (search) {
      const clause = ' AND (d.document_number LIKE ? OR c.name LIKE ?)';
      sql    += clause;
      cntSql += clause;
      params.push(`%${search}%`, `%${search}%`);
      cntParams.push(`%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY d.created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const [quotes, countResult] = await Promise.all([
      executeQuery(sql, params),
      executeQuery(cntSql, cntParams)
    ]);

    res.json({ data: quotes, total: countResult[0].total, page, limit });
  } catch (error) {
    logger.error('Error fetching quotes:', error);
    res.status(500).json({ message: 'Failed to fetch quotes' });
  }
});

app.post('/api/quotes', authenticateToken, async (req, res) => {
  try {
    const { customer_id, issue_date, valid_until, payment_terms, notes, terms_conditions, items } = req.body;

    if (!customer_id || !issue_date || !items || items.length === 0) {
      return res.status(400).json({ message: 'Customer, issue date, and at least one line item are required' });
    }

    const customers = await executeQuery(
      'SELECT id FROM customers WHERE id = ? AND user_id = ? AND active = 1',
      [customer_id, req.user.id]
    );
    if (customers.length === 0) return res.status(400).json({ message: 'Invalid customer' });

    let subtotal = 0, vat_amount = 0, total = 0;
    const lineItems = items.map(item => {
      const qty   = parseFloat(item.quantity)  || 0;
      const price = parseFloat(item.unit_price) || 0;
      const rate  = parseFloat(item.vat_rate)   ?? 15;
      const itemSubtotal = qty * price;
      const itemVat      = itemSubtotal * rate / 100;
      const itemTotal    = itemSubtotal + itemVat;
      subtotal   += itemSubtotal;
      vat_amount += itemVat;
      total      += itemTotal;
      return { ...item, quantity: qty, unit_price: price, vat_rate: rate,
               subtotal: itemSubtotal, vat_amount: itemVat, total: itemTotal };
    });

    const document_number = await getNextDocumentNumber(req.user.id, 'QUOTE');
    const currency_id = 1;

    const conn = await new Promise((resolve, reject) =>
      pool.getConnection((err, c) => err ? reject(err) : resolve(c))
    );
    try {
      await new Promise((resolve, reject) =>
        conn.beginTransaction(err => err ? reject(err) : resolve())
      );

      const docResult = await new Promise((resolve, reject) =>
        conn.query(
          `INSERT INTO documents (user_id, customer_id, type, document_number, currency_id, status,
            issue_date, valid_until, payment_terms, subtotal, vat_amount, total, notes, terms_conditions)
           VALUES (?, ?, 'QUOTE', ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?, ?)`,
          [req.user.id, customer_id, document_number, currency_id,
           issue_date, valid_until || null, payment_terms || null,
           subtotal.toFixed(2), vat_amount.toFixed(2), total.toFixed(2),
           notes || null, terms_conditions || null],
          (err, result) => err ? reject(err) : resolve(result)
        )
      );
      const docId = docResult.insertId;

      for (const item of lineItems) {
        await new Promise((resolve, reject) =>
          conn.query(
            `INSERT INTO document_items (document_id, product_id, description, quantity,
              unit_price, vat_rate, vat_amount, subtotal, total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [docId, item.product_id || null, item.description,
             item.quantity, item.unit_price, item.vat_rate,
             item.vat_amount.toFixed(2), item.subtotal.toFixed(2), item.total.toFixed(2)],
            (err, r) => err ? reject(err) : resolve(r)
          )
        );
      }

      await new Promise((resolve, reject) =>
        conn.query(
          `INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'CREATED')`,
          [docId],
          (err, r) => err ? reject(err) : resolve(r)
        )
      );

      await new Promise((resolve, reject) => conn.commit(err => err ? reject(err) : resolve()));
      conn.release();

      const quote     = await executeQuery(
        `SELECT d.*, c.name AS customer_name FROM documents d
         JOIN customers c ON c.id = d.customer_id WHERE d.id = ?`, [docId]
      );
      const itemsResult = await executeQuery(
        'SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [docId]
      );
      res.status(201).json({ ...quote[0], items: itemsResult });
    } catch (txError) {
      await new Promise(resolve => conn.rollback(resolve));
      conn.release();
      throw txError;
    }
  } catch (error) {
    logger.error('Error creating quote:', error);
    res.status(500).json({ message: 'Failed to create quote' });
  }
});

app.get('/api/quotes/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const [quotes, items, tracking] = await Promise.all([
      executeQuery(
        `SELECT d.*, c.name AS customer_name, c.email AS customer_email,
                c.billing_address AS customer_billing_address,
                c.vat_number AS customer_vat_number
         FROM documents d
         JOIN customers c ON c.id = d.customer_id
         WHERE d.id = ? AND d.user_id = ? AND d.type = 'QUOTE'`,
        [id, req.user.id]
      ),
      executeQuery('SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]),
      executeQuery('SELECT * FROM document_tracking WHERE document_id = ? ORDER BY event_date ASC', [id])
    ]);

    if (quotes.length === 0) return res.status(404).json({ message: 'Quote not found' });
    res.json({ ...quotes[0], items, tracking });
  } catch (error) {
    logger.error('Error fetching quote:', error);
    res.status(500).json({ message: 'Failed to fetch quote' });
  }
});

app.put('/api/quotes/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { customer_id, issue_date, valid_until, payment_terms, notes, terms_conditions, items } = req.body;

    const existing = await executeQuery(
      `SELECT id, status FROM documents WHERE id = ? AND user_id = ? AND type = 'QUOTE'`,
      [id, req.user.id]
    );
    if (existing.length === 0) return res.status(404).json({ message: 'Quote not found' });
    if (existing[0].status !== 'DRAFT') {
      return res.status(400).json({ message: 'Only DRAFT quotes can be edited' });
    }

    if (!customer_id || !issue_date || !items || items.length === 0) {
      return res.status(400).json({ message: 'Customer, issue date, and at least one line item are required' });
    }

    const customers = await executeQuery(
      'SELECT id FROM customers WHERE id = ? AND user_id = ? AND active = 1', [customer_id, req.user.id]
    );
    if (customers.length === 0) return res.status(400).json({ message: 'Invalid customer' });

    let subtotal = 0, vat_amount = 0, total = 0;
    const lineItems = items.map(item => {
      const qty   = parseFloat(item.quantity)  || 0;
      const price = parseFloat(item.unit_price) || 0;
      const rate  = parseFloat(item.vat_rate)   ?? 15;
      const itemSubtotal = qty * price;
      const itemVat      = itemSubtotal * rate / 100;
      const itemTotal    = itemSubtotal + itemVat;
      subtotal   += itemSubtotal;
      vat_amount += itemVat;
      total      += itemTotal;
      return { ...item, quantity: qty, unit_price: price, vat_rate: rate,
               subtotal: itemSubtotal, vat_amount: itemVat, total: itemTotal };
    });

    const conn = await new Promise((resolve, reject) =>
      pool.getConnection((err, c) => err ? reject(err) : resolve(c))
    );
    try {
      await new Promise((resolve, reject) =>
        conn.beginTransaction(err => err ? reject(err) : resolve())
      );

      await new Promise((resolve, reject) =>
        conn.query(
          `UPDATE documents SET customer_id=?, issue_date=?, valid_until=?, payment_terms=?,
            subtotal=?, vat_amount=?, total=?, notes=?, terms_conditions=?, updated_at=NOW()
           WHERE id=? AND user_id=?`,
          [customer_id, issue_date, valid_until || null, payment_terms || null,
           subtotal.toFixed(2), vat_amount.toFixed(2), total.toFixed(2),
           notes || null, terms_conditions || null, id, req.user.id],
          (err, r) => err ? reject(err) : resolve(r)
        )
      );

      await new Promise((resolve, reject) =>
        conn.query('DELETE FROM document_items WHERE document_id = ?', [id],
          (err, r) => err ? reject(err) : resolve(r))
      );

      for (const item of lineItems) {
        await new Promise((resolve, reject) =>
          conn.query(
            `INSERT INTO document_items (document_id, product_id, description, quantity,
              unit_price, vat_rate, vat_amount, subtotal, total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [id, item.product_id || null, item.description,
             item.quantity, item.unit_price, item.vat_rate,
             item.vat_amount.toFixed(2), item.subtotal.toFixed(2), item.total.toFixed(2)],
            (err, r) => err ? reject(err) : resolve(r)
          )
        );
      }

      await new Promise((resolve, reject) => conn.commit(err => err ? reject(err) : resolve()));
      conn.release();

      const quote = await executeQuery(
        `SELECT d.*, c.name AS customer_name FROM documents d
         JOIN customers c ON c.id = d.customer_id WHERE d.id = ?`, [id]
      );
      const itemsResult = await executeQuery(
        'SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]
      );
      res.json({ ...quote[0], items: itemsResult });
    } catch (txError) {
      await new Promise(resolve => conn.rollback(resolve));
      conn.release();
      throw txError;
    }
  } catch (error) {
    logger.error('Error updating quote:', error);
    res.status(500).json({ message: 'Failed to update quote' });
  }
});

app.post('/api/quotes/:id/send', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await executeQuery(
      `SELECT id, status FROM documents WHERE id = ? AND user_id = ? AND type = 'QUOTE'`,
      [id, req.user.id]
    );
    if (existing.length === 0) return res.status(404).json({ message: 'Quote not found' });
    if (!['DRAFT', 'SENT'].includes(existing[0].status)) {
      return res.status(400).json({ message: `Cannot send a quote with status ${existing[0].status}` });
    }

    await executeQuery(
      `UPDATE documents SET status = 'SENT', updated_at = NOW() WHERE id = ? AND user_id = ?`,
      [id, req.user.id]
    );
    await executeQuery(
      `INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'SENT')`, [id]
    );
    res.json({ message: 'Quote marked as sent' });
  } catch (error) {
    logger.error('Error sending quote:', error);
    res.status(500).json({ message: 'Failed to send quote' });
  }
});

app.post('/api/quotes/:id/convert-to-invoice', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;

    const quotes = await executeQuery(
      `SELECT d.*, c.id AS cust_id FROM documents d
       JOIN customers c ON c.id = d.customer_id
       WHERE d.id = ? AND d.user_id = ? AND d.type = 'QUOTE'`,
      [id, req.user.id]
    );
    if (quotes.length === 0) return res.status(404).json({ message: 'Quote not found' });
    if (quotes[0].status === 'CANCELLED') {
      return res.status(400).json({ message: 'Cannot convert a cancelled quote' });
    }

    const quoteItems = await executeQuery(
      'SELECT * FROM document_items WHERE document_id = ? ORDER BY id ASC', [id]
    );

    const invoice_number = await getNextDocumentNumber(req.user.id, 'INVOICE');
    const today = new Date().toISOString().split('T')[0];

    const conn = await new Promise((resolve, reject) =>
      pool.getConnection((err, c) => err ? reject(err) : resolve(c))
    );
    try {
      await new Promise((resolve, reject) =>
        conn.beginTransaction(err => err ? reject(err) : resolve())
      );

      const docResult = await new Promise((resolve, reject) =>
        conn.query(
          `INSERT INTO documents (user_id, customer_id, type, document_number, currency_id, status,
            issue_date, payment_terms, subtotal, vat_amount, total, notes, terms_conditions)
           VALUES (?, ?, 'INVOICE', ?, ?, 'DRAFT', ?, ?, ?, ?, ?, ?, ?)`,
          [req.user.id, quotes[0].customer_id, invoice_number, quotes[0].currency_id,
           today, quotes[0].payment_terms,
           quotes[0].subtotal, quotes[0].vat_amount, quotes[0].total,
           quotes[0].notes || null, quotes[0].terms_conditions || null],
          (err, result) => err ? reject(err) : resolve(result)
        )
      );
      const invoiceId = docResult.insertId;

      for (const item of quoteItems) {
        await new Promise((resolve, reject) =>
          conn.query(
            `INSERT INTO document_items (document_id, product_id, description, quantity,
              unit_price, vat_rate, vat_amount, subtotal, total)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [invoiceId, item.product_id || null, item.description,
             item.quantity, item.unit_price, item.vat_rate,
             item.vat_amount, item.subtotal, item.total],
            (err, r) => err ? reject(err) : resolve(r)
          )
        );
      }

      await new Promise((resolve, reject) =>
        conn.query(
          `INSERT INTO document_tracking (document_id, event_type) VALUES (?, 'CREATED')`,
          [invoiceId],
          (err, r) => err ? reject(err) : resolve(r)
        )
      );

      // Mark the source quote as sent/accepted if it was a draft
      await new Promise((resolve, reject) =>
        conn.query(
          `UPDATE documents SET status = 'SENT', updated_at = NOW() WHERE id = ? AND status = 'DRAFT'`,
          [id],
          (err, r) => err ? reject(err) : resolve(r)
        )
      );

      await new Promise((resolve, reject) => conn.commit(err => err ? reject(err) : resolve()));
      conn.release();

      res.status(201).json({ message: 'Quote converted to invoice', invoice_id: invoiceId });
    } catch (txError) {
      await new Promise(resolve => conn.rollback(resolve));
      conn.release();
      throw txError;
    }
  } catch (error) {
    logger.error('Error converting quote to invoice:', error);
    res.status(500).json({ message: 'Failed to convert quote to invoice' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Products

app.get('/api/products', authenticateToken, async (req, res) => {
  try {
    const search = req.query.search || '';
    const page   = Math.max(1, parseInt(req.query.page)  || 1);
    const limit  = Math.min(100, parseInt(req.query.limit) || 20);
    const offset = (page - 1) * limit;

    let sql    = 'SELECT * FROM products WHERE user_id = ? AND is_active = 1';
    let cntSql = 'SELECT COUNT(*) AS total FROM products WHERE user_id = ? AND is_active = 1';
    const params    = [req.user.id];
    const cntParams = [req.user.id];

    if (search) {
      const clause = ' AND (name LIKE ? OR description LIKE ?)';
      sql    += clause;
      cntSql += clause;
      params.push(`%${search}%`, `%${search}%`);
      cntParams.push(`%${search}%`, `%${search}%`);
    }

    sql += ' ORDER BY name ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const [products, countResult] = await Promise.all([
      executeQuery(sql, params),
      executeQuery(cntSql, cntParams)
    ]);

    res.json({ data: products, total: countResult[0].total, page, limit });
  } catch (error) {
    logger.error('Error fetching products:', error);
    res.status(500).json({ message: 'Failed to fetch products' });
  }
});

app.post('/api/products', authenticateToken, async (req, res) => {
  try {
    const { name, description, price, vat_inclusive } = req.body;

    if (!name || price == null) {
      return res.status(400).json({ message: 'Name and price are required' });
    }

    const result = await executeQuery(
      'INSERT INTO products (user_id, name, description, price, vat_inclusive) VALUES (?, ?, ?, ?, ?)',
      [req.user.id, name, description || null, price, vat_inclusive ? 1 : 0]
    );

    const product = await executeQuery('SELECT * FROM products WHERE id = ?', [result.insertId]);
    res.status(201).json(product[0]);
  } catch (error) {
    logger.error('Error creating product:', error);
    res.status(500).json({ message: 'Failed to create product' });
  }
});

app.get('/api/products/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const product = await executeQuery(
      'SELECT * FROM products WHERE id = ? AND user_id = ? AND is_active = 1',
      [id, req.user.id]
    );
    if (product.length === 0) {
      return res.status(404).json({ message: 'Product not found' });
    }
    res.json(product[0]);
  } catch (error) {
    logger.error('Error fetching product:', error);
    res.status(500).json({ message: 'Failed to fetch product' });
  }
});

app.put('/api/products/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, description, price, vat_inclusive } = req.body;

    if (!name || price == null) {
      return res.status(400).json({ message: 'Name and price are required' });
    }

    const existing = await executeQuery(
      'SELECT id FROM products WHERE id = ? AND user_id = ? AND is_active = 1',
      [id, req.user.id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Product not found' });
    }

    await executeQuery(
      'UPDATE products SET name = ?, description = ?, price = ?, vat_inclusive = ?, updated_at = NOW() WHERE id = ? AND user_id = ?',
      [name, description || null, price, vat_inclusive ? 1 : 0, id, req.user.id]
    );

    const product = await executeQuery('SELECT * FROM products WHERE id = ?', [id]);
    res.json(product[0]);
  } catch (error) {
    logger.error('Error updating product:', error);
    res.status(500).json({ message: 'Failed to update product' });
  }
});

app.delete('/api/products/:id', authenticateToken, async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await executeQuery(
      'SELECT id FROM products WHERE id = ? AND user_id = ? AND is_active = 1',
      [id, req.user.id]
    );
    if (existing.length === 0) {
      return res.status(404).json({ message: 'Product not found' });
    }

    await executeQuery(
      'UPDATE products SET is_active = 0, updated_at = NOW() WHERE id = ? AND user_id = ?',
      [id, req.user.id]
    );
    res.json({ message: 'Product deleted successfully' });
  } catch (error) {
    logger.error('Error deleting product:', error);
    res.status(500).json({ message: 'Failed to delete product' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

// Dashboard summary
app.get('/api/dashboard/summary', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [revenueRows, customersRows, openRows, overdueRows, recentRows] = await Promise.all([
      // Total revenue from paid invoices (current calendar month)
      executeQuery(
        `SELECT COALESCE(SUM(total), 0) AS monthRevenue,
                COALESCE(SUM(CASE WHEN YEAR(issue_date) = YEAR(CURDATE()) THEN total ELSE 0 END), 0) AS yearRevenue
         FROM documents
         WHERE user_id = ? AND type = 'INVOICE' AND status = 'PAID'
           AND YEAR(issue_date) = YEAR(CURDATE()) AND MONTH(issue_date) = MONTH(CURDATE())`,
        [userId]
      ),
      // Total active customers
      executeQuery(
        `SELECT COUNT(*) AS total FROM customers WHERE user_id = ? AND is_active = 1`,
        [userId]
      ),
      // Open (sent but not yet paid) invoices
      executeQuery(
        `SELECT COUNT(*) AS total FROM documents WHERE user_id = ? AND type = 'INVOICE' AND status = 'SENT'`,
        [userId]
      ),
      // Overdue invoices
      executeQuery(
        `SELECT COUNT(*) AS total FROM documents WHERE user_id = ? AND type = 'INVOICE' AND status = 'OVERDUE'`,
        [userId]
      ),
      // Recent tracking activity (last 5 events across all documents)
      executeQuery(
        `SELECT dt.event_type, dt.event_date, d.document_number, d.type AS document_type, c.company_name AS customer_name
         FROM document_tracking dt
         JOIN documents d ON dt.document_id = d.id
         JOIN customers c ON d.customer_id = c.id
         WHERE d.user_id = ?
         ORDER BY dt.event_date DESC
         LIMIT 5`,
        [userId]
      )
    ]);

    res.json({
      monthRevenue: parseFloat(revenueRows[0].monthRevenue),
      totalCustomers: customersRows[0].total,
      openInvoices: openRows[0].total,
      overdueInvoices: overdueRows[0].total,
      recentActivity: recentRows
    });
  } catch (error) {
    logger.error('Error fetching dashboard summary:', error);
    res.status(500).json({ message: 'Failed to fetch dashboard summary' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings API Endpoints
// ─────────────────────────────────────────────────────────────────────────────

// Serve uploaded logos
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// GET /api/settings — fetch all settings for the current user
app.get('/api/settings', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;

    const [userRows, settingRows] = await Promise.all([
      executeQuery(
        `SELECT email, company_name, company_registration, vat_number,
                contact_person, phone, address,
                bank_name, bank_account_number, bank_branch_code, bank_account_type
         FROM users WHERE id = ?`,
        [userId]
      ),
      executeQuery(
        'SELECT setting_key, setting_value FROM settings WHERE user_id = ?',
        [userId]
      )
    ]);

    if (userRows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    const kvSettings = {};
    for (const row of settingRows) {
      kvSettings[row.setting_key] = row.setting_value;
    }

    res.json({ ...userRows[0], ...kvSettings });
  } catch (error) {
    logger.error('Error fetching settings:', error);
    res.status(500).json({ message: 'Failed to fetch settings' });
  }
});

// PUT /api/settings/profile — update name, email, phone, optional password
app.put('/api/settings/profile', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { contact_person, email, phone, current_password, new_password } = req.body;

    if (!contact_person || !email) {
      return res.status(400).json({ message: 'Name and email are required' });
    }

    // If changing password, verify current password first
    if (new_password) {
      if (!current_password) {
        return res.status(400).json({ message: 'Current password is required to set a new password' });
      }
      const userRows = await executeQuery('SELECT password_hash FROM users WHERE id = ?', [userId]);
      if (userRows.length === 0) return res.status(404).json({ message: 'User not found' });

      const valid = await argon2.verify(userRows[0].password_hash, current_password);
      if (!valid) {
        return res.status(400).json({ message: 'Current password is incorrect' });
      }

      const newHash = await argon2.hash(new_password);
      await executeQuery(
        'UPDATE users SET contact_person = ?, email = ?, phone = ?, password_hash = ?, updated_at = NOW() WHERE id = ?',
        [contact_person, email, phone || null, newHash, userId]
      );
    } else {
      await executeQuery(
        'UPDATE users SET contact_person = ?, email = ?, phone = ?, updated_at = NOW() WHERE id = ?',
        [contact_person, email, phone || null, userId]
      );
    }

    res.json({ message: 'Profile updated successfully' });
  } catch (error) {
    logger.error('Error updating profile:', error);
    res.status(500).json({ message: 'Failed to update profile' });
  }
});

// PUT /api/settings/company — update company info
app.put('/api/settings/company', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { company_name, company_registration, vat_number, address } = req.body;

    await executeQuery(
      'UPDATE users SET company_name = ?, company_registration = ?, vat_number = ?, address = ?, updated_at = NOW() WHERE id = ?',
      [company_name || null, company_registration || null, vat_number || null, address || null, userId]
    );

    res.json({ message: 'Company details updated successfully' });
  } catch (error) {
    logger.error('Error updating company settings:', error);
    res.status(500).json({ message: 'Failed to update company details' });
  }
});

// POST /api/settings/logo — upload company logo (5 MB max)
app.post('/api/settings/logo', authenticateToken, (req, res) => {
  logoUpload.single('logo')(req, res, async (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ message: 'Logo must be 5 MB or smaller' });
      }
      return res.status(400).json({ message: err.message || 'Upload failed' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'No file uploaded' });
    }

    try {
      const userId = req.user.id;
      const logoPath = `/uploads/logos/${req.file.filename}`;

      // Delete previous logo file if it exists
      const existing = await executeQuery(
        "SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'company_logo'",
        [userId]
      );
      if (existing.length > 0 && existing[0].setting_value) {
        const oldFile = path.join(__dirname, existing[0].setting_value);
        fs.unlink(oldFile, () => {});
      }

      await executeQuery(
        `INSERT INTO settings (user_id, setting_key, setting_value, updated_at)
         VALUES (?, 'company_logo', ?, NOW())
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = NOW()`,
        [userId, logoPath]
      );

      res.json({ message: 'Logo uploaded successfully', logo_url: logoPath });
    } catch (error) {
      logger.error('Error saving logo path:', error);
      res.status(500).json({ message: 'Failed to save logo' });
    }
  });
});

// DELETE /api/settings/logo — remove company logo
app.delete('/api/settings/logo', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const existing = await executeQuery(
      "SELECT setting_value FROM settings WHERE user_id = ? AND setting_key = 'company_logo'",
      [userId]
    );

    if (existing.length > 0 && existing[0].setting_value) {
      const filePath = path.join(__dirname, existing[0].setting_value);
      fs.unlink(filePath, () => {});
    }

    await executeQuery(
      "DELETE FROM settings WHERE user_id = ? AND setting_key = 'company_logo'",
      [userId]
    );

    res.json({ message: 'Logo removed successfully' });
  } catch (error) {
    logger.error('Error removing logo:', error);
    res.status(500).json({ message: 'Failed to remove logo' });
  }
});

// PUT /api/settings/invoice — update invoice defaults (stored as key-value in settings table)
app.put('/api/settings/invoice', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { invoice_prefix, invoice_next_number, invoice_payment_terms, invoice_vat_rate, invoice_notes } = req.body;

    const pairs = [
      ['invoice_prefix', invoice_prefix ?? 'INV'],
      ['invoice_next_number', String(invoice_next_number ?? 1)],
      ['invoice_payment_terms', String(invoice_payment_terms ?? 30)],
      ['invoice_vat_rate', String(invoice_vat_rate ?? 15)],
      ['invoice_notes', invoice_notes ?? '']
    ];

    for (const [key, value] of pairs) {
      await executeQuery(
        `INSERT INTO settings (user_id, setting_key, setting_value, updated_at)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = NOW()`,
        [userId, key, value]
      );
    }

    res.json({ message: 'Invoice defaults updated successfully' });
  } catch (error) {
    logger.error('Error updating invoice settings:', error);
    res.status(500).json({ message: 'Failed to update invoice defaults' });
  }
});

// PUT /api/settings/payment — update bank/payment details
app.put('/api/settings/payment', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { bank_name, bank_account_number, bank_branch_code, bank_account_type } = req.body;

    await executeQuery(
      'UPDATE users SET bank_name = ?, bank_account_number = ?, bank_branch_code = ?, bank_account_type = ?, updated_at = NOW() WHERE id = ?',
      [bank_name || null, bank_account_number || null, bank_branch_code || null, bank_account_type || null, userId]
    );

    res.json({ message: 'Payment details updated successfully' });
  } catch (error) {
    logger.error('Error updating payment settings:', error);
    res.status(500).json({ message: 'Failed to update payment details' });
  }
});

// PUT /api/settings/notifications — update notification preferences
app.put('/api/settings/notifications', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const { notify_invoice_sent, notify_payment_received, notify_invoice_overdue } = req.body;

    const pairs = [
      ['notify_invoice_sent', notify_invoice_sent ? '1' : '0'],
      ['notify_payment_received', notify_payment_received ? '1' : '0'],
      ['notify_invoice_overdue', notify_invoice_overdue ? '1' : '0']
    ];

    for (const [key, value] of pairs) {
      await executeQuery(
        `INSERT INTO settings (user_id, setting_key, setting_value, updated_at)
         VALUES (?, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_at = NOW()`,
        [userId, key, value]
      );
    }

    res.json({ message: 'Notification preferences updated successfully' });
  } catch (error) {
    logger.error('Error updating notification settings:', error);
    res.status(500).json({ message: 'Failed to update notification preferences' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// REPORTS

// GET /api/reports/revenue-by-month — paid invoice revenue for the last 12 months
app.get('/api/reports/revenue-by-month', authenticateToken, async (req, res) => {
  try {
    const rows = await executeQuery(
      `SELECT DATE_FORMAT(issue_date, '%Y-%m') AS month, SUM(total) AS revenue
       FROM documents
       WHERE user_id = ? AND type = 'INVOICE' AND status = 'PAID'
         AND issue_date >= DATE_SUB(CURDATE(), INTERVAL 12 MONTH)
       GROUP BY DATE_FORMAT(issue_date, '%Y-%m')
       ORDER BY month ASC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (error) {
    logger.error('Error fetching revenue by month:', error);
    res.status(500).json({ message: 'Failed to fetch revenue report' });
  }
});

// GET /api/reports/invoice-status — count and total by status
app.get('/api/reports/invoice-status', authenticateToken, async (req, res) => {
  try {
    const rows = await executeQuery(
      `SELECT status, COUNT(*) AS count, COALESCE(SUM(total), 0) AS total
       FROM documents
       WHERE user_id = ? AND type = 'INVOICE'
       GROUP BY status`,
      [req.user.id]
    );
    res.json(rows);
  } catch (error) {
    logger.error('Error fetching invoice status breakdown:', error);
    res.status(500).json({ message: 'Failed to fetch invoice status report' });
  }
});

// GET /api/reports/top-customers — top 5 customers by paid revenue
app.get('/api/reports/top-customers', authenticateToken, async (req, res) => {
  try {
    const rows = await executeQuery(
      `SELECT c.name, SUM(d.total) AS revenue, COUNT(d.id) AS invoice_count
       FROM documents d
       JOIN customers c ON d.customer_id = c.id
       WHERE d.user_id = ? AND d.type = 'INVOICE' AND d.status = 'PAID'
       GROUP BY c.id, c.name
       ORDER BY revenue DESC
       LIMIT 5`,
      [req.user.id]
    );
    res.json(rows);
  } catch (error) {
    logger.error('Error fetching top customers:', error);
    res.status(500).json({ message: 'Failed to fetch top customers report' });
  }
});

// GET /api/reports/vat-summary — monthly VAT breakdown for the current year
app.get('/api/reports/vat-summary', authenticateToken, async (req, res) => {
  try {
    const rows = await executeQuery(
      `SELECT DATE_FORMAT(issue_date, '%Y-%m') AS month,
              SUM(subtotal) AS subtotal,
              SUM(vat_amount) AS vat_amount,
              SUM(total) AS total
       FROM documents
       WHERE user_id = ? AND type = 'INVOICE' AND status IN ('SENT', 'PAID')
         AND YEAR(issue_date) = YEAR(CURDATE())
       GROUP BY DATE_FORMAT(issue_date, '%Y-%m')
       ORDER BY month ASC`,
      [req.user.id]
    );
    res.json(rows);
  } catch (error) {
    logger.error('Error fetching VAT summary:', error);
    res.status(500).json({ message: 'Failed to fetch VAT summary report' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

// Catch-all route for Angular app
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist/www/index.html'));
});

// Start server
const port = process.env.PORT || 3000;
app.listen(port, () => {
  logger.info(`Server is running on port ${port}`);
});

module.exports = app;