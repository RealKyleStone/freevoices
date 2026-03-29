import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { IonicModule, AlertController, ToastController } from '@ionic/angular';
import { CustomerService } from '../../services/customer.service';
import { Customer } from '../../../../../models/database.models';
import { Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';

@Component({
  selector: 'app-customer-list',
  templateUrl: './customer-list.page.html',
  styleUrls: ['./customer-list.page.scss'],
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, IonicModule]
})
export class CustomerListPage implements OnInit {
  customers: Customer[] = [];
  isLoading = false;
  searchTerm = '';
  total = 0;
  page = 1;
  limit = 20;

  private searchSubject = new Subject<string>();

  constructor(
    private customerService: CustomerService,
    private alertCtrl: AlertController,
    private toastCtrl: ToastController
  ) {}

  ngOnInit() {
    this.searchSubject.pipe(debounceTime(300), distinctUntilChanged()).subscribe(() => {
      this.page = 1;
      this.loadCustomers();
    });
    this.loadCustomers();
  }

  loadCustomers() {
    this.isLoading = true;
    this.customerService.getCustomers(this.searchTerm, this.page, this.limit).subscribe({
      next: (res) => {
        this.customers = res.data;
        this.total = res.total;
        this.isLoading = false;
      },
      error: () => {
        this.isLoading = false;
        this.showToast('Failed to load customers', 'danger');
      }
    });
  }

  onSearchChange() {
    this.searchSubject.next(this.searchTerm);
  }

  get totalPages(): number {
    return Math.ceil(this.total / this.limit);
  }

  prevPage() {
    if (this.page > 1) { this.page--; this.loadCustomers(); }
  }

  nextPage() {
    if (this.page < this.totalPages) { this.page++; this.loadCustomers(); }
  }

  async confirmDelete(customer: Customer) {
    const alert = await this.alertCtrl.create({
      header: 'Delete Customer',
      message: `Remove ${customer.name} from your customers?`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Delete',
          role: 'destructive',
          handler: () => this.deleteCustomer(customer)
        }
      ]
    });
    await alert.present();
  }

  deleteCustomer(customer: Customer) {
    this.customerService.deleteCustomer(customer.id).subscribe({
      next: () => {
        this.customers = this.customers.filter(c => c.id !== customer.id);
        this.total--;
        this.showToast('Customer deleted');
      },
      error: () => this.showToast('Failed to delete customer', 'danger')
    });
  }

  private async showToast(message: string, color = 'success') {
    const toast = await this.toastCtrl.create({ message, duration: 2500, color, position: 'bottom' });
    await toast.present();
  }
}
