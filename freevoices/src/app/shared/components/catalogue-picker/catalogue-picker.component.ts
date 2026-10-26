import { CommonModule } from '@angular/common';
import { Component, ElementRef, EventEmitter, forwardRef, Input, OnDestroy, Output, ViewChild } from '@angular/core';
import { ControlValueAccessor, FormControl, FormGroup, NG_VALUE_ACCESSOR, ReactiveFormsModule, Validators } from '@angular/forms';
import { catchError, map, Observable, of, Subject, Subscription, switchMap, takeUntil, timer } from 'rxjs';
import { CustomerService } from '../../../features/customers/services/customer.service';
import { ProductService } from '../../../features/products/services/product.service';
import { Customer, Product } from '../../../../models/database.models';

type RecordRow = Customer | Product;
interface SearchRequest { search: string; page: number; delay: number; }
interface SearchPage { data: RecordRow[]; total: number; page: number; limit: number; }
let nextId = 0;

@Component({
  selector: 'app-catalogue-picker', standalone: true,
  imports: [CommonModule, ReactiveFormsModule],
  templateUrl: './catalogue-picker.component.html', styleUrls: ['./catalogue-picker.component.scss'],
  providers: [{ provide: NG_VALUE_ACCESSOR, useExisting: forwardRef(() => CataloguePickerComponent), multi: true }]
})
export class CataloguePickerComponent implements ControlValueAccessor, OnDestroy {
  @Input() kind: 'customer' | 'product' = 'customer';
  @Input() invalid = false;
  @Output() customerChosen = new EventEmitter<Customer>();
  @Output() productChosen = new EventEmitter<Product | null>();
  @ViewChild('dialog', { static: true }) dialog!: ElementRef<HTMLDialogElement>;
  @ViewChild('searchBox', { static: true }) searchBox!: ElementRef<HTMLInputElement>;
  readonly headingId = `catalogue-heading-${++nextId}`;
  value: number | null = null;
  selectedName = '';
  selectionError = '';
  disabled = false;
  rows: RecordRow[] = [];
  total = 0;
  page = 0;
  query = '';
  loading = false;
  creating = false;
  saving = false;
  error = '';
  private readonly cancelSearch = new Subject<void>();
  private focusTimer?: ReturnType<typeof setTimeout>;
  private readonly requests = new Subject<SearchRequest>();
  private readonly subscriptions = new Subscription();
  private lookup?: Subscription;
  private lastRequest: SearchRequest = { search: '', page: 1, delay: 0 };
  private changed: (value: number | null) => void = () => {};
  private touched: () => void = () => {};
  readonly createForm = new FormGroup({
    name: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.maxLength(100)] }),
    email: new FormControl('', { nonNullable: true }),
    billing_address: new FormControl('', { nonNullable: true }),
    price: new FormControl<number | null>(0),
    vat_inclusive: new FormControl(false, { nonNullable: true }),
  });

  constructor(private customers: CustomerService, private products: ProductService) {
    this.subscriptions.add(this.requests.pipe(switchMap(request => timer(request.delay).pipe(
      switchMap((): Observable<SearchPage> => this.kind === 'customer'
        ? this.customers.getCustomers(request.search, request.page, 20)
        : this.products.getProducts(request.search, request.page, 20)),
      map(result => ({ request, result, failed: false })),
      catchError(() => of({ request, result: null, failed: true })),
      takeUntil(this.cancelSearch)
    ))).subscribe(({ request, result, failed }) => {
      this.loading = false;
      if (failed || !result) { this.error = `Could not load ${this.kind}s. Your draft is unchanged.`; return; }
      this.rows = request.page === 1 ? result.data : this.rows.concat(result.data);
      this.page = result.page;
      this.total = result.total;
    }));
  }

  writeValue(value: number | null) {
    this.lookup?.unsubscribe();
    this.value = value ? Number(value) : null;
    this.selectedName = '';
    this.selectionError = '';
    if (this.value) {
      const lookup: Observable<RecordRow> = this.kind === 'customer' ? this.customers.getCustomerForSelection(this.value) : this.products.getProduct(this.value);
      this.lookup = lookup.subscribe({ next: row => this.selectedName = row.name, error: () => {
        this.selectedName = `Selected ${this.kind} #${this.value}`;
        this.selectionError = `This ${this.kind} could not be loaded. Search to select it again or choose another.`;
      } });
    }
  }
  registerOnChange(fn: (value: number | null) => void) { this.changed = fn; }
  registerOnTouched(fn: () => void) { this.touched = fn; }
  setDisabledState(disabled: boolean) { this.disabled = disabled; }

  open() {
    if (this.disabled) return;
    this.creating = false;
    this.query = '';
    this.searchBox.nativeElement.value = '';
    this.dialog.nativeElement.showModal();
    clearTimeout(this.focusTimer);
    this.focusTimer = setTimeout(() => { if (this.dialog.nativeElement.open) this.searchBox.nativeElement.focus(); });
    this.search('', 0);
  }
  close() { if (!this.saving) { clearTimeout(this.focusTimer); this.cancelSearch.next(); this.loading = false; this.dialog.nativeElement.close(); this.touched(); } }
  onCancel(event: Event) { if (this.saving) event.preventDefault(); else { clearTimeout(this.focusTimer); this.cancelSearch.next(); this.loading = false; this.touched(); } }
  search(query: string, delay = 250) {
    this.query = query.trim();
    this.rows = []; this.page = 0; this.total = 0;
    this.request({ search: this.query, page: 1, delay });
  }
  more() { if (!this.loading) this.request({ search: this.query, page: this.page + 1, delay: 0 }); }
  retry() { this.request({ ...this.lastRequest, delay: 0 }); }
  private request(request: SearchRequest) {
    this.lastRequest = request; this.loading = true; this.error = ''; this.requests.next(request);
  }
  choose(row: RecordRow | null) {
    clearTimeout(this.focusTimer); this.lookup?.unsubscribe();
    this.value = row?.id ?? null; this.selectedName = row?.name ?? ''; this.selectionError = '';
    this.changed(this.value); this.touched();
    if (this.kind === 'customer' && row) this.customerChosen.emit(row as Customer);
    if (this.kind === 'product') this.productChosen.emit(row as Product | null);
    this.cancelSearch.next(); this.loading = false;
    this.dialog.nativeElement.close();
  }
  beginCreate() {
    clearTimeout(this.focusTimer); this.cancelSearch.next(); this.loading = false;
    this.creating = true; this.error = '';
    this.focusTimer = setTimeout(() => this.dialog.nativeElement.querySelector<HTMLInputElement>('[formControlName="name"]')?.focus());
    const controls = this.createForm.controls;
    controls.email.setValidators(this.kind === 'customer' ? [Validators.required, Validators.email] : []);
    controls.billing_address.setValidators(this.kind === 'customer' ? [Validators.required] : []);
    controls.price.setValidators(this.kind === 'product' ? [Validators.required, Validators.min(0)] : []);
    this.createForm.reset({ name: this.query, email: '', billing_address: '', price: 0, vat_inclusive: false });
    Object.values(controls).forEach(control => control.updateValueAndValidity());
  }
  saveNew() {
    if (this.saving) return;
    this.createForm.markAllAsTouched();
    if (this.createForm.invalid) return;
    const value = this.createForm.getRawValue();
    const name = value.name.trim();
    if (!name || (this.kind === 'customer' && !value.billing_address.trim())) {
      this.error = 'Enter a name and the required details.'; return;
    }
    this.saving = true; this.error = '';
    const created: Observable<RecordRow> = this.kind === 'customer'
      ? this.customers.createCustomer({ name, email: value.email.trim(), billing_address: value.billing_address.trim() })
      : this.products.createProduct({ name, price: Number(value.price), vat_inclusive: value.vat_inclusive });
    this.subscriptions.add(created.subscribe({ next: row => { this.saving = false; this.choose(row); }, error: err => {
      this.saving = false; this.error = err.error?.message || `Could not add ${this.kind}. Your entries have been kept.`;
    } }));
  }
  backToSearch() { this.creating = false; this.error = ''; this.focusTimer = setTimeout(() => this.searchBox.nativeElement.focus()); }
  onEnter(event: Event) {
    if (event.target instanceof HTMLInputElement) {
      event.preventDefault();
      if (this.creating) this.saveNew(); else this.search(this.query, 0);
    }
  }
  secondary(row: RecordRow) { return this.kind === 'customer' ? (row as Customer).email : `Price: ${Number((row as Product).price).toFixed(2)}${(row as Product).vat_inclusive ? ' incl. VAT' : ' excl. VAT'}`; }
  trackRow(_index: number, row: RecordRow) { return row.id; }
  ngOnDestroy() {
    clearTimeout(this.focusTimer);
    // Release the browser's modal/inert state before Angular removes the DOM.
    if (this.dialog?.nativeElement.open) this.dialog.nativeElement.close();
    this.cancelSearch.next(); this.cancelSearch.complete(); this.lookup?.unsubscribe();
    this.subscriptions.unsubscribe(); this.requests.complete();
  }
}
