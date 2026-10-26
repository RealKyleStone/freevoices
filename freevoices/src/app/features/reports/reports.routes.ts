import { Routes } from '@angular/router';

export const REPORTS_ROUTES: Routes = [
  {
    path: 'bank',
    loadComponent: () => import('./pages/bank-review/bank-review.page')
      .then(m => m.BankReviewPage)
  },
  {
    path: '',
    loadComponent: () => import('./pages/reports/reports.page')
      .then(m => m.ReportsPage)
  }
];
