import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { IonicModule, ToastController } from '@ionic/angular';
import { Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { QuoteService, QuoteListItem } from '../../services/quote.service';

@Component({
  selector: 'app-quote-list',
  templateUrl: './quote-list.page.html',
  styleUrls: ['./quote-list.page.scss'],
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, IonicModule]
})
export class QuoteListPage implements OnInit {
  quotes: QuoteListItem[] = [];
  isLoading = false;
  searchTerm = '';
  selectedStatus = '';
  total = 0;
  page = 1;
  limit = 20;

  private searchSubject = new Subject<string>();

  constructor(
    private quoteService: QuoteService,
    private toastCtrl: ToastController
  ) {}

  ngOnInit() {
    this.searchSubject.pipe(debounceTime(300), distinctUntilChanged()).subscribe(() => {
      this.page = 1;
      this.loadQuotes();
    });
    this.loadQuotes();
  }

  loadQuotes() {
    this.isLoading = true;
    this.quoteService.getQuotes(this.searchTerm, this.selectedStatus, this.page, this.limit).subscribe({
      next: (res) => {
        this.quotes = res.data;
        this.total = res.total;
        this.isLoading = false;
      },
      error: async () => {
        this.isLoading = false;
        const toast = await this.toastCtrl.create({ message: 'Failed to load quotes', duration: 2500, color: 'danger', position: 'bottom' });
        await toast.present();
      }
    });
  }

  onSearchChange() { this.searchSubject.next(this.searchTerm); }

  onStatusChange() {
    this.page = 1;
    this.loadQuotes();
  }

  get totalPages(): number { return Math.ceil(this.total / this.limit); }
  prevPage() { if (this.page > 1) { this.page--; this.loadQuotes(); } }
  nextPage() { if (this.page < this.totalPages) { this.page++; this.loadQuotes(); } }

  getStatusColor(status: string): string {
    const map: Record<string, string> = {
      DRAFT: 'medium', SENT: 'primary', PAID: 'success', OVERDUE: 'warning', CANCELLED: 'danger'
    };
    return map[status] ?? 'medium';
  }
}
