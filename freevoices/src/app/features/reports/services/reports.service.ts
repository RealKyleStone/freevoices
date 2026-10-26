import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '../../../core/services/api.service';

export interface RevenueByMonth {
  month: string;   // 'YYYY-MM'
  revenue: number;
}

export interface InvoiceStatusBreakdown {
  status: string;
  count: number;
  total: number;
}

export interface TopCustomer {
  name: string;
  revenue: number;
  invoice_count: number;
}

export interface VatSummaryRow {
  month: string;
  subtotal: number;
  vat_amount: number;
  total: number;
}

export interface PaymentLedgerRow {
  id: number;
  payment_date: string;
  amount: number;
  payment_method: string;
  transaction_reference?: string;
  invoice_id: number;
  document_number: string;
  customer_id: number;
  customer_name: string;
}

export interface PaymentLedger {
  currency_code: string;
  from: string | null;
  to: string | null;
  rows: PaymentLedgerRow[];
}

@Injectable({ providedIn: 'root' })
export class ReportsService {
  constructor(private api: ApiService) {}

  getCurrencies(): Observable<{code:string;name:string;symbol:string}[]> { return this.api.get('/currencies'); }

  getRevenueByMonth(currency = 'ZAR'): Observable<RevenueByMonth[]> {
    return this.api.get<RevenueByMonth[]>(`/reports/revenue-by-month?currency=${encodeURIComponent(currency)}`);
  }

  getInvoiceStatus(currency = 'ZAR'): Observable<InvoiceStatusBreakdown[]> {
    return this.api.get<InvoiceStatusBreakdown[]>(`/reports/invoice-status?currency=${encodeURIComponent(currency)}`);
  }

  getTopCustomers(currency = 'ZAR'): Observable<TopCustomer[]> {
    return this.api.get<TopCustomer[]>(`/reports/top-customers?currency=${encodeURIComponent(currency)}`);
  }

  getVatSummary(currency = 'ZAR'): Observable<VatSummaryRow[]> {
    return this.api.get<VatSummaryRow[]>(`/reports/vat-summary?currency=${encodeURIComponent(currency)}`);
  }

  getPaymentsLedger(currency: string, from: string, to: string, customerId: number | null): Observable<PaymentLedger> {
    const query = new URLSearchParams({ currency });
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    if (customerId) query.set('customer_id', String(customerId));
    return this.api.get<PaymentLedger>(`/reports/payments-ledger?${query}`);
  }
}
