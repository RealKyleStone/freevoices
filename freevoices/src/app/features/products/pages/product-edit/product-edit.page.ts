import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IonicModule, ToastController } from '@ionic/angular';
// Side-effect import, deliberately absent from the imports array below.
//
// IonicModule alone doesn't register every Ionic web component in this app's
// standalone bootstrap (see main.ts's provideIonicAngular()) — components only
// upgrade once some page explicitly imports their standalone class. Nothing in
// the app did that for ion-textarea, so it silently never became interactive.
//
// Importing the class defines the custom element, but listing it in the
// imports array alongside IonicModule made two Angular components match
// <ion-textarea> and threw NG0300, which blanked this page under
// ng serve, though production builds compile the assertion out, so only
// local development was affected.
// Keep the import: removing it takes the element registration with it.
import { IonTextarea } from '@ionic/angular/standalone';
import { ProductService } from '../../services/product.service';

@Component({
  selector: 'app-product-edit',
  templateUrl: './product-edit.page.html',
  styleUrls: ['./product-edit.page.scss'],
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, IonicModule]
})
export class ProductEditPage implements OnInit {
  form: FormGroup;
  isLoading = false;
  isFetching = true;
  submitted = false;
  productId!: number;

  constructor(
    private fb: FormBuilder,
    private route: ActivatedRoute,
    private router: Router,
    private productService: ProductService,
    private toastCtrl: ToastController
  ) {
    this.form = this.fb.group({
      name:          ['', [Validators.required, Validators.minLength(2)]],
      description:   [''],
      price:         [null, [Validators.required, Validators.min(0)]],
      vat_inclusive: [false]
    });
  }

  ngOnInit() {
    this.productId = Number(this.route.snapshot.paramMap.get('id'));
    this.productService.getProduct(this.productId).subscribe({
      next: (product) => {
        this.form.patchValue({
          name:          product.name,
          description:   product.description,
          price:         product.price,
          vat_inclusive: product.vat_inclusive
        });
        this.isFetching = false;
      },
      error: async () => {
        this.isFetching = false;
        await this.showToast('Failed to load product', 'danger');
        this.router.navigate(['/products']);
      }
    });
  }

  isInvalid(field: string): boolean {
    const ctrl = this.form.get(field);
    return !!ctrl && ctrl.invalid && (ctrl.dirty || ctrl.touched || this.submitted);
  }

  async onSubmit() {
    this.submitted = true;
    if (this.form.invalid) { this.form.markAllAsTouched(); return; }

    this.isLoading = true;
    this.productService.updateProduct(this.productId, this.form.value).subscribe({
      next: () => {
        this.router.navigate(['/products', this.productId]);
      },
      error: async (err) => {
        this.isLoading = false;
        const msg = err.error?.message || 'Failed to update product';
        await this.showToast(msg, 'danger');
      }
    });
  }

  private async showToast(message: string, color = 'success') {
    const toast = await this.toastCtrl.create({ message, duration: 3000, color, position: 'bottom' });
    await toast.present();
  }
}
