import { UserSettings } from '../../features/settings/services/settings.service';
import { Currency } from '../../../models/database.models';

export interface SetupStep { id: string; title: string; detail: string; route: string; done: boolean; required: boolean; }
const filled = (value: unknown) => typeof value === 'string' && value.trim().length > 0;

export function businessSetup(settings: Partial<UserSettings>, currencies: Currency[]): SetupStep[] {
  const rate = Number(settings.invoice_vat_rate);
  const rateSet = filled(settings.invoice_vat_rate) && Number.isFinite(rate) && rate >= 0 && rate <= 100;
  const taxReady = rateSet && (rate === 0 || filled(settings.vat_number));
  const currency = currencies.find(c => c.id === Number(settings.default_currency_id) && c.is_active);
  const bankReady = [settings.bank_name, settings.bank_account_number, settings.bank_branch_code].every(filled);
  const onlineReady = currency?.code === 'ZAR' && !!(settings.payfast_enabled && settings.payfast_merchant_id && settings.payfast_merchant_key_set && settings.payfast_passphrase_set);
  const terms = Number(settings.invoice_payment_terms);
  const defaultsReady = /^[A-Z0-9]{1,12}$/.test(settings.invoice_prefix || '') && filled(settings.invoice_payment_terms) && Number.isInteger(terms) && terms >= 0;
  return [
    { id: 'identity', title: 'Business identity', detail: 'Add the business name and address shown on your invoices.', route: '/settings/company', done: filled(settings.company_name) && filled(settings.address), required: true },
    { id: 'vat', title: 'VAT details', detail: taxReady ? `Default VAT rate: ${rate}%` : 'Review your default VAT rate and, when charging VAT, add your VAT number.', route: rateSet && rate > 0 && !filled(settings.vat_number) ? '/settings/company' : '/settings/invoice', done: taxReady, required: true },
    { id: 'currency', title: 'Default currency', detail: currency ? `${currency.code} - ${currency.name}` : 'Choose the currency used for new invoices and quotes.', route: '/settings/invoice', done: !!currency, required: true },
    { id: 'payment', title: 'Payment details', detail: 'Add bank details or configure online payments so customers know how to pay.', route: '/settings/payment', done: bankReady || onlineReady, required: true },
    { id: 'defaults', title: 'Invoice defaults', detail: 'Review your numbering prefix and payment terms.', route: '/settings/invoice', done: defaultsReady, required: true },
    { id: 'branding', title: 'Business logo', detail: 'Optional: add your logo to personalise documents.', route: '/settings/company', done: filled(settings.company_logo), required: false },
  ];
}
