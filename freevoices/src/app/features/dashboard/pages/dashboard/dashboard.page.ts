// src/app/features/dashboard/pages/dashboard/dashboard.page.ts
import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { IonicModule } from '@ionic/angular';
import { CurrencyPipe } from '@angular/common';
import { DashboardService, DashboardSummary } from '../../services/dashboard.service';

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.page.html',
  styleUrls: ['./dashboard.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    IonicModule,
    CurrencyPipe
  ]
})
export class DashboardPage implements OnInit {
  selectedCurrency = 'ZAR';
  darkMode = false;
  isLoading = true;

  summary: DashboardSummary = {
    monthRevenue: 0,
    totalCustomers: 0,
    openInvoices: 0,
    overdueInvoices: 0,
    recentActivity: []
  };

  constructor(private dashboardService: DashboardService) {
    this.darkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  ngOnInit() {
    this.dashboardService.getSummary().subscribe({
      next: (data) => {
        this.summary = data;
        this.isLoading = false;
      },
      error: () => {
        this.isLoading = false;
      }
    });
  }

  formatEventType(eventType: string): string {
    const labels: Record<string, string> = {
      CREATED: 'Created',
      SENT: 'Sent',
      VIEWED: 'Viewed',
      DOWNLOADED: 'Downloaded',
      PAID: 'Paid',
      CANCELLED: 'Cancelled'
    };
    return labels[eventType] ?? eventType;
  }
}
