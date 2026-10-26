import { Component, OnInit, OnDestroy, AfterViewChecked, ViewChild, ElementRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import {
  IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonMenuButton, IonSpinner, IonToolbar,
} from '@ionic/angular/standalone';
import { Chart, ChartConfiguration, registerables } from 'chart.js';
import {
  ReportsService, RevenueByMonth, InvoiceStatusBreakdown, TopCustomer, VatSummaryRow, PaymentLedger, AgeingReport, CustomerStatement
} from '../../services/reports.service';
import { CataloguePickerComponent } from '../../../../shared/components/catalogue-picker/catalogue-picker.component';
import { paymentsLedgerCsv } from '../../services/payments-ledger-csv';
import { customerStatementCsv } from '../../services/statement-csv';
import { forkJoin, Subscription } from 'rxjs';
import { vatSummaryCsv } from '../../services/vat-csv';
import { addIcons } from 'ionicons';
import {
  alertCircleOutline,
} from 'ionicons/icons';

Chart.register(...registerables);

/*
 * Chart colours are read from the theme at build time rather than hard-coded.
 *
 * The five status colours used to be literals, two of which (#4a90e2 and
 * #f59e0b) appear nowhere else in the product, so the charts disagreed with
 * the status badges on every other screen. These map to the same tokens the
 * badges use, via the DRAFT/SENT/PAID/OVERDUE/CANCELLED mapping the list
 * pages already apply (medium / primary / success / warning / danger).
 */
const STATUS_TOKENS: Record<string, string> = {
  DRAFT:     '--fv-medium-text',
  SENT:      '--fv-teal-text',
  PAID:      '--fv-success-text',
  OVERDUE:   '--fv-warning-text',
  CANCELLED: '--fv-danger-text'
};

const STATUS_LABELS: Record<string, string> = {
  DRAFT: 'Draft', SENT: 'Issued', PAID: 'Paid',
  OVERDUE: 'Overdue', CANCELLED: 'Cancelled'
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
  imports: [
    CommonModule, ReactiveFormsModule, CataloguePickerComponent, IonButton, IonButtons, IonContent, IonHeader, IonIcon, IonMenuButton, IonSpinner,
    IonToolbar,
  ]
})
export class ReportsPage implements OnInit, OnDestroy, AfterViewChecked {
  @ViewChild('revenueCanvas')  revenueCanvas!:  ElementRef<HTMLCanvasElement>;
  @ViewChild('statusCanvas')   statusCanvas!:   ElementRef<HTMLCanvasElement>;
  @ViewChild('customersCanvas') customersCanvas!: ElementRef<HTMLCanvasElement>;
  @ViewChild('vatCanvas')      vatCanvas!:      ElementRef<HTMLCanvasElement>;

  selectedCurrency = 'ZAR';
  currencies: {code:string;name:string;symbol:string}[] = [];
  isLoading = true;
  hasError  = false;

  topCustomers: TopCustomer[] = [];
  vatRows: VatSummaryRow[]    = [];
  ledger: PaymentLedger | null = null;
  ageing: AgeingReport | null = null;
  statement: CustomerStatement | null = null;
  ledgerCustomer = new FormControl<number | null>(null);
  ledgerFrom = '';
  ledgerTo = '';
  ledgerLoading = false;
  ledgerError = '';
  accountingError = '';

  private charts: Chart[] = [];
  private themeObserver?: MutationObserver;

  private revenueData?: RevenueByMonth[];
  private statusData?:  InvoiceStatusBreakdown[];
  private customerData?: TopCustomer[];
  private vatData?:     VatSummaryRow[];
  private chartsPending = false;
  private requests = new Subscription();


  constructor(private reports: ReportsService) {
    addIcons({ alertCircleOutline });
  }

