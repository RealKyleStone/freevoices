# Freevoices — System Overview & Development Roadmap

> **Purpose of this document:** Give future contributors (including future AI assistants) a complete picture of what the system currently does, what's been scaffolded but not built, and a prioritised plan for what to build next.

---

## What Freevoices Is

A **free, open-source invoicing platform** for small businesses. It is a hybrid web + mobile application (Angular 18 + Ionic 8) backed by a Node.js/Express API and a MySQL database. It can be deployed to the web and packaged as a native iOS/Android app via Capacitor.

The core value proposition: give small businesses a simple, no-cost way to create invoices, manage customers, and track payments — without a subscription fee.

---

## Current State (as of March 2026)

### What Works Today

| Feature | Where |
|---|---|
| User registration with company details + bank details | `src/app/features/auth/pages/register/` |
| Login with email + password | `src/app/features/auth/pages/` |
| Email verification (token link sent on register) | `server.js` + `src/services/email.service.js` |
| Session-based auth (Bearer token, 24-hour TTL) | `server.js` |
| Route protection via AuthGuard | `src/app/core/auth/guards/auth.guard.ts` |
| Auth interceptor (auto-attaches token to all requests) | `src/app/core/http/interceptors/auth.interceptor.ts` |
| Google reCAPTCHA v2 Invisible on auth forms | `src/app/core/services/captcha.service.ts` |
| User profile API (`GET /api/profile`) | `server.js` |
| Banks list API (`GET /api/banks`) | `server.js` |
| Logout API (`POST /api/logout`) | `server.js` |
| Dashboard shell (static placeholder data) | `src/app/features/dashboard/` |
| 404 not-found page | `src/app/shared/` |
| Winston logging to file (error.log, combined.log) | `server.js` |
| Argon2 password hashing | `server.js` |
| **Customer CRUD API** — list (paginated + search), create, get, update, soft-delete | `server.js` |
| **Customer list page** — searchable, paginated, edit/delete actions | `src/app/features/customers/pages/customer-list/` |
| **Customer create/edit form** — reactive form, full validation | `src/app/features/customers/pages/customer-create/`, `customer-edit/` |
| **Customer detail page** — contact info + invoice history | `src/app/features/customers/pages/customer-detail/` |
| **Product CRUD API** — list (paginated + search), create, get, update, soft-delete | `server.js` |
| **Product list page** — searchable, paginated, edit/delete actions | `src/app/features/products/pages/product-list/` |
| **Product create/edit form** — name, description, price, VAT inclusive toggle | `src/app/features/products/pages/product-create/`, `product-edit/` |
| **Product detail page** | `src/app/features/products/pages/product-detail/` |
| **Invoice API** — list (paginated, status filter), create with line items (transaction), get, update (DRAFT only), mark sent, record payment | `server.js` |
| **Invoice list page** — status tabs (All/Draft/Sent/Paid/Overdue), search | `src/app/features/invoices/pages/invoice-list/` |
| **Invoice builder** — customer picker, dynamic line items with product catalogue integration, live VAT/total calculation, auto-generated number | `src/app/features/invoices/pages/invoice-create/`, `invoice-edit/` |
| **Invoice detail page** — items table, tracking timeline, payment history, inline payment form, action buttons | `src/app/features/invoices/pages/invoice-detail/` |
| **Quote API** — list (paginated, status filter), create with line items (transaction), get, update (DRAFT only), mark sent, convert to invoice | `server.js` |
| **Quote list page** — status tabs, search | `src/app/features/quotes/pages/quote-list/` |
| **Quote builder** — same as invoice builder, `valid_until` expiry date | `src/app/features/quotes/pages/quote-create/`, `quote-edit/` |
| **Quote detail page** — items, tracking timeline, "Convert to Invoice" action | `src/app/features/quotes/pages/quote-detail/` |
| **Database schema documented** | `database/schema.sql` |
| **Migrations applied** — soft-delete on customers (`001`), currencies seeded ZAR default (`002`), password reset tokens table (`003`), recurring invoice columns (`002_add_recurring_to_documents`) | All applied |
| **Dashboard live data** — `GET /api/dashboard/summary`, DashboardService, live stats + recent activity | `server.js` + `src/app/features/dashboard/` |
| **Forgot / Reset Password** — token generation, email link, secure reset with Argon2 | `server.js` + `src/app/features/auth/pages/forgot-password/`, `reset-password/` |

