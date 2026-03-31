import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { DatabaseService } from '../../../../services/database.service';
import { Document, DocumentItem, DocumentTracking } from '../../../../models/database.models';

export interface QuoteListItem {
  id: number;
  document_number: string;
  customer_name: string;
  status: string;
  issue_date: string;
  valid_until: string;
  subtotal: number;
  vat_amount: number;
  total: number;
  created_at: string;
}

export interface QuoteListResponse {
  data: QuoteListItem[];
  total: number;
  page: number;
  limit: number;
}

export interface QuoteDetail extends Document {
  customer_name: string;
  customer_email: string;
  customer_billing_address: string;
  customer_vat_number: string;
  items: DocumentItem[];
  tracking: DocumentTracking[];
}

export interface QuoteItemPayload {
  product_id?: number | null;
  description: string;
  quantity: number;
  unit_price: number;
  vat_rate: number;
}

export interface QuotePayload {
  customer_id: number;
  issue_date: string;
  valid_until?: string | null;
  payment_terms?: number | null;
  notes?: string | null;
  terms_conditions?: string | null;
  items: QuoteItemPayload[];
}

@Injectable({
  providedIn: 'root'
})
export class QuoteService {
  constructor(private db: DatabaseService) {}

  getQuotes(search = '', status = '', page = 1, limit = 20): Observable<QuoteListResponse> {
    return this.db.query<QuoteListResponse>('quotes', { params: { search, status, page, limit } });
  }

  getQuote(id: number): Observable<QuoteDetail> {
    return this.db.query<QuoteDetail>(`quotes/${id}`);
  }

  createQuote(data: QuotePayload): Observable<QuoteDetail> {
    return this.db.create<QuoteDetail>('quotes', data);
  }

  updateQuote(id: number, data: QuotePayload): Observable<QuoteDetail> {
    return this.db.update<QuoteDetail>('quotes', id, data);
  }

  sendQuote(id: number): Observable<{ message: string }> {
    return this.db.create<{ message: string }>(`quotes/${id}/send`, {});
  }

  convertToInvoice(id: number): Observable<{ message: string; invoice_id: number }> {
    return this.db.create<{ message: string; invoice_id: number }>(`quotes/${id}/convert-to-invoice`, {});
  }
}
