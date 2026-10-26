import { CommonModule } from '@angular/common';
import { Component, Input } from '@angular/core';
import { FormArray, FormGroup } from '@angular/forms';
import { lineTotals, roundCents } from '../../utils/document-math';

@Component({
  selector: 'app-invoice-preview',
  standalone: true,
  imports: [CommonModule],
  template: `
    <section class="preview" aria-label="Live invoice review">
      <header>
        <div><span class="eyebrow">Live review</span><h2>Invoice {{ invoiceNumber || 'draft' }}</h2></div>
        <span class="draft">Before saving</span>
      </header>
      <dl class="details">
        <div><dt>Bill to</dt><dd>{{ customerName || 'Choose a customer' }}</dd></div>
        <div><dt>Issued</dt><dd>{{ form.get('issue_date')?.value || '—' }}</dd></div>
        <div><dt>Due</dt><dd>{{ form.get('due_date')?.value || '—' }}</dd></div>
      </dl>
      <div class="table-wrap">
        <table>
          <thead><tr><th scope="col">Description</th><th scope="col">Qty</th><th scope="col">Price</th><th scope="col">VAT</th><th scope="col">Total</th></tr></thead>
          <tbody>
            <tr *ngFor="let item of items.controls; let i = index">
              <td>{{ item.get('description')?.value || 'Item ' + (i + 1) }}</td>
              <td>{{ item.get('quantity')?.value || 0 }}</td>
              <td>{{ currencySymbol }} {{ item.get('unit_price')?.value || 0 | number:'1.2-2' }}<small *ngIf="item.get('vat_inclusive')?.value">VAT incl.</small></td>
              <td>{{ item.get('vat_rate')?.value || 0 }}%</td>
              <td>{{ currencySymbol }} {{ lineTotal(i) | number:'1.2-2' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <dl class="totals">
        <div><dt>Subtotal</dt><dd>{{ currencySymbol }} {{ subtotal | number:'1.2-2' }}</dd></div>
        <div><dt>VAT</dt><dd>{{ currencySymbol }} {{ vat | number:'1.2-2' }}</dd></div>
        <div class="grand"><dt>Total</dt><dd>{{ currencySymbol }} {{ total | number:'1.2-2' }}</dd></div>
      </dl>
      <p *ngIf="form.get('notes')?.value"><strong>Notes</strong><br>{{ form.get('notes')?.value }}</p>
      <p *ngIf="form.get('terms_conditions')?.value"><strong>Terms &amp; conditions</strong><br>{{ form.get('terms_conditions')?.value }}</p>
      <p class="hint">On-screen review. The final invoice number and PDF layout are set when the document is saved or issued.</p>
    </section>
  `,
  styles: [`
    .preview { border: 1px solid var(--ion-color-medium-tint); border-radius: 12px; padding: 1rem; background: var(--ion-card-background, var(--ion-background-color)); }
    header, .details, .totals div { display: flex; justify-content: space-between; gap: 1rem; }
    header { align-items: start; } h2 { margin: .2rem 0 1rem; font-size: 1.3rem; }
    .eyebrow, .draft, .hint { color: var(--ion-color-medium); font-size: .8rem; }
    .details { flex-wrap: wrap; margin: 0 0 1rem; } dt { color: var(--ion-color-medium); font-size: .8rem; } dd { margin: .2rem 0 0; }
    .table-wrap { overflow-x: auto; } table { width: 100%; border-collapse: collapse; min-width: 440px; }
    th, td { padding: .55rem .3rem; text-align: right; border-bottom: 1px solid var(--ion-color-light-shade); }
    th:first-child, td:first-child { text-align: left; } small { display: block; color: var(--ion-color-medium); }
    .totals { margin: 1rem 0 0 auto; max-width: 280px; } .totals div { margin: .4rem 0; }
    .grand { border-top: 1px solid var(--ion-color-medium-tint); padding-top: .5rem; font-weight: 700; }
    p { white-space: pre-wrap; overflow-wrap: anywhere; } .hint { margin-bottom: 0; }
  `]
})
export class InvoicePreviewComponent {
  @Input({ required: true }) form!: FormGroup;
  @Input() currencySymbol = 'R';
  @Input() customerName = '';
  @Input() invoiceNumber = '';

  get items(): FormArray { return this.form.get('items') as FormArray; }
  lineTotal(index: number): number { return lineTotals(this.items.at(index).value).total; }
  get subtotal(): number { return roundCents(this.items.controls.reduce((sum, item) => sum + lineTotals(item.value).subtotal, 0)); }
  get vat(): number { return roundCents(this.items.controls.reduce((sum, item) => sum + lineTotals(item.value).vat, 0)); }
  get total(): number { return roundCents(this.subtotal + this.vat); }
}
