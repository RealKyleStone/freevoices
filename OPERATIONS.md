# FreeVoices operations for the Milestone 4 test build

26 October 2026. Deploy and test from `dev`; do not merge into `main` during the combined test round.

## Deploy

1. Install dependencies and run the repository's checks: `npm ci`, `npm run lint`, `npm run test:ci`, `npm run test:navigation`, and `npm run test:integration` against a new disposable database.
2. Back up the target database and its **separate** field encryption key before changing schema. Run `npm run migrate:dry-run`, then `npm run migrate`. Never replace an existing `DATA_ENCRYPTION_KEYS` value with a freshly generated key. Run `npm run encrypt:verify`; backfill older plaintext fields with `npm run encrypt:backfill` and verify again.
3. Review the legal source in `legal/`, run `npm run seed:legal` to publish the approved versions and refresh offline copies, then run `npm run deploy:build` and `npm run doctor`. Ship the generated deployment bundle, environment configuration, and the existing encryption key. Start the API only after migrations succeed. `GET /api/health/live` proves the HTTP process responds; `GET /api/health/ready` also checks database reachability.
4. Smoke test sign-in, invoice and quote views, PDF generation, a revocable portal link, and one sandbox payment. Verify outbound email and PayFast separately with real test accounts.

## Monitoring

Set a random `OPERATIONS_TOKEN` in the server environment. An operator can request `/api/ops/metrics` with the `x-operations-token` header. It returns email outbox counts, due recurring sources, pending bank rows and the current process's last scheduler success/failure times. Without the token the endpoint is absent. Protect the token and do not put it in the browser bundle. Alert on readiness failures, growing failed/uncertain outbox counts, overdue recurring work and stale scheduler timestamps. In a multi-worker deployment, scrape each worker or aggregate its telemetry externally; these timestamps are process-local.

## Backup and recovery

Set a separate 32-byte base64 `BACKUP_ENCRYPTION_KEY`. Run `node scripts/backup-db.js --encrypted` at least daily and copy the `.fvbak` to an access-controlled off-site location. Store the backup key and `DATA_ENCRYPTION_KEYS` separately from the backup. Do not treat the key or off-site copy as optional: the encrypted fields cannot be recovered without the original field key.

Run `npm run backup:retention` to preview encrypted backup files older than 30 days in the dedicated backup directory. After reviewing that directory, run `npm run backup:retention -- --apply`. The command only considers matching `.fvbak` files in that one directory. The operator must schedule the daily backup, off-site copy, retention, and alerting in the hosting environment; this repository cannot configure an unknown host.

For a restore drill, create a **new empty local** database named `freevoices_test_*` with a dedicated user. Set its `DB_*` variables, the original `DATA_ENCRYPTION_KEYS`, and `BACKUP_ENCRYPTION_KEY`, then run `npm run restore:drill -- path/to/backup.fvbak`. The script refuses production, remote hosts and nonempty databases, checks every table's row count and verifies the encryption canary. The latest local drill on 26 October restored 28 tables and 371 rows to a disposable database; the database and backup file were removed afterward. Repeat this on a recent full backup before relying on the procedure in production.

## Release decisions

The repository owner's software license choice is TBD. Do not claim FreeVoices is licensed open source until the owner adds the chosen license. External testers must use synthetic customer and bank data. Production email, OAuth, PayFast, off-site backups and monitoring need separate environment-level proof.
