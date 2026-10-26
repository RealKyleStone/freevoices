import { Component, HostListener, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup, FormArray, Validators, AbstractControl, ValidationErrors } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import {
  ToastController,
  IonBackButton, IonButton, IonButtons, IonCard, IonCardContent, IonCardHeader, IonCardTitle,
  IonContent, IonHeader, IonIcon, IonInput, IonItem, IonLabel, IonNote, IonSelect,
  IonSelectOption, IonSpinner, IonText, IonTextarea, IonTitle, IonToggle, IonToolbar,
} from '@ionic/angular/standalone';
import { forkJoin, of } from 'rxjs';
import { CataloguePickerComponent } from '../../../../shared/components/catalogue-picker/catalogue-picker.component';
import { InvoicePreviewComponent } from '../../../../shared/components/invoice-preview/invoice-preview.component';
import { addIcons } from 'ionicons';
import { trashOutline, addOutline } from 'ionicons/icons';
import { InvoiceService } from '../../services/invoice.service';
import { InvoiceDetail } from '../../services/invoice.service';
import { SettingsService } from '../../../settings/services/settings.service';
import { Customer, Product, Currency } from '../../../../../models/database.models';
import { lineTotals, roundCents, todayLocalIso, dueDateFromTerms } from '../../../../shared/utils/document-math';
import { HasUnsavedChanges } from '../../../../shared/guards/unsaved-changes.guard';

/** Mirrors the server rule: a due date cannot precede the issue date. */
function dueNotBeforeIssue(ctrl: AbstractControl): ValidationErrors | null {
  const issue = ctrl.parent?.get('issue_date')?.value;
  return ctrl.value && issue && ctrl.value < issue ? { beforeIssue: true } : null;
}

@Component({
  selector: 'app-invoice-create',
  templateUrl: './invoice-create.page.html',
  styleUrls: ['./invoice-create.page.scss'],
  standalone: true,
  imports: [
    CommonModule, ReactiveFormsModule, CataloguePickerComponent, InvoicePreviewComponent,
    IonBackButton, IonButton, IonButtons, IonCard, IonCardContent, IonCardHeader, IonCardTitle,
    IonContent, IonHeader, IonIcon, IonInput, IonItem, IonLabel, IonNote, IonSelect,
    IonSelectOption, IonSpinner, IonText, IonTextarea, IonTitle, IonToggle, IonToolbar,
  ]
})
export class InvoiceCreatePage implements OnInit, HasUnsavedChanges {
  form: FormGroup;
  currencies: Currency[] = [];
  isLoading = false;
  isLoadingData = true;
  submitted = false;
  selectedCustomerName = '';
  copiedFromNumber = '';
  private saved = false;
  private defaultVatRate = 15;
  private defaultTerms = 30;
  private requestKey = crypto.randomUUID();
  // The due date this page last filled in from the terms. While the field
  // still holds it, a change to the issue date or terms recalculates it; once
  // the user types their own date, it is left alone.
  private autoDueDate = '';

  constructor(
    private fb: FormBuilder,
    private invoiceService: InvoiceService,
    private settingsService: SettingsService,
    private router: Router,
    private toastCtrl: ToastController,
    private route: ActivatedRoute
  ) {
    addIcons({ trashOutline, addOutline });

    const today = todayLocalIso();
    this.form = this.fb.group({
      customer_id:          [null, Validators.required],
      currency_id:          [null, Validators.required],
      issue_date:           [today, Validators.required],
      due_date:             ['', dueNotBeforeIssue],
      payment_terms:        [30],
      notes:                [''],
      terms_conditions:     [''],
      items:                this.fb.array([]),
      is_recurring:         [false],
      recurrence_interval:  [null],
      recurrence_end_date:  [''],
      auto_send:            [false]
    });

    this.form.get('issue_date')!.valueChanges.subscribe(() => this.syncDueDate());
    this.form.get('payment_terms')!.valueChanges.subscribe(() => this.syncDueDate());
    this.syncDueDate();
  }

  /** Keep an untouched due date in step with issue date + payment terms. */
  private syncDueDate() {
    const ctrl = this.form.get('due_date')!;
    if (!ctrl.value || ctrl.value === this.autoDueDate) {
      this.autoDueDate = dueDateFromTerms(this.form.get('issue_date')!.value, this.form.get('payment_terms')!.value);
      ctrl.setValue(this.autoDueDate, { emitEvent: false });
    }
    // Re-run the "not before the issue date" check against the new issue date.
    ctrl.updateValueAndValidity({ emitEvent: false });
  }

  get dueDateIsAuto(): boolean {
    return !!this.autoDueDate && this.form.get('due_date')!.value === this.autoDueDate;
  }

  hasUnsavedChanges(): boolean {
    return this.form.dirty && !this.saved;
  }

