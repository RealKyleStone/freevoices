# Google Play listing — FreeVoices (za.co.freevoices.app)

Everything Play Console asks for on the first release, in the order the console asks for it.
Screens and graphics in this folder are generated from a disposable local database holding a
fictional business ("Fynbos Studio"). No real customer data appears in any image.

## Assets

| Play Console field | File | Spec |
|---|---|---|
| App icon | `play-icon-512.png` | 512×512 PNG, no transparency |
| Feature graphic | `feature-graphic-1024x500.png` | 1024×500 PNG |
| Phone screenshots (upload in this order) | `phone/01-dashboard.png` … `phone/07-customers.png` | 7 × 1080×1920 |
| 7-inch tablet screenshots | `raw/tablet7/tablet7-*.png` | 6 × 1920×1080 |
| 10-inch tablet screenshots | `raw/tablet10/tablet10-*.png` | 6 × 2560×1440 |

`raw/phone/` holds the uncaptioned phone captures, in case you prefer plain screenshots.

## Main store listing

**App name** (30 max): `FreeVoices: Free Invoicing` — 26 chars

**Short description** (80 max):

> Free invoices and quotes for South African small businesses. VAT-ready PDFs.

(76 chars)

**Full description** (4000 max):

```
FreeVoices is free invoicing for South African small businesses, freelancers and sole traders. Create professional VAT invoices and quotes on your phone, see who owes you money, and keep your records in order without paying a subscription.

INVOICES THAT LOOK PROFESSIONAL
• Create invoices in rand with 15% VAT worked out for you, per line, inclusive or exclusive
• Clean PDF invoices with your business name, VAT number, logo and banking details
• Automatic numbering, payment terms and due dates
• Email invoices straight to your customer, or share a secure link
• Recurring invoices for retainers and monthly work

QUOTES THAT TURN INTO INVOICES
• Send a quote with its own validity date
• Your customer can accept or decline it online
• Convert an accepted quote into an invoice in one tap

GET PAID AND KNOW WHO OWES YOU
• Record full or part payments and always see the balance due
• Overdue invoices are flagged automatically
• Ageing totals show what is current, 1–30, 31–60 and 61+ days overdue
• Optional friendly payment reminders to customers
• Optional online card payments through your own Payfast account

STAY ON TOP OF YOUR BOOKS
• Dashboard with money received this month, open and overdue invoices
• Paid revenue and output VAT reports, plus CSV export for your accountant
• Import a bank statement CSV and match payments to invoices
• Customer statements
• Give your bookkeeper read-only access

BUILT FOR SOUTH AFRICA
• Rand by default, with other currencies available
• Designed around POPIA: sensitive details such as banking and VAT numbers are individually encrypted
• Hosted in South Africa
• No ads, no analytics trackers, and we never sell your information

Delete your account at any time from Settings, or at freevoices.co.za/legal/delete-account.
```

**Category:** Business  **Tags:** Invoicing, Business management, Accounting
**Contact email:** admin@madeoc.co.za (from privacy policy §16; change if you want a separate support address)
**Website:** https://freevoices.co.za
**Privacy policy URL:** https://freevoices.co.za/legal/privacy

## App content

**Privacy policy:** https://freevoices.co.za/legal/privacy

**Ads:** No, the app contains no ads.

**App access:** All functionality is behind a login. Google's reviewers need working credentials.
Before submitting, **create a demo account on production** with fictional data and enter its
email and password in *App content → App access*. (The local screenshot account cannot be used:
it exists only in a disposable local database.)

**Content rating (IARC questionnaire):** category *Utility, Productivity, Communication or Other*.
Answer **No** to violence, sexuality, language, controlled substances, gambling and user-to-user
interaction. Users do not share content with each other publicly, and there are no in-app purchases
in the app itself. Expected result: Everyone / PEGI 3.

**Target audience:** 18 and over only. The app is for running a business; the privacy policy (§13) excludes children.

**News app:** No. **COVID-19 contact tracing:** No. **Government app:** No.
**Financial features:** answer that the app does **not** provide banking, loans, trading or money
transfer. FreeVoices only prints the seller's bank details on invoices. Online card payments are
taken by Payfast on its own hosted page, not inside the app.

**Health apps:** No.

### Data safety

Global answers:
- Does the app collect or share user data? **Yes**
- Is all user data encrypted in transit? **Yes** (HTTPS only; the WebView is a secure context and cleartext is disabled)
- Can users request deletion? **Yes**: in-app (Settings → Privacy) and https://freevoices.co.za/legal/delete-account

Data **shared**: **None.** The hosting provider is a service provider, and data sent to Google
sign-in or Payfast is sent at the user's own request. Play counts neither as sharing.

Data **collected** (none is used for ads, analytics, marketing or personalisation):

| Play data type | Collected | Required? | Purposes |
|---|---|---|---|
| Personal info → Name | Yes | Required | App functionality, Account management |
| Personal info → Email address | Yes | Required | App functionality, Account management |
| Personal info → Phone number | Yes | Required | App functionality |
| Personal info → Address | Yes | Required | App functionality |
| Personal info → Other info (company reg. and VAT numbers) | Yes | Optional | App functionality |
| Financial info → Other financial info (bank details on invoices, invoice and payment records) | Yes | Optional | App functionality |
| Photos and videos → Photos (business logo) | Yes | Optional | App functionality |
| App activity → Other actions (document created, sent, viewed, paid audit trail) | Yes | Required | App functionality, Fraud prevention, security and compliance |
| Device or other IDs | No | | |
| Location | No | | IP addresses are kept for security only and are never used to work out location |

Data about the **user's customers** (names, emails, addresses) is processed on the user's behalf
(POPIA operator role, policy §3). Declare it under the same Personal info types above.

## Release notes (en-ZA), version 1.0.1 (versionCode 4)

```
First release of FreeVoices on Google Play: free invoices, quotes, payment tracking and VAT reports for South African small businesses.
```