### What Is Scaffolded but Not Built

These routes and folder structures exist but have no working UI components or backend endpoints yet:

- `features/settings/` — profile, company, invoice, payment, notifications sub-pages
- `features/reports/` — reporting section

### Data Models Already Defined

All TypeScript interfaces live in [src/models/database.models.ts](src/models/database.models.ts). Enums match the live database exactly (all uppercase). The database schema is in [database/schema.sql](database/schema.sql).

- `User` — with company info, contact, bank details, email verification status
- `Customer` — billing/shipping addresses, payment terms ✅ fully wired
- `Document` — invoices and quotes, status workflow: `DRAFT → SENT → PAID / OVERDUE / CANCELLED`
- `DocumentItem` — line items with quantity, unit price, VAT
- `DocumentTracking` — audit log: `CREATED / SENT / VIEWED / DOWNLOADED / PAID / CANCELLED`
- `Payment` — payment records; methods: `PAYFLEX / PAYFAST / CARDANO / BANK_TRANSFER / OTHER`
- `Product` — reusable product/service catalogue per user
- `Currency` — multi-currency support
- `EmailLog` — audit trail of all sent emails
- `Settings` — user preferences as key-value pairs
- `Bank` — bank directory (SWIFT, branch codes)

### Tech Stack

| Layer | Technology |
|---|---|
| Frontend framework | Angular 18 (standalone components) |
| Mobile UI | Ionic 8 |
| Mobile native | Capacitor 6.2 (iOS + Android) |
| State management | NgRx installed but **not yet wired up** — using BehaviorSubject in AuthService |
| Backend | Node.js + Express |
| Database | MySQL 2 |
| Password hashing | Argon2 |
| Email | Nodemailer (SMTP, TLS 1.2+) |
| CAPTCHA | Google reCAPTCHA v2 Invisible |
| Logging | Winston |
| Icons | Ionicons 7.2 |

---

## Development Roadmap

Work is ordered by user value: a small business can't use the app until invoices exist. Build in this sequence.

---

### Phase 1 — Core Business Logic (Must-Have)

These features are the entire point of the app. Nothing else matters until these work.

#### 1.1 Customer Management ✅ COMPLETE

**Backend endpoints (live in `server.js`):**
- `GET /api/customers` — paginated list, search by name/email ✅
- `POST /api/customers` — create customer ✅
- `PUT /api/customers/:id` — update customer ✅
- `DELETE /api/customers/:id` — hard-delete for now; upgrade to soft-delete after running `database/migrations/001_add_customers_active.sql` ✅
- `GET /api/customers/:id` — single customer with their document history ✅

**Frontend pages (live in `src/app/features/customers/`):**
- Customer list page with search/filter and swipe-to-delete ✅
- Create/edit customer form (name, email, phone, billing address, shipping address, payment terms) ✅
- Customer detail page showing contact info and invoice history ✅

#### 1.2 Product / Service Catalogue ✅ COMPLETE

**Backend endpoints (live in `server.js`):**
- `GET /api/products` — paginated list, search by name/description ✅
- `POST /api/products` — create product ✅
- `PUT /api/products/:id` — update product ✅
- `DELETE /api/products/:id` — soft-delete (`is_active = 0`) ✅
- `GET /api/products/:id` — single product ✅

**Frontend pages (live in `src/app/features/products/`):**
- Product list with search/filter and edit/delete actions ✅
- Create/edit product form (name, description, price, VAT inclusive toggle) ✅
- Product detail page showing pricing info ✅

#### 1.3 Invoice Creation & Management ✅ COMPLETE

