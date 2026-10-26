import { FormBuilder } from '@angular/forms';
import { ActivatedRoute, convertToParamMap, Router } from '@angular/router';
import { ToastController } from '@ionic/angular/standalone';
import { of } from 'rxjs';
import { AuthService } from '../../../../core/auth/services/auth.service';
import { draftKey, clearDraft, writeDraft } from '../../../../shared/utils/browser-draft';
import { SettingsService, UserSettings } from '../../../settings/services/settings.service';
import { InvoiceService } from '../../services/invoice.service';
import { InvoiceCreatePage } from './invoice-create.page';

describe('invoice browser draft recovery', () => {
  const key = draftKey(98, 'invoice', 'new');
  afterEach(() => clearDraft(key));

  function page() {
    const invoices = jasmine.createSpyObj<InvoiceService>('InvoiceService', ['getInvoice', 'createInvoice']);
    const settings = jasmine.createSpyObj<SettingsService>('SettingsService', ['getSettings', 'getCurrencies']);
    settings.getSettings.and.returnValue(of({ default_currency_id: '1', invoice_vat_rate: '15', invoice_payment_terms: '30' } as UserSettings));
    settings.getCurrencies.and.returnValue(of([]));
    const route = { snapshot: { queryParamMap: convertToParamMap({}) } } as ActivatedRoute;
    const auth = { getCurrentUser: () => ({ id: 98 }) } as unknown as AuthService;
    const router = jasmine.createSpyObj<Router>('Router', ['navigate']);
    const instance = new InvoiceCreatePage(new FormBuilder(), invoices, settings, router, {} as ToastController, route, auth);
    instance.ngOnInit();
    return { instance, invoices, router };
  }

  it('offers a saved draft, restores its lines, and clears it after creation', () => {
    writeDraft(key, { customer_id: 7, currency_id: 1, issue_date: '2026-10-25', due_date: '2026-10-25',
      payment_terms: 0, notes: 'Recovered', terms_conditions: '', purchase_order_ref: 'PO-7', delivery_details: '',
      selectedCustomerName: 'Recovered buyer', is_recurring: false, recurrence_interval: null, recurrence_end_date: '', auto_send: false,
      items: [{ description: 'Service', product_id: null, quantity: 2, unit_label: 'hours', unit_price: 115,
        discount_percent: 10, vat_rate: 15, vat_inclusive: true }] });
    const { instance, invoices, router } = page();
    expect(instance.pendingDraft).not.toBeNull();
    instance.restoreBrowserDraft();
    expect(instance.pendingDraft).toBeNull();
    expect(instance.selectedCustomerName).toBe('Recovered buyer');
    expect(instance.form.value.purchase_order_ref).toBe('PO-7');
    expect(instance.docTotal).toBe(207);
    expect(instance.hasUnsavedChanges()).toBeTrue();
    invoices.createInvoice.and.returnValue(of({ id: 99 } as any));
    instance.onSubmit();
    expect(localStorage.getItem(key)).toBeNull();
    expect(router.navigate).toHaveBeenCalledWith(['/invoices', 99], { replaceUrl: true });
    instance.ngOnDestroy();
  });

  it('removes a draft when the user explicitly discards the unsaved form', () => {
    const { instance } = page();
    instance.form.get('notes')!.setValue('Do not keep');
    instance.form.markAsDirty();
    instance.onBeforeUnload(new Event('beforeunload') as BeforeUnloadEvent);
    expect(localStorage.getItem(key)).not.toBeNull();
    instance.discardUnsavedChanges();
    instance.ngOnDestroy();
    expect(localStorage.getItem(key)).toBeNull();
  });
});
