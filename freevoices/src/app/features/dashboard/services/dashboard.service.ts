import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '../../../core/services/api.service';

export interface DashboardSummary {
  currency_code?: string;
  monthRevenue: number;
  totalCustomers: number;
  openInvoices: number;
  overdueInvoices: number;
  outstanding: number;
  ageing: { current: number; days1to30: number; days31to60: number; days61plus: number };
  actionInvoices: { id: number; document_number: string; customer_name: string; due_date: string | null; balance_due: number }[];
  recentActivity: RecentActivity[];
  /** Server-relative path, e.g. /uploads/logos/logo_x.png, or null. */
  companyLogo?: string | null;
}

export interface RecentActivity {
  event_type: string;
  event_date: string;
  document_number: string;
  document_type: string;
  customer_name: string;
}

@Injectable({ providedIn: 'root' })
export class DashboardService {
  constructor(private api: ApiService) {}

  getSummary(): Observable<DashboardSummary> {
    return this.api.get<DashboardSummary>('/dashboard/summary');
  }
}
