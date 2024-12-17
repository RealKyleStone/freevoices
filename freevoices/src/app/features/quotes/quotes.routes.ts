// src/app/features/quotes/quotes.routes.ts
import { Routes } from '@angular/router';

export const QUOTE_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/quote-list/quote-list.page')
      .then(m => m.QuoteListPage)
  },
  {
    path: 'new',
    loadComponent: () => import('./pages/quote-create/quote-create.page')
      .then(m => m.QuoteCreatePage)
  },
  {
    path: ':id',
    loadComponent: () => import('./pages/quote-detail/quote-detail.page')
      .then(m => m.QuoteDetailPage)
  },
  {
    path: ':id/edit',
    loadComponent: () => import('./pages/quote-edit/quote-edit.page')
      .then(m => m.QuoteEditPage)
  }
];