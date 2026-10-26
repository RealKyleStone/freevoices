# FreeVoices product review and improvement plan

24 October 2026 · branch `dev` · initial local assessment

## Current status - 26 October 2026

Milestone 1's automated acceptance checks pass. The first Milestone 2 slice (setup checklist and searchable, paginated customer/product pickers) is implemented; the rest of Milestone 2 is planned. The navigation regression pass also fixed a tablet menu breakpoint gap, a mobile footer overlay that stayed open, conflicting authentication router outlets/cached views and a crash when report data was empty. The last published `dev` CI run passed: 142 backend tests, 112 frontend tests, 30 responsive navigation checks, production build and lint. [CI evidence](https://github.com/RealKyleStone/freevoices/actions/runs/40297548410) and the [full regression report](REGRESSION_REPORT.md) give the tested scope and limits. No changes have been merged into `main`.

The next Milestone 2 increment adds a live on-screen invoice review to create/edit: selected customer, dates, lines, VAT mode, totals, notes and terms update as the form changes. It uses the existing client/server-parity calculation helper. The review explicitly distinguishes itself from the final PDF and number. Local checks: 113 frontend tests, 30 responsive navigation checks, production build and lint pass. It has not been exercised in the live editor browser.

An invoice detail now offers **Copy as new draft**. The new builder carries the current customer, currency, terms, notes and line values, dates the draft today, recalculates its due date and starts a fresh request key. It does not carry payment, delivery, share or recurrence state. The user reviews the draft before creating it; the server allocates a new number on creation. Local verification: 114 frontend tests, 30 responsive navigation checks, production build and lint pass. The live editor browser remains unverified.

The historical assessment and reproduced findings below describe the starting state on 24 October. They are retained as evidence, not an open defect list. The implementation notes above each milestone record subsequent fixes. Live editor-browser navigation, real devices and screen readers, production email delivery, Google OAuth, PayFast transactions and production backup/key recovery remain unverified.

## Milestone 2 first slice - 26 October 2026

Implemented the company setup checklist and searchable catalogues on `dev`:

- The dashboard checklist derives progress from saved business identity, VAT defaults, active currency, payment information and invoice defaults. A logo is optional. Zero VAT and immediate terms are valid. It offers links to the existing settings pages, retries loading failures and refreshes on return to the dashboard. It does not block invoicing or certify tax compliance/provider readiness.
- All four invoice/quote create/edit screens now use server-paged customer/product pickers. Opening a builder no longer downloads every catalogue page. Pickers search after a short debounce, cancel stale requests, load more results on demand and retain an existing selection even outside the results.
- Customers and products can be added inside the picker and immediately selected. Required fields are validated; requests in progress cannot be double-submitted; failed saves keep the entered details. Cancelling leaves the document unchanged. A custom line can retain its description and price after clearing its catalogue reference.
- Customer selection applies the customer's payment terms, including zero. Product selection copies its inclusive/exclusive pricing mode while preserving the line's VAT rate.
- Native modal dialogs provide keyboard focus containment, labelled search, selectable results and explicit Close actions. Enter in search cannot accidentally submit the enclosing invoice. Broader mobile and screen-reader usability testing remains pending.
- Customer selection can request a lightweight detail response (`include_documents=false`) instead of downloading the customer's invoice history. Catalogue ordering uses name plus ID so equal names paginate consistently.

At the first-slice checkpoint, local verification passed **142 backend tests with zero skips** and **102 frontend tests**, plus build and lint. The current totals after navigation regressions are recorded in Current status above.

This is the first Milestone 2 slice, not the whole milestone. A live on-screen invoice review and copy-as-new-draft flow have since been added. A rendered PDF preview, discounts/units/references, draft autosave/recovery, richer money/ageing dashboard actions and the full usability pass remain planned.

## Milestone 1 complete - 26 October 2026

New work stays on `dev`; `main` is not merged. The dependable-billing fixes are already in PR_1. This follow-up adds the missing CI workflow and an isolated fresh-database test runner, plus explicit inclusive-VAT reconciliation assertions across issued PDFs, the VAT report, paid-revenue report and dashboard.

