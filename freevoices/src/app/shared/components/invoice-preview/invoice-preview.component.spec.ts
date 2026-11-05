import { TestBed } from '@angular/core/testing';
import { FormBuilder } from '@angular/forms';
import { InvoicePreviewComponent } from './invoice-preview.component';

describe('InvoicePreviewComponent', () => {
  it('updates the visible review when dates, lines and pricing mode change', () => {
    TestBed.configureTestingModule({ imports: [InvoicePreviewComponent] });
    const fb = TestBed.inject(FormBuilder);
    const form = fb.group({
      issue_date: ['2026-10-26'], due_date: ['2026-10-26'], notes: ['First note'],
      terms_conditions: [''],
      items: fb.array([fb.group({ description: ['Service'], quantity: [1], unit_price: [115], vat_rate: [15], vat_inclusive: [true] })])
    });
    const fixture = TestBed.createComponent(InvoicePreviewComponent);
    fixture.componentInstance.form = form;
    fixture.componentInstance.currencySymbol = 'R';
    fixture.componentInstance.customerName = 'Acme';
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Acme');
    expect(fixture.nativeElement.textContent).toContain('115.00');
    expect(fixture.nativeElement.textContent).toContain('First note');

    form.get('due_date')!.setValue('2026-11-25');
    form.get('items.0.quantity')!.setValue(2);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('2026-11-25');
    expect(fixture.nativeElement.textContent).toContain('230.00');
  });
  it('shows the same discounted inclusive total and reference as the server', () => {
    TestBed.configureTestingModule({ imports: [InvoicePreviewComponent] });
    const fb = TestBed.inject(FormBuilder);
    const form = fb.group({
      issue_date: ['2026-10-26'], due_date: ['2026-10-26'],
      purchase_order_ref: ['PO-123'], delivery_details: ['Remote delivery'],
      notes: [''], terms_conditions: [''],
      items: fb.array([fb.group({ description: ['Consulting'], quantity: [2], unit_label: ['hours'],
        unit_price: [115], discount_percent: [10], vat_rate: [15], vat_inclusive: [true] })])
    });
    const fixture = TestBed.createComponent(InvoicePreviewComponent);
    fixture.componentInstance.form = form;
    fixture.detectChanges();
    const text = fixture.nativeElement.textContent;
    expect(text).toContain('PO-123');
    expect(text).toContain('2 hours');
    expect(text).toContain('10% discount');
    expect(text).toContain('180.00');
    expect(text).toContain('27.00');
    expect(text).toContain('207.00');
    expect(text).toContain('Remote delivery');
  });
});
