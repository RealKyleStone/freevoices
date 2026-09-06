/**
 * Retention: erasing personal information once we no longer have a basis to
 * keep it.
 *
 * A module rather than another function in server.js, for the same reason
 * migrations.service.js is one: this is database work with no HTTP in it, and
 * keeping it out here means it can be run and tested without booting a server.
 */

const { executeQuery, withTransaction, logger } = require('./db.service');

/**
 * RFC 2606 reserves .invalid precisely so a placeholder address can never
 * resolve or route anywhere.
 */
const ANONYMISED_EMAIL_DOMAIN = 'anonymised.invalid';

/**
 * Append to security_events. A local copy rather than an import from server.js,
 * which would be a circular dependency — and the HTTP version wants a `req`
 * this caller does not have. Never throws: losing an audit row is bad, failing
 * the erasure it describes is worse.
 */
async function recordSystemEvent(eventType, userId, detail = null) {
  try {
    await executeQuery(
      `INSERT INTO security_events (user_id, event_type, ip_address, user_agent, detail)
       VALUES (?, ?, NULL, NULL, ?)`,
      [userId, eventType, detail ? String(detail).slice(0, 512) : null]
    );
  } catch (err) {
    logger.error('Failed to record system security event', { eventType, message: err.message });
  }
}

/**
 * Erase the personal information of every account whose grace period has run
 * out, and mark it ANONYMISED.
 *
 * This is the second half of /api/account/close. Closure sets `anonymise_after`
 * and opens a DELETION request; this finishes it. Everything the app already
 * assumes about ANONYMISED — the login guard, the export, the reactivation
 * refusal — was written against a state nothing actually produced until now.
 *
 * What it deliberately leaves alone:
 *
 *   documents and document_items — issued invoices carry a 7-year statutory
 *     retention, which is the whole reason closure anonymises instead of
 *     deleting. Erasing them to honour one obligation would breach another.
 *   customers — those documents point at them. A financial record whose
 *     counterparty has been blanked is no longer the record we are required
 *     to keep.
 *   security_events — the audit trail of what happened to this account,
 *     including its closure and this erasure. Whether the IP addresses in it
 *     should also be cleared is a controller's decision about the audit
 *     trail's own retention, not one to make silently in a cron job.
 *
 * Safe to run concurrently and repeatedly: under PM2 every worker schedules
 * this, so two can reach the same row at once. The `status = 'CLOSED'` guard on
 * the UPDATE means the loser changes nothing and skips the follow-up writes.
 *
 * @returns {Promise<{ due: number, anonymised: number, failed: number }>}
 */
async function anonymiseExpiredAccounts() {
  logger.info('Account anonymisation: starting');
  const summary = { due: 0, anonymised: 0, failed: 0 };

  const due = await executeQuery(
    `SELECT id FROM users
      WHERE status = 'CLOSED'
        AND anonymise_after IS NOT NULL
        AND anonymise_after <= NOW()`
  );
  summary.due = due.length;
  logger.info(`Account anonymisation: ${due.length} account(s) due`);

  for (const { id } of due) {
    try {
      const didAnonymise = await withTransaction(async (q) => {
        // email is NOT NULL and UNIQUE, so it cannot just be nulled — it
        // becomes a per-id placeholder that can never route anywhere.
        //
        // google_id has to go with the rest. Leave it populated and the next
        // sign-in from that Google account links straight back into this row,
        // handing whoever holds it an anonymised account with someone's
        // invoice history still attached.
        const result = await q(
          `UPDATE users SET
             email = ?,
             password_hash = NULL,
             google_id = NULL,
             company_name = NULL,
             company_registration = NULL,
             vat_number = NULL,
             contact_person = NULL,
             phone = NULL,
             address = NULL,
             bank_name = NULL,
             bank_account_number = NULL,
             bank_branch_code = NULL,
             bank_account_type = NULL,
             email_verified = 0,
             email_verification_token = NULL,
             email_verification_expires = NULL,
             failed_login_attempts = 0,
             last_failed_attempt = NULL,
             status = 'ANONYMISED',
             anonymised_at = NOW(),
             anonymise_after = NULL
           WHERE id = ? AND status = 'CLOSED'`,
          [`anonymised-${id}@${ANONYMISED_EMAIL_DOMAIN}`, id]
        );
        if (result.affectedRows === 0) return false;

        // Both are live credentials pointing at someone who no longer exists
        // here. Closure already revoked the sessions; this covers anything
        // created since, and the reset tokens it never touched.
        await q('DELETE FROM sessions WHERE userId = ?', [id]);
        await q('DELETE FROM password_reset_tokens WHERE user_id = ?', [id]);
        return true;
      });

      if (!didAnonymise) {
        logger.info(`Account anonymisation: user #${id} already handled, skipping`);
        continue;
      }

      // Close the loop on the DELETION request closure opened, so the POPIA
      // request log does not show a deletion stuck IN_PROGRESS forever.
      await executeQuery(
        `UPDATE data_subject_requests
            SET status = 'COMPLETED', completed_at = NOW(),
                notes = 'Personal information erased after the grace period'
          WHERE user_id = ? AND request_type = 'DELETION' AND status = 'IN_PROGRESS'`,
        [id]
      );
      await recordSystemEvent('ACCOUNT_ANONYMISED', id);

      summary.anonymised += 1;
      logger.info(`Account anonymisation: anonymised user #${id}`);
    } catch (itemError) {
      // One bad row must not strand every account queued behind it.
      summary.failed += 1;
      logger.error(`Account anonymisation: failed on user #${id}:`, itemError);
    }
  }

  logger.info('Account anonymisation: completed', summary);
  return summary;
}

module.exports = { anonymiseExpiredAccounts, ANONYMISED_EMAIL_DOMAIN };
