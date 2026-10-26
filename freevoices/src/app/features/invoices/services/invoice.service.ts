import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { DatabaseService } from '../../../../services/database.service';
import { Document, DocumentItem, DocumentTracking, Payment } from '../../../../models/database.models';
import { environment } from '../../../../environments/environment';

export interface InvoiceListItem {
  id: number;
  document_number: string;
  currency_code?: string;
  customer_name: string;
  status: string;
  issue_date: string;
  due_date: string;
  subtotal: number;
  vat_amount: number;
  total: number;
  created_at: string;
  notifications_muted?: boolean;
  amount_paid: string;
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
  notifications_muted?: boolean;
  /** Sum of recorded payments, from the server. */
  amount_paid: string;
  /** total - amount_paid, never negative. */
  balance_due: string;
  source_quote_number?: string | null;
  email_deliveries?: {id:number;kind:string;status:string;attempts:number;last_error:string|null;created_at:string;accepted_at:string|null}[];
}

export interface InvoiceItemPayload {
  vat_inclusive?: boolean;
  product_id?: number | null;
  description: string;
  quantity: number;
  unit_label?: string;
  unit_price: number;
  discount_percent?: number;
  vat_rate: number;
}

export interface InvoicePayload {
  request_key?: string;
  customer_id: number;
  issue_date: string;
  due_date?: string | null;
  payment_terms?: number | null;
  notes?: string | null;
  terms_conditions?: string | null;
  purchase_order_ref?: string | null;
  delivery_details?: string | null;
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
  constructor(private db: DatabaseService, private http: HttpClient) {}

  previewInvoice(data: InvoicePayload): Observable<Blob> {
    return this.http.post(`${environment.apiUrl}/invoices/preview`, data, { responseType: 'blob' });
  }

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

  sendInvoice(id: number, resendKey?: string): Observable<{ message: string }> {
    return this.db.create<{ message: string }>(`invoices/${id}/send`, resendKey ? { resend_key: resendKey } : {});
  }

  markPaid(id: number, data: MarkPaidPayload): Observable<{ message: string; settled: boolean; balance_due: string }> {
    return this.db.create<{ message: string; settled: boolean; balance_due: string }>(`invoices/${id}/mark-paid`, data);
  }

  sendReceipt(id: number, resendKey?: string): Observable<{ message: string }> {
    return this.db.create<{ message: string }>(`invoices/${id}/send-receipt`, resendKey ? {resend_key:resendKey} : {});
  }

  cancelInvoice(id: number): Observable<{ message: string }> {
    return this.db.create<{ message: string }>(`invoices/${id}/cancel`, {});
  }

  setNotificationsMuted(id: number, muted: boolean): Observable<{ message: string; notifications_muted: boolean }> {
    return this.db.update<{ message: string; notifications_muted: boolean }>(`invoices/${id}`, 'notifications', { muted });
  }

  revokeShare(id: number): Observable<{message:string}> {
    return this.db.delete<{message:string}>(`invoices/${id}`, 'share');
  }

  shareInvoice(id: number, rotate = false): Observable<{ token: string; share_url: string; expires_at: string }> {
    return this.db.create<{ token: string; share_url: string; expires_at: string }>(`invoices/${id}/share`, { rotate });
  }
}
