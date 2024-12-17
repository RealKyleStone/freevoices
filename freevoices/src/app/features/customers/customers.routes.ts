import { Routes } from '@angular/router';

export const CUSTOMER_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/customer-list/customer-list.page')
      .then(m => m.CustomerListPage)
  },
  {
    path: 'new',
    loadComponent: () => import('./pages/customer-create/customer-create.page')
      .then(m => m.CustomerCreatePage)
  },
  {
    path: ':id',
    loadComponent: () => import('./pages/customer-detail/customer-detail.page')
      .then(m => m.CustomerDetailPage)
  },
  {
    path: ':id/edit',
    loadComponent: () => import('./pages/customer-edit/customer-edit.page')
      .then(m => m.CustomerEditPage)
  }
];