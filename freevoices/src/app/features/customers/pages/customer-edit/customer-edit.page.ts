import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IonicModule, ToastController } from '@ionic/angular';
import { CustomerService } from '../../services/customer.service';

@Component({
  selector: 'app-customer-edit',
  templateUrl: './customer-edit.page.html',
  styleUrls: ['./customer-edit.page.scss'],
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, IonicModule]
})
export class CustomerEditPage implements OnInit {
  form: FormGroup;
  isLoading = false;
  isFetching = true;
  submitted = false;
  customerId!: number;

  constructor(
    private fb: FormBuilder,
    private route: ActivatedRoute,
    private router: Router,
    private customerService: CustomerService,
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

  ngOnInit() {
    this.customerId = Number(this.route.snapshot.paramMap.get('id'));
    this.customerService.getCustomer(this.customerId).subscribe({
      next: (customer) => {
        this.form.patchValue({
          name:             customer.name,
          email:            customer.email,
          phone:            customer.phone,
          vat_number:       customer.vat_number,
          billing_address:  customer.billing_address,
          shipping_address: customer.shipping_address,
          payment_terms:    customer.payment_terms ?? 30,
          notes:            customer.notes
        });
        this.isFetching = false;
      },
      error: async () => {
        this.isFetching = false;
        await this.showToast('Failed to load customer', 'danger');
        this.router.navigate(['/customers']);
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
    this.customerService.updateCustomer(this.customerId, this.form.value).subscribe({
      next: () => {
        this.router.navigate(['/customers', this.customerId]);
      },
      error: async (err) => {
        this.isLoading = false;
        const msg = err.error?.message || 'Failed to update customer';
        await this.showToast(msg, 'danger');
      }
    });
  }

  private async showToast(message: string, color = 'success') {
    const toast = await this.toastCtrl.create({ message, duration: 3000, color, position: 'bottom' });
    await toast.present();
  }
}
