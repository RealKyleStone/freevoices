# Milestone 1 and 2 regression pass

This report records the earlier Milestones 1 and 2 navigation pass. Current Milestones 1–4 verification and outstanding gates are tracked in [the testing matrix](MILESTONES_1_4_TEST_MATRIX.md); the results below have not been rerun as a combined external acceptance pass.

26 October 2026 - branch `dev`

## Findings fixed

1. **Tablet navigation gap.** Dashboard and Reports hid their menu triggers at 768px while the split-pane sidebar appeared at 992px. Removed the conflicting CSS hiding rules so Ionic controls button visibility using the menu's actual state.
2. **Menu overlay stayed open.** The Legal & privacy footer link did not dismiss the mobile menu. It now closes the menu when navigating; sign-out also closes it explicitly.
3. **Authentication shell routing.** The user observable emitted objects while the template compared it with boolean `true`, allowing two router outlets. The authentication observable now emits a boolean, and one stable routed outlet is shared across authentication states. Account changes reset Ionic's page stack so cached private drafts do not survive logout. Expired/logged-out sessions can leave a dirty private form without the unsaved-changes guard preventing the login redirect.
4. **Empty reports crashed.** Chart creation accessed customer/VAT canvases removed by empty-state conditions. Reports now initialise charts after the view is ready, build only present canvases and unsubscribe outstanding requests when destroyed.

## Checks and results

| Area | Result |
|---|---|
| Backend billing/API regressions on a fresh migrated database | 142 passed; zero skipped |
| Full frontend suite | 112 passed |
| Responsive navigation suite | 30 passed: 10 cases in each of three browser sizes |
| Production build | Passed |
| Lint and whitespace checks | Passed |

The responsive suite exercises actual AppComponent, Dashboard, Reports, Settings shell, Ionic menus, native catalogue dialog and Angular routing. It covers main navigation links and the brand link, tablet menu visibility, footer navigation dismissal, all seven settings sections, empty reports, theme switching, draft protection, cancelling a picker, sign-in/out and clearing private cached drafts. The measured local Karma frame sizes were 485x693, 869x749 and 1249x749 CSS pixels; Chrome's outer window size differs from the test frame size. CI runs these checks automatically on `dev`.

Customer/product/invoice/quote destinations use lightweight route fixtures in the navigation suite. Their actual API, pricing, history, outbox, recurring and selector behaviour are covered separately by the backend and component suites. This is not a claim of exhaustive end-to-end coverage of every product screen.

Backend fixtures use their own disposable database and dedicated user. The fixture database/user are removed after the local run; demo data and credentials are preserved.

## Limits

The VS Code embedded browser shown by the user is not exposed to the available browser automation connection: the browser inventory is empty and `iab` is unavailable. No claim is made that the live editor browser was driven or visually verified. These checks use headless Chrome against application components and the local API. Actual device/screen-reader testing, production email delivery, Google OAuth and PayFast transactions remain unverified. No changes are merged into `main`.
