import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { ApiService } from '../../../core/services/api.service';

export interface DashboardSummary {
  monthRevenue: number;
  totalCustomers: number;
  openInvoices: number;
  overdueInvoices: number;
  recentActivity: RecentActivity[];
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
