import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup, FormArray, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { IonicModule, ToastController } from '@ionic/angular';
import { forkJoin } from 'rxjs';
import { addIcons } from 'ionicons';
import { trashOutline, addOutline } from 'ionicons/icons';
import { InvoiceService } from '../../services/invoice.service';
import { CustomerService } from '../../../customers/services/customer.service';
import { ProductService } from '../../../products/services/product.service';
import { Customer, Product } from '../../../../../models/database.models';

@Component({
  selector: 'app-invoice-create',
  templateUrl: './invoice-create.page.html',
  styleUrls: ['./invoice-create.page.scss'],
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, IonicModule]
})
export class InvoiceCreatePage implements OnInit {
  form: FormGroup;
  customers: Customer[] = [];
  products: Product[] = [];
  isLoading = false;
  isLoadingData = true;
  submitted = false;

  constructor(
    private fb: FormBuilder,
    private invoiceService: InvoiceService,
    private customerService: CustomerService,
    private productService: ProductService,
    private router: Router,
    private toastCtrl: ToastController
  ) {
    addIcons({ trashOutline, addOutline });

    const today = new Date().toISOString().split('T')[0];
    this.form = this.fb.group({
      customer_id:      [null, Validators.required],
      issue_date:       [today, Validators.required],
      due_date:         [''],
      payment_terms:    [30],
      notes:            [''],
      terms_conditions: [''],
      items:            this.fb.array([])
    });
  }

  ngOnInit() {
    forkJoin({
      customers: this.customerService.getCustomers('', 1, 200),
      products:  this.productService.getProducts('', 1, 200)
    }).subscribe({
      next: ({ customers, products }) => {
        this.customers = customers.data;
        this.products  = products.data;
        this.addItem();
        this.isLoadingData = false;
      },
      error: async () => {
        this.isLoadingData = false;
        await this.showToast('Failed to load data', 'danger');
      }
    });
  }

  get items(): FormArray {
    return this.form.get('items') as FormArray;
  }

  private newItemGroup(): FormGroup {
    return this.fb.group({
      product_id:  [null],
      description: ['', Validators.required],
      quantity:    [1, [Validators.required, Validators.min(0.01)]],
      unit_price:  [0, [Validators.required, Validators.min(0)]],
      vat_rate:    [15, [Validators.required, Validators.min(0)]]
    });
  }

  addItem() {
    this.items.push(this.newItemGroup());
  }

  async removeItem(i: number) {
    if (this.items.length === 1) {
      await this.showToast('An invoice must have at least one line item', 'warning');
      return;
    }
    this.items.removeAt(i);
  }

  onProductChange(index: number) {
    const productId = this.items.at(index).get('product_id')?.value;
    if (!productId) return;
    const product = this.products.find(p => p.id === +productId);
    if (!product) return;
    this.items.at(index).patchValue({
      description: product.name,
      unit_price:  product.price,
      vat_rate:    15
    });
  }

  itemSubtotal(i: number): number {
    const v = this.items.at(i).value;
    return (v.quantity || 0) * (v.unit_price || 0);
  }

  itemVat(i: number): number {
    return this.itemSubtotal(i) * ((this.items.at(i).value.vat_rate || 0) / 100);
  }

  itemTotal(i: number): number {
    return this.itemSubtotal(i) + this.itemVat(i);
  }

  get docSubtotal(): number {
    return this.items.controls.reduce((sum, _, i) => sum + this.itemSubtotal(i), 0);
  }

  get docVat(): number {
    return this.items.controls.reduce((sum, _, i) => sum + this.itemVat(i), 0);
  }

  get docTotal(): number {
    return this.docSubtotal + this.docVat;
  }

  isItemInvalid(index: number, field: string): boolean {
    const ctrl = (this.items.at(index) as FormGroup).get(field);
    return !!ctrl && ctrl.invalid && (ctrl.dirty || ctrl.touched || this.submitted);
  }

  isInvalid(field: string): boolean {
    const ctrl = this.form.get(field);
    return !!ctrl && ctrl.invalid && (ctrl.dirty || ctrl.touched || this.submitted);
  }

  async onSubmit() {
    this.submitted = true;
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      await this.showToast('Please fill in all required fields', 'warning');
      return;
    }

    this.isLoading = true;
    const { items, ...rest } = this.form.value;
    const payload = {
      ...rest,
      items: items.map((item: any) => ({
        product_id:  item.product_id || null,
        description: item.description,
        quantity:    item.quantity,
        unit_price:  item.unit_price,
        vat_rate:    item.vat_rate
      }))
    };

    this.invoiceService.createInvoice(payload).subscribe({
      next: (invoice) => {
        this.router.navigate(['/invoices', invoice.id]);
      },
      error: async (err) => {
        this.isLoading = false;
        await this.showToast(err.error?.message || 'Failed to create invoice', 'danger');
      }
    });
  }

  private async showToast(message: string, color = 'success') {
    const toast = await this.toastCtrl.create({ message, duration: 3000, color, position: 'bottom' });
    await toast.present();
  }
}
