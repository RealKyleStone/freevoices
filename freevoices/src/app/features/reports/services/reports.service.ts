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

@Injectable({ providedIn: 'root' })
export class ReportsService {
  constructor(private api: ApiService) {}

  getRevenueByMonth(): Observable<RevenueByMonth[]> {
    return this.api.get<RevenueByMonth[]>('/reports/revenue-by-month');
  }

  getInvoiceStatus(): Observable<InvoiceStatusBreakdown[]> {
    return this.api.get<InvoiceStatusBreakdown[]>('/reports/invoice-status');
  }

  getTopCustomers(): Observable<TopCustomer[]> {
    return this.api.get<TopCustomer[]>('/reports/top-customers');
  }

  getVatSummary(): Observable<VatSummaryRow[]> {
    return this.api.get<VatSummaryRow[]>('/reports/vat-summary');
  }
}
