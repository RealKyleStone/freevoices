import { Routes } from '@angular/router';

export const PORTAL_ROUTES: Routes = [
  {
    path: 'invoice/:token',
    loadComponent: () => import('./pages/invoice-portal/invoice-portal.page')
      .then(m => m.InvoicePortalPage)
  }
];
