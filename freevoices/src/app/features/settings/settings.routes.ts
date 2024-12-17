import { Routes } from '@angular/router';

export const SETTINGS_ROUTES: Routes = [
  {
    path: '',
    loadComponent: () => import('./pages/settings-main/settings-main.page')
      .then(m => m.SettingsMainPage),
    children: [
      {
        path: 'profile',
        loadComponent: () => import('./pages/profile-settings/profile-settings.page')
          .then(m => m.ProfileSettingsPage)
      },
      {
        path: 'company',
        loadComponent: () => import('./pages/company-settings/company-settings.page')
          .then(m => m.CompanySettingsPage)
      },
      {
        path: 'invoice',
        loadComponent: () => import('./pages/invoice-settings/invoice-settings.page')
          .then(m => m.InvoiceSettingsPage)
      },
      {
        path: 'payment',
        loadComponent: () => import('./pages/payment-settings/payment-settings.page')
          .then(m => m.PaymentSettingsPage)
      },
      {
        path: 'notifications',
        loadComponent: () => import('./pages/notification-settings/notification-settings.page')
          .then(m => m.NotificationSettingsPage)
      },
      {
        path: '',
        redirectTo: 'profile',
        pathMatch: 'full'
      }
    ]
  }
];