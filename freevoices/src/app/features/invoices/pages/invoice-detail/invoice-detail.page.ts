import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import {
  AlertController, ToastController,
  IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonInput, IonItem,
  IonLabel, IonList, IonRouterLink, IonSelect, IonSelectOption, IonSpinner, IonText,
  IonTextarea, IonToolbar,
} from '@ionic/angular/standalone';
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
import { todayLocalIso } from '../../../../shared/utils/document-math';

@Component({
  selector: 'app-invoice-detail',
  templateUrl: './invoice-detail.page.html',
  styleUrls: ['./invoice-detail.page.scss'],
  standalone: true,
  imports: [
    CommonModule, RouterModule, ReactiveFormsModule,
    IonBackButton, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonInput, IonItem,
    IonLabel, IonList, IonRouterLink, IonSelect, IonSelectOption, IonSpinner, IonText,
    IonTextarea, IonToolbar,
  ]
})
export class InvoiceDetailPage implements OnInit {
  invoice?: InvoiceDetail;
  isLoading = true;
  invoiceId!: number;
  showPaymentForm = false;
  paymentForm: FormGroup;
  isSubmittingPayment = false;
  showCreditForm = false;
  showRefundForm = false;
  creditForm: FormGroup;
  refundForm: FormGroup;
  isSavingAdjustment = false;
  private creditRetry?: {fingerprint:string;key:string};
  private refundRetry?: {fingerprint:string;key:string};
  isSending = false;
  isDownloading = false;
  isDownloadingReceipt = false;
  isSendingReceipt = false;
  isCancelling = false;
  isTogglingMute = false;
  isSharing = false;
  shareLink: string | null = null;
  shareExpiry: string | null = null;
  private resendKey?: string;
  private receiptResendKey?: string;

  readonly paymentMethods = [
    { value: 'BANK_TRANSFER', label: 'Bank Transfer' },
    { value: 'PAYFAST',       label: 'PayFast' },
    { value: 'PAYFLEX',       label: 'PayFlex' },
    { value: 'CARDANO',       label: 'Cardano' },
    { value: 'OTHER',         label: 'Other' }
  ];

