import { FormBuilder } from '@angular/forms';
import { Router } from '@angular/router';
import { ToastController } from '@ionic/angular/standalone';
import { of } from 'rxjs';
import { InvoiceCreatePage } from './invoice-create.page';
import { InvoiceService } from '../../services/invoice.service';
import { SettingsService, UserSettings } from '../../../settings/services/settings.service';
import { Customer, Product } from '../../../../../models/database.models';

describe('invoice selection defaults', () => {
  function page() {
    const settings = jasmine.createSpyObj<SettingsService>('SettingsService', ['getSettings', 'getCurrencies']);
    settings.getSettings.and.returnValue(of({ default_currency_id: '1', invoice_vat_rate: '15', invoice_payment_terms: '30', invoice_notes: 'Thanks' } as UserSettings));
    settings.getCurrencies.and.returnValue(of([]));
    const instance = new InvoiceCreatePage(new FormBuilder(), {} as InvoiceService, settings, {} as Router, {} as ToastController);
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
});
