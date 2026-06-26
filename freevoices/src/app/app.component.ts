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
    // Wait for the user to be logged in before checking invoices
    // filter(Boolean) skips null/undefined (not logged in)
    // take(1) means we only do this once per app launch
    this.authService.currentUser$.pipe(
      filter(user => !!user),
      take(1)
    ).subscribe(() => {
      this.scheduleInvoiceNotifications();
    });
  }

  // Fetch all SENT and OVERDUE invoices and pass them to the notification service
  private scheduleInvoiceNotifications(): void {
    this.invoiceService.getInvoices('', '', 1, 100).subscribe({
      next: (response) => {
        // Only care about invoices that are SENT or OVERDUE
        const relevant = response.data.filter(inv =>
          ['SENT', 'OVERDUE'].includes(inv.status)
        );
        this.localNotifications.initNotifications(relevant);
      },
      error: (err) => console.error('Failed to fetch invoices for notifications:', err)
    });
  }

  async closeMenu() {
    await this.menuCtrl.close();
  }

  async logout() {
    // Cancel all scheduled notifications on logout
    await this.localNotifications.cancelAll();
    await this.authService.logout();
    this.router.navigate(['/login']);
  }
}
