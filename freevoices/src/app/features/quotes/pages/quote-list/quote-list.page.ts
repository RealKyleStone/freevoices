import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import {
  ToastController, IonButton, IonButtons, IonContent, IonFab, IonFabButton, IonHeader, IonIcon,
  IonItem, IonLabel, IonMenuButton, IonRouterLink, IonSearchbar, IonSegment, IonSegmentButton,
  IonSkeletonText, IonToolbar,
} from '@ionic/angular/standalone';
import { Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { QuoteService, QuoteListItem } from '../../services/quote.service';
import { addIcons } from 'ionicons';
import {
  add, addOutline, chevronBackOutline, chevronForwardOutline, documentOutline,
} from 'ionicons/icons';

@Component({
  selector: 'app-quote-list',
  templateUrl: './quote-list.page.html',
  styleUrls: ['./quote-list.page.scss'],
  standalone: true,
  imports: [
    CommonModule, RouterModule, FormsModule, IonButton, IonButtons, IonContent, IonFab,
    IonFabButton, IonHeader, IonIcon, IonItem, IonLabel, IonMenuButton, IonRouterLink,
    IonSearchbar, IonSegment, IonSegmentButton, IonSkeletonText, IonToolbar,
  ]
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
  ) {
    addIcons({ add, addOutline, chevronBackOutline, chevronForwardOutline, documentOutline });
  }

  ngOnInit() {
    this.searchSubject.pipe(debounceTime(300), distinctUntilChanged()).subscribe(() => {
      this.page = 1;
      this.loadQuotes();
    });
  }

  // Ionic keeps this page alive underneath the create and detail pages, so
  // ngOnInit runs only once. This runs every time the page comes back into
  // view, so a record added or changed elsewhere appears without a refresh.
  ionViewWillEnter() {
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
      DRAFT: 'medium', SENT: 'primary', PAID: 'success', CONVERTED: 'success', OVERDUE: 'warning', CANCELLED: 'danger'
    };
    return map[status] ?? 'medium';
  }
}
