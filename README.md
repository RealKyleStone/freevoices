# FreeVoices local development

Application code is in `freevoices/`. Use the `dev` branch for all development.

## Running on this workstation

The local setup uses an isolated MariaDB database, an Express API, and Angular's development server:

- App: http://localhost:4200
- API: http://localhost:3000/api
- Demo login: `demo@freevoices.test` / `LocalDemo2026!`
- Demo data: one customer, one product, two draft invoices, and a converted quote.

The demo credentials are only for this local database. Database credentials and the generated field-encryption key are in the ignored `freevoices/.env`. Keep that file with the database: replacing the encryption key makes encrypted records unreadable.

The portable MariaDB installation and data are outside this repository at `H:\Workspace\.local\freevoices`. It runs as a background process bound to `127.0.0.1`, without installing a Windows service. To restart it in PowerShell:

```powershell
Start-Process -FilePath 'H:\Workspace\.local\freevoices\mariadb-11.4.13-winx64\bin\mariadbd.exe' -ArgumentList '--defaults-file=H:\Workspace\.local\freevoices\data\my.ini','--bind-address=127.0.0.1','--console' -WindowStyle Hidden
```

Start the API and frontend in separate terminals, from `H:\Workspace\freevoices\freevoices`:

```powershell
npm.cmd run serve:api
```

```powershell
npm.cmd start -- --host 127.0.0.1
```

Skip startup commands for processes already running. Initial background process logs are under `H:\Workspace\.local\freevoices` (`db.*.log`, `api.*.log`, `web.*.log`). API application logs also appear in the ignored app-root log files.

Email is configured to localhost port 1025, but no SMTP server is running. Google sign-in is disabled locally, CAPTCHA is bypassed for development, and PayFast is configured for sandbox use with no merchant credentials. Use password login for evaluation. Email delivery and gateway payment flows need separate local integration setup.

Migration 014 adds encrypted issued-party snapshots and explicit per-line VAT-inclusive pricing. Run `npm.cmd run migrate` before starting an updated API. Issuing, sharing, or recording a first payment preserves that document's buyer/seller details and logo. Older issued documents receive a baseline from their current details; earlier overwritten versions cannot be recovered. The existing encryption key remains necessary to read both personal fields and the snapshots.

Migrations 015 and 016 add idempotent creation, pending email verification, stable share-link recovery, recurring occurrence markers and the encrypted email outbox. Run migrations before the updated API. Keep the same encryption key for outbox messages and saved links.

Invoice status `SENT` is displayed as **Issued**: it freezes the invoice, independently of email delivery. The delivery indicator and email history show queued, failed, uncertain or accepted-by-provider attempts. Known failures retry every 15 minutes, up to five automatic attempts; uncertain attempts need provider review before an explicit resend. Local SMTP is normally unavailable, so local invoice emails stay queued/failed unless a test server is running.

Recurring jobs run hourly and recover on API startup. The email queue and notification processor run each minute. Customer payment reminders are off by default; enable them in Notifications to send at 1/7/14 overdue days. Invoice mute stops reminders. Current share links keep their original 30-day expiry; use Replace link to invalidate one or Revoke link to disable it.

## Setting up another machine

1. Clone the repository with `git clone --branch dev https://github.com/RealKyleStone/freevoices.git`.
2. In the inner `freevoices/` directory, run `npm.cmd ci` on Windows (`npm ci` elsewhere). The current checkout was tested with Node 24.15.0 and npm 11.12.1.
3. Create a local MySQL/MariaDB database and a dedicated user with access to that database. Import `database/schema.sql` into the empty database before migrations.
4. Copy `.env.example` to `.env`. Set the local database credentials, `NODE_ENV=development`, `APP_URL=http://localhost:4200`, and `PAYFAST_MODE=sandbox`. Configure SMTP or expect email delivery to fail. Leave Google OAuth unset unless using your own development client.
5. Generate the encryption key using the command in `.env.example` and set `DATA_ENCRYPTION_KEYS` and `DATA_ENCRYPTION_KEY_ACTIVE` as described there.
6. Run `npm.cmd run migrate`. A fresh schema contains no currencies or banks. At minimum, insert a ZAR currency before creating invoices; the API falls back to currency ID 1:

