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

export interface AgeingReport {
  currency_code: string;
  as_of: string;
  totals: { current: number; days1to30: number; days31to60: number; days61plus: number };
  rows: { invoice_id: number; document_number: string; customer_name: string; due_date: string; balance_due: number; band: string }[];
}

export interface CustomerStatement {
  customer_id: number;
  customer_name: string;
  currency_code: string;
  from: string | null;
  to: string;
  opening_balance: number;
  closing_balance: number;
  rows: { day: string; kind: string; invoice_id: number; document_number: string; debit: number; credit: number; balance: number }[];
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

  getAgeing(currency: string, customerId: number | null): Observable<AgeingReport> {
    const query = new URLSearchParams({ currency });
    if (customerId) query.set('customer_id', String(customerId));
    return this.api.get<AgeingReport>(`/reports/ageing?${query}`);
  }

  getCustomerStatement(currency: string, customerId: number, from: string, to: string): Observable<CustomerStatement> {
    const query = new URLSearchParams({ currency, customer_id: String(customerId) });
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    return this.api.get<CustomerStatement>(`/reports/customer-statement?${query}`);
  }
}
