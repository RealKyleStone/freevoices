import { Component, OnInit, OnDestroy } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, Router } from '@angular/router';
import { IonicModule, AlertController } from '@ionic/angular';
import { CurrencyPipe } from '@angular/common';
import { DashboardService, DashboardSummary } from '../../services/dashboard.service';
import { AuthService } from 'src/app/core/auth/services/auth.service';

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.page.html',
  styleUrls: ['./dashboard.page.scss'],
  standalone: true,
  imports: [CommonModule, RouterModule, IonicModule, CurrencyPipe]
})
export class DashboardPage implements OnInit, OnDestroy {
  selectedCurrency = 'ZAR';
  isLoading = true;
  today = new Date();
  companyName = '';
  userEmail = '';
  private clockInterval: any;

  summary: DashboardSummary = {
    monthRevenue: 0,
    totalCustomers: 0,
    openInvoices: 0,
    overdueInvoices: 0,
    recentActivity: []
  };

  constructor(
    private dashboardService: DashboardService,
    private authService: AuthService,
    private alertCtrl: AlertController,
    private router: Router
  ) {}

  ngOnInit() {
    const user = this.authService.getCurrentUser();
    this.companyName = user?.company_name ?? '';
    this.userEmail = user?.email ?? '';

    // Update clock every minute
    this.clockInterval = setInterval(() => {
      this.today = new Date();
    }, 60000);

    this.dashboardService.getSummary().subscribe({
      next: (data) => { this.summary = data; this.isLoading = false; },
      error: () => { this.isLoading = false; }
    });
  }

  ngOnDestroy() {
    if (this.clockInterval) clearInterval(this.clockInterval);
  }

  getGreeting(): string {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good morning';
    if (hour < 18) return 'Good afternoon';
    return 'Good evening';
  }

  async openNotifications() {
    const hasOverdue = this.summary.overdueInvoices > 0;
    const alert = await this.alertCtrl.create({
      header: 'Notifications',
      message: hasOverdue
        ? `You have ${this.summary.overdueInvoices} overdue invoice${this.summary.overdueInvoices > 1 ? 's' : ''} that need attention.`
        : 'You\'re all caught up! No new notifications.',
      buttons: hasOverdue
        ? [
            { text: 'Dismiss', role: 'cancel' },
            { text: 'View invoices', handler: () => this.router.navigate(['/invoices'], { queryParams: { status: 'OVERDUE' } }) }
          ]
        : [{ text: 'OK', role: 'cancel' }]
    });
    await alert.present();
  }

  async openProfile(event: Event) {
    const alert = await this.alertCtrl.create({
      header: this.companyName || 'My Account',
      message: this.userEmail,
      buttons: [
        { text: 'Settings', handler: () => this.router.navigate(['/settings']) },
        { text: 'Sign out', role: 'destructive', handler: () => this.logout() },
        { text: 'Cancel', role: 'cancel' }
      ]
    });
    await alert.present();
  }

  async logout() {
    await this.authService.logout();
    this.router.navigate(['/login']);
  }

  getActivityIcon(eventType: string): string {
    const icons: Record<string, string> = {
      PAID: 'checkmark-circle-outline', SENT: 'send-outline',
      CANCELLED: 'close-circle-outline', OVERDUE: 'alert-circle-outline',
      VIEWED: 'eye-outline', DOWNLOADED: 'download-outline', CREATED: 'document-outline'
    };
    return icons[eventType] ?? 'document-outline';
  }

  getActivityColor(eventType: string): string {
    const colors: Record<string, string> = {
      PAID: 'success', OVERDUE: 'danger', CANCELLED: 'medium',
      SENT: 'primary', VIEWED: 'primary', DOWNLOADED: 'primary', CREATED: 'medium'
    };
    return colors[eventType] ?? 'medium';
  }

  formatEventType(eventType: string): string {
    const labels: Record<string, string> = {
      CREATED: 'Created', SENT: 'Sent', VIEWED: 'Viewed',
      DOWNLOADED: 'Downloaded', PAID: 'Paid', CANCELLED: 'Cancelled', OVERDUE: 'Overdue'
    };
    return labels[eventType] ?? eventType;
  }

  getActivityBadgeClass(eventType: string): string {
    const classes: Record<string, string> = {
      PAID: 'badge-success', OVERDUE: 'badge-danger', CANCELLED: 'badge-medium',
      SENT: 'badge-info', VIEWED: 'badge-info', DOWNLOADED: 'badge-info', CREATED: 'badge-medium'
    };
    return classes[eventType] ?? 'badge-medium';
  }
}