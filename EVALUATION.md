# Initial local evaluation

## Current implementation status ? 24 October 2026

The follow-up fixes are recorded in [PRODUCT_REVIEW.md](PRODUCT_REVIEW.md). Current checks pass: 140 backend tests with the local API regressions enabled, 82 frontend tests, production build and lint. Reproduced defects in pricing, PDF layout, numbering, document history, ownership, cancellation, defaults, currency reporting, retries, delivery tracking, recurring dates, share links and profile verification have been addressed on `dev`. Notifications/reminders now have a durable queue and local protocol coverage.

The sections below describe the original baseline. Live email/payment/OAuth integrations, full visual accessibility testing and production disaster recovery are still unverified. A local logical restore drill also passed for all 21 tables and 268 rows. Changes are prepared on `dev` for pull request `PR_1`.


For the subsequent feature assessment, reproduced defects, and prioritized improvement plan, see [PRODUCT_REVIEW.md](PRODUCT_REVIEW.md).

The original failures below are preserved as baseline evidence. Subsequent fixes now pass 120 backend tests (with local API integration enabled), all 79 frontend tests, the development build, and lint. PDF pagination, concurrent numbering, issued-party preservation and VAT-inclusive line pricing have been addressed; see the product review's fix progress for scope and remaining gaps.

Evaluated on 24 October 2026, from branch `dev`. This is a setup and API smoke evaluation, not a complete product or security review.

## Verified

- Locked dependencies install successfully with `npm ci`.
- The supplied schema imports into portable MariaDB 11.4.13; all 13 migrations apply successfully.
- The development frontend compiles and serves HTTP 200 on port 4200. The Express API boots on port 3000 with its field-encryption canary check passing.
- Password login, settings, account status, currencies, banks, customer/product/invoice/quote lists, dashboard summary, and all four report endpoints respond successfully with authentication.
- Creating a customer and product, creating and retrieving a draft invoice, downloading its PDF, creating a quote, and converting that quote to a second invoice succeed through the API.
- An invoice with ten R100 items at 15% VAT produces subtotal R1,000, VAT R150, and total R1,150. Thirty-day payment terms from 24 October resolve to 23 November.
- All 93 existing backend tests pass after scoping `test:server` to `test/*.test.js`. Previously, Node 24 also discovered the Angular `src/test.ts` entry and failed with `Zone is not defined`.

## Existing checks that fail

- Browser unit tests cannot compile: `src/app/features/invoices/services/invoice.service.spec.ts:30` uses a list fixture without the required `amount_paid` property.
- Lint reports five errors: a negated async pipe in `app.component.html`, and loose inequality in customer detail, invoice detail, quote detail, and invoice portal templates. One additional warning reports a missing `AfterViewInit` interface on the registration component.

These failures were recorded without changing unrelated application code.

## Findings and next evaluation work

1. Development originally targeted the production API. It now uses localhost and leaves Google OAuth disabled. The production environment file was not changed.
2. Fresh database setup needs explicit instructions and reference-data seeding: migrations assume the base schema exists, and the schema has no currency or bank rows. The local evaluation seeded ZAR and a fictional bank.
3. `ROADMAP.md` is stale. It calls reports and settings unimplemented, although their services, API routes, and pages now exist. Its `/api/profile` reference is also stale; this checkout exposes profile data through `/api/settings`.
4. The feature surface is substantial: customers, products, invoices, quotes, PDFs, quote conversion, dashboard, reports, account lifecycle, settings, recurring-invoice code, and PayFast integration are present. Presence alone does not verify every workflow.
5. Visual usability and responsive behavior remain unverified because no browser automation connection was available. The HTTP check confirms frontend serving, not successful browser rendering or navigation.
6. Email verification/delivery, password-reset delivery, reminders, recurring scheduling, Google OAuth, gateway payments/webhooks, and full account lifecycle flows remain untested. No live email or payment credentials were used.
7. Next useful pass: fix the existing test fixture and lint failures, then exercise the full browser journey from registration through company settings, invoice creation, partial payment, settlement, reporting, and mobile layouts.

## Changes made

- Local development API URL and disabled local Google OAuth in `freevoices/src/environments/environment.ts`.
- Backend test discovery scope in `freevoices/package.json`.
- Local setup instructions and this evaluation report.

All implementation changes were developed on `dev` and are prepared for pull request `PR_1`.
