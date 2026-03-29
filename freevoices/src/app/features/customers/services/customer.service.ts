import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { DatabaseService } from '../../../../services/database.service';
import { Customer, Document } from '../../../../models/database.models';

export interface CustomerListResponse {
  data: Customer[];
  total: number;
  page: number;
  limit: number;
}

export interface CustomerWithDocuments extends Customer {
  documents: Document[];
}

@Injectable({
  providedIn: 'root'
})
export class CustomerService {
  constructor(private db: DatabaseService) {}

  getCustomers(search = '', page = 1, limit = 20): Observable<CustomerListResponse> {
    return this.db.query<CustomerListResponse>('customers', { params: { search, page, limit } });
  }

  getCustomer(id: number): Observable<CustomerWithDocuments> {
    return this.db.query<CustomerWithDocuments>(`customers/${id}`);
  }

  createCustomer(data: Partial<Customer>): Observable<Customer> {
    return this.db.create<Customer>('customers', data);
  }

  updateCustomer(id: number, data: Partial<Customer>): Observable<Customer> {
    return this.db.update<Customer>('customers', id, data);
  }

  deleteCustomer(id: number): Observable<{ message: string }> {
    return this.db.delete<{ message: string }>('customers', id);
  }
}