  /** Resolve a CSS custom property against the document root. */
  private token(name: string, fallback: string): string {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  /**
   * Colours for the current theme.
   *
   * Chart.js draws to a canvas, so it cannot inherit CSS. Left to its own
   * defaults it paints tick labels, legend text and grid lines in #666 and
   * rgba(0,0,0,0.1), which is low contrast on the light surface and close to
   * invisible on the #111111 dark one.
   */
  private themeColors() {
    return {
      // --fv-medium-text and --ion-text-color-rgb both flip with the theme,
      // where --ion-color-medium does not: it stays #6b7280 in dark mode,
      // which is only about 3.45:1 against the #1e1e1e card. These measure
      // 10.5:1 in light and 6.6:1 in dark.
      text: this.token('--fv-medium-text', '#374151'),
      grid: `rgba(${this.token('--ion-text-color-rgb', '17, 24, 39')}, 0.12)`,
      primary: this.token('--ion-color-primary', '#0f766e'),
      accent: this.token('--fv-warning-text', '#854d0e'),
      status: (status: string) =>
        this.token(STATUS_TOKENS[status] ?? '--fv-medium-text', '#6b7280')
    };
  }

  ngOnInit() {
    this.requests.add(this.reports.getCurrencies().subscribe(rows => this.currencies = rows));
    this.loadReports();
  }

  changeCurrency(event: Event) {
    this.selectedCurrency = (event.target as HTMLSelectElement).value;
    this.ledger = null;
    this.ageing = null;
    this.statement = null;
    this.loadReports();
  }

  private loadReports() {
    this.destroyCharts();
    this.isLoading = true;
    this.hasError = false;
    this.chartsPending = false;
    this.requests.add(forkJoin({
      revenue:   this.reports.getRevenueByMonth(this.selectedCurrency),
      status:    this.reports.getInvoiceStatus(this.selectedCurrency),
      customers: this.reports.getTopCustomers(this.selectedCurrency),
      vat:       this.reports.getVatSummary(this.selectedCurrency)
    }).subscribe({
      next: ({ revenue, status, customers, vat }) => {
        this.revenueData  = revenue;
        this.statusData   = status;
        this.customerData = customers;
        this.vatData      = vat;
        this.topCustomers = customers;
        this.vatRows      = vat;
        this.isLoading    = false;
        this.chartsPending = true;
      },
      error: () => {
        this.isLoading = false;
        this.hasError  = true;
      }
    }));
  }


  ngAfterViewChecked() {
    if (this.chartsPending && this.revenueCanvas && this.statusCanvas) {
      this.chartsPending = false;
      this.buildCharts();
    }
  }

  ngOnDestroy() {
    this.requests.unsubscribe();
    this.chartsPending = false;
    this.themeObserver?.disconnect();
    this.destroyCharts();
  }

  /**
   * Redraw when the theme changes.
   *
   * AppComponent toggles .ion-palette-dark on the document element, and the
   * charts bake their colours in at draw time, so they have to be rebuilt to
   * follow it — otherwise switching theme leaves four charts painted for the
   * previous one until the page is revisited.
   */
  private watchTheme() {
    if (this.themeObserver) return;
    this.themeObserver = new MutationObserver(() => {
      if (this.charts.length) this.buildCharts();
    });
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    });
  }

  private destroyCharts() {
    this.charts.forEach(c => c.destroy());
    this.charts = [];
  }

  private buildCharts() {
    // Rebuilding reuses the same canvases, so the previous instances have to
    // be released first or Chart.js refuses to attach to them.
    this.destroyCharts();

    const t = this.themeColors();
    Chart.defaults.color = t.text;
    Chart.defaults.borderColor = t.grid;

    this.buildRevenueChart();
    this.buildStatusChart();
    if (this.customersCanvas) this.buildCustomersChart();
    if (this.vatCanvas) this.buildVatChart();
    this.watchTheme();
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
          label: `Revenue (${this.selectedCurrency})`,
          data: data.map(r => +r.revenue),
          backgroundColor: this.themeColors().primary,
          borderRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { callback: v => `${this.selectedCurrency} ${v}` } }
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
        labels: data.map(r => STATUS_LABELS[r.status] ?? r.status),
        datasets: [{
          data: data.map(r => +r.count),
          backgroundColor: data.map(r => this.themeColors().status(r.status))
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
          label: `Revenue (${this.selectedCurrency})`,
          data: data.map(r => +r.revenue),
          backgroundColor: this.themeColors().primary,
          borderRadius: 4
        }]
      },
      options: {
        indexAxis: 'y' as const,
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { beginAtZero: true, ticks: { callback: v => `${this.selectedCurrency} ${v}` } }
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
            backgroundColor: this.themeColors().primary,
            borderRadius: 4,
            stack: 'vat'
          },
          {
            label: 'VAT',
            data: data.map(r => +r.vat_amount),
            backgroundColor: this.themeColors().accent,
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
          y: { beginAtZero: true, stacked: true, ticks: { callback: v => `${this.selectedCurrency} ${v}` } },
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

  exportVatCsv() {
    if (!this.vatRows.length) return;
    const blob = new Blob([vatSummaryCsv(this.vatRows, this.selectedCurrency)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `freevoices-vat-${this.selectedCurrency}-${new Date().getFullYear()}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  loadLedger() {
    if (this.ledgerFrom && this.ledgerTo && this.ledgerFrom > this.ledgerTo) { this.ledgerError = 'From date must be before To date.'; return; }
    this.ledgerLoading = true;
    this.ledgerError = '';
    this.ledger = null;
    this.requests.add(this.reports.getPaymentsLedger(this.selectedCurrency, this.ledgerFrom, this.ledgerTo, this.ledgerCustomer.value).subscribe({
      next: ledger => { this.ledger = ledger; this.ledgerLoading = false; },
      error: err => { this.ledgerLoading = false; this.ledgerError = err.error?.message || 'Could not load payment transactions.'; }
    }));
  }

  exportLedgerCsv() {
    if (!this.ledger) return;
    const blob = new Blob([paymentsLedgerCsv(this.ledger)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
      link.download = `freevoices-cash-movements-${this.selectedCurrency}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  loadAgeing() {
    this.accountingError = '';
    this.ageing = null;
    this.requests.add(this.reports.getAgeing(this.selectedCurrency, this.ledgerCustomer.value).subscribe({
      next: report => this.ageing = report,
      error: err => this.accountingError = err.error?.message || 'Could not load ageing report.'
    }));
  }

  loadStatement() {
    if (!this.ledgerCustomer.value) { this.accountingError = 'Choose a customer for the statement.'; return; }
    if (this.ledgerFrom && this.ledgerTo && this.ledgerFrom > this.ledgerTo) { this.accountingError = 'From date must be before To date.'; return; }
    this.accountingError = '';
    this.statement = null;
    this.requests.add(this.reports.getCustomerStatement(this.selectedCurrency, this.ledgerCustomer.value, this.ledgerFrom, this.ledgerTo).subscribe({
      next: statement => this.statement = statement,
      error: err => this.accountingError = err.error?.message || 'Could not load customer statement.'
    }));
  }

  exportStatementCsv() {
    if (!this.statement) return;
    const blob = new Blob([customerStatementCsv(this.statement)], { type:'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `freevoices-statement-${this.statement.customer_id}-${this.selectedCurrency}.csv`;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(()=>URL.revokeObjectURL(url),0);
  }
}
