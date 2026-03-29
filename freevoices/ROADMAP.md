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
| **Customer CRUD API** — list (paginated + search), create, get, update, delete | `server.js` |
| **Customer list page** — searchable, paginated, swipe-to-delete | `src/app/features/customers/pages/customer-list/` |
| **Customer create/edit form** — reactive form, full validation | `src/app/features/customers/pages/customer-create/`, `customer-edit/` |
| **Customer detail page** — contact info + invoice history | `src/app/features/customers/pages/customer-detail/` |
| **Database schema documented** | `database/schema.sql` |

### What Is Scaffolded but Not Built

These routes and folder structures exist but have no working UI components or backend endpoints yet:

- `features/invoices/` — list, create, edit, detail views
- `features/quotes/` — list, create, edit, detail views
- `features/products/` — list, create, edit, detail views
- `features/settings/` — profile, company, invoice, payment, notifications sub-pages
- `features/reports/` — reporting section
- Forgot password / Reset password flows

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

#### 1.2 Product / Service Catalogue

**Backend endpoints:**
- `GET /api/products` — list, search
- `POST /api/products` — create
- `PUT /api/products/:id` — update
- `DELETE /api/products/:id` — soft-delete

**Frontend pages in `src/app/features/products/`:**
- Product list with search
- Create/edit form (name, description, unit price, VAT rate, currency)

#### 1.3 Invoice Creation & Management

This is the core feature. The `Document` model supports both invoices and quotes via a `type` field.

**Backend endpoints:**
- `GET /api/invoices` — list with status filters (draft/sent/paid/overdue)
- `POST /api/invoices` — create with line items
- `PUT /api/invoices/:id` — update (only allowed when in `draft`)
- `GET /api/invoices/:id` — full invoice with items and tracking history
- `POST /api/invoices/:id/send` — mark as sent + email PDF to customer
- `POST /api/invoices/:id/mark-paid` — record a payment

**Frontend pages in `src/app/features/invoices/`:**
- Invoice list with tabs: All / Draft / Sent / Paid / Overdue
- Invoice builder form:
  - Select customer (or quick-add inline)
  - Add line items (pick from products catalogue or type ad-hoc)
  - Auto-calculate subtotal, VAT, total
  - Invoice number, issue date, due date, payment terms, notes
- Invoice detail / preview page
- PDF generation (see Phase 2)

#### 1.4 Quote Management

Structurally identical to invoices. Shares the `Document` model.

**Additional endpoint:**
- `POST /api/quotes/:id/convert-to-invoice` — convert accepted quote to invoice

---

### Phase 2 — Polish & Productivity

Once Phase 1 works, these features dramatically improve day-to-day usability.

#### 2.1 PDF Generation

Users need to send professional-looking PDF invoices to customers.

**Options (pick one):**
- **[Puppeteer](https://pptr.dev/)** — render the Angular invoice component as HTML, then print to PDF server-side. Most flexible.
- **[PDFKit](https://pdfkit.org/)** — generate PDFs programmatically in Node.js. Lighter weight.

Suggested approach: create an Angular invoice template component used for both on-screen preview and PDF export. Pass the rendered HTML to a `/api/invoices/:id/pdf` endpoint.

#### 2.2 Email Invoice to Customer

The email infrastructure already exists (`src/services/email.service.js`). This is a matter of:
- Attaching the generated PDF to a Nodemailer message
- Building a clean HTML email template
- Calling it from the `POST /api/invoices/:id/send` endpoint

#### 2.3 Dashboard — Live Data

Replace the hardcoded placeholder values in [src/app/features/dashboard/pages/dashboard/dashboard.page.ts](src/app/features/dashboard/pages/dashboard/dashboard.page.ts) with real API data.

**New endpoint:**
- `GET /api/dashboard/summary` — returns: total revenue (month/year), open invoices count, overdue count, recent activity

#### 2.4 Settings Pages

Build out `src/app/features/settings/` sub-pages:

- **Profile** — update name, email, phone, password
- **Company** — company name, address, logo upload, registration number, VAT number
- **Invoice defaults** — default payment terms, invoice notes, VAT rate, invoice number prefix/counter
- **Payment details** — bank account displayed on invoices
- **Notifications** — email notification preferences

#### 2.5 Forgot Password / Reset Password

The routes are commented out in `app.routes.ts`. Standard flow:
1. `POST /api/auth/forgot-password` — generate a reset token, email a link
2. `GET /api/auth/reset-password?token=...` — validate token, serve the reset form
3. `POST /api/auth/reset-password` — update password, invalidate the token

---

### Phase 3 — Advanced Features

Once the core is solid, these add significant value for growing businesses.

#### 3.1 Reports

Basic financial reports:

- Revenue by month (bar chart)
- Outstanding vs paid invoices (pie chart)
- Top customers by revenue
- VAT summary report (useful for tax filing)

Use a lightweight charting library — [Chart.js](https://www.chartjs.org/) works well with Angular. Build in `src/app/features/reports/`.

#### 3.2 Recurring Invoices

Allow a user to mark an invoice as recurring (weekly/monthly/quarterly). A server-side cron job auto-generates and optionally auto-sends the invoice.

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
| Dashboard uses hardcoded placeholder data | `dashboard.page.ts` | Replace with `/api/dashboard/summary` |
| NgRx installed but completely unused | `package.json` | Either use it or remove it to keep bundle size down |
| No global frontend error handler | — | Add an Angular `ErrorHandler` or an HTTP interceptor to catch and display API errors consistently |
| No input validation middleware | `server.js` | Add `express-validator` to validate and sanitise all POST/PUT request bodies |
| Database migrations | `database/migrations/` | Folder created; first migration (`001_add_customers_active.sql`) adds soft-delete to customers. Add a runner tool like `db-migrate` or `Knex` to manage these properly. |
| Customer delete is hard-delete | `server.js` | Run `database/migrations/001_add_customers_active.sql` then switch to soft-delete |
| Profile API selects non-existent columns | `server.js` | `GET /api/profile` selects `username`, `role`, `organizationID`, `organizationName` — none of these columns exist in the `users` table. Fix the SELECT to match the actual schema. |
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

## Suggested First PR for a New Contributor

**Customer CRUD is done** — the next best self-contained starting point is **Product / Service Catalogue** (Phase 1.2):
1. Add the 4 product endpoints to `server.js`
2. Build the product list page in `src/app/features/products/`
3. Build the create/edit product form
4. Wire the routes back in `app.routes.ts`

This follows the exact same pattern as the customer CRUD and directly unblocks invoice line-item selection.
