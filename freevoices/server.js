require('dotenv').config();
const express = require('express');
const path = require('path');
const mysql = require('mysql2');
const cors = require('cors');
const bodyParser = require('body-parser');
const argon2 = require('argon2');
const winston = require('winston');
const { randomUUID } = require('crypto');

const app = express();

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'dist/www')));

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

// Login endpoint
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    logger.info(`Login attempt for user: ${email}`);

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
        role: user.role,
        organizationId: user.organizationID,
        organizationName: user.organizationName
      }
    });
  } catch (error) {
    logger.error('Login error:', error);
    res.status(500).json({ message: 'Login error' });
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