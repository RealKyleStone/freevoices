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
