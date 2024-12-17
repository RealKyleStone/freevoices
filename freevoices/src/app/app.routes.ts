import { Routes } from '@angular/router';
import { AuthGuard } from './core/auth/guards/auth.guard';
import { AUTH_ROUTES } from './features/auth/auth.routes';

export const routes: Routes = [
  {
    path: '',
    redirectTo: 'dashboard',
    pathMatch: 'full'
  },
  {
    path: 'auth',
    children: AUTH_ROUTES
  },
  {
    path: '',
    canActivate: [AuthGuard],
    children: [
      {
        path: 'dashboard',
        loadComponent: () => import('./features/dashboard/pages/dashboard/dashboard.page')
          .then(m => m.DashboardPage)
      }     
      
      /*,
      {
        path: 'invoices',
        loadChildren: () => import('./features/invoices/invoices.routes')
          .then(m => m.INVOICE_ROUTES)
      },
      {
        path: 'quotes',
        loadChildren: () => import('./features/quotes/quotes.routes')
          .then(m => m.QUOTE_ROUTES)
      },
      {
        path: 'customers',
        loadChildren: () => import('./features/customers/customers.routes')
          .then(m => m.CUSTOMER_ROUTES)
      },
      {
        path: 'products',
        loadChildren: () => import('./features/products/products.routes')
          .then(m => m.PRODUCT_ROUTES)
      },
      {
        path: 'settings',
        loadChildren: () => import('./features/settings/settings.routes')
          .then(m => m.SETTINGS_ROUTES)
      }*/
    ]
  },
  {
    path: 'login',
    loadComponent: () => import('./features/auth/pages/Login.page')
      .then(m => m.LoginPage)
  },
  {
    path: '**',
    loadComponent: () => import('./shared/pages/not-found/not-found.page')
      .then(m => m.NotFoundPage)
  }
];