# Milestones 1–4 testing matrix

26 October 2026 · branch `dev` · South African small businesses

## Status

This is a working verification matrix, **not the combined external testing handoff**. Every roadmap item is in scope. The latest implementation checkpoint is `4d49fb2` on `dev`; no change has been merged to `main`. Use fictional customers, bank statements and payments. Run migrations 017–020 before testing newer workflows.

| Area | What is available on `dev` | What testers should verify | Gate |
|---|---|---|---|
| M1 dependable billing | Numbering, pricing/PDF, party snapshots, outbox, recurring and ownership fixes | Inclusive/exclusive VAT, concurrent and repeat requests, email retries, recurring dates, invoice history | Automated acceptance passed; real SMTP/payment/provider checks pending |
| M2 fast daily work | Setup checklist, paged pickers, inline creation, preview, discounts/units, draft recovery, copy/convert, dashboard collections, responsive menu fixes | Follow the seven journeys in [the M2 handoff](MILESTONE_2_TEST_HANDOFF.md), including phone/tablet/keyboard/screen reader | External usability acceptance pending |
| M3 quote decision | Revocable customer review link, PDF, expiry, accept/decline, guarded conversion | Accept, decline, replay, expiry, revoke, ownership, mobile and keyboard flows; one invoice per quote | Automated API checks passed; external usability pending |
| M3 settlement | Part payments, balances, paid-in-full receipt | Reconcile invoice, portal, receipt, dashboard and ledger after partial and final payment | Credit notes, refunds and part-payment receipts still to build |
| M3 collections | Opt-in reminders with configurable stages, email delivery history, seller share action | Pause/retry, delivery history, portal payment refresh and last update, bounced/failed email handling | End-to-end collections and portal checks pending |
| M3 bank review | CSV preview, duplicate detection, pending queue, match suggestions, explicit match/ignore, linked payment | Duplicate file/row, wrong currency, ambiguous reference, partial/excess/negative amount, concurrent match, ownership and audit | Automated API checks passed; human review pending |
| M4 reporting | VAT CSV, filtered payment ledger, ageing, customer statement | Reconcile totals to source invoices/payments in one and multiple currencies and periods; test CSV formula safety | Automated checks partially cover this; external reconciliation pending |
| M4 imports | Customer/product template, preview, row errors, duplicate and replay handling | Valid/invalid/mixed files, repeated upload, large file, cancellation and owner isolation | Automated API checks passed; user testing pending |
| M4 business access | Owner-scoped data only | Owner/bookkeeper/staff authorization, invitations, separation of businesses, audit events | Roles and business boundary still to build |
| M4 operations | Live/ready endpoints, private metrics, encrypted backup, retention, local restore drill | Failed scheduler/outbox alert, off-site backup, key recovery, latest-backup restore and deployment rollback | Local restore passed; production setup/evidence pending |
| M4 release | Product review, roadmap and runbooks | Slow connection, phone/tablet, keyboard, zoom, screen reader, PDF/CSV accessibility, operating costs and contribution setup | External checks pending; license decision TBD |

## Latest local automated evidence

At `4d49fb2`, a fresh disposable migrated database passed **152 backend tests, zero failures and zero skips**. Angular passed **127 frontend tests**; lint and production build passed. The established responsive navigation suite previously passed **30 checks** at phone, tablet and desktop sizes. An encrypted backup restored into a disposable local database and passed table counts and a canary check. CI for `4d49fb2` has not been verified in this document. These checks do not prove that the embedded editor browser, real devices, production SMTP, PayFast, OAuth or off-site recovery work.

## Combined handoff exit conditions

1. Implement credit notes, refunds, part-payment receipts, business roles and their audit/authorization tests.
2. Complete collections and portal status checks; reconcile credits/refunds in dashboards, statements and exports.
3. Pass fresh-database backend, frontend, navigation, lint, production build and dev CI checks on the final commit.
4. Prove a recent encrypted off-site backup can be restored with recovered keys; configure job/delivery monitoring and alerts.
5. Record real device, keyboard, zoom and screen-reader results; separately verify production integrations in their own sandbox or production settings.
6. Obtain the repository owner's license decision before describing FreeVoices as licensed open source. A private beta can be tested while that decision is pending.

For each failure, record the commit, route, account/role, currency, browser/device, steps, expected and actual result, and a screenshot or log with private data removed.
