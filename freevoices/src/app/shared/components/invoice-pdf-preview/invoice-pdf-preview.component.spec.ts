import { TestBed } from '@angular/core/testing';
import { FormBuilder } from '@angular/forms';
import { of } from 'rxjs';
import { InvoiceService } from '../../../features/invoices/services/invoice.service';
import { InvoicePdfPreviewComponent } from './invoice-pdf-preview.component';

describe('InvoicePdfPreviewComponent', () => {
  it('requests a rendered preview with the current unsaved values and stored edit currency', () => {
    const invoices = jasmine.createSpyObj<InvoiceService>('InvoiceService', ['previewInvoice']);
    invoices.previewInvoice.and.returnValue(of(new Blob(['%PDF-1.4'], { type: 'application/pdf' })));
    TestBed.configureTestingModule({ imports: [InvoicePdfPreviewComponent], providers: [{ provide: InvoiceService, useValue: invoices }] });
    const fb = TestBed.inject(FormBuilder);
    const fixture = TestBed.createComponent(InvoicePdfPreviewComponent);
    const component = fixture.componentInstance;
    component.form = fb.group({ customer_id: [7], issue_date: ['2026-10-26'], due_date: ['2026-10-26'],
      items: fb.array([fb.group({ description: ['Service'], quantity: [2], unit_price: [115], discount_percent: [10], vat_rate: [15], vat_inclusive: [true] })]) });
    component.currencyId = 2;
    fixture.detectChanges();
    spyOn(component.dialog.nativeElement, 'showModal');
    component.open();
    expect(invoices.previewInvoice).toHaveBeenCalledWith(jasmine.objectContaining({
      customer_id: 7, currency_id: 2,
      items: [jasmine.objectContaining({ discount_percent: 10 })]
    }));
    expect(component.dialog.nativeElement.showModal).toHaveBeenCalled();
    component.ngOnDestroy();
  });
});
