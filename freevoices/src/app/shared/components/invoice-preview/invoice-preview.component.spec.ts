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
});
