/**
 * Ordered, idempotent schema migrations with a ledger and a cross-process lock.
 *
 * Replaces the single ad-hoc `migrateDatabase()` that used to live in
 * server.js. Three properties matter and none of them were true before:
 *
 *   1. FAIL FAST. The old version caught every error and let the server boot
 *      anyway. With column widenings and encrypted writes coming, a silently
 *      failed ALTER means permanently truncated ciphertext. A failed migration
 *      now aborts startup.
 *   2. ONE RUNNER AT A TIME. GET_LOCK is held on a single dedicated connection
 *      for the whole run, so PM2 cluster workers cannot race the same DDL.
 *   3. IDEMPOTENT BY CONSTRUCTION. Every step re-checks INFORMATION_SCHEMA
 *      before acting. DDL implicitly commits in MySQL, so a migration cannot be
 *      wrapped in a transaction — the guards, not the ledger, are what make a
 *      half-finished run safe to repeat.
 */

const { getConnection, queryOn, logger } = require('./db.service');

const LOCK_NAME = 'freevoices:migrate';
const LOCK_TIMEOUT_SECONDS = 60;

// ─── INFORMATION_SCHEMA predicates ────────────────────────────────────────────

async function tableExists(q, table) {
  const rows = await q(
    'SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]
  );
  return rows[0].cnt > 0;
}

async function columnExists(q, table, column) {
  const rows = await q(
    'SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?',
    [table, column]
  );
  return rows[0].cnt > 0;
}

async function columnDefinition(q, table, column) {
  const rows = await q(
    `SELECT COLUMN_TYPE, IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
    [table, column]
  );
  return rows[0] || null;
}

async function indexExists(q, table, indexName) {
  const rows = await q(
    'SELECT COUNT(*) AS cnt FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ?',
    [table, indexName]
  );
  return rows[0].cnt > 0;
}

async function tableEngine(q, table) {
  const rows = await q(
    'SELECT ENGINE FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?',
    [table]
  );
  return rows.length ? rows[0].ENGINE : null;
}

/**
 * Find a foreign key by what it actually does rather than by name — the
 * `*_ibfk_N` names in database/schema.sql are MySQL-generated and may differ in
 * a database that was built by a different route.
 */
async function findForeignKey(q, table, column, referencedTable) {
  const rows = await q(
    `SELECT k.CONSTRAINT_NAME, r.DELETE_RULE
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
       JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA
        AND r.CONSTRAINT_NAME   = k.CONSTRAINT_NAME
      WHERE k.TABLE_SCHEMA = DATABASE()
        AND k.TABLE_NAME = ?
        AND k.COLUMN_NAME = ?
        AND k.REFERENCED_TABLE_NAME = ?`,
    [table, column, referencedTable]
  );
  return rows[0] || null;
}

/** Re-point a foreign key at a new ON DELETE rule. No-op if already correct. */
async function setForeignKeyDeleteRule(q, table, column, referencedTable, referencedColumn, rule) {
  const existing = await findForeignKey(q, table, column, referencedTable);

  if (existing && existing.DELETE_RULE === rule) {
    return false;
  }

  if (existing) {
    // MySQL cannot alter a constraint in place; drop and re-add.
    await q(`ALTER TABLE \`${table}\` DROP FOREIGN KEY \`${existing.CONSTRAINT_NAME}\``);
  }

  const name = `fk_${table}_${column}`;
  await q(
    `ALTER TABLE \`${table}\`
       ADD CONSTRAINT \`${name}\`
       FOREIGN KEY (\`${column}\`) REFERENCES \`${referencedTable}\` (\`${referencedColumn}\`)
       ON DELETE ${rule}`
  );
  logger.info(`Migration: ${table}.${column} -> ${referencedTable}.${referencedColumn} ON DELETE ${rule}`);
  return true;
}

// ─── The migrations ───────────────────────────────────────────────────────────

