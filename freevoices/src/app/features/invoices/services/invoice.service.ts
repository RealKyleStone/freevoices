import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { DatabaseService } from '../../../../services/database.service';
import { Document, DocumentItem, DocumentTracking, Payment } from '../../../../models/database.models';

export interface InvoiceListItem {
  id: number;
  document_number: string;
  customer_name: string;
  status: string;
  issue_date: string;
  due_date: string;
  subtotal: number;
  vat_amount: number;
  total: number;
  created_at: string;
}

export interface InvoiceListResponse {
  data: InvoiceListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface InvoiceDetail extends Document {
  customer_name: string;
  customer_email: string;
  customer_billing_address: string;
  customer_vat_number: string;
  items: DocumentItem[];
  tracking: DocumentTracking[];
  payments: Payment[];
  currency_symbol?: string;
  currency_code?: string;
}

export interface InvoiceItemPayload {
  product_id?: number | null;
  description: string;
  quantity: number;
  unit_price: number;
  vat_rate: number;
}

export interface InvoicePayload {
  customer_id: number;
  issue_date: string;
  due_date?: string | null;
  payment_terms?: number | null;
  notes?: string | null;
  terms_conditions?: string | null;
  currency_id?: number | null;
  items: InvoiceItemPayload[];
  is_recurring?: boolean;
  recurrence_interval?: 'WEEKLY' | 'MONTHLY' | 'QUARTERLY' | 'YEARLY' | null;
  recurrence_end_date?: string | null;
  auto_send?: boolean;
}

export interface MarkPaidPayload {
  amount: number;
  payment_date: string;
  payment_method: string;
  transaction_reference?: string;
  notes?: string;
}

@Injectable({
  providedIn: 'root'
})
export class InvoiceService {
  constructor(private db: DatabaseService) {}

  getInvoices(search = '', status = '', page = 1, limit = 20): Observable<InvoiceListResponse> {
    return this.db.query<InvoiceListResponse>('invoices', { params: { search, status, page, limit } });
  }

  getInvoice(id: number): Observable<InvoiceDetail> {
    return this.db.query<InvoiceDetail>(`invoices/${id}`);
  }

  createInvoice(data: InvoicePayload): Observable<InvoiceDetail> {
    return this.db.create<InvoiceDetail>('invoices', data);
  }

  updateInvoice(id: number, data: InvoicePayload): Observable<InvoiceDetail> {
    return this.db.update<InvoiceDetail>('invoices', id, data);
  }

  sendInvoice(id: number): Observable<{ message: string }> {
    return this.db.create<{ message: string }>(`invoices/${id}/send`, {});
  }

  markPaid(id: number, data: MarkPaidPayload): Observable<{ message: string }> {
    return this.db.create<{ message: string }>(`invoices/${id}/mark-paid`, data);
  }

  shareInvoice(id: number): Observable<{ token: string; share_url: string }> {
    return this.db.create<{ token: string; share_url: string }>(`invoices/${id}/share`, {});
  }
}
