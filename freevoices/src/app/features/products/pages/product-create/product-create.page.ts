import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { Router } from '@angular/router';
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
  selector: 'app-product-create',
  templateUrl: './product-create.page.html',
  styleUrls: ['./product-create.page.scss'],
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, IonicModule]
})
export class ProductCreatePage {
  form: FormGroup;
  isLoading = false;
  submitted = false;

  constructor(
    private fb: FormBuilder,
    private productService: ProductService,
    private router: Router,
    private toastCtrl: ToastController
  ) {
    this.form = this.fb.group({
      name:          ['', [Validators.required, Validators.minLength(2)]],
      description:   [''],
      price:         [null, [Validators.required, Validators.min(0)]],
      vat_inclusive: [false]
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
    this.productService.createProduct(this.form.value).subscribe({
      next: (product) => {
        this.router.navigate(['/products', product.id]);
      },
      error: async (err) => {
        this.isLoading = false;
        const msg = err.error?.message || 'Failed to create product';
        const toast = await this.toastCtrl.create({ message: msg, duration: 3000, color: 'danger', position: 'bottom' });
        await toast.present();
      }
    });
  }
}
