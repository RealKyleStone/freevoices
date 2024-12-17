import { Routes } from '@angular/router';

export const PRODUCT_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/product-list/product-list.page')
      .then(m => m.ProductListPage)
  },
  {
    path: 'new',
    loadComponent: () => import('./pages/product-create/product-create.page')
      .then(m => m.ProductCreatePage)
  },
  {
    path: ':id',
    loadComponent: () => import('./pages/product-detail/product-detail.page')
      .then(m => m.ProductDetailPage)
  },
  {
    path: ':id/edit',
    loadComponent: () => import('./pages/product-edit/product-edit.page')
      .then(m => m.ProductEditPage)
  }
];