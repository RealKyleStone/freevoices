import { businessSetup } from './business-setup';
import { UserSettings } from '../../features/settings/services/settings.service';
import { Currency } from '../../../models/database.models';

const currencies = [{ id: 1, code: 'ZAR', name: 'Rand', is_active: true }] as Currency[];
const ready: Partial<UserSettings> = { company_name: 'Cape Services', address: 'Cape Town', invoice_vat_rate: '0',
  default_currency_id: '1', bank_name: 'Bank', bank_account_number: '123', bank_branch_code: '456', invoice_prefix: 'INV', invoice_payment_terms: '0' };
describe('business setup checklist', () => {
  it('does not treat fallback defaults or missing values as reviewed setup', () => {
    expect(businessSetup({}, currencies).filter(s => s.required && s.done).length).toBe(0);
  });
  it('allows zero VAT and immediate payment terms without requiring optional branding or registration', () => {
    const steps = businessSetup(ready, currencies);
    expect(steps.filter(s => s.required && s.done).length).toBe(5);
    expect(steps.find(s => s.id === 'branding')?.required).toBeFalse();
  });
  it('points a positive VAT rate with no VAT number to company settings', () => {
    const step = businessSetup({ ...ready, invoice_vat_rate: '15' }, currencies).find(s => s.id === 'vat');
    expect(step?.done).toBeFalse(); expect(step?.route).toBe('/settings/company');
    expect(businessSetup({ ...ready, invoice_vat_rate: '15', vat_number: '12345' }, currencies).find(s => s.id === 'vat')?.done).toBeTrue();
  });
  it('requires an active configured currency and complete payment details', () => {
    const steps = businessSetup({ ...ready, default_currency_id: '99', bank_branch_code: '' }, currencies);
    expect(steps.find(s => s.id === 'currency')?.done).toBeFalse(); expect(steps.find(s => s.id === 'payment')?.done).toBeFalse();
  });
  it('does not count a ZAR-only gateway as payment setup for another currency', () => {
    const usd = [{ ...currencies[0], id: 2, code: 'USD' }];
    const steps = businessSetup({ ...ready, default_currency_id: '2', bank_name: '', payfast_enabled: true, payfast_merchant_id: '12345', payfast_merchant_key_set: true, payfast_passphrase_set: true }, usd);
    expect(steps.find(s => s.id === 'payment')?.done).toBeFalse();
  });
  it('accepts configured online payments and rejects invalid VAT/default values', () => {
    const settings = { ...ready, bank_name: '', payfast_enabled: true, payfast_merchant_id: '12345', payfast_merchant_key_set: true, payfast_passphrase_set: true, invoice_vat_rate: 'no', invoice_payment_terms: '-1' };
    const steps = businessSetup(settings, currencies);
    expect(steps.find(s => s.id === 'payment')?.done).toBeTrue(); expect(steps.find(s => s.id === 'vat')?.done).toBeFalse(); expect(steps.find(s => s.id === 'defaults')?.done).toBeFalse();
  });
});
