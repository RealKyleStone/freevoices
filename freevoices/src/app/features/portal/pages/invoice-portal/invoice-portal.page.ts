import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { IonicModule } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { downloadOutline, warningOutline } from 'ionicons/icons';
import { environment } from '../../../../../environments/environment';

interface PortalInvoice {
  id: number;
  document_number: string;
  status: string;
  issue_date: string;
  due_date: string;
  payment_terms: number;
  subtotal: number;
  vat_amount: number;
  total: number;
  notes: string;
  terms_conditions: string;
  customer_name: string;
  customer_email: string;
  customer_billing_address: string;
  customer_vat_number: string;
  currency_symbol: string;
  currency_code: string;
  company_name: string;
  company_vat_number: string;
  company_address: string;
  company_email: string;
  company_logo: string | null;
  bank_name: string;
  bank_account_number: string;
  bank_branch_code: string;
  bank_account_type: string;
  items: {
    description: string;
    quantity: number;
    unit_price: number;
    vat_rate: number;
    vat_amount: number;
    subtotal: number;
    total: number;
  }[];
}

@Component({
  selector: 'app-invoice-portal',
  templateUrl: './invoice-portal.page.html',
  styleUrls: ['./invoice-portal.page.scss'],
  standalone: true,
  imports: [CommonModule, IonicModule]
})
export class InvoicePortalPage implements OnInit {
  invoice?: PortalInvoice;
  isLoading = true;
  error: string | null = null;
  isDownloading = false;
  token!: string;

  private apiUrl = environment.apiUrl;

  constructor(
    private route: ActivatedRoute,
    private http: HttpClient
  ) {
    addIcons({ downloadOutline, warningOutline });
  }

  ngOnInit() {
    this.token = this.route.snapshot.paramMap.get('token') || '';
    this.http.get<PortalInvoice>(`${this.apiUrl}/public/invoice/${this.token}`).subscribe({
      next: (invoice) => {
        this.invoice = invoice;
        this.isLoading = false;
      },
      error: (err) => {
        this.error = err.error?.message || 'Invoice not found or link has expired.';
        this.isLoading = false;
      }
    });
  }

  get currencySymbol(): string {
    return this.invoice?.currency_symbol || 'R';
  }

  getStatusColor(status: string): string {
    const map: Record<string, string> = {
      DRAFT: 'medium', SENT: 'primary', PAID: 'success', OVERDUE: 'warning', CANCELLED: 'danger'
    };
    return map[status] ?? 'medium';
  }

  async downloadPdf() {
    this.isDownloading = true;
    try {
      const response = await fetch(`${this.apiUrl}/public/invoice/${this.token}/pdf`);
      if (!response.ok) throw new Error('Failed to generate PDF');
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = `${this.invoice?.document_number || 'invoice'}.pdf`;
      a.click();
      URL.revokeObjectURL(blobUrl);
    } catch {
      // Silently fail — user will see no download
    } finally {
      this.isDownloading = false;
    }
  }
}
