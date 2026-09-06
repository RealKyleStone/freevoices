import { Routes } from '@angular/router';

export const AUTH_ROUTES: Routes = [
  {
    path: '',
    children: [
      {
        path: 'login',
        loadComponent: () => import('./pages/Login.page').then(m => m.LoginPage)
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
      },
      {
        // Second half of a Google sign-up. Unguarded because no account exists
        // yet — the page is only reachable with a Google ID token in router
        // state, and it bounces back to /login without one.
        path: 'google-complete',
        loadComponent: () => import('./pages/google-complete/google-complete.page')
          .then(m => m.GoogleCompletePage)
      }
    ]
  }
];
