import { Component, OnInit } from '@angular/core';
import { Router, RouterModule } from '@angular/router';
import { IonApp, IonSplitPane, IonMenu, IonContent, IonList,
         IonMenuToggle, IonItem, IonIcon, IonLabel, IonFooter,
         IonRouterOutlet, MenuController } from '@ionic/angular/standalone';
import { AuthService } from './core/auth/services/auth.service';
import { CommonModule } from '@angular/common';
import {
  walletOutline, gridOutline, cashOutline, businessOutline,
  barChartOutline, logOutOutline, notificationsOutline,
  personCircleOutline, addCircleOutline, personAddOutline,
  documentTextOutline, alertCircleOutline, peopleOutline,
  receiptOutline, cubeOutline, settingsOutline
} from 'ionicons/icons';
import { addIcons } from 'ionicons';
import { Observable } from 'rxjs';
import { filter, take } from 'rxjs/operators';
import { LocalNotificationService } from './core/services/local-notification.service';
import { BrowserNotificationService } from './core/services/browser-notification.service';
import { InvoiceService } from './features/invoices/services/invoice.service';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  standalone: true,
  imports: [
    RouterModule,
    CommonModule,
    IonApp,
    IonSplitPane,
    IonMenu,
    IonContent,
    IonList,
    IonMenuToggle,
    IonItem,
    IonIcon,
    IonLabel,
    IonFooter,
    IonRouterOutlet
  ]
})
export class AppComponent implements OnInit {
  isLoggedIn$: Observable<any>;

  constructor(
    private authService: AuthService,
    private router: Router,
    private menuCtrl: MenuController,
    private localNotifications: LocalNotificationService,
    private browserNotifications: BrowserNotificationService,
    private invoiceService: InvoiceService
  ) {
    this.isLoggedIn$ = this.authService.currentUser$;
    addIcons({
      'wallet-outline': walletOutline,
      'grid-outline': gridOutline,
      'cash-outline': cashOutline,
      'business-outline': businessOutline,
      'bar-chart-outline': barChartOutline,
      'log-out-outline': logOutOutline,
      'notifications-outline': notificationsOutline,
      'person-circle-outline': personCircleOutline,
      'add-circle-outline': addCircleOutline,
      'person-add-outline': personAddOutline,
      'document-text-outline': documentTextOutline,
      'alert-circle-outline': alertCircleOutline,
      'people-outline': peopleOutline,
      'receipt-outline': receiptOutline,
      'cube-outline': cubeOutline,
      'settings-outline': settingsOutline
    });
  }

  ngOnInit(): void {
    // Request browser notification permission immediately on app load
    this.browserNotifications.requestPermission();

    // Wait for user to be logged in before checking invoices
    this.authService.currentUser$.pipe(
      filter(user => !!user),
      take(1)
    ).subscribe(() => {
      this.checkInvoicesOnStartup();
    });
  }

  // Fetch invoices on startup — schedule local notifications (native Android)
  // and fire browser notifications for any overdue invoices
  private checkInvoicesOnStartup(): void {
    this.invoiceService.getInvoices('', '', 1, 100).subscribe({
      next: (response) => {
        const relevant = response.data.filter(inv =>
          ['SENT', 'OVERDUE'].includes(inv.status)
        );

        // Schedule native local notifications (Android/iOS)
        this.localNotifications.initNotifications(relevant);

        // Fire browser notifications for every overdue invoice
        const overdue = relevant.filter(inv => inv.status === 'OVERDUE');
        overdue.forEach(inv => {
          this.browserNotifications.notify(
            'Invoice Overdue',
            `Invoice ${inv.document_number} is overdue. Follow up with your customer.`
          );
        });
      },
      error: (err) => console.error('Failed to fetch invoices for notifications:', err)
    });
  }

  async closeMenu() {
    await this.menuCtrl.close();
  }

  async logout() {
    await this.localNotifications.cancelAll();
    await this.authService.logout();
    this.router.navigate(['/login']);
  }
}
