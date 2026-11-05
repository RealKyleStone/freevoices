# Milestones 1–4 regression report

26 October 2026 · branch `dev` · South African small-business beta

## Result

The automated and local API regression pass succeeded. This is **not full external acceptance**: real SMTP delivery, PayFast and Google sandbox journeys, real-device and assistive-technology use, production monitoring/off-site recovery, and South African tax review still need separate evidence.

| Check | Result | Evidence |
|---|---|---|
| Fresh schema and backend integration | Passed | 157 tests, 0 failures, 0 skips; migrations 001–024 and encrypted-column preflight applied to disposable database |
| Angular components | Passed | 127 Chrome Headless tests |
| Responsive navigation | Passed | 30 Chrome Headless checks across phone, tablet and desktop launchers |
| Lint and production build | Passed | `npm run lint`; `npm run build -- --configuration production` |
| Local API smoke | Passed | 41 authenticated owner/bookkeeper route checks, including dashboard, lists, statements, bank suggestions, invoices, invoice and receipt PDFs, and access boundaries; account export passed separately before its rate limit was reached; readiness and public legal endpoints also passed |
| Field encryption | Passed | Four bank/refund columns widened by migration 024; 100 older plaintext customer addresses backfilled; all registered fields decrypt and no plaintext remains in the local demo database |
| Encrypted restore | Passed locally | Recent snapshot restored 28 tables and 371 rows into an empty disposable local database; field-encryption canary verified; disposable database and backup removed |
| Deployment doctor | Passed locally | Zero failures, six expected warnings for development/sandbox configuration after publishing the existing legal documents in the local demo database |
| PayFast offline signature checks | Passed | 39 checks; this does not validate a real sandbox payment |
| `dev` CI | Passed before this regression fix | [`d45aaaf` run](https://github.com/RealKyleStone/freevoices/actions/runs/40355540853); rerun required on the final migration 024 commit |

## Feature coverage

| Milestone | Covered by this pass | Still needs testing |
|---|---|---|
| M1 dependable billing | Fresh-database numbering, pricing, ownership, document history, outbox and recurring checks; local invoice PDF bytes verified | Real SMTP receipt/delivery behavior and provider payment |
| M2 daily work | Frontend suite and responsive navigation/menu checks passed | Hands-on seven-journey pass on actual phone/tablet, keyboard and screen reader |
| M3 quote to cash | Quote decisions, payment/credit/refund settlement, bank import/matching and report reconciliation passed backend checks | Seller and customer visual journeys, credit-note/receipt PDF review, tax treatment signoff, real email and PayFast sandbox |
| M4 sustained use | Import replay/validation, reporting, bookkeeper invite/one-slot/isolation/revocation and local backup/restore passed; owner and bookkeeper API views returned the same eight demo invoices | Real invite email, staff role and full business migration, off-site recovery, monitoring/alerts, accessibility and license decision |

## Findings and fixes

1. The encryption preflight initially failed on `bank_import_rows.description`, `bank_import_rows.reference`, `bank_import_rows.account_label` and `payment_refunds.reference`. Migration 024 widens these fields to `MEDIUMTEXT`. The local backfill and verification then passed. The fresh-database runner now checks encrypted-column preflight before tests, so this schema regression fails CI.
2. The local deployment doctor initially failed because the account-deletion legal document was not published in the demo database. The repository legal files had no unresolved placeholders, so the local seed published all three existing documents. The generated offline privacy asset was also behind its source and has been refreshed. Production publication still needs its own review and deployment step.

## Remaining gates

- Verify invoice, invite and reminder email with a real SMTP test mailbox, including failure and retry handling.
- Complete a real PayFast sandbox transaction and Google sign-in with configured provider credentials.
- Review financial PDFs and VAT/credit-note wording with a qualified South African practitioner.
- Run visual, keyboard, zoom and screen-reader journeys on real devices; live browser inspection was not completed in this pass.
- Configure and prove off-site backup, key recovery, delivery/scheduler alerts and rollback in the target environment.
- Finish staff access and full business boundary work, then obtain the owner's license choice before describing the repository as licensed open source.
