import { FormBuilder } from '@angular/forms';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { ToastController } from '@ionic/angular/standalone';
import { of } from 'rxjs';
import { InvoiceCreatePage } from './invoice-create.page';
import { InvoiceDetail, InvoiceService } from '../../services/invoice.service';
import { SettingsService, UserSettings } from '../../../settings/services/settings.service';
import { Customer, Product } from '../../../../../models/database.models';
import { AuthService } from '../../../../core/auth/services/auth.service';

describe('invoice selection defaults', () => {
  function page(source?: InvoiceDetail) {
    const settings = jasmine.createSpyObj<SettingsService>('SettingsService', ['getSettings', 'getCurrencies']);
    settings.getSettings.and.returnValue(of({ default_currency_id: '1', invoice_vat_rate: '15', invoice_payment_terms: '30', invoice_notes: 'Thanks' } as UserSettings));
    settings.getCurrencies.and.returnValue(of([]));
    const invoices = jasmine.createSpyObj<InvoiceService>('InvoiceService', ['getInvoice']);
    if (source) invoices.getInvoice.and.returnValue(of(source));
    const route = { snapshot: { queryParamMap: convertToParamMap(source ? { copyFrom: String(source.id) } : {}) } } as ActivatedRoute;
    const auth = { getCurrentUser: () => null } as unknown as AuthService;
    const instance = new InvoiceCreatePage(new FormBuilder(), invoices, settings, {} as Router, {} as ToastController, route, auth);
    instance.ngOnInit(); return instance;
  }
  it('applies zero-day customer terms without resetting the rest of the draft', () => {
    const instance = page(); instance.form.patchValue({ notes: 'Keep draft notes' });
    instance.onCustomerSelected({ payment_terms: 0 } as Customer);
    expect(instance.form.value.payment_terms).toBe(0); expect(instance.form.value.notes).toBe('Keep draft notes');
    expect(instance.form.value.due_date).toBe(instance.form.value.issue_date);
  });
  it('copies inclusive product pricing, preserves an explicit zero VAT rate and keeps custom item details', () => {
    const instance = page(); instance.items.at(0).patchValue({ vat_rate: 0 });
    instance.onProductSelected(0, { name: 'Repair', price: 115, vat_inclusive: true } as Product);
    expect(instance.items.at(0).value).toEqual(jasmine.objectContaining({ description: 'Repair', unit_price: 115, vat_inclusive: true, vat_rate: 0 }));
    instance.onProductSelected(0, null);
    expect(instance.items.at(0).value.description).toBe('Repair'); expect(instance.docTotal).toBe(115);
  });
  it('copies editable values into a fresh dated draft without the source schedule', () => {
    const source = {
      id: 42, document_number: 'INV-OLD', customer_id: 7, customer_name: 'Acme', currency_id: 2,
      payment_terms: 0, issue_date: '2024-01-01', due_date: '2024-01-01', notes: 'Keep this',
      terms_conditions: 'Pay promptly', is_recurring: true, recurrence_interval: 'MONTHLY', auto_send: true,
      items: [{ product_id: 8, description: 'Service', quantity: 2, unit_price: 115, vat_rate: 15, vat_inclusive: true }]
    } as InvoiceDetail;
    const instance = page(source);
    expect(instance.copiedFromNumber).toBe('INV-OLD');
    expect(instance.selectedCustomerName).toBe('Acme');
    expect(instance.form.value).toEqual(jasmine.objectContaining({
      customer_id: 7, currency_id: 2, payment_terms: 0, notes: 'Keep this',
      terms_conditions: 'Pay promptly', is_recurring: false, auto_send: false,
      recurrence_interval: null
    }));
    expect(instance.form.value.issue_date).not.toBe('2024-01-01');
    expect(instance.form.value.due_date).toBe(instance.form.value.issue_date);
    expect(instance.items.length).toBe(1);
    expect(instance.items.at(0).value).toEqual(jasmine.objectContaining({
      product_id: 8, quantity: 2, unit_price: 115, vat_inclusive: true
    }));
    expect(instance.docTotal).toBe(230);
    expect(instance.hasUnsavedChanges()).toBeTrue();
  });
});
