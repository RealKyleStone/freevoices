import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup, FormArray, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { IonicModule, ToastController } from '@ionic/angular';
import { forkJoin } from 'rxjs';
import { QuoteService } from '../../services/quote.service';
import { CustomerService } from '../../../customers/services/customer.service';
import { ProductService } from '../../../products/services/product.service';
import { Customer, Product } from '../../../../../models/database.models';

@Component({
  selector: 'app-quote-edit',
  templateUrl: './quote-edit.page.html',
  styleUrls: ['./quote-edit.page.scss'],
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, IonicModule]
})
export class QuoteEditPage implements OnInit {
  form: FormGroup;
  customers: Customer[] = [];
  products: Product[] = [];
  isLoading = false;
  isFetching = true;
  submitted = false;
  quoteId!: number;

  constructor(
    private fb: FormBuilder,
    private route: ActivatedRoute,
    private router: Router,
    private quoteService: QuoteService,
    private customerService: CustomerService,
    private productService: ProductService,
    private toastCtrl: ToastController
  ) {
    this.form = this.fb.group({
      customer_id:      [null, Validators.required],
      issue_date:       ['',  Validators.required],
      valid_until:      [''],
      payment_terms:    [30],
      notes:            [''],
      terms_conditions: [''],
      items:            this.fb.array([])
    });
  }

  ngOnInit() {
    this.quoteId = Number(this.route.snapshot.paramMap.get('id'));

    forkJoin({
      quote:     this.quoteService.getQuote(this.quoteId),
      customers: this.customerService.getCustomers('', 1, 200),
      products:  this.productService.getProducts('', 1, 200)
    }).subscribe({
      next: ({ quote, customers, products }) => {
        if (quote.status !== 'DRAFT') {
          this.showToast('Only DRAFT quotes can be edited', 'warning');
          this.router.navigate(['/quotes', this.quoteId]);
          return;
        }

        this.customers = customers.data;
        this.products  = products.data;

        this.form.patchValue({
          customer_id:      quote.customer_id,
          issue_date:       quote.issue_date?.toString().split('T')[0],
          valid_until:      quote.valid_until?.toString().split('T')[0] ?? '',
          payment_terms:    quote.payment_terms,
          notes:            quote.notes,
          terms_conditions: quote.terms_conditions
        });

        quote.items.forEach(item => {
          this.items.push(this.fb.group({
            product_id:  [item.product_id ?? null],
            description: [item.description, Validators.required],
            quantity:    [item.quantity,    [Validators.required, Validators.min(0.01)]],
            unit_price:  [item.unit_price,  [Validators.required, Validators.min(0)]],
            vat_rate:    [item.vat_rate,    [Validators.required, Validators.min(0)]]
          }));
        });

        if (this.items.length === 0) this.addItem();
        this.isFetching = false;
      },
      error: async () => {
        this.isFetching = false;
        await this.showToast('Failed to load quote', 'danger');
        this.router.navigate(['/quotes']);
      }
    });
  }

  get items(): FormArray { return this.form.get('items') as FormArray; }

  addItem() {
    this.items.push(this.fb.group({
      product_id:  [null],
      description: ['', Validators.required],
      quantity:    [1,  [Validators.required, Validators.min(0.01)]],
      unit_price:  [0,  [Validators.required, Validators.min(0)]],
      vat_rate:    [15, [Validators.required, Validators.min(0)]]
    }));
  }

  removeItem(i: number) { if (this.items.length > 1) this.items.removeAt(i); }

  onProductChange(index: number) {
    const productId = this.items.at(index).get('product_id')?.value;
    if (!productId) return;
    const product = this.products.find(p => p.id === +productId);
    if (!product) return;
    this.items.at(index).patchValue({ description: product.name, unit_price: product.price, vat_rate: 15 });
  }

  itemSubtotal(i: number): number {
    const v = this.items.at(i).value;
    return (v.quantity || 0) * (v.unit_price || 0);
  }
  itemVat(i: number): number { return this.itemSubtotal(i) * ((this.items.at(i).value.vat_rate || 0) / 100); }
  itemTotal(i: number): number { return this.itemSubtotal(i) + this.itemVat(i); }
  get docSubtotal(): number { return this.items.controls.reduce((s, _, i) => s + this.itemSubtotal(i), 0); }
  get docVat(): number { return this.items.controls.reduce((s, _, i) => s + this.itemVat(i), 0); }
  get docTotal(): number { return this.docSubtotal + this.docVat; }

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
    if (this.form.invalid) { this.form.markAllAsTouched(); return; }

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

    this.quoteService.updateQuote(this.quoteId, payload).subscribe({
      next: () => { this.router.navigate(['/quotes', this.quoteId]); },
      error: async (err) => {
        this.isLoading = false;
        await this.showToast(err.error?.message || 'Failed to update quote', 'danger');
      }
    });
  }

  private async showToast(message: string, color = 'success') {
    const toast = await this.toastCtrl.create({ message, duration: 3000, color, position: 'bottom' });
    await toast.present();
  }
}
