import { Component } from '@angular/core';
import { ComponentFixture, fakeAsync, TestBed, tick } from '@angular/core/testing';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { By } from '@angular/platform-browser';
import { of, Subject, throwError } from 'rxjs';
import { CustomerService } from '../../../features/customers/services/customer.service';
import { ProductService } from '../../../features/products/services/product.service';
import { Customer, Product } from '../../../../models/database.models';
import { CataloguePickerComponent } from './catalogue-picker.component';

@Component({ standalone: true, imports: [CataloguePickerComponent, ReactiveFormsModule], template: `
  <form [formGroup]="form"><app-catalogue-picker formControlName="record" [kind]="kind"></app-catalogue-picker></form>` })
class HostComponent {
  kind: 'customer' | 'product' = 'customer';
  form = new FormGroup({ record: new FormControl<number | null>(null) });
}
const customer = { id: 125, name: 'Cape Services', email: 'cape@example.test', billing_address: 'Cape Town' } as Customer;
const product = { id: 215, name: 'Repair service', price: 115, vat_inclusive: true } as Product;
const page = (data: Customer[] = [customer], current = 1, total = data.length) => ({ data, total, page: current, limit: 20 });

describe('catalogue picker', () => {
  let fixture: ComponentFixture<HostComponent>;
  let picker: CataloguePickerComponent;
  let customers: jasmine.SpyObj<CustomerService>;
  let products: jasmine.SpyObj<ProductService>;
  beforeEach(async () => {
    customers = jasmine.createSpyObj('CustomerService', ['getCustomers', 'getCustomerForSelection', 'createCustomer']);
    products = jasmine.createSpyObj('ProductService', ['getProducts', 'getProduct', 'createProduct']);
    customers.getCustomers.and.returnValue(of(page())); customers.getCustomerForSelection.and.returnValue(of(customer));
    products.getProducts.and.returnValue(of({ data: [product], total: 1, page: 1, limit: 20 })); products.getProduct.and.returnValue(of(product));
    await TestBed.configureTestingModule({ imports: [HostComponent], providers: [
      { provide: CustomerService, useValue: customers }, { provide: ProductService, useValue: products }
    ] }).compileComponents();
    fixture = TestBed.createComponent(HostComponent); fixture.detectChanges();
    picker = fixture.debugElement.query(By.directive(CataloguePickerComponent)).componentInstance;
  });
  afterEach(() => { if (picker.dialog.nativeElement.open) picker.close(); fixture.destroy(); });

  it('loads one server page on opening and focuses search inside a labelled modal', async () => {
    expect(customers.getCustomers).not.toHaveBeenCalled();
    picker.open(); fixture.detectChanges();
    await fixture.whenStable();
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(customers.getCustomers).toHaveBeenCalledOnceWith('', 1, 20);
    expect(picker.dialog.nativeElement.open).toBeTrue();
    expect(document.activeElement).toBe(picker.searchBox.nativeElement);
    expect(picker.dialog.nativeElement.getAttribute('aria-labelledby')).toBe(picker.headingId);
    picker.close(); expect(picker.dialog.nativeElement.open).toBeFalse();
    picker.open(); fixture.detectChanges(); await fixture.whenStable();
    const modal = picker.dialog.nativeElement;
    fixture.destroy(); expect(modal.open).toBeFalse();
  });

  it('cancels stale searches immediately and debounces typing', fakeAsync(() => {
    const old = new Subject<any>();
    customers.getCustomers.and.returnValues(old, of(page([{ ...customer, id: 900, name: 'New result' }])));
    picker.open(); tick();
    picker.search('new'); old.next(page());
    expect(picker.rows).toEqual([]);
    tick(249); expect(customers.getCustomers).toHaveBeenCalledTimes(1);
    tick(1); expect(customers.getCustomers).toHaveBeenCalledWith('new', 1, 20);
    expect(picker.rows.map(row => row.id)).toEqual([900]);
  }));

  it('loads further pages and retries a failed page without losing previous results', fakeAsync(() => {
    const first = Array.from({ length: 20 }, (_, i) => ({ ...customer, id: i + 1 }));
    customers.getCustomers.and.returnValues(of(page(first, 1, 21)), throwError(() => new Error('Offline')), of(page([{ ...customer, id: 21 }], 2, 21)));
    picker.open(); tick(); picker.more(); tick();
    expect(picker.rows.length).toBe(20); expect(picker.error).toContain('Could not load');
    picker.retry(); tick();
    expect(picker.rows.length).toBe(21); expect(picker.page).toBe(2);
    expect(customers.getCustomers).toHaveBeenCalledWith('', 2, 20);
  }));

  it('retains an existing selection outside the first page and marks the form dirty only on selection', fakeAsync(() => {
    fixture.componentInstance.form.setValue({ record: 125 }); fixture.detectChanges();
    expect(picker.selectedName).toBe('Cape Services'); expect(fixture.componentInstance.form.pristine).toBeTrue();
    picker.open(); tick(); picker.choose({ ...customer, id: 900 });
    expect(fixture.componentInstance.form.value.record).toBe(900);
    expect(fixture.componentInstance.form.dirty).toBeTrue(); expect(fixture.componentInstance.form.touched).toBeTrue();
  }));

  it('adds a customer inline without navigating and prevents double submission', fakeAsync(() => {
    const saved = new Subject<Customer>(); customers.createCustomer.and.returnValue(saved);
    picker.open(); tick(); picker.beginCreate(); fixture.detectChanges(); tick();
    picker.createForm.patchValue({ name: ' New customer ', email: 'new@example.test', billing_address: ' Durban ' });
    picker.saveNew(); picker.saveNew();
    expect(customers.createCustomer).toHaveBeenCalledOnceWith({ name: 'New customer', email: 'new@example.test', billing_address: 'Durban' });
    const cancel = new Event('cancel', { cancelable: true }); picker.onCancel(cancel); expect(cancel.defaultPrevented).toBeTrue();
    saved.next({ ...customer, id: 901 }); saved.complete();
    expect(fixture.componentInstance.form.value.record).toBe(901); expect(picker.dialog.nativeElement.open).toBeFalse();
  }));

  it('keeps inline entries after an error and validates required email and address', fakeAsync(() => {
    customers.createCustomer.and.returnValue(throwError(() => ({ error: { message: 'Please retry' } })));
    picker.open(); tick(); picker.beginCreate(); fixture.detectChanges(); tick();
    picker.saveNew(); expect(customers.createCustomer).not.toHaveBeenCalled();
    picker.createForm.patchValue({ name: 'Keep me', email: 'keep@example.test', billing_address: 'Joburg' }); picker.saveNew();
    expect(picker.error).toBe('Please retry'); expect(picker.createForm.value.name).toBe('Keep me');
    expect(picker.dialog.nativeElement.open).toBeTrue();
  }));

  it('uses product search, preserves inclusive pricing on creation and supports custom items', fakeAsync(() => {
    fixture.componentInstance.kind = 'product'; fixture.detectChanges(); products.createProduct.and.returnValue(of(product));
    const selected = jasmine.createSpy('selected'); picker.productChosen.subscribe(selected);
    picker.open(); tick(); expect(products.getProducts).toHaveBeenCalledOnceWith('', 1, 20);
    picker.beginCreate(); fixture.detectChanges(); tick(); picker.createForm.patchValue({ name: 'Repair service', price: 115, vat_inclusive: true }); picker.saveNew();
    expect(products.createProduct).toHaveBeenCalledOnceWith({ name: 'Repair service', price: 115, vat_inclusive: true });
    expect(selected).toHaveBeenCalledWith(product);
    picker.open(); tick(); picker.choose(null); expect(fixture.componentInstance.form.value.record).toBeNull(); expect(selected).toHaveBeenCalledWith(null);
  }));

  it('prevents Enter in search from submitting the enclosing invoice form', fakeAsync(() => {
    picker.open(); tick(); const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
    picker.searchBox.nativeElement.dispatchEvent(event); tick(); expect(event.defaultPrevented).toBeTrue();
    expect(fixture.componentInstance.form.pristine).toBeTrue();
  }));

  it('honours a disabled form control', () => {
    fixture.componentInstance.form.disable(); fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.picker-trigger').disabled).toBeTrue();
    picker.open(); expect(picker.dialog.nativeElement.open).toBeFalse(); expect(customers.getCustomers).not.toHaveBeenCalled();
  });
});
