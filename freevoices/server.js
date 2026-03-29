require('dotenv').config();
const axios = require('axios');

const EmailService = require('./src/services/email.service');
const express = require('express');
const path = require('path');
const mysql = require('mysql2');
const cors = require('cors');
const bodyParser = require('body-parser');
const argon2 = require('argon2');
const winston = require('winston');
const { randomUUID } = require('crypto');

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

// Get user profile endpoint
app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    const sql = 'SELECT id, username, email, role, organizationID, organizationName FROM users WHERE id = ? AND deleted = 0';
    const users = await executeQuery(sql, [req.user.id]);

    if (users.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }

    res.json(users[0]);
  } catch (error) {
    logger.error('Profile fetch error:', error);
    res.status(500).json({ message: 'Error fetching profile' });
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