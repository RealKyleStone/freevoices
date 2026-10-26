import { Component, ElementRef, Input, OnDestroy, ViewChild } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeResourceUrl } from '@angular/platform-browser';
import { FormGroup } from '@angular/forms';
import { Subscription } from 'rxjs';
import { IonButton, IonSpinner } from '@ionic/angular/standalone';
import { InvoiceService, InvoicePayload } from '../../../features/invoices/services/invoice.service';

@Component({
  selector: 'app-invoice-pdf-preview',
  standalone: true,
  imports: [CommonModule, IonButton, IonSpinner],
  template: `
    <ion-button type="button" fill="outline" expand="block" (click)="open()" [disabled]="loading">
      <ion-spinner *ngIf="loading" slot="start" name="crescent"></ion-spinner>
      {{ loading ? 'Rendering PDF...' : 'Preview PDF' }}
    </ion-button>
    <p *ngIf="error" role="alert">{{ error }}</p>
    <dialog #pdfDialog aria-label="Invoice PDF preview" (close)="close()">
      <div class="preview-head"><strong>Invoice PDF preview</strong><ion-button type="button" fill="clear" (click)="pdfDialog.close()">Close</ion-button></div>
      <p>PREVIEW is shown in place of the final invoice number. Opening this view does not save or issue the invoice.</p>
      <iframe *ngIf="safeUrl" [src]="safeUrl" title="Invoice PDF preview"></iframe>
    </dialog>
  `,
  styles: [`
    dialog { width: min(94vw, 900px); max-width: none; max-height: 90vh; padding: 1rem; border: 1px solid var(--ion-color-medium-tint); border-radius: 12px; background: var(--ion-background-color); color: var(--ion-text-color); }
    dialog::backdrop { background: rgba(0,0,0,.65); }
    .preview-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
    p { margin: .4rem 0 1rem; font-size: .85rem; }
    iframe { display: block; width: 100%; height: min(72vh, 760px); border: 0; background: white; }
  `]
})
export class InvoicePdfPreviewComponent implements OnDestroy {
  @Input({ required: true }) form!: FormGroup;
  @Input() currencyId?: number;
  @ViewChild('pdfDialog') dialog!: ElementRef<HTMLDialogElement>;
  loading = false;
  error = '';
  safeUrl?: SafeResourceUrl;
  private objectUrl?: string;
  private request?: Subscription;

  constructor(private invoices: InvoiceService, private sanitizer: DomSanitizer) {}

  open() {
    if (this.form.invalid) { this.form.markAllAsTouched(); this.error = 'Complete the required invoice fields before previewing.'; return; }
    this.error = '';
    this.loading = true;
    const payload = { ...this.form.getRawValue(), currency_id: this.currencyId ?? this.form.get('currency_id')?.value } as InvoicePayload;
    this.request?.unsubscribe();
    this.request = this.invoices.previewInvoice(payload).subscribe({
      next: pdf => {
        this.loading = false;
        this.close();
        this.objectUrl = URL.createObjectURL(pdf);
        this.safeUrl = this.sanitizer.bypassSecurityTrustResourceUrl(this.objectUrl);
        this.dialog.nativeElement.showModal();
      },
      error: () => { this.loading = false; this.error = 'Could not render the PDF. Check the selected customer and line items, then try again.'; }
    });
  }

  close() {
    this.safeUrl = undefined;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = undefined;
  }

  ngOnDestroy() { this.request?.unsubscribe(); this.dialog?.nativeElement.close(); this.close(); }
}
