import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { IonicModule, AlertController, ToastController } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  createOutline, calendarOutline, timerOutline, timeOutline,
  sendOutline, documentTextOutline, downloadOutline
} from 'ionicons/icons';
import { QuoteService, QuoteDetail } from '../../services/quote.service';
import { environment } from '../../../../../environments/environment';
import { BrowserNotificationService } from '../../../../core/services/browser-notification.service';

@Component({
  selector: 'app-quote-detail',
  templateUrl: './quote-detail.page.html',
  styleUrls: ['./quote-detail.page.scss'],
  standalone: true,
  imports: [CommonModule, RouterModule, IonicModule]
})
export class QuoteDetailPage implements OnInit {
  quote?: QuoteDetail;
  isLoading = true;
  isConverting = false;
  isDownloading = false;
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
      sendOutline, documentTextOutline, downloadOutline
    });
  }

  ngOnInit() {
    this.quoteId = Number(this.route.snapshot.paramMap.get('id'));
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
      DRAFT: 'medium', SENT: 'primary', ACCEPTED: 'success', EXPIRED: 'warning', CANCELLED: 'danger'
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
      message: 'This will create a new DRAFT invoice from this quote. Continue?',
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
        const toast = await this.toastCtrl.create({ message: 'Invoice created from quote', duration: 2500, color: 'success', position: 'bottom' });
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
        const toast = await this.toastCtrl.create({ message: err.error?.message || 'Failed to convert quote', duration: 3000, color: 'danger', position: 'bottom' });
        await toast.present();
      }
    });
  }

  get canEdit(): boolean { return this.quote?.status === 'DRAFT'; }
  get canSend(): boolean { return ['DRAFT', 'SENT'].includes(this.quote?.status ?? ''); }
  get canConvert(): boolean { return this.quote?.status !== 'CANCELLED'; }
}