| Completion criterion | Evidence/status |
|---|---|
| P0 reproductions, ownership and email-verification safeguards | Backend API regressions run with the full suite |
| Unique concurrent numbers and safe request replay | Concurrent numbering and idempotency regressions |
| Historical issued parties remain stable | Document-history regression after buyer/seller edits and logo deletion |
| Pricing agrees across preview, API, PDF and reports | Actual client helper parity plus issued-inclusive PDF/report/dashboard assertions |
| Email failure visible and safe to retry | Outbox, local SMTP acceptance, duplicate-send and ambiguous-attempt regressions |
| Recurring calendar, restarts and concurrent workers | Anchored monthly/leap-year fixtures, occurrence uniqueness and queue recovery checks |
| Build, backend tests, frontend tests and lint pass in CI | Passed on dev: [GitHub Actions run](https://github.com/RealKyleStone/freevoices/actions/runs/40285572397) |

Local validation: **141 backend tests with zero skips** on a newly imported/migrated database, **82 frontend tests**, production build and lint pass. The test database and its dedicated user used for this workstation run were removed afterwards. The runner itself never drops/replaces database contents. All 16 migrations were exercised from the base schema; ordinary `.env` credentials and the demo database were not used for integration execution.

Milestone 1 automated acceptance criteria passed on GitHub Actions for commit `37b6d7a`: 141 backend tests with zero skips, 82 frontend tests, production build and lint. [Verified run](https://github.com/RealKyleStone/freevoices/actions/runs/40285572397). Production-provider and usability validation described below remains separate work.

## Fix progress

The first implementation pass fixes PDF pagination and concurrent document numbering. The 60-line regression sample now renders as four pages with repeated table headings and page-numbered footers. Pagination is shared by invoices, quotes and receipts, including long descriptions and trailing text sections.

Document numbering is allocated inside the creation transaction, using an existing owner-row lock and a current locking read of the highest sequence. Manual invoices, quotes, conversion and recurring generation share that allocator. The live integration regression covers concurrent creation, mixed creation/conversion, duplicate conversion, old transaction snapshots, rollback and sequence rollover beyond 9999.

The first pass passed all 109 backend tests with the local API integration test enabled and required no schema migration.

The second pass adds migration `014_document_pricing_and_snapshots` and fixes issued-document party preservation and VAT-inclusive pricing:

- Invoice/quote line items now store their pricing mode. Product selection copies it; all four create/edit screens let the user see and change it. R115 including 15% VAT remains R115 total, split into R100 net and R15 VAT. Mode survives editing, conversion, recurring copying, portal access, PDFs and receipts.
- Issuing through send, marked PDF download, sharing, quote conversion, or first payment captures one encrypted buyer/seller snapshot. It includes bank details and logo bytes, so deleting/replacing the live logo does not change archived documents. New drafts continue to use current party records.
- Draft updates recheck state under a database lock, preventing an edit racing issuance from changing an issued document's lines. Share-link creation on a draft is labelled as issuance in the UI.
- Migration 014 freezes the currently known details of older issued/part-paid documents as an explicitly labelled `migration_baseline`. It cannot recover details already overwritten before deployment. Existing amounts and old line pricing modes are not recalculated.
- Account export includes saved party versions. Encryption verification/backfill tooling understands the snapshot table's document primary key. Gateway credentials remain live and are excluded from snapshots and public responses.
- The existing frontend test fixtures and lint findings have been repaired. All 79 frontend tests and lint pass. The backend suite has 120 passing tests with both local API regressions enabled.

The third pass adds migrations `015_reliable_billing_workflows` and `016_outbox_suppression` and fixes the remaining reproduced workflow defects:

- Document creation validates active products and customers against the current business. Part-paid invoices cannot be cancelled; concurrent payment/cancellation is serialised. Invalid payment methods return a validation error.
- Create requests accept a business-scoped idempotency key. Concurrent retries return the same document; changed content under an existing key returns 409. The create screens keep their request key across failed submissions.
- Invoice numbering uses the configured prefix and minimum next number without reusing allocated numbers. Settings show the actual next number. Saved terms, VAT, currency and notes apply to new documents; customer terms override the business default, including zero days. Existing line values survive editing.
- All four builders fetch every catalogue page, making customers/products beyond the first 100 available. This fixes truncation; a server-search picker remains a future scaling improvement.
- Reports filter by an explicit currency and the dashboard uses the business default currency. Invoice, quote and customer document lists show each document's currency code. These are separate currency totals, not currency conversion.
- Invoice and receipt email is rendered into an encrypted persistent outbox. Concurrent workers claim each attempt once, known failures retry up to five automatic attempts, and an interrupted/ambiguous SMTP attempt requires review rather than blind resend. Explicit resending gets a new key. The UI distinguishes an issued invoice from email-provider acceptance and exposes delivery history. Provider acceptance is not proof of inbox delivery; production bounce handling remains future work.
- Recurring generation locks and re-reads each source, records unique scheduled occurrences, catches up missed dates, respects end dates and preserves the original day across short months and leap years. Copy creation and schedule advancement commit together. Auto-send queueing recovers after a restart. Hourly jobs and startup recovery use South African calendar dates.
- Owner notification settings now drive queued alerts. Customer reminders are a separate explicit opt-in, off by default, at 1/7/14 overdue days. Recovery sends the latest due stage. Invoice mute, settlement, cancellation and account closure suppress queued reminders. Reminder timing is currently fixed.
- Copying a valid share link reuses it and its original expiry. Replacing or revoking a link is explicit. Encrypted token recovery does not expose raw links through account export. Legacy links cannot be recovered from their hash; the first request for one creates a replacement.
- Logical backups now read one consistent database snapshot and preserve SQL date/time strings. A local restore drill recreated 21 tables and 268 rows, compared every value, checked 21 foreign keys and removed the temporary database. Production encrypted off-site backups and key recovery still need operational validation.
- Email changes require the current password and retain the existing verified address until the new address is confirmed. Password changes revoke other sessions; reset and email-confirmation flows revoke all sessions. Closure clears pending email changes, share links and pending billing emails.

Validation: **140 backend tests**, including local API/database regressions, an actual local SMTP exchange, concurrent workers, and password/session checks; **82 frontend tests**; production build; lint. All pass locally. Changes are prepared on `dev` for pull request `PR_1`.

Remaining work is primarily product expansion and production validation: full mobile/keyboard/screen-reader journeys, real SMTP delivery and bounce handling, PayFast sandbox end-to-end transactions, Google sign-in, production backup and key-recovery drills, credit notes/refunds/statements, quote acceptance, imports, staff roles, richer report filters and larger-catalogue search. The historical findings below preserve the original evidence and are not the current defect list.

## Product direction

Serve South African small businesses broadly: help an owner quote accurately, issue a professional invoice, collect payment, and hand clear records to their bookkeeper. Product and service businesses should both fit the core workflow.

The existing feature surface is substantial. The immediate opportunity is to make its financial behavior and customer-facing documents dependable, then make daily work fast and easy. Proposed product promise: **professional billing, clear balances, and less time chasing payment**.

## Evidence and limits

This review combines source inspection, authenticated local API exercises with synthetic accounts, and rendered invoice PDF inspection. Your demo account was not used for the destructive scenarios. A separate audit account holds the test invoices and customers; a second synthetic business supports ownership checks. USD was added to the local currency reference data to exercise reporting.

The authenticated browser journey, responsive layouts, keyboard navigation, and assistive-technology behavior still need a visual test pass. The open local app was in an editor browser; this assessment did not automate the editor UI. Actual SMTP delivery, Google OAuth, and live gateway behavior remain unverified. No live email or payment credentials were used.

Machine-readable observations and the long-invoice sample are in `H:\Workspace\.local\freevoices\feature-audit-results.json` and `long-invoice.pdf`. These are local evidence, outside Git. The findings below distinguish reproduced behavior from source inspection and proposed capabilities.

## What existed at the initial review

| Area | Current evidence | Assessment |
|---|---|---|
| Customers and products | API creation and list operations work; list/search/detail/edit pages exist | Useful core; selection and migration workflows need work |
| Invoice builder | API creates documents, calculates line totals, and resolves due dates | Working basic flow; pricing modes and saved defaults need correction |
| Quotes | Creation and conversion work; conversion code locks the quote and rejects a second live conversion | Useful starting point; customer acceptance is missing |
| Payments | Partial payment works; payment above the balance is rejected | Good foundation; refunds, reversals, credits, and reconciliation need design |
| PDFs and receipts | Invoice PDF download succeeds; receipt generation code exists | Long invoice pagination is broken |
| Dashboard and reporting | Dashboard and all four report endpoints respond | Multi-currency figures are misleading; reporting controls are limited |
| Sharing and online payment | Invoice portal, expiring share links, and PayFast implementation exist | Needs full customer journey and integration validation |
| Recurring invoices | Scheduling fields, generation job, and auto-send code exist | Calendar behavior and operational guarantees need correction |
| Company and account settings | Profile, company, branding, invoice, payment, and notification pages exist | Some saved options are disconnected from behavior |
| Data protection foundations | Argon2, session token hashing, field encryption, rate limiting, migration ledger, account lifecycle, export and backup tooling exist | Valuable foundations; complete authorization and recovery testing is still required |
| Automated checks | 93 backend tests pass | Frontend tests do not compile; lint has five errors and one warning; route-level regression coverage needs expansion |

## Initial priority findings (historical)

P0 means a release blocker for the affected workflow. P1 means the next reliability or usability milestone. These priorities are product judgments based on the evidence, not a completed security or compliance certification.

| Priority | Finding and evidence | Required behavior |
|---|---|---|
| P0 | **Long PDF pagination breaks.** A 60-line invoice generated 219 pages. Rendered page two contains only the next description; extraction shows later quantities/prices isolated on separate pages. The invoice table positions rows manually without a page-break strategy. | Keep rows together, repeat table headers, reserve footer space, and place totals predictably. Test long descriptions and 1/20/60/200-line invoices across invoices, quotes, and receipts. |
| P0 | **Concurrent invoice creation fails.** Eight parallel requests returned two 201s and six 500s. Number allocation reads the latest number before the insert transaction; the database uniqueness constraint prevents duplicates by rejecting competing requests. | Allocate numbers atomically within the tenant and document type. A concurrent batch must produce unique numbers without server errors. Add request idempotency so retries do not create additional invoices. |
| P0 | **Issued documents change with customer edits.** After editing an audit customer's name, the same SENT invoice returned the new identity. Invoice/PDF queries join current customer and seller records. | Snapshot seller, buyer, tax, address, and relevant payment details when issuing a document. Preserve issued versions; handle corrections explicitly. |
| P0 | **VAT-inclusive product prices are treated as exclusive by the builder.** Source inspection: `onProductChange` copies `product.price`, ignores `vat_inclusive`, and sets VAT to 15. An inclusive price of R115 follows the exclusive calculation path to R132.25. | Define inclusive/exclusive pricing consistently across catalogue, builder, API, PDF, and reports. A R115 inclusive item at 15% produces R100 net, R15 VAT, and R115 total. Support a business-level VAT setup and appropriate zero-rate/no-VAT choices. |
| P0 | **Reports combine currencies without conversion.** Local ZAR and USD payments were summed into one revenue figure; report UI labels figures as rand. Invoice status and VAT aggregates also lack currency grouping. | Group by currency initially, or use explicit, auditable exchange rates and a base currency. Never label an unconverted mixed sum as rand. Reconcile dashboard, reports, and exported data. |
| P0 | **Failed email is recorded as SENT.** With SMTP unavailable, send returned 207 and `emailFailed: true`, yet document status became SENT and a SENT tracking event was added. The UI shows a warning, but the underlying status still implies success. | Separate document issuance from delivery state. Track queued/accepted/failed/bounced states with truthful labels, visible retry actions, and an outbox with idempotent retries. SMTP acceptance alone must not imply recipient delivery. |
| P0 | **Recurring calendar behavior is wrong.** A MONTHLY invoice dated 31 January 2027 schedules 3 March. `is_recurring: true` without an interval is accepted with a null next date. | Define a monthly anchor/end-of-month policy; Jan 31 should follow that policy in February. Validate schedules. Give each generated occurrence a unique key and safe multi-worker locking, timezone handling, retry, and missed-run recovery. |
| P1 | **Part-paid invoices can be cancelled without resolving the money.** R40 against R115 was recorded, then cancellation succeeded. No corresponding refund or credit was created. | Define paid-document adjustments and implement credit/refund/reversal records, or block cancellation until the financial state is resolved. Keep a complete audit trail and reconcile customer balances. |
| P1 | **Saved invoice defaults do not control the workflow.** Saving prefix AUDIT and next number 500 still produced INV-2026-0001. The builder loads settings but applies only currency; payment terms, VAT and notes remain hard-coded or blank. | Apply company defaults and customer overrides deliberately. Define precedence and apply it consistently to invoices, quotes, conversion, and recurring generation. |
| P1 | **Catalogue/customer selection stops at 100.** Builder requests 200 records, API caps the response at 100, and no further page is loaded. A local list with 101 customers returned only 100. | Use server-searchable, paginated pickers and inline customer/product creation. Every active record must remain selectable at realistic business volumes. |
| P1 | **Tenant checks are incomplete for line-item references.** An audit invoice accepted a product ID owned by the second synthetic business. A cross-tenant invoice read correctly returned 404. | Validate each referenced customer, product, document and upload against the authenticated business. Preserve the working read isolation. This test demonstrates a foreign reference, not disclosure of the other business's product data. |
| P1 | **Changing email preserves verification.** Updating the synthetic user's email returned 200 and left `email_verified = 1`. | Verify the new address through a pending-change flow; define reauthentication and account notification behavior. Review session revocation after password changes and account recovery. |
| P1 | **Notification preferences imply automation that is absent.** Source search finds storage of `notify_invoice_overdue`, but no consumer of that setting or overdue-reminder email path. The overdue job changes status only. | Implement explicit reminder schedules with consent/preferences, preview, retry history and pause controls; make the settings describe actual behavior. |
| P1 | **Share links rotate on every generation.** Generating another link caused the earlier link to return 404. | Make “copy link” stable during its lifetime. Provide separate expiry, revoke and regenerate controls with clear consequences. Build links from configured public origins so development and split frontend/API deployments remain correct. |

Code entry points: `freevoices/server.js:919` (numbering), `:928` (recurrence date), `:982` (creation), `:1166` (sending), `:1235` (cancellation), `:1261` (sharing), `:1581` (profile), `:1655` (defaults), `:1794` (reports), `:1874` (recurring job), `:1941` (overdue job); `freevoices/src/services/pdf.service.js:135` (invoice rows); `freevoices/src/app/features/invoices/pages/invoice-create/invoice-create.page.ts:110` and `:165` (loading/defaults/product selection).

## Milestone 1 — Dependable billing

Address the P0 findings first, along with the tenant-reference and email-verification defects. Introduce focused regression tests for the reproduced failures. Restore the existing frontend test fixture and lint baseline so continuous checks can protect subsequent work.

Completion criteria:

- All P0 reproductions pass with defined expected results.
- Parallel invoice creation produces unique numbers; replaying the same request is safe.
- Historical issued documents remain stable after customer/company edits.
- Pricing-mode fixtures produce identical amounts across builder, API, PDF and reports.
- Failed email is visible as a delivery failure, with a safe retry path.
- Recurring generation handles month ends, leap years, restarts and concurrent workers deterministically.
- Build, backend tests, frontend tests and lint pass in CI.

## Milestone 2 — Fast daily work

Build around a first successful invoice and the owner's daily work:

- A short company setup checklist: business identity, VAT setup, currency, branding, payment details, and invoice defaults. Allow progressive setup with clear prompts for incomplete information.
- Searchable customer/product selectors with inline creation, reliable defaults, and large-catalogue support.
- A compact invoice editor with live document preview, inclusive/exclusive pricing, discounts, units, purchase-order references and optional delivery details where useful.
- Draft autosave and recovery, duplicate/copy invoice, and a clear distinction between save draft, issue, send, and share.
- Consistent loading, empty, success and error states; preserved work after failures; useful keyboard navigation and a full mobile test pass.
- Dashboard actions based on money: outstanding balances, amounts overdue, ageing, and clear links to the invoices requiring action.

Proposed usability target: after company setup, a new user can create a customer and issue their first correct invoice within five minutes without assistance. Measure the actual baseline before claiming improvement.

## Milestone 3 — Quote to cash

Complete the money-collection loop:

- Customer-facing quote review, accept/decline, expiry and recorded acceptance; predictable conversion to one invoice.
- Deposits and part payments with clear balances, receipts, credit notes, refunds and customer statements.
- Customer reminders with configurable timing, a pause option, delivery history and safe retries.
- A reliable mobile invoice portal with business branding, PDF download, payment information and verified payment-status updates.
- Copyable links and native sharing for messaging apps. Any direct message sending should be explicit and user-controlled.
- Bank-statement CSV import and payment matching with reviewable suggestions, duplicate detection and an audit trail.

Customer portal approval, credit notes and configurable reminders are established benchmark capabilities in [Zoho Invoice](https://www.zoho.com/in/invoice/features/) and [Xero's reminder setup](https://central.xero.com/0/article/Set-up-invoice-reminders). Their presence informs the proposed baseline; it does not mean FreeVoices must copy every accounting feature.

## Milestone 4 — Ready for sustained business use

- Reports with period/customer/currency filters, ageing, customer statements, CSV export and figures that reconcile to transactions. Make report definitions visible.
- Import customers/products with a template, validation preview, actionable row errors and safe retry behavior.
- Business membership and owner/bookkeeper/staff permissions, with business-scoped audit logs and approval rules where needed. The current model largely scopes records directly to a user, so introduce a business boundary deliberately.
- Health/readiness checks, error monitoring, delivery and scheduler metrics, database backup/restore drills, key recovery procedures and a repeatable deployment process. Existing backup scripts need restore verification.
- A pinned dependency maintenance process, authorization regression suite, upload validation and session/account-recovery review.
- Update the roadmap and contributor setup. Agree an explicit software license with the repository owner before relying on the current open-source description.
- Test slow connections, mobile layouts, keyboard-only flows, zoom and screen-reader labels. Include the customer portal and exported documents in acceptance testing.
- Define sustainable operating costs for a free service: hosting, transactional email, support and payment processing. Make any commercial terms clear to users.

## Metrics to establish

| Outcome | Suggested measure |
|---|---|
| Activation | Share of new businesses issuing a first invoice; median time to first correct invoice |
| Reliability | Invoice create/PDF failure rates; failed deliveries; recurring occurrences missed or duplicated |
| Collection | Time from issue to payment; overdue balance by age; share of balances successfully reconciled |
| Usability | Completion rate for create/send/record-payment flows on desktop and mobile; work lost after errors |
| Trust | Reconciliation mismatches, support requests per active business, restore drill success |

No production usage baseline was available. Treat these as measurements to add, not claimed results.

## Recommended next implementation

Continue Milestone 2 on `dev`: a rendered PDF preview; units, discounts and references; draft autosave and recovery; and clearer outstanding-balance and ageing actions. Measure the first-invoice usability target with real users and exercise complete mobile, keyboard and screen-reader journeys. Then validate the production integrations and recovery procedures listed in Current status before treating the service as ready for routine business billing.
