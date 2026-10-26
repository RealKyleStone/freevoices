import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute } from '@angular/router';
import { HttpClient } from '@angular/common/http';
import { IonBadge, IonButton, IonContent, IonSpinner } from '@ionic/angular/standalone';
import { environment } from '../../../../../environments/environment';

interface PortalQuote {
  document_number: string;
  status: string;
  issue_date: string;
  valid_until?: string;
  subtotal: number;
  vat_amount: number;
  total: number;
  notes?: string;
  terms_conditions?: string;
  purchase_order_ref?: string;
  delivery_details?: string;
  customer_name: string;
  currency_symbol: string;
  company_name: string;
  company_address?: string;
  company_email?: string;
  company_logo?: string | null;
  items: { description: string; quantity: number; unit_label?: string; unit_price: number; discount_percent?: number; vat_rate: number; total: number }[];
}

@Component({
  selector: 'app-quote-portal',
  templateUrl: './quote-portal.page.html',
  styleUrls: ['../invoice-portal/invoice-portal.page.scss', './quote-portal.page.scss'],
  standalone: true,
  imports: [CommonModule, IonBadge, IonButton, IonContent, IonSpinner]
})
export class QuotePortalPage implements OnInit {
  quote?: PortalQuote;
  token = '';
  isLoading = true;
  isSubmitting = false;
  isDownloading = false;
  error: string | null = null;
  decisionMessage: string | null = null;

  constructor(private route: ActivatedRoute, private http: HttpClient) {}

  ngOnInit() {
    this.token = this.route.snapshot.paramMap.get('token') || '';
    this.load();
  }

  load() {
    this.http.get<PortalQuote>(`${environment.apiUrl}/public/quote/${this.token}`).subscribe({
      next: quote => { this.quote = quote; this.isLoading = false; },
      error: err => { this.error = err.error?.message || 'Quote not found or link has expired.'; this.isLoading = false; }
    });
  }

  decide(decision: 'ACCEPTED' | 'DECLINED') {
    if (this.isSubmitting || this.quote?.status !== 'SENT') return;
    this.isSubmitting = true;
    this.error = null;
    this.http.post<{ message: string }>(`${environment.apiUrl}/public/quote/${this.token}/decision`, { decision }).subscribe({
      next: response => { this.isSubmitting = false; this.decisionMessage = response.message; this.load(); },
      error: err => { this.isSubmitting = false; this.error = err.error?.message || 'Could not record your decision. Please try again.'; this.load(); }
    });
  }

  async downloadPdf() {
    if (this.isDownloading) return;
    this.isDownloading = true;
    try {
      const response = await fetch(`${environment.apiUrl}/public/quote/${this.token}/pdf`);
      if (!response.ok) throw new Error('PDF unavailable');
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement('a');
      link.href = url;
      link.download = `${this.quote?.document_number || 'quote'}.pdf`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch { this.error = 'Could not download the quote PDF. Please try again.'; }
    finally { this.isDownloading = false; }
  }
}
