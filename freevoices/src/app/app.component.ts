import { Component, OnInit } from '@angular/core';
import { Router, RouterModule } from '@angular/router';
import { IonApp, IonSplitPane, IonMenu, IonContent, IonList,
         IonMenuToggle, IonItem, IonIcon, IonLabel, IonFooter,
         IonRouterOutlet, MenuController } from '@ionic/angular/standalone';
import { AuthService } from './core/auth/services/auth.service';
import { CommonModule } from '@angular/common';
import { addIcons } from 'ionicons';
import {
  walletOutline, gridOutline, cashOutline, businessOutline,
  barChartOutline, logOutOutline, notificationsOutline,
  personCircleOutline, addCircleOutline, personAddOutline,
  documentTextOutline, alertCircleOutline, peopleOutline,
  receiptOutline, cubeOutline, settingsOutline,
  sunnyOutline, moonOutline, add, addOutline,
  chevronBackOutline, chevronForwardOutline, createOutline,
  trashOutline, sendOutline, downloadOutline,
  checkmarkCircleOutline, closeCircleOutline, eyeOutline,
  shareSocialOutline, copyOutline, calendarOutline, alarmOutline,
  timeOutline, documentOutline, mailOutline, callOutline,
  locationOutline, navigateOutline, pricetagOutline, timerOutline
} from 'ionicons/icons';
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
    RouterModule, CommonModule,
    IonApp, IonSplitPane, IonMenu, IonContent, IonList,
    IonMenuToggle, IonItem, IonIcon, IonLabel, IonFooter,
    IonRouterOutlet
  ]
})
export class AppComponent implements OnInit {
  isLoggedIn$: Observable<any>;
  isDarkMode = false;

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
      walletOutline, gridOutline, cashOutline, businessOutline,
      barChartOutline, logOutOutline, notificationsOutline,
      personCircleOutline, addCircleOutline, personAddOutline,
      documentTextOutline, alertCircleOutline, peopleOutline,
      receiptOutline, cubeOutline, settingsOutline,
      sunnyOutline, moonOutline, add, addOutline,
      chevronBackOutline, chevronForwardOutline, createOutline,
      trashOutline, sendOutline, downloadOutline,
      checkmarkCircleOutline, closeCircleOutline, eyeOutline,
      shareSocialOutline, copyOutline, calendarOutline, alarmOutline,
      timeOutline, documentOutline, mailOutline, callOutline,
      locationOutline, navigateOutline, pricetagOutline, timerOutline
    });
  }

  ngOnInit(): void {
    this.initTheme();
    this.browserNotifications.requestPermission();
    this.authService.currentUser$.pipe(filter(user => !!user), take(1)).subscribe(() => {
      this.checkInvoicesOnStartup();
    });
  }

  initTheme() {
    const saved = localStorage.getItem('fv-theme');
    if (saved) {
      this.isDarkMode = saved === 'dark';
    } else {
      const hour = new Date().getHours();
      this.isDarkMode = hour >= 18 || hour < 6;
    }
    this.applyTheme();
  }

  toggleTheme() {
    this.isDarkMode = !this.isDarkMode;
    localStorage.setItem('fv-theme', this.isDarkMode ? 'dark' : 'light');
    this.applyTheme();
  }

  applyTheme() {
    const toggle = this.isDarkMode;
    document.body.classList.toggle('ion-palette-dark', toggle);
    document.documentElement.classList.toggle('ion-palette-dark', toggle);
    const ionApp = document.querySelector('ion-app');
    if (ionApp) ionApp.classList.toggle('ion-palette-dark', toggle);
  }

  private checkInvoicesOnStartup(): void {
    this.invoiceService.getInvoices('', '', 1, 100).subscribe({
      next: (response) => {
        const relevant = response.data.filter((inv: any) => ['SENT', 'OVERDUE'].includes(inv.status));
        this.localNotifications.initNotifications(relevant);
        const overdue = relevant.filter((inv: any) => inv.status === 'OVERDUE');
        overdue.forEach((inv: any) => {
          this.browserNotifications.notify('Invoice Overdue', `Invoice ${inv.document_number} is overdue.`);
        });
      },
      error: (err) => console.error('Failed to fetch invoices for notifications:', err)
    });
  }

  async closeMenu() { await this.menuCtrl.close(); }

  async logout() {
    await this.authService.logout();
    this.router.navigate(['/login']);
  }
}