import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { IonicModule, AlertController, ToastController } from '@ionic/angular';
import { Subject } from 'rxjs';
import { debounceTime, distinctUntilChanged } from 'rxjs/operators';
import { ProductService } from '../../services/product.service';
import { Product } from '../../../../../models/database.models';

@Component({
  selector: 'app-product-list',
  templateUrl: './product-list.page.html',
  styleUrls: ['./product-list.page.scss'],
  standalone: true,
  imports: [CommonModule, RouterModule, FormsModule, IonicModule]
})
export class ProductListPage implements OnInit {
  products: Product[] = [];
  isLoading = false;
  searchTerm = '';
  total = 0;
  page = 1;
  limit = 20;

  private searchSubject = new Subject<string>();

  constructor(
    private productService: ProductService,
    private alertCtrl: AlertController,
    private toastCtrl: ToastController
  ) {}

  ngOnInit() {
    this.searchSubject.pipe(debounceTime(300), distinctUntilChanged()).subscribe(() => {
      this.page = 1;
      this.loadProducts();
    });
    this.loadProducts();
  }

  loadProducts() {
    this.isLoading = true;
    this.productService.getProducts(this.searchTerm, this.page, this.limit).subscribe({
      next: (res) => {
        this.products = res.data;
        this.total = res.total;
        this.isLoading = false;
      },
      error: () => {
        this.isLoading = false;
        this.showToast('Failed to load products', 'danger');
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
    if (this.page > 1) { this.page--; this.loadProducts(); }
  }

  nextPage() {
    if (this.page < this.totalPages) { this.page++; this.loadProducts(); }
  }

  async confirmDelete(product: Product) {
    const alert = await this.alertCtrl.create({
      header: 'Delete Product',
      message: `Remove "${product.name}" from your catalogue?`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Delete', role: 'destructive', handler: () => this.deleteProduct(product) }
      ]
    });
    await alert.present();
  }

  deleteProduct(product: Product) {
    this.productService.deleteProduct(product.id).subscribe({
      next: () => {
        this.products = this.products.filter(p => p.id !== product.id);
        this.total--;
        this.showToast('Product deleted');
      },
      error: () => this.showToast('Failed to delete product', 'danger')
    });
  }

  private async showToast(message: string, color = 'success') {
    const toast = await this.toastCtrl.create({ message, duration: 2500, color, position: 'bottom' });
    await toast.present();
  }
}
