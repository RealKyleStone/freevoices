import { Injectable } from '@angular/core';
import { LocalNotifications, ScheduleOptions } from '@capacitor/local-notifications';
import { Capacitor } from '@capacitor/core';
import { InvoiceListItem } from '../../features/invoices/services/invoice.service';

@Injectable({
  providedIn: 'root'
})
export class LocalNotificationService {

  // Entry point — call this once on app start after the user is logged in
  // It requests permission then checks all invoices and schedules notifications
  async initNotifications(invoices: InvoiceListItem[]): Promise<void> {
    // Local notifications only work on native Android/iOS, not in browser
    if (!Capacitor.isNativePlatform()) {
      console.log('Local notifications not available on web — skipping');
      return;
    }

    await this.requestPermission();
    await this.checkAndSchedule(invoices);
  }

  // Ask the user for notification permission
  private async requestPermission(): Promise<void> {
    let permStatus = await LocalNotifications.checkPermissions();

    if (permStatus.display === 'prompt') {
      permStatus = await LocalNotifications.requestPermissions();
    }

    if (permStatus.display !== 'granted') {
      console.warn('Local notification permission denied');
    }
  }

  // Loop through invoices and schedule the right notifications
  private async checkAndSchedule(invoices: InvoiceListItem[]): Promise<void> {
    const notifications: ScheduleOptions['notifications'] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    for (const invoice of invoices) {
      // Skip invoices with no due date, already paid/cancelled, or notifications muted
      if (!invoice.due_date || ['PAID', 'CANCELLED'].includes(invoice.status) || invoice.notifications_muted) continue;

      const dueDate = new Date(invoice.due_date);
      dueDate.setHours(0, 0, 0, 0);

      // Invoice is OVERDUE — fire an immediate notification
      if (invoice.status === 'OVERDUE') {
        notifications.push({
          id: invoice.id * 10,       // unique id based on invoice id
          title: 'Invoice Overdue',
          body: `Invoice ${invoice.document_number} is overdue. Follow up with your customer.`,
          schedule: { at: new Date(Date.now() + 3000) }, // 3 seconds from now
          sound: 'default',
          smallIcon: 'ic_stat_icon_config_sample',
          actionTypeId: '',
          extra: { invoiceId: invoice.id }
        });
      }

      // Invoice is due TOMORROW — schedule a reminder notification for 9am tomorrow
      if (invoice.status === 'SENT' && dueDate.getTime() === tomorrow.getTime()) {
        const fireAt = new Date(tomorrow);
        fireAt.setHours(9, 0, 0, 0);

        notifications.push({
          id: invoice.id * 10 + 1,  // different id from overdue notification
          title: 'Invoice Due Tomorrow',
          body: `Invoice ${invoice.document_number} is due tomorrow. Make sure to follow up.`,
          schedule: { at: fireAt },
          sound: 'default',
          smallIcon: 'ic_stat_icon_config_sample',
          actionTypeId: '',
          extra: { invoiceId: invoice.id }
        });
      }
    }

    // Only schedule if we have notifications to send
    if (notifications.length > 0) {
      await LocalNotifications.schedule({ notifications });
      console.log(`Scheduled ${notifications.length} local notification(s)`);
    }
  }

  // Cancel all pending notifications — useful on logout
  async cancelAll(): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    const pending = await LocalNotifications.getPending();
    if (pending.notifications.length > 0) {
      await LocalNotifications.cancel({ notifications: pending.notifications });
    }
  }

  // Cancel all pending notifications for a specific invoice (used on cancel or mute)
  async cancelForInvoice(invoiceId: number): Promise<void> {
    if (!Capacitor.isNativePlatform()) return;
    const ids = [
      { id: invoiceId * 10 },
      { id: invoiceId * 10 + 1 },
    ];
    try {
      await LocalNotifications.cancel({ notifications: ids });
    } catch (_) {}
  }
}
