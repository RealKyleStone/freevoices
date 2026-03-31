import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { IonicModule, AlertController, ToastController } from '@ionic/angular';
import { ProductService } from '../../services/product.service';
import { Product } from '../../../../../models/database.models';

@Component({
  selector: 'app-product-detail',
  templateUrl: './product-detail.page.html',
  styleUrls: ['./product-detail.page.scss'],
  standalone: true,
  imports: [CommonModule, RouterModule, IonicModule]
})
export class ProductDetailPage implements OnInit {
  product?: Product;
  isLoading = true;
  productId!: number;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private productService: ProductService,
    private alertCtrl: AlertController,
    private toastCtrl: ToastController
  ) {}

  ngOnInit() {
    this.productId = Number(this.route.snapshot.paramMap.get('id'));
    this.loadProduct();
  }

  loadProduct() {
    this.isLoading = true;
    this.productService.getProduct(this.productId).subscribe({
      next: (product) => {
        this.product = product;
        this.isLoading = false;
      },
      error: async () => {
        this.isLoading = false;
        const toast = await this.toastCtrl.create({ message: 'Failed to load product', duration: 3000, color: 'danger', position: 'bottom' });
        await toast.present();
        this.router.navigate(['/products']);
      }
    });
  }

  async confirmDelete() {
    const alert = await this.alertCtrl.create({
      header: 'Delete Product',
      message: `Remove "${this.product?.name}" from your catalogue?`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Delete', role: 'destructive', handler: () => this.deleteProduct() }
      ]
    });
    await alert.present();
  }

  deleteProduct() {
    this.productService.deleteProduct(this.productId).subscribe({
      next: async () => {
        const toast = await this.toastCtrl.create({ message: 'Product deleted', duration: 2500, color: 'success', position: 'bottom' });
        await toast.present();
        this.router.navigate(['/products']);
      },
      error: async () => {
        const toast = await this.toastCtrl.create({ message: 'Failed to delete product', duration: 3000, color: 'danger', position: 'bottom' });
        await toast.present();
      }
    });
  }
}