const MIGRATIONS = [
  {
    id: '001_documents_notifications_muted',
    description: 'Add documents.notifications_muted (was the original inline auto-migration)',
    async up(q) {
      if (await columnExists(q, 'documents', 'notifications_muted')) return 'already present';
      await q('ALTER TABLE documents ADD COLUMN notifications_muted TINYINT(1) NOT NULL DEFAULT 0');
      return 'column added';
    },
  },

  {
    id: '002_document_tracking_overdue_enum',
    description: "Add 'OVERDUE' to document_tracking.event_type — processOverdueInvoices already inserts it",
    async up(q) {
      const col = await columnDefinition(q, 'document_tracking', 'event_type');
      if (!col) throw new Error('document_tracking.event_type not found');
      if (col.COLUMN_TYPE.includes("'OVERDUE'")) return 'already present';

      // The nightly overdue cron inserts 'OVERDUE', which is absent from the
      // enum. Under a non-strict sql_mode that silently stores ''. Widening it
      // now, before strict mode turns those writes into hard errors.
      await q(
        `ALTER TABLE document_tracking
           MODIFY event_type enum('CREATED','SENT','VIEWED','DOWNLOADED','PAID','CANCELLED','OVERDUE') NOT NULL`
      );
      return "enum widened with 'OVERDUE'";
    },
  },

  {
    id: '003_sessions_hardening',
    description: 'sessions: purge junk, bigint ids, MyISAM->InnoDB, unique token, FK to users, expires index',
    async up(q) {
      const notes = [];

      // (1) Shrink first. Expired and orphaned rows would block the unique
      //     index and the foreign key, and nothing of value is lost — the worst
      //     case is that somebody signs in again.
      const expired = await q('DELETE FROM sessions WHERE expires < NOW()');
      if (expired.affectedRows) notes.push(`purged ${expired.affectedRows} expired`);

      const orphaned = await q('DELETE s FROM sessions s LEFT JOIN users u ON u.id = s.userId WHERE u.id IS NULL');
      if (orphaned.affectedRows) notes.push(`purged ${orphaned.affectedRows} orphaned`);

      // (2) Duplicate tokens would fail the unique index. Keep the newest.
      const dupes = await q('DELETE s1 FROM sessions s1 JOIN sessions s2 ON s1.token = s2.token AND s1.id < s2.id');
      if (dupes.affectedRows) notes.push(`purged ${dupes.affectedRows} duplicate tokens`);

      // (3) Widen the id columns BEFORE the FK: an FK requires userId's type to
      //     match users.id, which is bigint(20).
      const userIdCol = await columnDefinition(q, 'sessions', 'userId');
      if (userIdCol && !userIdCol.COLUMN_TYPE.toLowerCase().startsWith('bigint')) {
        await q('ALTER TABLE sessions MODIFY id bigint(20) NOT NULL AUTO_INCREMENT, MODIFY userId bigint(20) NOT NULL');
        notes.push('ids widened to bigint');
      }

      // (4) MyISAM cannot hold a foreign key, has no transactions, and is
      //     crash-unsafe. Every other table is already InnoDB.
      if ((await tableEngine(q, 'sessions')) === 'MyISAM') {
        await q('ALTER TABLE sessions ENGINE=InnoDB');
        notes.push('converted to InnoDB');
      }

      // (5) The index that was missing while every authenticated request did
      //     SELECT ... WHERE token = ? against a full table scan.
      if (!(await indexExists(q, 'sessions', 'uq_sessions_token'))) {
        await q('ALTER TABLE sessions ADD UNIQUE KEY uq_sessions_token (token)');
        notes.push('unique token index added');
      }

      // (6) Now the FK is legal. CASCADE so deleting a user cannot orphan
      //     sessions — previously there was no FK at all.
      if (await setForeignKeyDeleteRule(q, 'sessions', 'userId', 'users', 'id', 'CASCADE')) {
        notes.push('FK to users added');
      }

      // (7) Supports the retention job's expiry sweep.
      if (!(await indexExists(q, 'sessions', 'idx_sessions_expires'))) {
        await q('ALTER TABLE sessions ADD KEY idx_sessions_expires (expires)');
        notes.push('expires index added');
      }

      return notes.length ? notes.join('; ') : 'already hardened';
    },
  },

  {
    id: '004_document_child_cascades',
    description: 'ON DELETE CASCADE from documents to its children, so retention can delete a document at all',
    async up(q) {
      // Without these the retention engine hits ER_ROW_IS_REFERENCED_2 and
      // cannot delete a single documents row. Every one of these children is
      // meaningless without its parent document.
      const changed = [];
      for (const table of ['document_items', 'document_tracking', 'email_log', 'payments']) {
        if (!(await tableExists(q, table))) continue;
        if (await setForeignKeyDeleteRule(q, table, 'document_id', 'documents', 'id', 'CASCADE')) {
          changed.push(table);
        }
      }
      return changed.length ? `cascaded: ${changed.join(', ')}` : 'already cascading';
    },
  },

  {
    id: '005_email_log_nullable_document',
    description: 'email_log.document_id nullable so non-document emails (support, account notices) can be logged',
    async up(q) {
      const col = await columnDefinition(q, 'email_log', 'document_id');
      if (!col) throw new Error('email_log.document_id not found');
      if (col.IS_NULLABLE === 'YES') return 'already nullable';

      // A NULL never violates a foreign key, so the FK added in 004 can stay.
      await q('ALTER TABLE email_log MODIFY document_id bigint(20) DEFAULT NULL');
      return 'made nullable';
    },
  },

  {
    id: '006_legal_documents',
    description: 'legal_documents: versioned policy/terms copy served to the app and the public pages',
    async up(q) {
      if (await tableExists(q, 'legal_documents')) return 'already present';

      // utf8mb4 deliberately, unlike every other table in this schema. The
      // policy text contains em-dashes, arrows and the Regulator's address;
      // in latin1 a legally published document would render as mojibake.
      await q(`
        CREATE TABLE legal_documents (
          id bigint(20) NOT NULL AUTO_INCREMENT,
          slug varchar(40) NOT NULL,
          version varchar(20) NOT NULL,
          title varchar(160) NOT NULL,
          effective_date date NOT NULL,
          summary_html text DEFAULT NULL,
          content_html mediumtext NOT NULL,
          is_current tinyint(1) NOT NULL DEFAULT 0,
          created_at timestamp NOT NULL DEFAULT current_timestamp(),
          PRIMARY KEY (id),
          UNIQUE KEY slug_version (slug, version),
          KEY idx_current (slug, is_current)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `);
      return 'table created';
    },
  },

  {
    id: '007_account_lifecycle',
    description: 'users lifecycle columns, security_events and data_subject_requests — closure, export and audit',
    async up(q) {
      const notes = [];

      // Until now a user could not leave: there was no delete endpoint and no
      // status column. `status` is the gate authenticateToken checks; the two
      // timestamps drive the 30-day anonymisation the retention engine runs.
      const columns = [
        ["status", "enum('ACTIVE','CLOSED','ANONYMISED') NOT NULL DEFAULT 'ACTIVE'"],
        ['closed_at', 'datetime DEFAULT NULL'],
        ['anonymise_after', 'datetime DEFAULT NULL'],
        ['anonymised_at', 'datetime DEFAULT NULL'],
        ['last_login_at', 'datetime DEFAULT NULL'],
      ];
      for (const [name, definition] of columns) {
        if (await columnExists(q, 'users', name)) continue;
        await q(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
        notes.push(name);
      }

      // Lets the retention sweep find accounts due for anonymisation without a
      // full scan.
      if (!(await indexExists(q, 'users', 'idx_users_lifecycle'))) {
        await q('ALTER TABLE users ADD KEY idx_users_lifecycle (status, anonymise_after)');
        notes.push('idx_users_lifecycle');
      }

      if (!(await tableExists(q, 'security_events'))) {
        // Replaces logging authentication events as free text into combined.log
        // with an auditable, retention-bounded table. user_id is nullable and
        // ON DELETE SET NULL so the record survives the user it describes —
        // otherwise closing an account destroys the evidence of it closing.
        await q(`
          CREATE TABLE security_events (
            id bigint(20) NOT NULL AUTO_INCREMENT,
            user_id bigint(20) DEFAULT NULL,
            event_type varchar(48) NOT NULL,
            ip_address varchar(45) DEFAULT NULL,
            user_agent varchar(512) DEFAULT NULL,
            detail varchar(512) DEFAULT NULL,
            created_at timestamp NOT NULL DEFAULT current_timestamp(),
            PRIMARY KEY (id),
            KEY idx_user (user_id, created_at),
            KEY idx_retention (created_at),
            CONSTRAINT fk_sec_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        notes.push('security_events');
      }

      if (!(await tableExists(q, 'data_subject_requests'))) {
        // POPIA s23/s24 requests. Keeping a record is how you demonstrate you
        // honoured them — "we deleted it" is not much use without evidence.
        await q(`
          CREATE TABLE data_subject_requests (
            id bigint(20) NOT NULL AUTO_INCREMENT,
            user_id bigint(20) DEFAULT NULL,
            subject_email varchar(255) DEFAULT NULL,
            request_type enum('ACCESS','EXPORT','CORRECTION','DELETION','OBJECTION','MARKETING_OPT_OUT') NOT NULL,
            channel enum('IN_APP','EMAIL','POST') NOT NULL DEFAULT 'IN_APP',
            status enum('RECEIVED','IN_PROGRESS','COMPLETED','REFUSED') NOT NULL DEFAULT 'RECEIVED',
            notes varchar(512) DEFAULT NULL,
            ip_address varchar(45) DEFAULT NULL,
            requested_at timestamp NOT NULL DEFAULT current_timestamp(),
            completed_at datetime DEFAULT NULL,
            PRIMARY KEY (id),
            KEY idx_user (user_id, requested_at),
            KEY idx_open (status, requested_at),
            CONSTRAINT fk_dsr_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
        `);
        notes.push('data_subject_requests');
      }

      return notes.length ? `added: ${notes.join(', ')}` : 'already present';
    },
  },

  {
    id: '008_users_consent_columns',
    description: 'users: recorded Terms and Privacy Policy acceptance (version + timestamp)',
    async up(q) {
      // The denormalised "what did this user last accept" fields. The
      // append-only acceptance history lands with the consent-capture work;
      // these exist now so /api/account/status and the export can report it,
      // and so the re-consent guard has a cheap column to gate on.
      const columns = [
        ['terms_accepted_at', 'datetime DEFAULT NULL'],
        ['terms_version', 'varchar(20) DEFAULT NULL'],
        ['privacy_accepted_at', 'datetime DEFAULT NULL'],
        ['privacy_policy_version', 'varchar(20) DEFAULT NULL'],
      ];
      const added = [];
      for (const [name, definition] of columns) {
        if (await columnExists(q, 'users', name)) continue;
        await q(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
        added.push(name);
      }
      return added.length ? `added: ${added.join(', ')}` : 'already present';
    },
  },
  {
    id: '009_users_google_auth',
    description: 'users: google_id for Google Sign-In, and a nullable password_hash for accounts that have no password',
    async up(q) {
      const done = [];

      // Google's `sub` claim: an opaque, stable, per-account identifier. We key
      // on this rather than on email because a Google account's email address
      // can change while sub never does.
      //
      // processAccountAnonymisation in server.js clears this column along with
      // the other personal fields. It has to: leave it populated and the next
      // sign-in from that Google account links straight back into the
      // anonymised row instead of creating a fresh one. Keep the two in step.
      if (!(await columnExists(q, 'users', 'google_id'))) {
        await q('ALTER TABLE users ADD COLUMN google_id varchar(64) DEFAULT NULL');
        done.push('google_id');
      }

      // UNIQUE so two rows can never claim the same Google account. MySQL
      // exempts NULLs from UNIQUE, so every existing password-only user stays
      // valid without backfilling anything.
      if (!(await indexExists(q, 'users', 'uniq_users_google_id'))) {
        await q('ALTER TABLE users ADD UNIQUE KEY uniq_users_google_id (google_id)');
        done.push('uniq_users_google_id');
      }

      // A Google-only account has no password to hash. Leaving this NOT NULL
      // would force a sentinel value into the column, and a sentinel that
      // argon2.verify() might one day be coaxed into accepting is exactly the
      // kind of thing that turns into an auth bypass. NULL means "no password
      // login for this account", and the login endpoint checks for it.
      const pw = await columnDefinition(q, 'users', 'password_hash');
      if (pw && pw.IS_NULLABLE === 'NO') {
        await q('ALTER TABLE users MODIFY COLUMN password_hash varchar(255) DEFAULT NULL');
        done.push('password_hash nullable');
      }

      return done.length ? `applied: ${done.join(', ')}` : 'already present';
    },
  },

  {
    id: '010_crypto_canary',
    description: 'crypto_canary: one known-plaintext row so the app refuses to boot on the wrong encryption key',
    async up(q) {
      if (await tableExists(q, 'crypto_canary')) return 'already present';

      // The failure this exists to catch: deploy to a fresh machine, generate a
      // fresh DATA_ENCRYPTION_KEYS because none was carried across, and every
      // check passes — the key is present, well-formed, the right length. The
      // app boots, serves errors on every encrypted read, and starts writing
      // new rows under a key that cannot read the old ones. Two key
      // generations get mixed into one table with no clean way back.
      //
      // The row is written on first boot and verified on every boot after.
      // `id` is pinned to 1 so there can only ever be one.
      await q(`CREATE TABLE crypto_canary (
        id tinyint(1) NOT NULL DEFAULT 1,
        key_id varchar(32) NOT NULL,
        envelope varchar(512) NOT NULL,
        created_at timestamp NOT NULL DEFAULT current_timestamp(),
        PRIMARY KEY (id)
      )`);
      return 'table created';
    },
  },

  {
    id: '011_payfast',
    description: 'PayFast: per-user merchant credentials, invoice pay tokens, and gateway columns on payments',
    async up(q) {
      const done = [];

      // ── users: the seller's own PayFast account ───────────────────────────
      //
      // Per-user, not global: every FreeVoices user is a separate South African
      // business collecting into their own PayFast account.
      //
      // varchar(512) because these three are stored encrypted (see
      // encrypted-fields.js) and an AES-GCM envelope of a short secret is
      // roughly 130 characters of base64url plus the `fv1.<keyId>$` prefix.
      // They stay *character* columns on purpose: the envelope is pure ASCII,
      // so it is byte-identical in latin1 and utf8mb4, and VARBINARY would make
      // mysql2 hand back a Buffer — turning a missed decrypt into
      // `{"type":"Buffer",...}` instead of a recognisable `fv1.1$...`.
      const userColumns = [
        ['payfast_merchant_id', 'varchar(512) DEFAULT NULL'],
        ['payfast_merchant_key', 'varchar(512) DEFAULT NULL'],
        ['payfast_passphrase', 'varchar(512) DEFAULT NULL'],
        ['payfast_enabled', 'tinyint(1) NOT NULL DEFAULT 0'],
        // Added now because it is free now and an ALTER later; v1 drives
        // sandbox/live from the server-wide PAYFAST_MODE env var and leaves
        // this unexposed. PayFast's sandbox only accepts its own shared
        // credentials, so a per-user test mode proves nothing about a user's
        // real account.
        ['payfast_mode', "varchar(10) NOT NULL DEFAULT 'LIVE'"],
      ];
      for (const [name, definition] of userColumns) {
        if (await columnExists(q, 'users', name)) continue;
        await q(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
        done.push(`users.${name}`);
      }

      // ── documents: the payment link token ─────────────────────────────────
      //
      // Deliberately NOT share_token. POST /api/invoices/:id/share *rotates*
      // that token on every call, so reusing it would kill every pay link
      // already sitting in a customer's inbox the moment the seller clicks
      // "Share" again.
      //
      // No expiry column either: the gate is invoice status, not time. An
      // unpaid invoice should stay payable, and a link that expires mid
      // collection is a support ticket.
      if (!(await columnExists(q, 'documents', 'pay_token'))) {
        await q('ALTER TABLE documents ADD COLUMN pay_token varchar(64) DEFAULT NULL');
        done.push('documents.pay_token');
      }
      if (!(await indexExists(q, 'documents', 'uniq_documents_pay_token'))) {
        await q('ALTER TABLE documents ADD UNIQUE KEY uniq_documents_pay_token (pay_token)');
        done.push('uniq_documents_pay_token');
      }

      // ── payments: gateway provenance ──────────────────────────────────────
      //
      // payment_method already has 'PAYFAST' in its enum, so no enum ALTER.
      //
      // provider_payment_id holds PayFast's pf_payment_id and is PLAINTEXT on
      // purpose. transaction_reference is slated for encryption by the POPIA
      // work, and encryption uses a random IV — the same pf_payment_id would
      // encrypt differently every time and a unique index on it would never
      // fire. Since PayFast re-sends notifications until it gets a 200, losing
      // de-duplication means double-recording real payments.
      const paymentColumns = [
        ['provider', "varchar(20) DEFAULT NULL"],
        ['provider_payment_id', 'varchar(64) DEFAULT NULL'],
        ['status', 'varchar(20) DEFAULT NULL'],
        ['fee_amount', 'decimal(15,2) DEFAULT NULL'],
        ['net_amount', 'decimal(15,2) DEFAULT NULL'],
        ['raw_payload', 'text DEFAULT NULL'],
      ];
      for (const [name, definition] of paymentColumns) {
        if (await columnExists(q, 'payments', name)) continue;
        await q(`ALTER TABLE payments ADD COLUMN ${name} ${definition}`);
        done.push(`payments.${name}`);
      }

      // MySQL exempts NULLs from UNIQUE, so every existing manually-recorded
      // payment (provider IS NULL) stays valid and manual payments can never
      // collide with each other — only two notifications for the same PayFast
      // transaction can.
      if (!(await indexExists(q, 'payments', 'uniq_payments_provider_ref'))) {
        await q('ALTER TABLE payments ADD UNIQUE KEY uniq_payments_provider_ref (provider, provider_payment_id)');
        done.push('uniq_payments_provider_ref');
      }

      return done.length ? `applied: ${done.join(', ')}` : 'already present';
    },
  },

  {
    id: '012_widen_for_encryption',
    description: 'Widen the columns POPIA phase 6 encrypts, so an AES-GCM envelope fits where the plaintext used to',
    async up(q) {
      // An envelope is roughly 1.34 x plaintext BYTES + 44, so every column
      // holding a value we are about to encrypt has to grow before the backfill
      // runs. Skip this and MySQL truncates the ciphertext on write — the value
      // is then unrecoverable, and outside strict mode it happens silently.
      //
      // These stay CHARACTER columns in latin1 on purpose. base64url plus the
      // `fv1.<keyId>$` prefix is pure ASCII, so it is byte-identical in latin1
      // and utf8mb4 and the charset stops mattering. VARBINARY would make
      // mysql2 hand back Buffers, turning a missed decrypt into
      // `{"type":"Buffer",...}` rather than a recognisable `fv1.1$...`.
      //
      // Do NOT convert them to CHARACTER SET ascii — that would destroy every
      // accented character in the addresses already stored.
      const TARGETS = [
        // varchar(<=255) keeps InnoDB's one-byte length prefix, so these can be
        // done in place without rebuilding the table or blocking writes.
        ['users', 'bank_account_number', 'varchar(255)'],
        ['users', 'bank_branch_code', 'varchar(255)'],
        ['users', 'bank_account_type', 'varchar(255)'],
        ['users', 'vat_number', 'varchar(255)'],
        ['users', 'company_registration', 'varchar(255)'],
        ['users', 'phone', 'varchar(255)'],
        ['customers', 'phone', 'varchar(255)'],
        ['customers', 'vat_number', 'varchar(255)'],
        ['document_tracking', 'ip_address', 'varchar(255)'],
        // Crossing 255 bytes moves the length prefix to two bytes, and
        // TEXT -> MEDIUMTEXT changes the storage class. Both rebuild the table
        // and reject an ALGORITHM=INPLACE hint, so they must not carry one.
        ['payments', 'transaction_reference', 'varchar(512)'],
        ['users', 'address', 'mediumtext'],
        ['customers', 'billing_address', 'mediumtext'],
        ['customers', 'shipping_address', 'mediumtext'],
        ['customers', 'notes', 'mediumtext'],
        // Widened and registered, but deliberately excluded from the backfill —
        // see scripts/encrypt-backfill.js. No code reads this column, and on a
        // mature database it is the largest in the schema.
        ['document_tracking', 'user_agent', 'mediumtext'],
      ];

      const widened = [];
      for (const [table, column, targetType] of TARGETS) {
        const rows = await q(
          `SELECT COLUMN_TYPE, IS_NULLABLE
             FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
          [table, column]
        );
        if (rows.length === 0) continue;                                  // not in this schema
        if (rows[0].COLUMN_TYPE.toLowerCase() === targetType) continue;   // already widened

        // Every one of these is nullable with no meaningful default today, and
        // MODIFY silently drops whatever it does not restate. Rather than carry
        // logic to rebuild a definition we do not have, refuse — a migration
        // that stops is far cheaper than one that quietly makes a NOT NULL
        // column nullable.
        if (rows[0].IS_NULLABLE === 'NO') {
          throw new Error(
            `${table}.${column} is NOT NULL, which this migration was written assuming it is not. ` +
            'Restate its full definition here before widening it.'
          );
        }

        const inPlace = /^varchar\(\d+\)$/.test(targetType)
          && parseInt(targetType.match(/\d+/)[0], 10) <= 255;
        const hint = inPlace ? ', ALGORITHM=INPLACE, LOCK=NONE' : '';

        await q(`ALTER TABLE ${table} MODIFY COLUMN ${column} ${targetType} NULL${hint}`);
        widened.push(`${table}.${column}`);
      }

      return widened.length ? `widened: ${widened.join(', ')}` : 'already widened';
    },
  },

  {
    id: '013_quote_conversion_and_part_payments',
    description: 'Link converted invoices to their quote, add the CONVERTED quote status, and PAYMENT/CONVERTED history events',
    async up(q) {
      const done = [];

      // ── documents.source_quote_id ─────────────────────────────────────────
      //
      // Converting a quote used to leave no trace on the invoice, so the only
      // guard against converting it twice was the user's memory. The link is
      // what lets the convert route refuse a duplicate and the two detail
      // pages point at each other.
      if (!(await columnExists(q, 'documents', 'source_quote_id'))) {
        await q('ALTER TABLE documents ADD COLUMN source_quote_id bigint(20) DEFAULT NULL');
        done.push('documents.source_quote_id');
      }
      if (!(await indexExists(q, 'documents', 'idx_documents_source_quote'))) {
        await q('ALTER TABLE documents ADD KEY idx_documents_source_quote (source_quote_id)');
        done.push('idx_documents_source_quote');
      }
      // SET NULL rather than CASCADE: deleting a quote must never take an
      // issued invoice with it.
      if (await setForeignKeyDeleteRule(q, 'documents', 'source_quote_id', 'documents', 'id', 'SET NULL')) {
        done.push('fk documents.source_quote_id');
      }

      // ── documents.status: CONVERTED ───────────────────────────────────────
      //
      // Conversion used to set the quote to SENT, which claimed it had been
      // sent when nothing was. MODIFY drops whatever it does not restate, so
      // NOT NULL and the default are spelled out again.
      const status = await columnDefinition(q, 'documents', 'status');
      if (!status) throw new Error('documents.status not found');
      if (!status.COLUMN_TYPE.includes("'CONVERTED'")) {
        await q(
          `ALTER TABLE documents
             MODIFY status enum('DRAFT','SENT','PAID','OVERDUE','CANCELLED','CONVERTED') NOT NULL DEFAULT 'DRAFT'`
        );
        done.push("documents.status +'CONVERTED'");
      }

      // ── document_tracking.event_type: PAYMENT, CONVERTED ──────────────────
      //
      // PAYMENT is a part payment that leaves a balance; PAID stays reserved
      // for the payment that settles the invoice.
      const event = await columnDefinition(q, 'document_tracking', 'event_type');
      if (!event) throw new Error('document_tracking.event_type not found');
      if (!event.COLUMN_TYPE.includes("'PAYMENT'") || !event.COLUMN_TYPE.includes("'CONVERTED'")) {
        await q(
          `ALTER TABLE document_tracking
             MODIFY event_type enum('CREATED','SENT','VIEWED','DOWNLOADED','PAID','CANCELLED','OVERDUE','PAYMENT','CONVERTED') NOT NULL`
        );
        done.push("document_tracking.event_type +'PAYMENT','CONVERTED'");
      }

      return done.length ? `applied: ${done.join(', ')}` : 'already present';
    },
  },
  {
    id: '014_document_pricing_and_snapshots',
    description: 'Preserve per-line VAT pricing mode and encrypted issued-document party snapshots',
    async up(q) {
      if (!(await columnExists(q, 'document_items', 'vat_inclusive'))) {
        await q('ALTER TABLE document_items ADD COLUMN vat_inclusive TINYINT(1) NOT NULL DEFAULT 0 AFTER vat_rate');
      }
      await q(`CREATE TABLE IF NOT EXISTS document_snapshots (
        document_id bigint(20) NOT NULL PRIMARY KEY,
        payload longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL,
        created_at timestamp NOT NULL DEFAULT current_timestamp(),
        CONSTRAINT fk_document_snapshots_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      ) ENGINE=InnoDB`);
      // Old party versions cannot be reconstructed. Preserve the current known
      // details explicitly as a migration baseline, never label them original.
      const { captureDocumentSnapshot } = require('./document-snapshot.service');
      let count = 0;
      while (true) {
        const rows = await q(`SELECT d.id FROM documents d LEFT JOIN document_snapshots s ON s.document_id = d.id
          WHERE s.document_id IS NULL AND (d.status <> 'DRAFT' OR EXISTS
            (SELECT 1 FROM payments p WHERE p.document_id = d.id)) ORDER BY d.id LIMIT 100`);
        if (!rows.length) break;
        for (const row of rows) {
          await captureDocumentSnapshot(q, row.id, 'migration_baseline');
          count++;
        }
      }
      return `pricing mode added; ${count} issued document baselines captured`;
    },
  },
  {
    id: '015_reliable_billing_workflows',
    description: 'Pending email changes, delivery outbox, stable share links, recurring occurrences and request deduplication',
    async up(q) {
      for (const [name, definition] of [
        ['pending_email', 'varchar(255) DEFAULT NULL'],
        ['pending_email_token', 'varchar(64) DEFAULT NULL'],
        ['pending_email_expires', 'datetime DEFAULT NULL'],
      ]) {
        if (!(await columnExists(q, 'users', name))) await q(`ALTER TABLE users ADD COLUMN ${name} ${definition}`);
      }
      for (const [name, definition] of [
        ['delivery_status', "enum('UNKNOWN','NOT_SENT','QUEUED','SENDING','ACCEPTED','FAILED','UNCERTAIN') NOT NULL DEFAULT 'UNKNOWN'"],
        ['delivery_error', 'varchar(500) DEFAULT NULL'],
        ['request_key', 'varchar(100) DEFAULT NULL'],
        ['request_hash', 'char(64) DEFAULT NULL'],
        ['recurrence_anchor_date', 'date DEFAULT NULL'],
        ['source_recurring_id', 'bigint(20) DEFAULT NULL'],
        ['recurrence_occurrence_date', 'date DEFAULT NULL'],
      ]) {
        if (!(await columnExists(q, 'documents', name))) await q(`ALTER TABLE documents ADD COLUMN ${name} ${definition}`);
      }
      if (!(await indexExists(q, 'documents', 'uniq_document_request'))) {
        await q('ALTER TABLE documents ADD UNIQUE KEY uniq_document_request (user_id, type, request_key)');
      }
      if (!(await indexExists(q, 'documents', 'uniq_recurring_occurrence'))) {
        await q('ALTER TABLE documents ADD UNIQUE KEY uniq_recurring_occurrence (source_recurring_id, recurrence_occurrence_date)');
      }
      await setForeignKeyDeleteRule(q, 'documents', 'source_recurring_id', 'documents', 'id', 'SET NULL');
      await q('UPDATE documents SET recurrence_anchor_date=issue_date WHERE is_recurring=1 AND recurrence_anchor_date IS NULL');
      await q(`CREATE TABLE IF NOT EXISTS document_share_links (
        document_id bigint(20) NOT NULL PRIMARY KEY,
        payload longtext CHARACTER SET utf8mb4 NOT NULL,
        CONSTRAINT fk_document_share_link FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
      ) ENGINE=InnoDB`);
      await q(`CREATE TABLE IF NOT EXISTS email_outbox (
        id bigint(20) NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id bigint(20) NOT NULL,
        document_id bigint(20) DEFAULT NULL,
        kind varchar(30) NOT NULL,
        dedupe_key varchar(120) NOT NULL,
        payload longtext CHARACTER SET utf8mb4 NOT NULL,
        status enum('QUEUED','SENDING','ACCEPTED','FAILED','UNCERTAIN') NOT NULL DEFAULT 'QUEUED',
        attempts int NOT NULL DEFAULT 0,
        next_attempt_at datetime NOT NULL DEFAULT current_timestamp(),
        lease_until datetime DEFAULT NULL,
        last_error varchar(500) DEFAULT NULL,
        accepted_at datetime DEFAULT NULL,
        created_at timestamp NOT NULL DEFAULT current_timestamp(),
        UNIQUE KEY uniq_email_request (user_id, dedupe_key),
        KEY idx_email_due (status, next_attempt_at),
        CONSTRAINT fk_outbox_document FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
        CONSTRAINT fk_outbox_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB`);
      return 'workflow fields, stable links and encrypted outbox created';
    },
  },
  {
    id:'016_outbox_suppression',
    description:'Suppress queued messages for closed accounts and settled reminders',
    async up(q) {
      await q("ALTER TABLE email_outbox MODIFY status ENUM('QUEUED','SENDING','ACCEPTED','FAILED','UNCERTAIN','CANCELLED') NOT NULL DEFAULT 'QUEUED'");
      return 'outbox cancellation available';
    },
  },
  {
    id:'017_document_commercial_fields',
    description:'Units, line discounts and customer purchase-order/delivery references',
    async up(q) {
      for (const [column,definition] of [
        ['purchase_order_ref','varchar(100) DEFAULT NULL'],
        ['delivery_details','text DEFAULT NULL'],
      ]) if (!(await columnExists(q,'documents',column))) await q(`ALTER TABLE documents ADD COLUMN ${column} ${definition}`);
      for (const [column,definition] of [
        ['unit_label',"varchar(20) NOT NULL DEFAULT 'each'"],
        ['discount_percent','decimal(5,2) NOT NULL DEFAULT 0.00'],
      ]) if (!(await columnExists(q,'document_items',column))) await q(`ALTER TABLE document_items ADD COLUMN ${column} ${definition}`);
      return 'document commercial fields available';
    },
  },
  {
    id:'018_quote_decisions',
    description:'Recorded customer quote acceptance and decline',
    async up(q) {
      const status = await columnDefinition(q, 'documents', 'status');
      if (!status.COLUMN_TYPE.includes("'ACCEPTED'") || !status.COLUMN_TYPE.includes("'DECLINED'")) {
        await q("ALTER TABLE documents MODIFY status ENUM('DRAFT','SENT','PAID','OVERDUE','CANCELLED','CONVERTED','ACCEPTED','DECLINED') NOT NULL DEFAULT 'DRAFT'");
      }
      const event = await columnDefinition(q, 'document_tracking', 'event_type');
      if (!event.COLUMN_TYPE.includes("'ACCEPTED'") || !event.COLUMN_TYPE.includes("'DECLINED'")) {
        await q("ALTER TABLE document_tracking MODIFY event_type ENUM('CREATED','SENT','VIEWED','DOWNLOADED','PAID','CANCELLED','OVERDUE','PAYMENT','CONVERTED','ACCEPTED','DECLINED') NOT NULL");
      }
      return 'quote decision statuses and tracking available';
    },
  },
  {
    id:'019_catalogue_import_batches',
    description:'Idempotent customer and product CSV import batches',
    async up(q) {
      if (!(await tableExists(q,'catalogue_import_batches'))) await q(`CREATE TABLE catalogue_import_batches (
        id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id bigint NOT NULL,
        kind enum('customers','products') NOT NULL,
        content_hash char(64) NOT NULL,
        created_count int NOT NULL,
        created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_catalogue_import(user_id,kind,content_hash),
        CONSTRAINT fk_catalogue_import_owner FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      return 'catalogue import batches available';
    },
  },
  {
    id:'020_bank_import_rows',
    description:'Reviewable bank statement rows and payment matches',
    async up(q) {
      if (!(await tableExists(q,'bank_import_rows'))) await q(`CREATE TABLE bank_import_rows (
        id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id bigint NOT NULL,
        currency_id bigint NOT NULL,
        transaction_date date NOT NULL,
        amount decimal(15,2) NOT NULL,
        description text DEFAULT NULL,
        reference text DEFAULT NULL,
        account_label text DEFAULT NULL,
        source_hash char(64) NOT NULL,
        status enum('PENDING','MATCHED','IGNORED') NOT NULL DEFAULT 'PENDING',
        invoice_id bigint DEFAULT NULL,
        payment_id bigint DEFAULT NULL,
        decided_at timestamp NULL DEFAULT NULL,
        created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_bank_import_row(user_id,source_hash),
        KEY idx_bank_import_status(user_id,status,transaction_date),
        CONSTRAINT fk_bank_import_owner FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
        CONSTRAINT fk_bank_import_currency FOREIGN KEY(currency_id) REFERENCES currencies(id),
        CONSTRAINT fk_bank_import_invoice FOREIGN KEY(invoice_id) REFERENCES documents(id) ON DELETE SET NULL,
        CONSTRAINT fk_bank_import_payment FOREIGN KEY(payment_id) REFERENCES payments(id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      return 'bank import review rows available';
    },
  },
  {
    id:'021_invoice_adjustments',
    description:'Immutable invoice credit notes and payment refunds',
    async up(q) {
      const status=await columnDefinition(q,'documents','status');
      if (!status.COLUMN_TYPE.includes("'CREDITED'")) await q("ALTER TABLE documents MODIFY status ENUM('DRAFT','SENT','PAID','OVERDUE','CANCELLED','CONVERTED','ACCEPTED','DECLINED','CREDITED') NOT NULL DEFAULT 'DRAFT'");
      const event=await columnDefinition(q,'document_tracking','event_type');
      if (!event.COLUMN_TYPE.includes("'CREDIT_NOTE'") || !event.COLUMN_TYPE.includes("'REFUND'")) await q("ALTER TABLE document_tracking MODIFY event_type ENUM('CREATED','SENT','VIEWED','DOWNLOADED','PAID','CANCELLED','OVERDUE','PAYMENT','CONVERTED','ACCEPTED','DECLINED','CREDIT_NOTE','REFUND') NOT NULL");
      if (!(await tableExists(q,'credit_notes'))) await q(`CREATE TABLE credit_notes (
        id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id bigint NOT NULL,
        invoice_id bigint NOT NULL,
        request_key char(36) NOT NULL,
        document_number varchar(40) DEFAULT NULL,
        issue_date date NOT NULL,
        reason varchar(500) NOT NULL,
        description varchar(1000) NOT NULL,
        subtotal decimal(15,2) NOT NULL,
        vat_amount decimal(15,2) NOT NULL,
        total decimal(15,2) NOT NULL,
        created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_credit_note_number(document_number),
        UNIQUE KEY uq_credit_request(user_id,request_key),
        KEY idx_credit_invoice(invoice_id,issue_date),
        CONSTRAINT fk_credit_owner FOREIGN KEY(user_id) REFERENCES users(id),
        CONSTRAINT fk_credit_invoice FOREIGN KEY(invoice_id) REFERENCES documents(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      if (!(await tableExists(q,'payment_refunds'))) await q(`CREATE TABLE payment_refunds (
        id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
        user_id bigint NOT NULL,
        invoice_id bigint NOT NULL,
        payment_id bigint NOT NULL,
        request_key char(36) NOT NULL,
        amount decimal(15,2) NOT NULL,
        refund_date date NOT NULL,
        method varchar(40) NOT NULL,
        reference text DEFAULT NULL,
        reason varchar(500) NOT NULL,
        created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_refund_invoice(invoice_id,refund_date),
        UNIQUE KEY uq_refund_request(user_id,request_key),
        CONSTRAINT fk_refund_owner FOREIGN KEY(user_id) REFERENCES users(id),
        CONSTRAINT fk_refund_invoice FOREIGN KEY(invoice_id) REFERENCES documents(id),
        CONSTRAINT fk_refund_payment FOREIGN KEY(payment_id) REFERENCES payments(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      return 'credit notes and refunds available';
    },
  },
  {
    id:'022_bookkeeper_access',
    description:'Explicit read-only bookkeeper access to an owner business',
    async up(q) {
      if (!(await tableExists(q,'business_bookkeepers'))) await q(`CREATE TABLE business_bookkeepers (
        id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
        owner_id bigint NOT NULL,
        member_id bigint NOT NULL,
        granted_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        revoked_at timestamp NULL DEFAULT NULL,
        UNIQUE KEY uq_bookkeeper_member(member_id),
        KEY idx_bookkeeper_owner(owner_id,revoked_at),
        CONSTRAINT fk_bookkeeper_owner FOREIGN KEY(owner_id) REFERENCES users(id),
        CONSTRAINT fk_bookkeeper_member FOREIGN KEY(member_id) REFERENCES users(id),
        CONSTRAINT chk_bookkeeper_distinct CHECK (owner_id<>member_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      if (!(await tableExists(q,'business_access_events'))) await q(`CREATE TABLE business_access_events (
        id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
        owner_id bigint NOT NULL,
        member_id bigint NOT NULL,
        actor_id bigint NOT NULL,
        action enum('GRANTED','REVOKED') NOT NULL,
        created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
        KEY idx_business_access_events(owner_id,created_at),
        CONSTRAINT fk_access_event_owner FOREIGN KEY(owner_id) REFERENCES users(id),
        CONSTRAINT fk_access_event_member FOREIGN KEY(member_id) REFERENCES users(id),
        CONSTRAINT fk_access_event_actor FOREIGN KEY(actor_id) REFERENCES users(id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
      return 'bookkeeper access available';
    },
  },
];

// ─── Runner ───────────────────────────────────────────────────────────────────

async function ensureLedger(q) {
  await q(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id varchar(120) NOT NULL,
      description varchar(255) DEFAULT NULL,
      result varchar(255) DEFAULT NULL,
      applied_at timestamp NOT NULL DEFAULT current_timestamp(),
      PRIMARY KEY (id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

/**
 * Run every pending migration. Throws on the first failure — callers must let
 * that propagate rather than booting a server against a half-migrated schema.
 */
async function runMigrations({ dryRun = false } = {}) {
  const conn = await getConnection();
  const q = (sql, params) => queryOn(conn, sql, params);
  let locked = false;

  try {
    // GET_LOCK is connection-scoped, which is exactly why the whole run stays
    // on this one checked-out connection instead of going through the pool.
    const lock = await q('SELECT GET_LOCK(?, ?) AS ok', [LOCK_NAME, LOCK_TIMEOUT_SECONDS]);
    if (lock[0].ok !== 1) {
      throw new Error(`Could not acquire migration lock '${LOCK_NAME}' within ${LOCK_TIMEOUT_SECONDS}s — another instance is migrating`);
    }
    locked = true;

    // A dry run must not write anything at all, including the ledger table —
    // it exists so you can inspect a production database safely.
    let applied = new Set();
    if (dryRun) {
      if (await tableExists(q, 'schema_migrations')) {
        const rows = await q('SELECT id FROM schema_migrations');
        applied = new Set(rows.map(r => r.id));
      }
    } else {
      await ensureLedger(q);
      const rows = await q('SELECT id FROM schema_migrations');
      applied = new Set(rows.map(r => r.id));
    }

    const pending = MIGRATIONS.filter(m => !applied.has(m.id));
    if (pending.length === 0) {
      logger.info('Migrations: schema up to date', { total: MIGRATIONS.length });
      return { applied: [], pending: [] };
    }

    if (dryRun) {
      logger.info('Migrations: pending (dry run, nothing applied)', { pending: pending.map(m => m.id) });
      return { applied: [], pending: pending.map(m => m.id) };
    }

    const done = [];
    for (const migration of pending) {
      logger.info(`Migration ${migration.id}: running — ${migration.description}`);
      const result = await migration.up(q);
      // DDL implicitly commits, so the ledger write cannot share a transaction
      // with the migration. If the process dies in between, the guards inside
      // up() make the retry a no-op.
      await q(
        'INSERT INTO schema_migrations (id, description, result) VALUES (?, ?, ?)',
        [migration.id, migration.description.slice(0, 255), String(result).slice(0, 255)]
      );
      logger.info(`Migration ${migration.id}: done — ${result}`);
      done.push(migration.id);
    }

    return { applied: done, pending: [] };
  } finally {
    if (locked) {
      try { await q('SELECT RELEASE_LOCK(?)', [LOCK_NAME]); } catch (err) {
        logger.error('Failed to release migration lock', err);
      }
    }
    conn.release();
  }
}

module.exports = {
  runMigrations,
  MIGRATIONS,
  // exported for reuse by later migrations and the retention engine
  tableExists,
  columnExists,
  columnDefinition,
  indexExists,
  tableEngine,
  findForeignKey,
  setForeignKeyDeleteRule,
};
