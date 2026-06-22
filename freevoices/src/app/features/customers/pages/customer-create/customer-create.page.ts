import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { IonicModule, ToastController } from '@ionic/angular';
import { CustomerService } from '../../services/customer.service';

@Component({
  selector: 'app-customer-create',
  templateUrl: './customer-create.page.html',
  styleUrls: ['./customer-create.page.scss'],
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, IonicModule]
})
export class CustomerCreatePage {
  form: FormGroup;
  isLoading = false;
  submitted = false;

  constructor(
    private fb: FormBuilder,
    private customerService: CustomerService,
    private router: Router,
    private toastCtrl: ToastController
  ) {
    this.form = this.fb.group({
      name:             ['', [Validators.required, Validators.minLength(2)]],
      email:            ['', [Validators.required, Validators.email]],
      phone:            [''],
      vat_number:       [''],
      billing_address:  ['', Validators.required],
      shipping_address: [''],
      payment_terms:    [30],
      notes:            ['']
    });
  }

  isInvalid(field: string): boolean {
    const ctrl = this.form.get(field);
    return !!ctrl && ctrl.invalid && (ctrl.dirty || ctrl.touched || this.submitted);
  }

  // Returns the first validation error message for a field
  getError(field: string): string {
    const ctrl = this.form.get(field);
    if (!ctrl || !ctrl.errors) return '';
    if (ctrl.errors['required'])  return `${this.fieldLabel(field)} is required`;
    if (ctrl.errors['email'])     return 'Please enter a valid email address';
    if (ctrl.errors['minlength']) return `${this.fieldLabel(field)} is too short`;
    return 'Invalid value';
  }

  private fieldLabel(field: string): string {
    const labels: Record<string, string> = {
      name: 'Name', email: 'Email', billing_address: 'Billing address',
      phone: 'Phone', payment_terms: 'Payment terms'
    };
    return labels[field] || field;
  }

  async onSubmit() {
    this.submitted = true;
    this.form.markAllAsTouched();

    if (this.form.invalid) {
      // Find the first invalid field and show its error as a toast
      const firstInvalidField = Object.keys(this.form.controls)
        .find(key => this.form.controls[key].invalid);
      const message = firstInvalidField
        ? this.getError(firstInvalidField)
        : 'Please fill in all required fields correctly';

      const toast = await this.toastCtrl.create({
        message,
        duration: 3000,
        color: 'danger',
        position: 'bottom'
      });
      await toast.present();
      return;
    }

    this.isLoading = true;
    this.customerService.createCustomer(this.form.value).subscribe({
      next: (customer) => {
        this.router.navigate(['/customers', customer.id]);
      },
      error: async (err) => {
        this.isLoading = false;
        const msg = err.error?.message || 'Failed to create customer';
        const toast = await this.toastCtrl.create({ message: msg, duration: 3000, color: 'danger', position: 'bottom' });
        await toast.present();
      }
    });
  }
}