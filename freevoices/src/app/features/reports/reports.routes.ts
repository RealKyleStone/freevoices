import { Routes } from '@angular/router';

export const REPORTS_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/reports/reports.page')
      .then(m => m.ReportsPage)
  }
];