  @HostListener('window:beforeunload', ['$event'])
  onBeforeUnload(event: BeforeUnloadEvent) {
    if (this.hasUnsavedChanges()) { event.preventDefault(); event.returnValue = ''; }
  }

  ngOnInit() {
    const copyId = Number(this.route.snapshot.queryParamMap.get('copyFrom'));
    const sourceId = Number.isSafeInteger(copyId) && copyId > 0 ? copyId : null;
    forkJoin({
      currencies: this.settingsService.getCurrencies(),
      settings:   this.settingsService.getSettings(),
      source:     sourceId ? this.invoiceService.getInvoice(sourceId) : of(null)
    }).subscribe({
      next: ({ currencies, settings, source }) => {
        this.currencies = currencies;
        const defaultCurrencyId = parseInt(settings.default_currency_id || '1', 10);
        this.defaultVatRate = Number(settings.invoice_vat_rate ?? 15);
        this.defaultTerms = Number(settings.invoice_payment_terms ?? 30);
        this.form.patchValue({ currency_id: defaultCurrencyId, payment_terms: this.defaultTerms, notes: settings.invoice_notes || '' });
        if (source) this.copyFrom(source);
        else this.addItem();
        this.isLoadingData = false;
      },
      error: async () => {
        this.isLoadingData = false;
        await this.showToast(sourceId ? 'Could not load the invoice to copy' : 'Failed to load data', 'danger');
        if (sourceId) this.router.navigate(['/invoices', sourceId]);
      }
    });
  }

  private copyFrom(source: InvoiceDetail) {
    this.copiedFromNumber = source.document_number;
    this.selectedCustomerName = source.customer_name;
    // A copy is a new draft dated today. The source's number, payment state,
    // delivery history, shares and recurrence schedule never carry across.
    this.form.patchValue({
      customer_id: source.customer_id,
      currency_id: source.currency_id,
      payment_terms: source.payment_terms ?? this.defaultTerms,
      notes: source.notes ?? '',
      terms_conditions: source.terms_conditions ?? '',
      is_recurring: false,
      recurrence_interval: null,
      recurrence_end_date: '',
      auto_send: false
    });
    this.items.clear();
    for (const item of source.items) {
      const group = this.newItemGroup();
      group.patchValue({
        product_id: item.product_id ?? null,
        description: item.description,
        quantity: item.quantity,
        unit_price: item.unit_price,
        vat_inclusive: !!item.vat_inclusive,
        vat_rate: item.vat_rate
      });
      this.items.push(group);
    }
    if (!this.items.length) this.addItem();
    this.form.markAsDirty();
  }

  get isRecurring(): boolean {
    return !!this.form.get('is_recurring')?.value;
  }

  get currencySymbol(): string {
    const id = this.form.get('currency_id')?.value;
    return this.currencies.find(c => c.id === +id)?.symbol || 'R';
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
      vat_inclusive: [false],
      vat_rate:    [this.defaultVatRate, [Validators.required, Validators.min(0), Validators.max(100)]]
    });
  }

  addItem() {
    this.items.push(this.newItemGroup());
  }

  removeItem(i: number) {
    // The button is disabled on the last line; this is the backstop.
    if (this.items.length > 1) { this.items.removeAt(i); this.form.markAsDirty(); }
  }

  onCustomerSelected(customer: Customer | null) {
    this.selectedCustomerName = customer?.name || '';
    if (customer) this.form.patchValue({ payment_terms: customer.payment_terms ?? this.defaultTerms });
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

  get docSubtotal(): number {
    return roundCents(this.items.controls.reduce((sum, _, i) => sum + this.itemSubtotal(i), 0));
  }

  get docVat(): number {
    return roundCents(this.items.controls.reduce((sum, _, i) => sum + this.itemVat(i), 0));
  }

  get docTotal(): number {
    return roundCents(this.docSubtotal + this.docVat);
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
    const { items, is_recurring, recurrence_interval, recurrence_end_date, auto_send, ...rest } = this.form.value;
    const payload = {
      ...rest,
      items: items.map((item: any) => ({
        product_id:  item.product_id || null,
        description: item.description,
        quantity:    item.quantity,
        unit_price:  item.unit_price,
        vat_rate:    item.vat_rate,
        vat_inclusive: item.vat_inclusive
      })),
      is_recurring,
      recurrence_interval: is_recurring ? recurrence_interval : null,
      recurrence_end_date: is_recurring && recurrence_end_date ? recurrence_end_date : null,
      auto_send: is_recurring ? auto_send : false
    };

    this.invoiceService.createInvoice({ ...payload, request_key: this.requestKey }).subscribe({
      next: (invoice) => {
        this.saved = true;
        this.router.navigate(['/invoices', invoice.id], { replaceUrl: true });
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
