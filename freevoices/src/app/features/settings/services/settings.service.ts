import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../../../environments/environment';
import { Currency } from '../../../../models/database.models';

export interface UserSettings {
  // Profile
  contact_person: string;
  email: string;
  phone: string;
  // Company
  company_name: string;
  company_registration: string;
  vat_number: string;
  address: string;
  company_logo?: string;
  // Invoice defaults
  invoice_prefix: string;
  invoice_next_number: string;
  invoice_payment_terms: string;
  invoice_vat_rate: string;
  invoice_notes: string;
  default_currency_id: string;
  // Payment
  bank_name: string;
  bank_account_number: string;
  bank_branch_code: string;
  bank_account_type: string;
  // Notifications
  notify_invoice_sent: string;
  notify_payment_received: string;
  notify_invoice_overdue: string;
}

@Injectable({ providedIn: 'root' })
export class SettingsService {
  private apiUrl = environment.apiUrl;

  constructor(private http: HttpClient) {}

  private getHeaders(): HttpHeaders {
    const token = localStorage.getItem('token');
    return new HttpHeaders({
      'Content-Type': 'application/json',
      Authorization: token ? `Bearer ${token}` : ''
    });
  }

  private getAuthHeader(): HttpHeaders {
    const token = localStorage.getItem('token');
    return new HttpHeaders({ Authorization: token ? `Bearer ${token}` : '' });
  }

  getSettings(): Observable<UserSettings> {
    return this.http.get<UserSettings>(`${this.apiUrl}/settings`, {
      headers: this.getHeaders()
    });
  }

  getCurrencies(): Observable<Currency[]> {
    return this.http.get<Currency[]>(`${this.apiUrl}/currencies`, {
      headers: this.getHeaders()
    });
  }

  updateProfile(data: {
    contact_person: string;
    email: string;
    phone: string;
    current_password?: string;
    new_password?: string;
  }): Observable<{ message: string }> {
    return this.http.put<{ message: string }>(`${this.apiUrl}/settings/profile`, data, {
      headers: this.getHeaders()
    });
  }

  updateCompany(data: {
    company_name: string;
    company_registration: string;
    vat_number: string;
    address: string;
  }): Observable<{ message: string }> {
    return this.http.put<{ message: string }>(`${this.apiUrl}/settings/company`, data, {
      headers: this.getHeaders()
    });
  }

  uploadLogo(file: File): Observable<{ message: string; logo_url: string }> {
    const token = localStorage.getItem('token');
    const formData = new FormData();
    formData.append('logo', file);
    return this.http.post<{ message: string; logo_url: string }>(
      `${this.apiUrl}/settings/logo`,
      formData,
      { headers: new HttpHeaders({ Authorization: token ? `Bearer ${token}` : '' }) }
    );
  }

  deleteLogo(): Observable<{ message: string }> {
    return this.http.delete<{ message: string }>(`${this.apiUrl}/settings/logo`, {
      headers: this.getHeaders()
    });
  }

  updateInvoiceDefaults(data: {
    invoice_prefix: string;
    invoice_next_number: number;
    invoice_payment_terms: number;
    invoice_vat_rate: number;
    invoice_notes: string;
    default_currency_id: number;
  }): Observable<{ message: string }> {
    return this.http.put<{ message: string }>(`${this.apiUrl}/settings/invoice`, data, {
      headers: this.getHeaders()
    });
  }

  updatePayment(data: {
    bank_name: string;
    bank_account_number: string;
    bank_branch_code: string;
    bank_account_type: string;
  }): Observable<{ message: string }> {
    return this.http.put<{ message: string }>(`${this.apiUrl}/settings/payment`, data, {
      headers: this.getHeaders()
    });
  }

  updateNotifications(data: {
    notify_invoice_sent: boolean;
    notify_payment_received: boolean;
    notify_invoice_overdue: boolean;
  }): Observable<{ message: string }> {
    return this.http.put<{ message: string }>(`${this.apiUrl}/settings/notifications`, data, {
      headers: this.getHeaders()
    });
  }
}
