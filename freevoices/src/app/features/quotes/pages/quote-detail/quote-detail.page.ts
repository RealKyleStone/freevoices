import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { IonicModule, AlertController, ToastController } from '@ionic/angular';
import { QuoteService, QuoteDetail } from '../../services/quote.service';

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
  quoteId!: number;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private quoteService: QuoteService,
    private alertCtrl: AlertController,
    private toastCtrl: ToastController
  ) {}

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
      next: () => this.loadQuote(),
      error: async () => {
        const toast = await this.toastCtrl.create({ message: 'Failed to update quote', duration: 3000, color: 'danger', position: 'bottom' });
        await toast.present();
      }
    });
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
