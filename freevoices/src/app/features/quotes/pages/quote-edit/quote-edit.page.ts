import { Component, HostListener, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup, FormArray, Validators } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import {
  ToastController,
  IonBackButton, IonButton, IonButtons, IonCard, IonCardContent, IonCardHeader, IonCardTitle,
  IonContent, IonHeader, IonIcon, IonInput, IonItem, IonLabel, IonNote, IonSelect,
  IonSelectOption, IonSpinner, IonText, IonTextarea, IonTitle, IonToggle, IonToolbar,
} from '@ionic/angular/standalone';
import { forkJoin } from 'rxjs';
import { QuoteService } from '../../services/quote.service';
import { CustomerService } from '../../../customers/services/customer.service';
import { ProductService } from '../../../products/services/product.service';
import { SettingsService } from '../../../settings/services/settings.service';
import { Customer, Product } from '../../../../../models/database.models';
import { lineTotals, roundCents, todayLocalIso } from '../../../../shared/utils/document-math';
import { HasUnsavedChanges } from '../../../../shared/guards/unsaved-changes.guard';

@Component({
  selector: 'app-quote-edit',
  templateUrl: './quote-edit.page.html',
  styleUrls: ['./quote-edit.page.scss'],
  standalone: true,
  imports: [
    CommonModule, ReactiveFormsModule,
    IonBackButton, IonButton, IonButtons, IonCard, IonCardContent, IonCardHeader, IonCardTitle,
    IonContent, IonHeader, IonIcon, IonInput, IonItem, IonLabel, IonNote, IonSelect,
    IonSelectOption, IonSpinner, IonText, IonTextarea, IonTitle, IonToggle, IonToolbar,
  ]
})
export class QuoteEditPage implements OnInit, HasUnsavedChanges {
  form: FormGroup;
  customers: Customer[] = [];
  products: Product[] = [];
  isLoading = false;
  isFetching = true;
  submitted = false;
  private saved = false;
  private defaultVatRate = 15;
  private defaultTerms = 30;
  currencySymbol = 'R';
  quoteId!: number;

  constructor(
    private fb: FormBuilder,
    private route: ActivatedRoute,
    private router: Router,
    private quoteService: QuoteService,
    private customerService: CustomerService,
    private productService: ProductService,
    private settingsService: SettingsService,
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

  hasUnsavedChanges(): boolean {
    return this.form.dirty && !this.saved;
  }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(event: BeforeUnloadEvent) {
    if (this.hasUnsavedChanges()) { event.preventDefault(); event.returnValue = ''; }
  }

  ngOnInit() {
    this.quoteId = Number(this.route.snapshot.paramMap.get('id'));

    forkJoin({
      quote:     this.quoteService.getQuote(this.quoteId),
      customers: this.customerService.getAllCustomers(),
      products:  this.productService.getAllProducts(),
      settings: this.settingsService.getSettings()
    }).subscribe({
      next: ({ quote, customers, products, settings }) => {
        if (quote.status !== 'DRAFT') {
          this.showToast('Only DRAFT quotes can be edited', 'warning');
          this.router.navigate(['/quotes', this.quoteId]);
          return;
        }

        this.defaultVatRate = Number(settings.invoice_vat_rate ?? 15);
        this.defaultTerms = Number(settings.invoice_payment_terms ?? 30);
        this.customers = customers;
        this.products  = products;

        this.currencySymbol = quote.currency_symbol || 'R';
        this.form.patchValue({
          customer_id:      quote.customer_id,
          issue_date:       quote.issue_date?.toString().slice(0, 10),
          valid_until:      quote.valid_until?.toString().slice(0, 10) ?? '',
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
            vat_inclusive: [!!item.vat_inclusive],
            vat_rate:    [item.vat_rate,    [Validators.required, Validators.min(0), Validators.max(100)]]
          }));
        });

        if (this.items.length === 0) this.addItem();
        this.form.get('customer_id')!.valueChanges.subscribe(id => {
          const customer = this.customers.find(c => c.id === +id);
          this.form.patchValue({payment_terms:customer?.payment_terms ?? this.defaultTerms});
        });
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
      vat_inclusive: [false],
      vat_rate:    [this.defaultVatRate, [Validators.required, Validators.min(0), Validators.max(100)]]
    }));
  }

  removeItem(i: number) { if (this.items.length > 1) { this.items.removeAt(i); this.form.markAsDirty(); } }

  onProductChange(index: number) {
    const productId = this.items.at(index).get('product_id')?.value;
    if (!productId) return;
    const product = this.products.find(p => p.id === +productId);
    if (!product) return;
    this.items.at(index).patchValue({ description: product.name, unit_price: product.price, vat_inclusive: !!product.vat_inclusive, vat_rate: this.items.at(index).get('vat_rate')?.value ?? this.defaultVatRate });
  }

  // Rounded per line, half-up, exactly as the server stores them.
  itemSubtotal(i: number): number { return lineTotals(this.items.at(i).value).subtotal; }
  itemVat(i: number): number { return lineTotals(this.items.at(i).value).vat; }
  itemTotal(i: number): number { return lineTotals(this.items.at(i).value).total; }
  get docSubtotal(): number { return roundCents(this.items.controls.reduce((s, _, i) => s + this.itemSubtotal(i), 0)); }
  get docVat(): number { return roundCents(this.items.controls.reduce((s, _, i) => s + this.itemVat(i), 0)); }
  get docTotal(): number { return roundCents(this.docSubtotal + this.docVat); }

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
      await this.showToast('Please correct the highlighted fields', 'warning');
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
        vat_rate:    item.vat_rate,
        vat_inclusive: item.vat_inclusive
      }))
    };

    this.quoteService.updateQuote(this.quoteId, payload).subscribe({
      next: () => { this.saved = true; this.router.navigate(['/quotes', this.quoteId]); },
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