  /**
   * Display label for a stored payment method.
   *
   * The payment history rendered the raw column value, so a recorded
   * payment read "BANK_TRANSFER". These labels already existed for the
   * select above; this just reuses them for display. Unknown values fall
   * through unchanged rather than being hidden.
   */
  paymentMethodLabel(value: string): string {
    return this.paymentMethods.find(m => m.value === value)?.label ?? value;
  }

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
      payment_date:         [todayLocalIso(), Validators.required],
      payment_method:       ['BANK_TRANSFER', Validators.required],
      transaction_reference: [''],
      notes:                ['']
    });
    this.creditForm = this.fb.group({
      subtotal:[null,[Validators.required,Validators.min(0)]],vat_amount:[0,[Validators.required,Validators.min(0)]],
      reason:['',Validators.required],description:['',Validators.required]
    });
    this.refundForm = this.fb.group({
      payment_id:[null,Validators.required],amount:[null,[Validators.required,Validators.min(0.01)]],
      refund_date:[todayLocalIso(),Validators.required],method:['BANK_TRANSFER',Validators.required],reference:[''],reason:['',Validators.required]
    });
  }

  ngOnInit() {
    this.invoiceId = Number(this.route.snapshot.paramMap.get('id'));
  }

  // Reloaded on every entry rather than once in ngOnInit: Ionic reuses this
  // page when returning from Edit, which otherwise showed the old values.
  ionViewWillEnter() {
    this.loadInvoice();
  }

  loadInvoice() {
    this.isLoading = true;
    this.invoiceService.getInvoice(this.invoiceId).subscribe({
      next: (invoice) => {
        this.invoice = invoice;
        this.isLoading = false;
        // Default to, and cap at, what is still owed. The server rejects more
        // than the balance; this says so before the round trip.
        const balance = +invoice.balance_due;
        const amount = this.paymentForm.get('amount')!;
        amount.setValidators([Validators.required, Validators.min(0.01), Validators.max(balance)]);
        amount.setValue(balance > 0 ? balance.toFixed(2) : null);
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
      DRAFT: 'medium', SENT: 'primary', PAID: 'success', CREDITED:'success', OVERDUE: 'warning', CANCELLED: 'danger'
    };
    return map[status] ?? 'medium';
  }

  getTrackingIcon(eventType: string): string {
    const map: Record<string, string> = {
      CREATED: 'document-outline', SENT: 'send-outline', VIEWED: 'eye-outline',
      DOWNLOADED: 'download-outline', PAID: 'checkmark-circle-outline', CANCELLED: 'close-circle-outline',
      PAYMENT: 'cash-outline', CREDIT_NOTE:'document-outline', REFUND:'cash-outline', OVERDUE: 'alarm-outline'
    };
    return map[eventType] ?? 'ellipse-outline';
  }

  getTrackingLabel(eventType: string): string {
    const map: Record<string, string> = {
      PAYMENT: 'Part payment received', PAID: 'Paid in full', CREDIT_NOTE:'Credit note issued', REFUND:'Refund recorded'
    };
    return map[eventType] ?? eventType.charAt(0) + eventType.slice(1).toLowerCase();
  }

  async confirmSend() {
    const alert = await this.alertCtrl.create({
      header: 'Email Invoice',
      message: `${this.invoice?.delivery_status === 'UNCERTAIN' ? 'Check your email provider before resending: a previous attempt may have been accepted. ' : ''}Send this invoice as a PDF to ${this.invoice?.customer_email || 'the customer'}?`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Send Email', handler: () => this.sendInvoice() }
      ]
    });
    await alert.present();
  }

  async sendInvoice() {
    this.isSending = true;
    this.invoiceService.sendInvoice(this.invoiceId, this.resendKey ||= ['ACCEPTED','UNCERTAIN'].includes(this.invoice?.delivery_status || '') ? crypto.randomUUID() : undefined).subscribe({
      next: async (res: any) => {
        this.isSending = false;
        const color = res.emailFailed ? 'warning' : 'success';
        const toast = await this.toastCtrl.create({ message: res.message || 'Invoice sent', duration: 4000, color, position: 'bottom' });
        await toast.present();
        // Browser notification — fires even if tab is minimized
        if (res.delivery_status === 'ACCEPTED') this.browserNotifications.notify(
          'Invoice email accepted',
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

  async downloadPaymentReceipt(paymentId: number) {
    this.isDownloadingReceipt = true;
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${environment.apiUrl}/invoices/${this.invoiceId}/payments/${paymentId}/receipt`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error('Failed to generate payment receipt');
      const blobUrl = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `RCPT-${paymentId}.pdf`;
      a.click();
      URL.revokeObjectURL(blobUrl);
    } catch {
      const toast = await this.toastCtrl.create({ message: 'Failed to download payment receipt', duration: 3000, color: 'danger', position: 'bottom' });
      await toast.present();
    } finally { this.isDownloadingReceipt = false; }
  }

  async downloadCreditNote(noteId: number, number: string) {
    try {
      const token = localStorage.getItem('token');
      const response = await fetch(`${environment.apiUrl}/invoices/${this.invoiceId}/credit-notes/${noteId}/pdf`, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) throw new Error('Failed to generate credit note');
      const blobUrl = URL.createObjectURL(await response.blob());
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${number}.pdf`;
      a.click();
      URL.revokeObjectURL(blobUrl);
    } catch {
      const toast = await this.toastCtrl.create({ message: 'Failed to download credit note', duration: 3000, color: 'danger', position: 'bottom' });
      await toast.present();
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
    this.invoiceService.sendReceipt(this.invoiceId, this.receiptResendKey ||= ['ACCEPTED','UNCERTAIN'].includes(this.invoice?.email_deliveries?.find(e => e.kind === 'RECEIPT')?.status || '') ? crypto.randomUUID() : undefined).subscribe({
      next: async (res: any) => {
        this.isSendingReceipt = false;
        const color = res.emailFailed ? 'warning' : 'success';
        const toast = await this.toastCtrl.create({ message: res.message || 'Receipt sent', duration: 4000, color, position: 'bottom' });
        await toast.present();
        if (res.delivery_status === 'ACCEPTED') { this.receiptResendKey = undefined; this.loadInvoice(); }
        if (res.delivery_status === 'ACCEPTED') this.browserNotifications.notify(
          'Receipt email accepted',
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
      next: async (res) => {
        this.showPaymentForm = false;
        const toast = await this.toastCtrl.create({ message: res.message || 'Payment recorded', duration: 3000, color: 'success', position: 'bottom' });
        await toast.present();
        // Browser notification — fires when payment is recorded
        this.browserNotifications.notify(
          res.settled ? 'Invoice Paid' : 'Payment Recorded',
          res.settled
            ? `Invoice ${this.invoice?.document_number} has been paid in full.`
            : `Payment recorded on invoice ${this.invoice?.document_number}. ${this.currencySymbol} ${res.balance_due} still outstanding.`
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

  get creditFormTotal(): number { return Math.round((Number(this.creditForm.value.subtotal || 0)+Number(this.creditForm.value.vat_amount || 0))*100)/100; }
  get creditRemaining(): number { return Math.max(0,Number(this.invoice?.total || 0)-this.creditTotal); }
  get canIssueCredit(): boolean { return !!this.invoice?.adjustments_available && !['DRAFT','CANCELLED'].includes(this.invoice.status) && this.creditRemaining>0; }
  get refundablePayments() { return (this.invoice?.payments || []).filter(payment=>this.unrefundedAmount(payment.id)>0); }
  unrefundedAmount(paymentId:number):number {
    const payment=this.invoice?.payments.find(item=>item.id===paymentId);
    const refunded=(this.invoice?.refunds || []).filter(item=>item.payment_id===paymentId).reduce((sum,item)=>sum+Number(item.amount),0);
    return Math.max(0,Math.round((Number(payment?.amount || 0)-refunded)*100)/100);
  }
  openRefund(paymentId:number) {
    this.showRefundForm=true;
    this.refundForm.patchValue({payment_id:paymentId,amount:this.unrefundedAmount(paymentId),refund_date:todayLocalIso()});
  }
  private adjustmentKey(kind:'credit'|'refund',payload:object):string {
    const fingerprint=JSON.stringify(payload);
    const previous=kind==='credit' ? this.creditRetry : this.refundRetry;
    if (previous?.fingerprint===fingerprint) return previous.key;
    const next={fingerprint,key:window.crypto.randomUUID()};
    if (kind==='credit') this.creditRetry=next; else this.refundRetry=next;
    return next.key;
  }
  async submitCreditNote() {
    if (this.creditForm.invalid || this.creditFormTotal<=0 || this.creditFormTotal>this.creditRemaining) { this.creditForm.markAllAsTouched(); return; }
    const confirmed=await this.alertCtrl.create({header:'Issue credit note?',message:'This creates a numbered, permanent adjustment to the invoice. Check the net and VAT amounts before continuing.',buttons:[{text:'Review',role:'cancel'},{text:'Issue credit note',role:'confirm'}]});
    await confirmed.present();
    const answer=await confirmed.onDidDismiss();
    if (answer.role!=='confirm') return;
    const payload={...this.creditForm.value,total:this.creditFormTotal};
    this.isSavingAdjustment=true;
    try {
      await firstValueFrom(this.invoiceService.issueCreditNote(this.invoiceId,{...payload,request_key:this.adjustmentKey('credit',payload)}));
      this.creditRetry=undefined;this.showCreditForm=false;this.creditForm.reset({subtotal:null,vat_amount:0,reason:'',description:''});
      this.loadInvoice();
      const toast=await this.toastCtrl.create({message:'Credit note issued',duration:3000,color:'success'});await toast.present();
    } catch (error: any) {
      const toast=await this.toastCtrl.create({message:error.error?.message || 'Could not issue credit note',duration:4000,color:'danger'});await toast.present();
    } finally { this.isSavingAdjustment=false; }
  }
  async submitRefund() {
    const paymentId=Number(this.refundForm.value.payment_id);
    const amount=Number(this.refundForm.value.amount);
    if (this.refundForm.invalid || amount<=0 || amount>this.unrefundedAmount(paymentId)) { this.refundForm.markAllAsTouched(); return; }
    const confirmed=await this.alertCtrl.create({header:'Record refund?',message:'Record this only after the money has actually been returned. The original payment stays in the history.',buttons:[{text:'Review',role:'cancel'},{text:'Record refund',role:'confirm'}]});
    await confirmed.present();
    const answer=await confirmed.onDidDismiss();
    if (answer.role!=='confirm') return;
    const payload={...this.refundForm.value};
    this.isSavingAdjustment=true;
    try {
      await firstValueFrom(this.invoiceService.recordRefund(this.invoiceId,{...payload,request_key:this.adjustmentKey('refund',payload)}));
      this.refundRetry=undefined;this.showRefundForm=false;this.refundForm.reset({payment_id:null,amount:null,refund_date:todayLocalIso(),method:'BANK_TRANSFER',reference:'',reason:''});
      this.loadInvoice();
      const toast=await this.toastCtrl.create({message:'Refund recorded',duration:3000,color:'success'});await toast.present();
    } catch (error: any) {
      const toast=await this.toastCtrl.create({message:error.error?.message || 'Could not record refund',duration:4000,color:'danger'});await toast.present();
    } finally { this.isSavingAdjustment=false; }
  }

  get amountPaid(): number { return +(this.invoice?.amount_paid ?? 0); }
  get balanceDue(): number { return +(this.invoice?.balance_due ?? 0); }
  get creditTotal(): number { return +(this.invoice?.credit_total ?? 0); }
  get refundTotal(): number { return +(this.invoice?.refund_total ?? 0); }
  get refundDue(): number { return +(this.invoice?.refund_due ?? 0); }

  /** Some money in, some still owed. Shown alongside the status, not instead of it. */
  get isPartlyPaid(): boolean {
    return this.amountPaid > 0 && this.balanceDue > 0 && this.invoice?.status !== 'CANCELLED';
  }

  // Once a payment is recorded the lines are evidence of what was billed.
  get canEdit(): boolean { return this.invoice?.status === 'DRAFT' && (this.invoice?.payments || []).length === 0; }
  get canSend(): boolean { return ['DRAFT', 'SENT', 'OVERDUE'].includes(this.invoice?.status ?? ''); }
  get canMarkPaid(): boolean { return !['PAID', 'CREDITED', 'CANCELLED'].includes(this.invoice?.status ?? ''); }
  get canCancel(): boolean { return !['PAID', 'CREDITED', 'CANCELLED'].includes(this.invoice?.status ?? '') && Number(this.invoice?.amount_paid || 0) === 0 && Number(this.invoice?.credit_total || 0) === 0; }
  get currencySymbol(): string { return this.invoice?.currency_symbol || 'R'; }

  async manageShare(rotate: boolean) {
    const alert = await this.alertCtrl.create({header:rotate ? 'Replace share link?' : 'Revoke share link?',
      message:'The current link will stop working.',buttons:[{text:'Keep link',role:'cancel'},
        {text:rotate ? 'Replace link' : 'Revoke link',role:'destructive',handler:()=>{
          if(rotate) this.generateShareLink(true);
          else this.invoiceService.revokeShare(this.invoiceId).subscribe({next:()=>{this.shareLink=null;this.shareExpiry=null;},error:async()=>{
            const toast=await this.toastCtrl.create({message:'Could not revoke link',duration:3000,color:'danger'});await toast.present();
          }});
        }}]});
    await alert.present();
  }

  async generateShareLink(rotate = false) {
    this.isSharing = true;
    this.invoiceService.shareInvoice(this.invoiceId, rotate).subscribe({
      next: async (res) => {
        this.isSharing = false;
        this.shareLink = res.share_url;
        this.shareExpiry = res.expires_at;
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

  async shareViaDevice() {
    if (!this.shareLink) return;
    if (!navigator.share) return this.copyShareLink();
    try { await navigator.share({ title: `Invoice ${this.invoice?.document_number}`, url: this.shareLink }); }
    catch (error) { if ((error as DOMException).name !== 'AbortError') {
      const toast = await this.toastCtrl.create({ message: 'Could not open sharing. Copy the link instead.', duration: 3000, color: 'warning' });
      await toast.present();
    } }
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
