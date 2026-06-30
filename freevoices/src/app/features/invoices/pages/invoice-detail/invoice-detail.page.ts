import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { IonicModule, AlertController, ToastController } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  createOutline, calendarOutline, alarmOutline, timeOutline, sendOutline,
  cashOutline, documentOutline, eyeOutline, downloadOutline,
  checkmarkCircleOutline, closeCircleOutline, ellipseOutline, shareSocialOutline, copyOutline, mailOutline,
  notificationsOutline, notificationsOffOutline, banOutline
} from 'ionicons/icons';
import { InvoiceService, InvoiceDetail } from '../../services/invoice.service';
import { environment } from '../../../../../environments/environment';
import { BrowserNotificationService } from '../../../../core/services/browser-notification.service';
import { LocalNotificationService } from '../../../../core/services/local-notification.service';

@Component({
  selector: 'app-invoice-detail',
  templateUrl: './invoice-detail.page.html',
  styleUrls: ['./invoice-detail.page.scss'],
  standalone: true,
  imports: [CommonModule, RouterModule, ReactiveFormsModule, IonicModule]
})
export class InvoiceDetailPage implements OnInit {
  invoice?: InvoiceDetail;
  isLoading = true;
  invoiceId!: number;
  showPaymentForm = false;
  paymentForm: FormGroup;
  isSubmittingPayment = false;
  isSending = false;
  isDownloading = false;
  isDownloadingReceipt = false;
  isSendingReceipt = false;
  isCancelling = false;
  isTogglingMute = false;
  isSharing = false;
  shareLink: string | null = null;

