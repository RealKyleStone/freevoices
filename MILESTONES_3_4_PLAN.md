# Milestones 3 and 4 delivery plan

26 October 2026. All implementation stays on `dev`. Milestone 2 is available for external testing; acceptance findings feed into this work.

## Milestone 3: quote to cash

1. **Quote decision.** Give each issued quote a revocable customer link, a branded mobile review page, PDF download, expiry display, and explicit Accept/Decline actions. Record decision time and evidence. Make repeat decisions idempotent; prevent a declined or expired quote from being converted accidentally. Preserve the existing one-live-invoice-per-quote rule.
2. **Settlement documents.** Show deposits and part payments against a remaining balance. Add receipts and credit notes with immutable numbering and links to the original invoice. Define refund handling separately from credit issuance; neither should silently delete payment history.
3. **Collections.** Extend the existing opt-in 1/7/14 day reminder and pause controls with per-invoice delivery history and safe retries. Keep payment status in the portal tied to verified ledger entries and show the last update time. Add copy/share actions initiated by the business user.
4. **Bank reconciliation.** Import a bank CSV into a review queue. Preview rows, detect duplicate imports, suggest matches using amount/date/reference, require a human to confirm, and keep the source row plus match decision in an audit trail. Never mark an invoice paid from a suggestion alone.

Acceptance: a quote can be reviewed and decided once, converted once, invoiced, partially paid and reconciled; balances, receipts, customer view and audit history agree. Automated tests cover ownership, replay, concurrent requests, expiry, wrong-currency and duplicate-bank-row cases. External testers exercise phone and keyboard flows.

## Milestone 4: sustained business use

1. **Reports.** Add visible definitions, date/customer/currency filters, ageing and customer statements. CSV exports must reconcile to the underlying transactions and protect spreadsheet users from formula injection. The first change exports the existing year-to-date VAT summary in its selected currency.
2. **Imports.** Provide customer/product templates, validation previews, row-level errors, duplicate handling and safe retry.
3. **Business access.** Introduce a business boundary and migrate existing owner data deliberately. Add owner/bookkeeper/staff roles and business-scoped audit events before allowing shared access.
4. **Operations.** Add readiness and scheduler/delivery metrics, alerts, repeatable deployment, encrypted off-site backups and tested restore/key recovery. Keep authorization, uploads, sessions and account recovery in regression coverage.
5. **Release evidence.** Document contribution setup and operating costs. Confirm a license with the owner. Test slow connections, phone/tablet layouts, keyboard, zoom, screen readers and exported documents.

Acceptance: reports reconcile across currencies and periods; imports are safely repeatable; role tests prove isolation; restore drill recovers a recent backup with its keys; operators can detect and respond to failed jobs. Real payment, email and OAuth integrations require their own sandbox and production verification.

## Current checkpoint

- Milestone 3: customer quote review links, recorded accept/decline, expiry display, revocation and conversion guards are implemented. Bank CSV rows can be previewed, deduplicated, reviewed and matched by explicit confirmation with a payment audit link. Existing invoice portal, part payments, paid-in-full receipts and opt-in reminders now have configurable reminder days and user-initiated device sharing. Credit notes and refunds still need acceptance.
- Migration 021 stores immutable credit notes and refunds with replay keys, distinguishes outstanding balance from refund due, and renders credit-note PDFs. Per-payment receipts are available for part payments. Integration covers credits, refunds, statements, VAT and cash reports, ownership, concurrency, a fully credited status and the customer portal. Seller forms and routes can be enabled locally with `NODE_ENV=development` and `INVOICE_ADJUSTMENTS_ENABLED=true`; production remains closed. The local demo database has migrations 018–021 and its API readiness check passes. Live seller UI and PDF/tax review remain unverified, so this is **not** release acceptance. The PDF fields follow the [SARS VAT 404 guide, section 13.8.3](https://www.sars.gov.za/wp-content/uploads/Ops/Guides/Legal-Pub-Guide-VAT02-VAT-404-Guide-for-Vendors.pdf); actual tax treatment and wording still need review by a qualified South African tax practitioner.
- Milestone 4: VAT CSV export, a filterable payment transaction ledger, customer statement and ageing view, customer/product CSV imports, live/ready checks, private operations metrics, encrypted backup output and a local restore drill are implemented. Business membership/roles, production off-site backup and monitoring setup, and release accessibility checks remain pending. See [OPERATIONS.md](OPERATIONS.md).
- The repository owner's license decision is **TBD**. Do not present the repository as licensed open source until the owner decides and adds the actual license text.
- This is **not** the combined Milestones 1–4 testing handoff. It remains a working plan until every roadmap item and regression gate is complete. The [testing matrix](MILESTONES_1_4_TEST_MATRIX.md) records the current feature gates and local evidence at `4d49fb2`.