This is the core feature. The `Document` model supports both invoices and quotes via a `type` field.

**Backend endpoints (live in `server.js`):**
- `GET /api/invoices` — paginated list with search, status filter ✅
- `POST /api/invoices` — create with line items (DB transaction) ✅
- `PUT /api/invoices/:id` — update (DRAFT only, replaces line items) ✅
- `GET /api/invoices/:id` — full invoice with items, tracking history, payments ✅
- `POST /api/invoices/:id/send` — mark as SENT + tracking event ✅
- `POST /api/invoices/:id/mark-paid` — record payment, mark PAID + tracking event ✅

**Frontend pages (live in `src/app/features/invoices/`):**
- Invoice list with segment tabs: All / Draft / Sent / Paid / Overdue, search ✅
- Invoice builder form: customer picker, line items with product catalogue integration, auto-calculate subtotal/VAT/total, invoice number auto-generated server-side ✅
- Invoice detail page: line items, totals, tracking timeline, payment history, action buttons ✅
- Invoice edit page: same builder pre-populated (DRAFT only, redirects otherwise) ✅
- PDF generation — see Phase 2

#### 1.4 Quote Management ✅ COMPLETE

Structurally identical to invoices. Shares the `Document` model. Key differences: `valid_until` expiry date, `QUO-` number prefix, convert-to-invoice action.

**Backend endpoints (live in `server.js`):**
- `GET /api/quotes` — paginated list with search, status filter ✅
- `POST /api/quotes` — create with line items (DB transaction) ✅
- `GET /api/quotes/:id` — full quote with items and tracking history ✅
- `PUT /api/quotes/:id` — update (DRAFT only) ✅
- `POST /api/quotes/:id/send` — mark as SENT + tracking event ✅
- `POST /api/quotes/:id/convert-to-invoice` — copies quote into a new DRAFT invoice ✅

**Frontend pages (live in `src/app/features/quotes/`):**
- Quote list with segment tabs and search ✅
- Create/edit quote form (same builder as invoices, `valid_until` instead of `due_date`) ✅
- Quote detail page with "Convert to Invoice" action button ✅

---

### Phase 2 — Polish & Productivity

Once Phase 1 works, these features dramatically improve day-to-day usability.

#### 2.1 PDF Generation ✅ COMPLETE

**Library:** PDFKit (server-side, no headless browser required)

**Backend (live in `server.js` + `src/services/pdf.service.js`):**
- `GET /api/invoices/:id/pdf` — generates and streams a PDF; also logs a `DOWNLOADED` tracking event ✅
- `src/services/pdf.service.js` — `buildInvoicePdf(invoice, items, user)` builds a professional A4 layout: company header, billed-to block, line items table, totals, banking details, footer ✅

**Frontend (`invoice-detail` page):**
- "Download PDF" button fetches the PDF as a blob and triggers a browser download ✅

#### 2.2 Email Invoice to Customer ✅ COMPLETE

**Backend:**
- `POST /api/invoices/:id/send` now generates the PDF via `buildInvoicePdf`, attaches it to a Nodemailer message, and emails it to the customer's address ✅
- Returns an error if the customer has no email on file ✅

**Email template (`src/services/email.service.js` — `sendInvoiceEmail`):**
- Clean HTML email with invoice summary table, amount due, due date, and banking details ✅

**Frontend:**
- "Mark as Sent" button renamed to "Email to Customer" with loading spinner ✅

#### 2.3 Dashboard — Live Data ✅ COMPLETE

**Backend endpoint (live in `server.js`):**
- `GET /api/dashboard/summary` — returns: revenue this month, active customer count, open invoice count, overdue count, last 5 tracking events ✅

**Frontend (live in `src/app/features/dashboard/`):**
- `DashboardService` calls the summary endpoint ✅
- Dashboard page replaced with live stats, skeleton loaders, and real recent-activity list ✅

#### 2.4 Settings Pages ✅ COMPLETE

Build out `src/app/features/settings/` sub-pages:

