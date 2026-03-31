import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { IonicModule, AlertController, ToastController } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  createOutline, calendarOutline, alarmOutline, timeOutline, sendOutline,
  cashOutline, documentOutline, eyeOutline, downloadOutline,
  checkmarkCircleOutline, closeCircleOutline, ellipseOutline
} from 'ionicons/icons';
import { InvoiceService, InvoiceDetail } from '../../services/invoice.service';
import { environment } from '../../../../../environments/environment';

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
    private fb: FormBuilder
  ) {
    addIcons({
      createOutline, calendarOutline, alarmOutline, timeOutline, sendOutline,
      cashOutline, documentOutline, eyeOutline, downloadOutline,
      checkmarkCircleOutline, closeCircleOutline, ellipseOutline
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
        this.loadInvoice();
      },
      error: async (err) => {
        this.isSending = false;
        const toast = await this.toastCtrl.create({ message: err.error?.message || 'Failed to send invoice', duration: 3000, color: 'danger', position: 'bottom' });
        await toast.present();
      }
    });
  }

  async downloadPdf() {
    this.isDownloading = true;
    const token = localStorage.getItem('token');
    try {
      const response = await fetch(`${environment.apiUrl}/invoices/${this.invoiceId}/pdf`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!response.ok) throw new Error('Failed to generate PDF');
      const blob = await response.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `${this.invoice?.document_number || 'invoice'}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      const toast = await this.toastCtrl.create({ message: 'Failed to download PDF', duration: 3000, color: 'danger', position: 'bottom' });
      await toast.present();
    } finally {
      this.isDownloading = false;
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

  get canEdit(): boolean {
    return this.invoice?.status === 'DRAFT';
  }

  get canSend(): boolean {
    return ['DRAFT', 'SENT'].includes(this.invoice?.status ?? '');
  }

  get canMarkPaid(): boolean {
    return !['PAID', 'CANCELLED'].includes(this.invoice?.status ?? '');
  }
}
