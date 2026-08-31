import { Routes } from '@angular/router';

/**
 * Registered OUTSIDE the AuthGuard block in app.routes.ts, deliberately:
 *
 *  - Google Play requires the privacy policy and the account-deletion page to be
 *    reachable before an account exists.
 *  - The registration consent checkboxes link here, so they must work for a
 *    visitor with no session.
 *  - When the re-consent interstitial lands, someone refusing new terms must
 *    still be able to read what they are refusing, and to leave.
 */
export const LEGAL_ROUTES: Routes = [
  {
    path: '',
    redirectTo: 'privacy',
    pathMatch: 'full'
  },
  {
    path: ':slug',
    loadComponent: () => import('./pages/legal-view/legal-view.page')
      .then(m => m.LegalViewPage)
  }
];
