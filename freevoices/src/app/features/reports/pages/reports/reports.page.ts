import { Component, OnInit, OnDestroy, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';
import { Chart, ChartConfiguration, registerables } from 'chart.js';
import {
  ReportsService, RevenueByMonth, InvoiceStatusBreakdown, TopCustomer, VatSummaryRow
} from '../../services/reports.service';
import { forkJoin } from 'rxjs';

Chart.register(...registerables);

const STATUS_COLORS: Record<string, string> = {
  DRAFT:     '#9ca3af',
  SENT:      '#4a90e2',
  PAID:      '#16a34a',
  OVERDUE:   '#f59e0b',
  CANCELLED: '#ef4444'
};

const MONTH_LABELS: Record<string, string> = {
  '01': 'Jan', '02': 'Feb', '03': 'Mar', '04': 'Apr',
  '05': 'May', '06': 'Jun', '07': 'Jul', '08': 'Aug',
  '09': 'Sep', '10': 'Oct', '11': 'Nov', '12': 'Dec'
};

function formatMonth(ym: string): string {
  const [, m] = ym.split('-');
  return MONTH_LABELS[m] ?? ym;
}

@Component({
  selector: 'app-reports',
  templateUrl: './reports.page.html',
  styleUrls: ['./reports.page.scss'],
  standalone: true,
  imports: [CommonModule, IonicModule]
})
export class ReportsPage implements OnInit, OnDestroy {
  @ViewChild('revenueCanvas')  revenueCanvas!:  ElementRef<HTMLCanvasElement>;
  @ViewChild('statusCanvas')   statusCanvas!:   ElementRef<HTMLCanvasElement>;
  @ViewChild('customersCanvas') customersCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('vatCanvas')      vatCanvas!:      ElementRef<HTMLCanvasElement>;

  isLoading = true;
  hasError  = false;

  topCustomers: TopCustomer[] = [];
  vatRows: VatSummaryRow[]    = [];

  private charts: Chart[] = [];

  private revenueData?: RevenueByMonth[];
  private statusData?:  InvoiceStatusBreakdown[];
  private customerData?: TopCustomer[];
  private vatData?:     VatSummaryRow[];


  constructor(private reports: ReportsService) {}

  ngOnInit() {
    forkJoin({
      revenue:   this.reports.getRevenueByMonth(),
      status:    this.reports.getInvoiceStatus(),
      customers: this.reports.getTopCustomers(),
      vat:       this.reports.getVatSummary()
    }).subscribe({
      next: ({ revenue, status, customers, vat }) => {
        this.revenueData  = revenue;
        this.statusData   = status;
        this.customerData = customers;
        this.vatData      = vat;
        this.topCustomers = customers;
        this.vatRows      = vat;
        this.isLoading    = false;
        // Wait one tick for Angular to render the *ngIf canvases before building charts
        setTimeout(() => this.buildCharts(), 0);
      },
      error: () => {
        this.isLoading = false;
        this.hasError  = true;
      }
    });
  }


  ngOnDestroy() {
    this.charts.forEach(c => c.destroy());
  }

  private buildCharts() {
    this.buildRevenueChart();
    this.buildStatusChart();
    this.buildCustomersChart();
    this.buildVatChart();
  }

  private register(chart: Chart) {
    this.charts.push(chart);
  }

  private buildRevenueChart() {
    const data = this.revenueData ?? [];
    const cfg: ChartConfiguration = {
      type: 'bar',
      data: {
        labels: data.map(r => formatMonth(r.month)),
        datasets: [{
          label: 'Revenue (R)',
          data: data.map(r => +r.revenue),
          backgroundColor: '#4a90e2',
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { callback: v => `R ${v}` } }
        }
      }
    };
    this.register(new Chart(this.revenueCanvas.nativeElement, cfg));
  }

  private buildStatusChart() {
    const data = this.statusData ?? [];
    const cfg: ChartConfiguration = {
      type: 'doughnut',
      data: {
        labels: data.map(r => r.status),
        datasets: [{
          data: data.map(r => +r.count),
          backgroundColor: data.map(r => STATUS_COLORS[r.status] ?? '#9ca3af')
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } }
      }
    };
    this.register(new Chart(this.statusCanvas.nativeElement, cfg));
  }

  private buildCustomersChart() {
    const data = this.customerData ?? [];
    const cfg: ChartConfiguration = {
      type: 'bar',
      data: {
        labels: data.map(r => r.name),
        datasets: [{
          label: 'Revenue (R)',
          data: data.map(r => +r.revenue),
          backgroundColor: '#16a34a',
          borderRadius: 4
        }]
      },
      options: {
        indexAxis: 'y' as const,
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, ticks: { callback: v => `R ${v}` } }
        }
      }
    };
    this.register(new Chart(this.customersCanvas.nativeElement, cfg));
  }

  private buildVatChart() {
    const data = this.vatData ?? [];
    const cfg: ChartConfiguration = {
      type: 'bar',
      data: {
        labels: data.map(r => formatMonth(r.month)),
        datasets: [
          {
            label: 'Subtotal',
            data: data.map(r => +r.subtotal),
            backgroundColor: '#4a90e2',
            borderRadius: 4,
            stack: 'vat'
          },
          {
            label: 'VAT',
            data: data.map(r => +r.vat_amount),
            backgroundColor: '#f59e0b',
            borderRadius: 4,
            stack: 'vat'
          }
        ]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' } },
        scales: {
          y: { beginAtZero: true, stacked: true, ticks: { callback: v => `R ${v}` } },
          x: { stacked: true }
        }
      }
    };
    this.register(new Chart(this.vatCanvas.nativeElement, cfg));
  }

  get totalPaidRevenue(): number {
    return (this.revenueData ?? []).reduce((s, r) => s + +r.revenue, 0);
  }

  get totalVat(): number {
    return this.vatRows.reduce((s, r) => s + +r.vat_amount, 0);
  }

  get totalVatSubtotal(): number {
    return this.vatRows.reduce((s, r) => s + +r.subtotal, 0);
  }

  get totalVatTotal(): number {
    return this.vatRows.reduce((s, r) => s + +r.total, 0);
  }
}
