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
import { forkJoin } from 'rxjs';
import { CataloguePickerComponent } from '../../../../shared/components/catalogue-picker/catalogue-picker.component';
import { addIcons } from 'ionicons';
import { trashOutline, addOutline } from 'ionicons/icons';
import { InvoiceService, InvoicePayload } from '../../services/invoice.service';
import { SettingsService } from '../../../settings/services/settings.service';
import { Customer, Product } from '../../../../../models/database.models';
import { lineTotals, roundCents, dueDateFromTerms } from '../../../../shared/utils/document-math';
import { HasUnsavedChanges } from '../../../../shared/guards/unsaved-changes.guard';

/** Mirrors the server rule: a due date cannot precede the issue date. */
function dueNotBeforeIssue(ctrl: AbstractControl): ValidationErrors | null {
  const issue = ctrl.parent?.get('issue_date')?.value;
  return ctrl.value && issue && ctrl.value < issue ? { beforeIssue: true } : null;
}

@Component({
  selector: 'app-invoice-edit',
  templateUrl: './invoice-edit.page.html',
  styleUrls: ['./invoice-edit.page.scss'],
  standalone: true,
  imports: [
    CommonModule, ReactiveFormsModule, CataloguePickerComponent,
    IonBackButton, IonButton, IonButtons, IonCard, IonCardContent, IonCardHeader, IonCardTitle,
    IonContent, IonHeader, IonIcon, IonInput, IonItem, IonLabel, IonNote, IonSelect,
    IonSelectOption, IonSpinner, IonText, IonTextarea, IonTitle, IonToggle, IonToolbar,
  ]
})
export class InvoiceEditPage implements OnInit, HasUnsavedChanges {
  form: FormGroup;
  isLoading = false;
  isFetching = true;
  submitted = false;
  invoiceId!: number;
  currencySymbol = 'R';
  private saved = false;
  private defaultVatRate = 15;
  private defaultTerms = 30;
  // See invoice-create: an untouched due date follows issue date + terms.
  private autoDueDate = '';

  private readonly recurrenceFields = ['is_recurring', 'recurrence_interval', 'recurrence_end_date', 'auto_send'];

  constructor(
    private fb: FormBuilder,
    private route: ActivatedRoute,
    private router: Router,
    private invoiceService: InvoiceService,
    private settingsService: SettingsService,
    private toastCtrl: ToastController
  ) {
    addIcons({ trashOutline, addOutline });
    this.form = this.fb.group({
      customer_id:         [null, Validators.required],
      issue_date:          ['', Validators.required],
      due_date:            ['', dueNotBeforeIssue],
      payment_terms:       [30],
      notes:               [''],
      terms_conditions:    [''],
      items:               this.fb.array([]),
      is_recurring:        [false],
      recurrence_interval: [null],
      recurrence_end_date: [''],
      auto_send:           [false]
    });

    this.form.get('issue_date')!.valueChanges.subscribe(() => this.syncDueDate());
    this.form.get('payment_terms')!.valueChanges.subscribe(() => this.syncDueDate());
  }

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
    this.invoiceId = Number(this.route.snapshot.paramMap.get('id'));

    forkJoin({
      invoice:   this.invoiceService.getInvoice(this.invoiceId),
      settings: this.settingsService.getSettings()
    }).subscribe({
      next: ({ invoice, settings }) => {
        if (invoice.status !== 'DRAFT') {
          this.showToast('Only DRAFT invoices can be edited', 'warning');
          this.router.navigate(['/invoices', this.invoiceId]);
          return;
        }
        if ((invoice.payments || []).length > 0) {
          this.showToast('This invoice has payments recorded and can no longer be edited', 'warning');
          this.router.navigate(['/invoices', this.invoiceId]);
          return;
        }

        this.defaultVatRate = Number(settings.invoice_vat_rate ?? 15);
        this.defaultTerms = Number(settings.invoice_payment_terms ?? 30);

        this.currencySymbol = invoice.currency_symbol || 'R';
        // Dates arrive as 'YYYY-MM-DD'. They used to arrive as a UTC
        // timestamp of local midnight ('2026-10-19T22:00:00Z' for the 20th),
        // and this split then loaded the day before into the form.
        this.form.patchValue({
          customer_id:         invoice.customer_id,
          issue_date:          invoice.issue_date?.toString().slice(0, 10),
          due_date:            invoice.due_date?.toString().slice(0, 10) ?? '',
          payment_terms:       invoice.payment_terms,
          notes:               invoice.notes,
          terms_conditions:    invoice.terms_conditions,
          is_recurring:        !!invoice.is_recurring,
          recurrence_interval: invoice.recurrence_interval ?? null,
          recurrence_end_date: invoice.recurrence_end_date?.toString().slice(0, 10) ?? '',
          auto_send:           !!invoice.auto_send
        }, { emitEvent: false });
        // A stored due date that matches the terms is treated as calculated,
        // so changing the terms moves it.
        const calculated = dueDateFromTerms(this.form.value.issue_date, invoice.payment_terms);
        if (!this.form.value.due_date || this.form.value.due_date === calculated) {
          this.autoDueDate = calculated;
          this.form.get('due_date')!.setValue(calculated, { emitEvent: false });
        }

        invoice.items.forEach(item => {
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
        this.isFetching = false;
      },
      error: async () => {
        this.isFetching = false;
        await this.showToast('Failed to load invoice', 'danger');
        this.router.navigate(['/invoices']);
      }
    });
  }

  get isRecurring(): boolean {
    return !!this.form.get('is_recurring')?.value;
  }

  get items(): FormArray {
    return this.form.get('items') as FormArray;
  }

  addItem() {
    this.items.push(this.fb.group({
      product_id:  [null],
      description: ['', Validators.required],
      quantity:    [1,  [Validators.required, Validators.min(0.01)]],
      unit_price:  [0,  [Validators.required, Validators.min(0)]],
      vat_inclusive: [false],
      vat_rate:    [this.defaultVatRate, [Validators.required, Validators.min(0), Validators.max(100)]]
    }));
    this.form.markAsDirty();
  }

  removeItem(i: number) {
    if (this.items.length > 1) { this.items.removeAt(i); this.form.markAsDirty(); }
  }

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
      // Saving used to do nothing visible here: the page stayed put with no
      // message, which read as a silent failure.
      this.form.markAllAsTouched();
      await this.showToast('Please correct the highlighted fields', 'warning');
      return;
    }

    this.isLoading = true;
    const { items, is_recurring, recurrence_interval, recurrence_end_date, auto_send, ...rest } = this.form.value;
    const payload: InvoicePayload = {
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
    // The server keeps the stored schedule when is_recurring is absent, so it
    // is only sent when the user actually changed the recurring card.
    if (this.recurrenceFields.some(f => this.form.get(f)?.dirty)) {
      Object.assign(payload, {
        is_recurring,
        recurrence_interval: is_recurring ? recurrence_interval : null,
        recurrence_end_date: is_recurring && recurrence_end_date ? recurrence_end_date : null,
        auto_send: is_recurring ? auto_send : false
      });
    }

    this.invoiceService.updateInvoice(this.invoiceId, payload).subscribe({
      next: () => {
        this.saved = true;
        this.router.navigate(['/invoices', this.invoiceId]);
      },
      error: async (err) => {
        this.isLoading = false;
        await this.showToast(err.error?.message || 'Failed to update invoice', 'danger');
      }
    });
  }

  private async showToast(message: string, color = 'success') {
    const toast = await this.toastCtrl.create({ message, duration: 3000, color, position: 'bottom' });
    await toast.present();
  }
}