- **Profile** — update name, email, phone, password
- **Company** — company name, address, logo upload, registration number, VAT number
- **Invoice defaults** — default payment terms, invoice notes, VAT rate, invoice number prefix/counter
- **Payment details** — bank account displayed on invoices
- **Notifications** — email notification preferences

#### 2.5 Forgot Password / Reset Password ✅ COMPLETE

**Backend endpoints (live in `server.js`):**
- `POST /api/auth/forgot-password` — generates a UUID reset token, stores it with a 1-hour expiry in `password_reset_tokens`, emails a reset link ✅
- `POST /api/auth/reset-password` — validates token (expiry + used flag), hashes new password with Argon2, marks token used ✅

**Frontend pages (live in `src/app/features/auth/pages/`):**
- Forgot-password page — email form, success/error messaging, email-enumeration-safe response ✅
- Reset-password page — reads token from URL query param, password + confirm fields with match validation, redirects to login on success ✅
- Routes wired in `auth.routes.ts` ✅

---

### Phase 3 — Advanced Features

Once the core is solid, these add significant value for growing businesses.

#### 3.1 Reports ✅ COMPLETE

**Backend endpoints (live in `server.js`):**
- `GET /api/reports/revenue-by-month` — paid invoice revenue for last 12 months ✅
- `GET /api/reports/invoice-status` — count + total by status (all time) ✅
- `GET /api/reports/top-customers` — top 5 customers by paid revenue ✅
- `GET /api/reports/vat-summary` — monthly subtotal/VAT/total for current year ✅

**Frontend (live in `src/app/features/reports/`):**
- Chart.js installed (vanilla, no ng2-charts wrapper needed) ✅
- Revenue by month — bar chart ✅
- Invoice status breakdown — doughnut chart ✅
- Top customers — horizontal bar chart ✅
- VAT summary — stacked bar chart + printable table ✅
- Wired into `/reports` route and side-nav menu ✅

#### 3.2 Recurring Invoices ✅ COMPLETE

**DB columns added to `documents` (migration `002_add_recurring_to_documents.sql` applied):**
- `is_recurring TINYINT(1)` — flag enabling recurrence
- `recurrence_interval ENUM('WEEKLY','MONTHLY','QUARTERLY','YEARLY')` — schedule cadence
- `recurrence_next_date DATE` — date the cron uses to decide when to fire; advanced after each run
- `recurrence_end_date DATE` — optional stop date; recurrence disabled automatically when crossed
- `auto_send TINYINT(1)` — if set, each generated copy is emailed immediately

**Backend (live in `server.js`):**
- `advanceDate(dateStr, interval)` helper — UTC-safe date arithmetic for all four intervals ✅
- `POST /api/invoices` and `PUT /api/invoices/:id` — accept and persist all 5 recurring fields; `recurrence_next_date` computed server-side as `issue_date + interval` ✅
- `processRecurringInvoices()` — queries all due recurring invoices, clones each (doc + items) in a transaction, advances `recurrence_next_date`, disables recurrence at end date, auto-sends via `buildInvoicePdf` + `emailService` if flagged ✅
- `cron.schedule('5 0 * * *', processRecurringInvoices)` — fires at 00:05 daily; failures per document are isolated and logged without stopping other rows ✅

**Frontend (live in `src/app/features/invoices/pages/invoice-create/`):**
- "Recurring Schedule" card in the invoice builder with: Recurring toggle → Interval select (Weekly/Monthly/Quarterly/Yearly) + optional End Date + Auto-send toggle ✅
- `isRecurring` getter drives conditional visibility of interval/end date/auto-send controls ✅
- Recurring fields included in submit payload; stripped when toggle is off ✅

#### 3.3 Multi-Currency

