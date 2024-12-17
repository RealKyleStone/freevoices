import { Routes } from '@angular/router';

export const AUTH_ROUTES: Routes = [
  {
    path: '',
    children: [
      {
        path: 'login',
        loadComponent: () => import('./pages/Login.page').then(m => m.LoginPage)
      }/*,
      {
        path: 'register',
        loadComponent: () => import('./pages/register/register.page').then(m => m.RegisterPage)
      },
      {
        path: 'forgot-password',
        loadComponent: () => import('./pages/forgot-password/forgot-password.page')
          .then(m => m.ForgotPasswordPage)
      },
      {
        path: 'reset-password',
        loadComponent: () => import('./pages/reset-password/reset-password.page')
          .then(m => m.ResetPasswordPage)
      }*/
    ]
  }
];