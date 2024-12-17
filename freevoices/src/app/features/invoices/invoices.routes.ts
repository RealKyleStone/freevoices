import { Routes } from '@angular/router';

export const INVOICE_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/invoice-list/invoice-list.page')
      .then(m => m.InvoiceListPage)
  },
  {
    path: 'new',
    loadComponent: () => import('./pages/invoice-create/invoice-create.page')
      .then(m => m.InvoiceCreatePage)
  },
  {
    path: ':id',
    loadComponent: () => import('./pages/invoice-detail/invoice-detail.page')
      .then(m => m.InvoiceDetailPage)
  },
  {
    path: ':id/edit',
    loadComponent: () => import('./pages/invoice-edit/invoice-edit.page')
      .then(m => m.InvoiceEditPage)
  }
];