The `Currency` model already exists. Wire it up:
- User sets a default currency in Settings
- Currency picker on invoice builder
- Exchange rate fetching (free tier from [exchangerate.host](https://exchangerate.host) or [Open Exchange Rates](https://openexchangerates.org))

#### 3.4 Customer Portal

A read-only shareable link per invoice where the customer can:
- View the invoice
- Download the PDF
- Mark as "I've seen this" (updates `DocumentTracking`)
- Potentially pay online (Phase 4)

#### 3.5 NgRx State Management

NgRx is installed but unused. As the app grows, wire it up for:
- Invoice list + pagination state
- Customer list state
- Dashboard summary state
- Optimistic UI updates

---

### Phase 4 — Payments Integration

Enable in-app payment collection. This is a significant undertaking and should come after Phase 3.

- **[Stripe](https://stripe.com/)** or **[PayFast](https://www.payfast.co.za/)** (South African businesses) integration
- Payment link embedded in customer-facing invoice view
- Webhook handler to auto-mark invoices as paid when payment clears
- Payment history page

---

## Known Issues & Technical Debt

These should be addressed before or alongside Phase 2:

| Issue | Location | Notes |
|---|---|---|
| CAPTCHA secret key hardcoded | `server.js:19` | Move to `.env` |
| SMTP `rejectUnauthorized: false` | `src/services/email.service.js` | Enable in production, handle self-signed certs properly |
| Mobile CAPTCHA bypass via User-Agent | `server.js` | User-Agent can be spoofed; use a more robust mobile detection or disable CAPTCHA for authenticated requests only |
| Dashboard uses hardcoded placeholder data | `dashboard.page.ts` | ✅ Fixed — wired to `/api/dashboard/summary` |
| NgRx installed but completely unused | `package.json` | Either use it or remove it to keep bundle size down |
| No global frontend error handler | — | Add an Angular `ErrorHandler` or an HTTP interceptor to catch and display API errors consistently |
| No input validation middleware | `server.js` | Add `express-validator` to validate and sanitise all POST/PUT request bodies |
| Database migrations | `database/migrations/` | All three migrations applied and files removed. Consider adding a runner tool like `db-migrate` or `Knex` for future migrations. |
| Customer delete is hard-delete | `server.js` | ✅ Fixed — migration `001` applied, soft-delete now in place |
| Profile API selects non-existent columns | `server.js` | ✅ Fixed — stale `GET /api/profile` endpoint removed; profile is managed via `PUT /api/settings/profile` |
| `.env` committed? | `.env` | Verify `.env` is in `.gitignore`. It should never be committed. |

---

## File Map for New Contributors

| If you want to... | Look at... |
|---|---|
| Add a new API endpoint | `server.js` |
| Add a new page/route | `src/app/app.routes.ts` + create component in `src/app/features/` |
| Change what happens after login | `src/app/core/auth/services/auth.service.ts` |
| Change how HTTP requests are made | `src/app/core/services/api.service.ts` |
| Update data models | `src/models/database.models.ts` |
| Change email templates | `src/services/email.service.js` |
| Update environment/API URLs | `src/environments/environment.ts` + `environment.prod.ts` |
| Change auth guard logic | `src/app/core/auth/guards/auth.guard.ts` |

---

## Suggested Next Steps for a New Contributor

**Phases 1 and 2 are fully complete.** The entire CRUD pipeline, PDF generation, email delivery, dashboard, settings, and password reset are all live.

**Phase 3.1 (Reports) is now complete.** Revenue by month, invoice status breakdown, top customers, and VAT summary are all wired to live data with Chart.js charts.

The remaining Phase 3 items are the best next targets, in priority order:

1. **Recurring Invoices (Phase 3.2) is now complete.** New DB columns, `node-cron` daily job, and invoice builder toggle are all live.

2. **Multi-Currency is now complete** (Phase 3.3) — the `currencies` table and `currency_id` column already exist. Wire a currency picker into the invoice/quote builder, store the user's default currency in `settings`, and optionally fetch exchange rates for display conversion.

3. **Customer Portal is now complete** (Phase 3.4) — generate a signed, read-only share link per invoice. The customer can view the invoice, download the PDF, and trigger a `VIEWED` tracking event — no login required.

Address the remaining known issues (NgRx cleanup, global error handler, `express-validator`) alongside any of the above.
