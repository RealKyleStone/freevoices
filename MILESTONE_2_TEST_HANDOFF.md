# Milestone 2 testing handoff

26 October 2026 · branch `dev` · South African small businesses

## Build under test

Use the latest `dev` commit. Do not merge this branch into `main` during testing. Start the API after running migrations; migration 017 adds line units, discounts, purchase-order references and delivery details. Use fictional customer and payment data.

Local automated checks before publication: 144 backend tests on a fresh migrated database with zero skips, 121 frontend tests, 30 responsive navigation checks, production build and lint pass. The isolated test database and user were removed after the run. Check the latest `dev` run in [GitHub Actions](https://github.com/RealKyleStone/freevoices/actions).

## Test journeys

1. **First invoice in five minutes.** On a new account, follow the dashboard setup checklist, add a customer and product from inside the invoice builder, create an invoice, and record the elapsed time. Check that zero VAT and zero-day terms remain valid.
2. **Large catalogue.** Search for a customer/product beyond the first 100 records. Load more pages, cancel a search, recover from a failed request, and keep a selected record while changing the search text.
3. **Pricing and PDF.** Enter two hours at R115 each, VAT-inclusive, with a 10% discount. The live review, server PDF preview and saved invoice should show R180 net, R27 VAT and R207 total. Add a purchase-order reference and delivery details; confirm they appear on the detail page and PDF. The PDF preview must say PREVIEW and must not create an invoice or allocate a number.
4. **Draft recovery.** Enter changes in invoice and quote create/edit forms, reload the browser, and choose Restore. Check lines, pricing, notes, customer and dates. Repeat and choose Discard. After a successful save, the old recovery prompt should be gone. Drafts are stored on that device for up to 30 days and are scoped to the signed-in account.
5. **Copy and convert.** Copy a paid or issued invoice as a new draft. It should carry editable customer, currency, terms, references, notes and line pricing but no payment, email, share or recurrence state. Create it and confirm a fresh number. Convert a quote with a discount, unit and reference into an invoice and compare values.
6. **Collections.** Record a part payment, then review the dashboard in that invoice's currency. Outstanding balance and its ageing band should reflect the remaining amount. Follow an invoice link from the dashboard. Check a second currency separately, including its own outstanding total.
7. **Navigation and usability.** On phone, tablet and desktop widths, open and close the main menu, visit all settings sections, switch theme, open/cancel the catalogue picker, visit empty Reports, and sign out with an unsaved draft. Use keyboard only and a screen reader for the first-invoice journey. Check the PDF preview dialog can be opened and closed without submitting the form.

For every failure, capture the route, device/browser, steps, expected and actual result, and a screenshot or console/network error if available. Record the first-invoice time and any point where the user needs help.

## Scope and limits

Automated tests cover financial calculations, API ownership, conversion, recurrence, PDF content, draft recovery helpers, component behavior and responsive navigation. They do not replace a human mobile, keyboard and screen-reader pass. The VS Code embedded browser was not accessible to the available browser automation connection. Production SMTP delivery/bounces, PayFast transactions, Google OAuth and production backup/key recovery belong to later validation and were not used here.
