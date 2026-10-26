import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import {
  AlertController, ToastController, IonBackButton, IonButton, IonButtons, IonContent,
  IonHeader, IonIcon, IonRouterLink, IonSpinner, IonToolbar,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import {
  createOutline, calendarOutline, timerOutline, timeOutline,
  sendOutline, documentTextOutline, downloadOutline,
  documentOutline, eyeOutline, checkmarkCircleOutline, closeCircleOutline, ellipseOutline
} from 'ionicons/icons';
import { QuoteService, QuoteDetail } from '../../services/quote.service';
import { environment } from '../../../../../environments/environment';
import { BrowserNotificationService } from '../../../../core/services/browser-notification.service';

@Component({
  selector: 'app-quote-detail',
  templateUrl: './quote-detail.page.html',
  styleUrls: ['./quote-detail.page.scss'],
  standalone: true,
  imports: [
    CommonModule, RouterModule, IonBackButton, IonButton, IonButtons, IonContent, IonHeader,
    IonIcon, IonRouterLink, IonSpinner, IonToolbar,
  ]
})
export class QuoteDetailPage implements OnInit {
  quote?: QuoteDetail;
  isLoading = true;
  isConverting = false;
  isDownloading = false;
  isSharing = false;
  shareLink: string | null = null;
  shareExpiry: string | null = null;
  quoteId!: number;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private quoteService: QuoteService,
    private alertCtrl: AlertController,
    private toastCtrl: ToastController,
    private browserNotifications: BrowserNotificationService
  ) {
    addIcons({
      createOutline, calendarOutline, timerOutline, timeOutline,
      sendOutline, documentTextOutline, downloadOutline,
      documentOutline, eyeOutline, checkmarkCircleOutline, closeCircleOutline, ellipseOutline
    });
  }

  ngOnInit() {
    this.quoteId = Number(this.route.snapshot.paramMap.get('id'));
  }

  // Reloaded on every entry rather than once in ngOnInit: Ionic reuses this
  // page when returning from Edit, which otherwise showed the old values.
  ionViewWillEnter() {
    this.loadQuote();
  }

  loadQuote() {
    this.isLoading = true;
    this.quoteService.getQuote(this.quoteId).subscribe({
      next: (quote) => { this.quote = quote; this.isLoading = false; },
      error: async () => {
        this.isLoading = false;
        const toast = await this.toastCtrl.create({ message: 'Failed to load quote', duration: 3000, color: 'danger', position: 'bottom' });
        await toast.present();
        this.router.navigate(['/quotes']);
      }
    });
  }

  getStatusColor(status: string): string {
    const map: Record<string, string> = {
      DRAFT: 'medium', SENT: 'primary', ACCEPTED: 'success', CONVERTED: 'success', EXPIRED: 'warning', DECLINED: 'danger', OVERDUE: 'warning', CANCELLED: 'danger'
    };
    return map[status] ?? 'medium';
  }

  getTrackingIcon(eventType: string): string {
    const map: Record<string, string> = {
      CREATED: 'document-outline', SENT: 'send-outline', VIEWED: 'eye-outline',
      DOWNLOADED: 'download-outline', PAID: 'checkmark-circle-outline', CANCELLED: 'close-circle-outline',
      CONVERTED: 'document-text-outline', ACCEPTED: 'checkmark-circle-outline', DECLINED: 'close-circle-outline'
    };
    return map[eventType] ?? 'ellipse-outline';
  }

  getTrackingLabel(eventType: string): string {
    if (eventType === 'CONVERTED') return 'Converted to invoice';
    return eventType.charAt(0) + eventType.slice(1).toLowerCase();
  }

  async confirmSend() {
    const alert = await this.alertCtrl.create({
      header: 'Mark as Sent',
      message: 'Mark this quote as sent to the customer?',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Mark Sent', handler: () => this.sendQuote() }
      ]
    });
    await alert.present();
  }

  sendQuote() {
    this.quoteService.sendQuote(this.quoteId).subscribe({
      next: async () => {
        // Browser notification — fires when quote is marked as sent
        this.browserNotifications.notify(
          'Quote Sent',
          `Quote ${this.quote?.document_number} has been marked as sent to ${this.quote?.customer_name}.`
        );
        this.loadQuote();
      },
      error: async () => {
        const toast = await this.toastCtrl.create({ message: 'Failed to update quote', duration: 3000, color: 'danger', position: 'bottom' });
        await toast.present();
      }
    });
  }

  shareQuote(rotate = false) {
    this.isSharing = true;
    this.quoteService.shareQuote(this.quoteId, rotate).subscribe({
      next: response => { this.isSharing = false; this.shareLink = response.share_url; this.shareExpiry = response.expires_at; this.loadQuote(); },
      error: async err => {
        this.isSharing = false;
        const toast = await this.toastCtrl.create({ message: err.error?.message || 'Could not create quote link', duration: 3000, color: 'danger' });
        await toast.present();
      }
    });
  }

  async copyShareLink() {
    if (!this.shareLink) return;
    try {
      await navigator.clipboard.writeText(this.shareLink);
      const toast = await this.toastCtrl.create({ message: 'Quote link copied', duration: 2000, color: 'success' });
      await toast.present();
    } catch {
      const toast = await this.toastCtrl.create({ message: 'Copy failed. Select the link below to copy it.', duration: 3000, color: 'warning' });
      await toast.present();
    }
  }

  async shareViaDevice() {
    if (!this.shareLink) return;
    if (!navigator.share) return this.copyShareLink();
    try { await navigator.share({ title: `Quote ${this.quote?.document_number}`, url: this.shareLink }); }
    catch (error) { if ((error as DOMException).name !== 'AbortError') {
      const toast = await this.toastCtrl.create({ message: 'Could not open sharing. Copy the link instead.', duration: 3000, color: 'warning' });
      await toast.present();
    } }
  }

  async manageShare(rotate: boolean) {
    const alert = await this.alertCtrl.create({ header: rotate ? 'Replace quote link?' : 'Revoke quote link?', message: 'The current customer link will stop working.', buttons: [
      { text: 'Keep link', role: 'cancel' },
      { text: rotate ? 'Replace link' : 'Revoke link', role: 'destructive', handler: () => {
        if (rotate) this.shareQuote(true);
        else this.quoteService.revokeShare(this.quoteId).subscribe({ next: () => { this.shareLink = null; this.shareExpiry = null; }, error: async () => {
          const toast = await this.toastCtrl.create({ message: 'Could not revoke quote link', duration: 3000, color: 'danger' }); await toast.present();
        } });
      } }
    ] });
    await alert.present();
  }

  async downloadPdf() {
    this.isDownloading = true;
    const token = localStorage.getItem('token');
    try {
      const url = `${environment.apiUrl}/quotes/${this.quoteId}/pdf`;
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error('Failed to generate PDF');
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${this.quote?.document_number || 'quote'}.pdf`;
      a.click();
      URL.revokeObjectURL(blobUrl);
      // Browser notification — fires when quote PDF is downloaded
      this.browserNotifications.notify(
        'Quote Downloaded',
        `Quote ${this.quote?.document_number} has been downloaded as a PDF.`
      );
    } catch {
      const toast = await this.toastCtrl.create({ message: 'Failed to download quote', duration: 3000, color: 'danger', position: 'bottom' });
      await toast.present();
    } finally {
      this.isDownloading = false;
    }
  }

  async confirmConvert() {
    const alert = await this.alertCtrl.create({
      header: 'Convert to Invoice',
      message: this.cancelledInvoices.length
        ? `This will create a new DRAFT invoice from this quote. The earlier invoice ${this.cancelledInvoices.map(i => i.document_number).join(', ')} was cancelled. Continue?`
        : 'This will create a new DRAFT invoice from this quote. Continue?',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Convert', handler: () => this.convertToInvoice() }
      ]
    });
    await alert.present();
  }

  convertToInvoice() {
    this.isConverting = true;
    this.quoteService.convertToInvoice(this.quoteId).subscribe({
      next: async (res) => {
        this.isConverting = false;
        const toast = await this.toastCtrl.create({ message: res.message || 'Invoice created from quote', duration: 2500, color: 'success', position: 'bottom' });
        await toast.present();
        // Browser notification — fires when quote is converted to invoice
        this.browserNotifications.notify(
          'Quote Converted',
          `Quote ${this.quote?.document_number} has been successfully converted to an invoice.`
        );
        this.router.navigate(['/invoices', res.invoice_id]);
      },
      error: async (err) => {
        this.isConverting = false;
        // Already converted (another tab, or a retry after a dropped
        // connection): take the user to the invoice that exists rather than
        // making a second one.
        if (err.status === 409 && err.error?.invoice_id) {
          const toast = await this.toastCtrl.create({ message: err.error.message, duration: 3500, color: 'warning', position: 'bottom' });
          await toast.present();
          this.router.navigate(['/invoices', err.error.invoice_id]);
          return;
        }
        const toast = await this.toastCtrl.create({ message: err.error?.message || 'Failed to convert quote', duration: 3000, color: 'danger', position: 'bottom' });
        await toast.present();
      }
    });
  }

  get canEdit(): boolean { return this.quote?.status === 'DRAFT'; }
  get canSend(): boolean { return ['DRAFT', 'SENT'].includes(this.quote?.status ?? ''); }
  get canShare(): boolean { return ['DRAFT', 'SENT', 'ACCEPTED'].includes(this.quote?.status ?? ''); }
  /** The invoice this quote became, if it has not been cancelled. */
  get activeInvoice() {
    return (this.quote?.converted_invoices || []).find(i => i.status !== 'CANCELLED');
  }
  get cancelledInvoices() {
    return (this.quote?.converted_invoices || []).filter(i => i.status === 'CANCELLED');
  }
  // One live invoice per quote; the server enforces the same rule.
  get canConvert(): boolean { return !['CANCELLED', 'DECLINED', 'EXPIRED'].includes(this.quote?.status ?? '') && !this.activeInvoice; }
  get currencySymbol(): string { return this.quote?.currency_symbol || 'R'; }
}