  readonly paymentMethods = [
    { value: 'BANK_TRANSFER', label: 'Bank Transfer' },
    { value: 'PAYFAST',       label: 'PayFast' },
    { value: 'PAYFLEX',       label: 'PayFlex' },
    { value: 'CARDANO',       label: 'Cardano' },
    { value: 'OTHER',         label: 'Other' }
  ];

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private invoiceService: InvoiceService,
    private alertCtrl: AlertController,
    private toastCtrl: ToastController,
    private fb: FormBuilder,
    private browserNotifications: BrowserNotificationService,
    private localNotifications: LocalNotificationService
  ) {
    addIcons({
      createOutline, calendarOutline, alarmOutline, timeOutline, sendOutline,
      cashOutline, documentOutline, eyeOutline, downloadOutline,
      checkmarkCircleOutline, closeCircleOutline, ellipseOutline,
      shareSocialOutline, copyOutline, mailOutline,
      notificationsOutline, notificationsOffOutline, banOutline
    });

    this.paymentForm = this.fb.group({
      amount:                [null, [Validators.required, Validators.min(0.01)]],
      payment_date:         [new Date().toISOString().split('T')[0], Validators.required],
      payment_method:       ['BANK_TRANSFER', Validators.required],
      transaction_reference: [''],
      notes:                ['']
    });
  }

  ngOnInit() {
    this.invoiceId = Number(this.route.snapshot.paramMap.get('id'));
    this.loadInvoice();
  }

  loadInvoice() {
    this.isLoading = true;
    this.invoiceService.getInvoice(this.invoiceId).subscribe({
      next: (invoice) => {
        this.invoice = invoice;
        this.isLoading = false;
        const paid = (invoice.payments || []).reduce((s, p) => s + +p.amount, 0);
        const outstanding = +invoice.total - paid;
        if (outstanding > 0) this.paymentForm.patchValue({ amount: outstanding.toFixed(2) });
      },
      error: async () => {
        this.isLoading = false;
        const toast = await this.toastCtrl.create({ message: 'Failed to load invoice', duration: 3000, color: 'danger', position: 'bottom' });
        await toast.present();
        this.router.navigate(['/invoices']);
      }
    });
  }

  getStatusColor(status: string): string {
    const map: Record<string, string> = {
      DRAFT: 'medium', SENT: 'primary', PAID: 'success', OVERDUE: 'warning', CANCELLED: 'danger'
    };
    return map[status] ?? 'medium';
  }

  getTrackingIcon(eventType: string): string {
    const map: Record<string, string> = {
      CREATED: 'document-outline', SENT: 'send-outline', VIEWED: 'eye-outline',
      DOWNLOADED: 'download-outline', PAID: 'checkmark-circle-outline', CANCELLED: 'close-circle-outline'
    };
    return map[eventType] ?? 'ellipse-outline';
  }

  async confirmSend() {
    const alert = await this.alertCtrl.create({
      header: 'Email Invoice',
      message: `Send this invoice as a PDF to ${this.invoice?.customer_email || 'the customer'}?`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Send Email', handler: () => this.sendInvoice() }
      ]
    });
    await alert.present();
  }

  async sendInvoice() {
    this.isSending = true;
    this.invoiceService.sendInvoice(this.invoiceId).subscribe({
      next: async (res: any) => {
        this.isSending = false;
        const color = res.emailFailed ? 'warning' : 'success';
        const toast = await this.toastCtrl.create({ message: res.message || 'Invoice sent', duration: 4000, color, position: 'bottom' });
        await toast.present();
        // Browser notification — fires even if tab is minimized
        this.browserNotifications.notify(
          'Invoice Sent',
          `Invoice ${this.invoice?.document_number} has been sent to ${this.invoice?.customer_email}.`
        );
        this.loadInvoice();
      },
      error: async (err) => {
        this.isSending = false;
        const toast = await this.toastCtrl.create({ message: err.error?.message || 'Failed to send invoice', duration: 3000, color: 'danger', position: 'bottom' });
        await toast.present();
      }
    });
  }

  async downloadPdf(markSent = false) {
    this.isDownloading = true;
    const token = localStorage.getItem('token');
    try {
      const url = `${environment.apiUrl}/invoices/${this.invoiceId}/pdf${markSent ? '?markSent=true' : ''}`;
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error('Failed to generate PDF');
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${this.invoice?.document_number || 'invoice'}.pdf`;
      a.click();
      URL.revokeObjectURL(blobUrl);
      if (markSent) this.loadInvoice();
    } catch {
      const toast = await this.toastCtrl.create({ message: 'Failed to download PDF', duration: 3000, color: 'danger', position: 'bottom' });
      await toast.present();
    } finally {
      this.isDownloading = false;
    }
  }

  async downloadReceipt() {
    this.isDownloadingReceipt = true;
    const token = localStorage.getItem('token');
    try {
      const url = `${environment.apiUrl}/invoices/${this.invoiceId}/receipt`;
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error('Failed to generate receipt');
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `RECEIPT-${this.invoice?.document_number || 'receipt'}.pdf`;
      a.click();
      URL.revokeObjectURL(blobUrl);
      // Browser notification — fires when receipt is successfully downloaded
      this.browserNotifications.notify(
        'Receipt Downloaded',
        `Receipt for invoice ${this.invoice?.document_number} has been downloaded.`
      );
    } catch {
      const toast = await this.toastCtrl.create({ message: 'Failed to download receipt', duration: 3000, color: 'danger', position: 'bottom' });
      await toast.present();
    } finally {
      this.isDownloadingReceipt = false;
    }
  }

  async confirmSendReceipt() {
    const alert = await this.alertCtrl.create({
      header: 'Email Receipt',
      message: `Send the payment receipt to ${this.invoice?.customer_email || 'the customer'}?`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Send Receipt', handler: () => this.sendReceipt() }
      ]
    });
    await alert.present();
  }

  async sendReceipt() {
    this.isSendingReceipt = true;
    this.invoiceService.sendReceipt(this.invoiceId).subscribe({
      next: async (res: any) => {
        this.isSendingReceipt = false;
        const color = res.emailFailed ? 'warning' : 'success';
        const toast = await this.toastCtrl.create({ message: res.message || 'Receipt sent', duration: 4000, color, position: 'bottom' });
        await toast.present();
        this.browserNotifications.notify(
          'Receipt Sent',
          `Receipt for invoice ${this.invoice?.document_number} has been sent to ${this.invoice?.customer_email}.`
        );
      },
      error: async (err) => {
        this.isSendingReceipt = false;
        const toast = await this.toastCtrl.create({ message: err.error?.message || 'Failed to send receipt', duration: 3000, color: 'danger', position: 'bottom' });
        await toast.present();
      }
    });
  }

  async confirmDownload() {
    if (this.invoice?.status === 'DRAFT') {
      const alert = await this.alertCtrl.create({
        header: 'Download Invoice',
        message: 'Do you want to mark this invoice as sent?',
        buttons: [
          { text: 'No, keep as draft', handler: () => this.downloadPdf(false) },
          { text: 'Yes, mark as sent', handler: () => this.downloadPdf(true) }
        ]
      });
      await alert.present();
    } else {
      this.downloadPdf(false);
    }
  }

  togglePaymentForm() {
    this.showPaymentForm = !this.showPaymentForm;
  }

  submitPayment() {
    if (this.paymentForm.invalid) { this.paymentForm.markAllAsTouched(); return; }
    this.isSubmittingPayment = true;
    this.invoiceService.markPaid(this.invoiceId, this.paymentForm.value).subscribe({
      next: async () => {
        this.showPaymentForm = false;
        const toast = await this.toastCtrl.create({ message: 'Payment recorded', duration: 2500, color: 'success', position: 'bottom' });
        await toast.present();
        // Browser notification — fires when payment is recorded
        this.browserNotifications.notify(
          'Invoice Paid',
          `Invoice ${this.invoice?.document_number} has been marked as paid.`
        );
        this.loadInvoice();
        this.isSubmittingPayment = false;
      },
      error: async (err) => {
        this.isSubmittingPayment = false;
        const toast = await this.toastCtrl.create({ message: err.error?.message || 'Failed to record payment', duration: 3000, color: 'danger', position: 'bottom' });
        await toast.present();
      }
    });
  }

  get totalPaid(): number {
    return (this.invoice?.payments || []).reduce((s, p) => s + +p.amount, 0);
  }

  get canEdit(): boolean { return this.invoice?.status === 'DRAFT'; }
  get canSend(): boolean { return ['DRAFT', 'SENT'].includes(this.invoice?.status ?? ''); }
  get canMarkPaid(): boolean { return !['PAID', 'CANCELLED'].includes(this.invoice?.status ?? ''); }
  get canCancel(): boolean { return !['PAID', 'CANCELLED'].includes(this.invoice?.status ?? ''); }
  get currencySymbol(): string { return this.invoice?.currency_symbol || 'R'; }

  async generateShareLink() {
    this.isSharing = true;
    this.invoiceService.shareInvoice(this.invoiceId).subscribe({
      next: async (res) => {
        this.isSharing = false;
        this.shareLink = res.share_url;
      },
      error: async () => {
        this.isSharing = false;
        const toast = await this.toastCtrl.create({ message: 'Failed to generate share link', duration: 3000, color: 'danger', position: 'bottom' });
        await toast.present();
      }
    });
  }

  async copyShareLink() {
    if (!this.shareLink) return;
    await navigator.clipboard.writeText(this.shareLink);
    const toast = await this.toastCtrl.create({ message: 'Link copied to clipboard', duration: 2000, color: 'success', position: 'bottom' });
    await toast.present();
  }

  async confirmCancel() {
    const alert = await this.alertCtrl.create({
      header: 'Cancel Invoice',
      message: `Are you sure you want to cancel invoice ${this.invoice?.document_number}? This cannot be undone.`,
      buttons: [
        { text: 'Keep invoice', role: 'cancel' },
        { text: 'Cancel invoice', role: 'destructive', handler: () => this.performCancel() }
      ]
    });
    await alert.present();
  }

  async performCancel() {
    this.isCancelling = true;
    this.invoiceService.cancelInvoice(this.invoiceId).subscribe({
      next: async () => {
        this.isCancelling = false;
        await this.localNotifications.cancelForInvoice(this.invoiceId);
        const toast = await this.toastCtrl.create({ message: 'Invoice cancelled', duration: 3000, color: 'medium', position: 'bottom' });
        await toast.present();
        this.loadInvoice();
      },
      error: async (err) => {
        this.isCancelling = false;
        const toast = await this.toastCtrl.create({ message: err.error?.message || 'Failed to cancel invoice', duration: 3000, color: 'danger', position: 'bottom' });
        await toast.present();
      }
    });
  }

  async toggleNotificationMute() {
    if (!this.invoice) return;
    const newMuted = !this.invoice.notifications_muted;
    this.isTogglingMute = true;
    this.invoiceService.setNotificationsMuted(this.invoiceId, newMuted).subscribe({
      next: async (res) => {
        this.isTogglingMute = false;
        if (newMuted) {
          await this.localNotifications.cancelForInvoice(this.invoiceId);
        }
        const toast = await this.toastCtrl.create({
          message: newMuted ? 'Notifications muted for this invoice' : 'Notifications enabled for this invoice',
          duration: 2500, color: 'primary', position: 'bottom'
        });
        await toast.present();
        this.loadInvoice();
      },
      error: async () => {
        this.isTogglingMute = false;
        const toast = await this.toastCtrl.create({ message: 'Failed to update notification settings', duration: 3000, color: 'danger', position: 'bottom' });
        await toast.present();
      }
    });
  }
}
