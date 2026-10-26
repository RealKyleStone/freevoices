import { Component, HostListener, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup, FormArray, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import {
  ToastController,
  IonBackButton, IonButton, IonButtons, IonCard, IonCardContent, IonCardHeader, IonCardTitle,
  IonContent, IonHeader, IonIcon, IonInput, IonItem, IonLabel, IonNote, IonSelect,
  IonSelectOption, IonSpinner, IonText, IonTextarea, IonTitle, IonToggle, IonToolbar,
} from '@ionic/angular/standalone';
import { forkJoin } from 'rxjs';
import { CataloguePickerComponent } from '../../../../shared/components/catalogue-picker/catalogue-picker.component';
import { addIcons } from 'ionicons';
import { trashOutline, addOutline } from 'ionicons/icons';
import { QuoteService } from '../../services/quote.service';
import { SettingsService } from '../../../settings/services/settings.service';
import { Customer, Product, Currency } from '../../../../../models/database.models';
import { lineTotals, roundCents, todayLocalIso } from '../../../../shared/utils/document-math';
import { HasUnsavedChanges } from '../../../../shared/guards/unsaved-changes.guard';

@Component({
  selector: 'app-quote-create',
  templateUrl: './quote-create.page.html',
  styleUrls: ['./quote-create.page.scss'],
  standalone: true,
  imports: [
    CommonModule, ReactiveFormsModule, CataloguePickerComponent,
    IonBackButton, IonButton, IonButtons, IonCard, IonCardContent, IonCardHeader, IonCardTitle,
    IonContent, IonHeader, IonIcon, IonInput, IonItem, IonLabel, IonNote, IonSelect,
    IonSelectOption, IonSpinner, IonText, IonTextarea, IonTitle, IonToggle, IonToolbar,
  ]
})
export class QuoteCreatePage implements OnInit, HasUnsavedChanges {
  form: FormGroup;
  currencies: Currency[] = [];
  isLoading = false;
  isLoadingData = true;
  submitted = false;
  private saved = false;
  private defaultVatRate = 15;
  private defaultTerms = 30;
  private requestKey = crypto.randomUUID();

  constructor(
    private fb: FormBuilder,
    private quoteService: QuoteService,
    private settingsService: SettingsService,
    private router: Router,
    private toastCtrl: ToastController
  ) {
    addIcons({ trashOutline, addOutline });
    const today = todayLocalIso();
    this.form = this.fb.group({
      customer_id:      [null, Validators.required],
      currency_id:      [null, Validators.required],
      issue_date:       [today, Validators.required],
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
    forkJoin({
      currencies: this.settingsService.getCurrencies(),
      settings:   this.settingsService.getSettings()
    }).subscribe({
      next: ({ currencies, settings }) => {
        this.currencies = currencies;
        const defaultCurrencyId = parseInt(settings.default_currency_id || '1', 10);
        this.defaultVatRate = Number(settings.invoice_vat_rate ?? 15);
        this.defaultTerms = Number(settings.invoice_payment_terms ?? 30);
        this.form.patchValue({ currency_id: defaultCurrencyId, payment_terms: this.defaultTerms, notes: settings.invoice_notes || '' });
        this.addItem();
        this.isLoadingData = false;
      },
      error: async () => {
        this.isLoadingData = false;
        await this.showToast('Failed to load data', 'danger');
      }
    });
  }

  get currencySymbol(): string {
    const id = this.form.get('currency_id')?.value;
    return this.currencies.find(c => c.id === +id)?.symbol || 'R';
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

  onCustomerSelected(customer: Customer) {
    this.form.patchValue({ payment_terms: customer.payment_terms ?? this.defaultTerms });
  }

  onProductSelected(index: number, product: Product | null) {
    if (!product) return;
    this.items.at(index).patchValue({
      description: product.name, unit_price: product.price, vat_inclusive: !!product.vat_inclusive,
      vat_rate: this.items.at(index).get('vat_rate')?.value ?? this.defaultVatRate
    });
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
        product_id: item.product_id || null,
        description: item.description,
        quantity:    item.quantity,
        unit_price:  item.unit_price,
        vat_rate:    item.vat_rate,
        vat_inclusive: item.vat_inclusive
      }))
    };

    this.quoteService.createQuote({ ...payload, request_key: this.requestKey }).subscribe({
      next: (quote) => { this.saved = true; this.router.navigate(['/quotes', quote.id], { replaceUrl: true }); },
      error: async (err) => {
        this.isLoading = false;
        await this.showToast(err.error?.message || 'Failed to create quote', 'danger');
      }
    });
  }

  private async showToast(message: string, color = 'success') {
    const toast = await this.toastCtrl.create({ message, duration: 3000, color, position: 'bottom' });
    await toast.present();
  }
}