```sql
INSERT INTO currencies (id, code, name, symbol) VALUES (1, 'ZAR', 'South African Rand', 'R');
```

7. Start the API and frontend as above and register a local account. Use fictional data.

## Checks

Run these from the inner application directory:

```powershell
npm.cmd run build -- --configuration development
npm.cmd run test:server
npm.cmd run lint
npm.cmd test -- --watch=false --browsers=ChromeHeadless
```

Chrome must be installed for browser unit tests; set `CHROME_BIN` if needed. See [EVALUATION.md](EVALUATION.md) for the initial results and known failures.

The backend suite includes PDF pagination and client/server pricing regressions. Its numbering and document-history integration tests are opt-in and require the running local API and the same local database configuration. Each creates and cleans up its own synthetic business:

```powershell
$env:FREEVOICES_TEST_API_URL = 'http://localhost:3000/api'
node --test test/document-number.integration.test.js test/document-history.integration.test.js
Remove-Item Env:FREEVOICES_TEST_API_URL
```

Set that variable when running `npm.cmd run test:server` to include the integration test in the full backend suite. Both the API URL and database host must point to localhost; production mode is rejected.

Current validation: 141 backend tests (with `FREEVOICES_TEST_API_URL=http://localhost:3000/api`), 82 headless frontend tests, production build and lint pass. Integration tests create and remove their own synthetic businesses. SMTP protocol tests use an ephemeral local server; real inbox delivery, OAuth, payment-provider transactions and production disaster recovery still need separate validation. See [PRODUCT_REVIEW.md](PRODUCT_REVIEW.md) for current fix status and remaining product work.

The logical backup script now uses one consistent transaction and SQL-format date/time strings (`format_version: 2`). A local restore drill verified all 21 tables, 268 rows and 21 foreign keys in a disposable database. It is still an unencrypted logical export; production off-site backup scheduling, retention, encryption and separate key recovery need operational setup. Repeated API regression runs can hit the normal authentication rate limits; restart the local API between complete runs rather than disabling those limits.

## Milestone 1 automated checks

All new development stays on `dev`. The workflow in `.github/workflows/dev-checks.yml` checks pushes to `dev` and pull requests targeting `dev`; it does not deploy or merge branches. Its frontend job runs the production build, lint and headless browser tests. Its backend job uses a fresh MariaDB 11.4.13 service and runs every backend test, failing if any test is skipped. No production credentials or repository secrets are needed.

To run the same backend checks locally, first create an **empty disposable database** named `freevoices_test` or `freevoices_test_<suffix>`, with a database user granted access only to that database. From the inner app directory, supply the connection explicitly:

```powershell
$env:DB_HOST = '127.0.0.1'
$env:DB_NAME = 'freevoices_test_local'
$env:DB_USER = 'your_disposable_test_user'
$env:DB_PASSWORD = 'your_test_password'
npm.cmd run test:integration
```

The runner refuses remote hosts, production mode, other database names and any nonempty database. It imports the base schema, seeds ZAR/USD, starts a separate API on a temporary port, applies migrations and uses a freshly generated encryption key. SMTP is forced to localhost; the real SMTP protocol regression creates its own local test server. It stops the API afterwards but never drops the database. Use a new empty database for another run; the temporary key is intentionally not saved. Do not point this command at the demo database.

Run `npm.cmd run test:ci` for browser tests (Chrome required), plus `npm.cmd run build` and `npm.cmd run lint`.

26 October 2026 validation: 141 backend tests pass with zero skips against a fresh migrated database; 82 frontend tests, production build and lint pass locally. The workflow YAML is parsed and its dev-only triggers checked. Milestone 1's CI completion criterion passed on `dev` at commit `37b6d7a`: [GitHub Actions run](https://github.com/RealKyleStone/freevoices/actions/runs/40285572397) confirmed all 141 backend tests with zero skips, 82 frontend tests, the production build and lint.
