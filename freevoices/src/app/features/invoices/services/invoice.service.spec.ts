// ============================================================
// invoice.service.spec.ts — Unit tests for InvoiceService
// ============================================================
// HOW TO RUN:
//   ng test --watch=false --browsers=ChromeHeadless
// ============================================================

import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { InvoiceService, InvoiceListResponse, InvoiceDetail, InvoicePayload, MarkPaidPayload } from './invoice.service';
import { DatabaseService } from 'src/services/database.service';
import { of, throwError } from 'rxjs';

// ── Shared mock data ──────────────────────────────────────────────────────────
// This is a realistic fake invoice list item — matches the InvoiceListItem interface
const MOCK_LIST_ITEM = {
  id: 13,
  document_number: 'INV-2026-0002',
  customer_name: 'Bubbles Corp',
  status: 'PAID',
  issue_date: '2026-06-17',
  due_date: '2026-07-17',
  subtotal: 19000,
  vat_amount: 2850,
  total: 21850,
  created_at: new Date().toISOString()
};

const MOCK_LIST_RESPONSE: InvoiceListResponse = {
  data: [MOCK_LIST_ITEM],
  total: 1,
  page: 1,
  limit: 20
};

// A full invoice detail — what getInvoice() returns
const MOCK_INVOICE_DETAIL: Partial<InvoiceDetail> = {
  id: 13,
  document_number: 'INV-2026-0002',
  customer_name: 'Bubbles Corp',
  customer_email: 'bubbles@test.com',
  customer_billing_address: '2858 F Baart Street Mabopane',
  customer_vat_number: '',
  status: 'PAID',
  type: 'INVOICE',
  total: 21850,
  subtotal: 19000,
  vat_amount: 2850,
  items: [],
  tracking: [],
  payments: [],
  currency_symbol: 'R'
};

// A valid payload for creating an invoice
const MOCK_CREATE_PAYLOAD: InvoicePayload = {
  customer_id: 1,
  issue_date: '2026-06-22',
  items: [
    { description: 'Web Design', quantity: 1, unit_price: 5000, vat_rate: 15 }
  ]
};

// A valid payload for recording a payment
const MOCK_PAYMENT_PAYLOAD: MarkPaidPayload = {
  amount: 21850,
  payment_date: '2026-06-22',
  payment_method: 'BANK_TRANSFER',
  transaction_reference: 'REF-001'
};

// ── Tests ─────────────────────────────────────────────────────────────────────
describe('InvoiceService', () => {
  let service: InvoiceService;
  let dbSpy: jasmine.SpyObj<DatabaseService>;

  beforeEach(() => {
    // Create a fake DatabaseService — we control exactly what it returns
    dbSpy = jasmine.createSpyObj('DatabaseService', ['create', 'query', 'update', 'delete']);

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        InvoiceService,
        { provide: DatabaseService, useValue: dbSpy }
      ]
    });

    service = TestBed.inject(InvoiceService);
  });

  // ============================================================
  // GROUP 1: Service creation
  // ============================================================
  describe('service creation', () => {

    it('should be created', () => {
      expect(service).toBeTruthy();
    });

  });

  // ============================================================
  // GROUP 2: getInvoices()
  // ============================================================
  describe('getInvoices()', () => {

    it('should call db.query with the invoices endpoint', () => {
      dbSpy.query.and.returnValue(of(MOCK_LIST_RESPONSE));

      service.getInvoices().subscribe();

      expect(dbSpy.query).toHaveBeenCalledWith('invoices', jasmine.objectContaining({
        params: jasmine.objectContaining({ search: '', status: '', page: 1, limit: 20 })
      }));
    });

    it('should pass search term to query params', () => {
      dbSpy.query.and.returnValue(of(MOCK_LIST_RESPONSE));

      service.getInvoices('INV-2026').subscribe();

      expect(dbSpy.query).toHaveBeenCalledWith('invoices', jasmine.objectContaining({
        params: jasmine.objectContaining({ search: 'INV-2026' })
      }));
    });

    it('should pass status filter to query params', () => {
      dbSpy.query.and.returnValue(of(MOCK_LIST_RESPONSE));

      service.getInvoices('', 'PAID').subscribe();

      expect(dbSpy.query).toHaveBeenCalledWith('invoices', jasmine.objectContaining({
        params: jasmine.objectContaining({ status: 'PAID' })
      }));
    });

    it('should pass page and limit to query params', () => {
      dbSpy.query.and.returnValue(of(MOCK_LIST_RESPONSE));

      service.getInvoices('', '', 2, 10).subscribe();

      expect(dbSpy.query).toHaveBeenCalledWith('invoices', jasmine.objectContaining({
        params: jasmine.objectContaining({ page: 2, limit: 10 })
      }));
    });

    it('should return the invoice list response', (done) => {
      dbSpy.query.and.returnValue(of(MOCK_LIST_RESPONSE));

      service.getInvoices().subscribe(result => {
        expect(result.data.length).toBe(1);
        expect(result.data[0].document_number).toBe('INV-2026-0002');
        expect(result.total).toBe(1);
        done();
      });
    });

    it('should propagate errors from DatabaseService', (done) => {
      dbSpy.query.and.returnValue(throwError(() => ({ status: 500 })));

      service.getInvoices().subscribe({
        next: () => fail('Expected an error'),
        error: (err) => {
          expect(err.status).toBe(500);
          done();
        }
      });
    });

  });

  // ============================================================
  // GROUP 3: getInvoice()
  // ============================================================
  describe('getInvoice()', () => {

    it('should call db.query with the correct invoice endpoint', () => {
      dbSpy.query.and.returnValue(of(MOCK_INVOICE_DETAIL));

      service.getInvoice(13).subscribe();

      // The endpoint must include the invoice ID
      expect(dbSpy.query).toHaveBeenCalledWith('invoices/13');
    });

    it('should return the full invoice detail with items, tracking and payments', (done) => {
      dbSpy.query.and.returnValue(of(MOCK_INVOICE_DETAIL));

      service.getInvoice(13).subscribe(result => {
        expect(result.document_number).toBe('INV-2026-0002');
        expect(result.customer_name).toBe('Bubbles Corp');
        expect(result.items).toEqual([]);
        expect(result.payments).toEqual([]);
        done();
      });
    });

    it('should propagate a 404 when invoice is not found', (done) => {
      dbSpy.query.and.returnValue(throwError(() => ({ status: 404 })));

      service.getInvoice(999).subscribe({
        next: () => fail('Expected a 404'),
        error: (err) => {
          expect(err.status).toBe(404);
          done();
        }
      });
    });

  });

  // ============================================================
  // GROUP 4: createInvoice()
  // ============================================================
  describe('createInvoice()', () => {

    it('should call db.create with the invoices endpoint and payload', () => {
      dbSpy.create.and.returnValue(of(MOCK_INVOICE_DETAIL));

      service.createInvoice(MOCK_CREATE_PAYLOAD).subscribe();

      expect(dbSpy.create).toHaveBeenCalledWith('invoices', MOCK_CREATE_PAYLOAD);
    });

    it('should return the created invoice detail', (done) => {
      dbSpy.create.and.returnValue(of(MOCK_INVOICE_DETAIL));

      service.createInvoice(MOCK_CREATE_PAYLOAD).subscribe(result => {
        expect(result.id).toBe(13);
        expect(result.document_number).toBe('INV-2026-0002');
        done();
      });
    });

    it('should propagate a 400 error when required fields are missing', (done) => {
      dbSpy.create.and.returnValue(throwError(() => ({
        status: 400,
        error: { message: 'Customer, issue date, and at least one line item are required' }
      })));

      // Empty items array — the backend will reject this
      const badPayload = { ...MOCK_CREATE_PAYLOAD, items: [] };
      service.createInvoice(badPayload).subscribe({
        next: () => fail('Expected a 400 error'),
        error: (err) => {
          expect(err.status).toBe(400);
          done();
        }
      });
    });

  });

  // ============================================================
  // GROUP 5: updateInvoice()
  // ============================================================
  describe('updateInvoice()', () => {

    it('should call db.update with the invoices endpoint, id, and payload', () => {
      dbSpy.update.and.returnValue(of(MOCK_INVOICE_DETAIL));

      service.updateInvoice(13, MOCK_CREATE_PAYLOAD).subscribe();

      expect(dbSpy.update).toHaveBeenCalledWith('invoices', 13, MOCK_CREATE_PAYLOAD);
    });

    it('should return the updated invoice detail', (done) => {
      dbSpy.update.and.returnValue(of(MOCK_INVOICE_DETAIL));

      service.updateInvoice(13, MOCK_CREATE_PAYLOAD).subscribe(result => {
        expect(result.id).toBe(13);
        done();
      });
    });

    it('should propagate a 400 error when trying to update a non-DRAFT invoice', (done) => {
      // Only DRAFT invoices can be edited — backend enforces this
      dbSpy.update.and.returnValue(throwError(() => ({
        status: 400,
        error: { message: 'Only DRAFT invoices can be edited' }
      })));

      service.updateInvoice(13, MOCK_CREATE_PAYLOAD).subscribe({
        next: () => fail('Expected a 400'),
        error: (err) => {
          expect(err.status).toBe(400);
          done();
        }
      });
    });

  });

  // ============================================================
  // GROUP 6: sendInvoice()
  // ============================================================
  describe('sendInvoice()', () => {

    it('should call db.create with the send endpoint', () => {
      dbSpy.create.and.returnValue(of({ message: 'Invoice emailed to bubbles@test.com' }));

      service.sendInvoice(13).subscribe();

      // Note: sendInvoice posts to invoices/:id/send with an empty body {}
      expect(dbSpy.create).toHaveBeenCalledWith('invoices/13/send', {});
    });

    it('should return a success message', (done) => {
      dbSpy.create.and.returnValue(of({ message: 'Invoice emailed to bubbles@test.com' }));

      service.sendInvoice(13).subscribe(result => {
        expect(result.message).toContain('emailed');
        done();
      });
    });

    it('should propagate a 404 when invoice is not found', (done) => {
      dbSpy.create.and.returnValue(throwError(() => ({ status: 404 })));

      service.sendInvoice(999).subscribe({
        next: () => fail('Expected a 404'),
        error: (err) => {
          expect(err.status).toBe(404);
          done();
        }
      });
    });

  });

  // ============================================================
  // GROUP 7: markPaid()
  // ============================================================
  describe('markPaid()', () => {

    it('should call db.create with the mark-paid endpoint and payment data', () => {
      dbSpy.create.and.returnValue(of({ message: 'Payment recorded successfully' }));

      service.markPaid(13, MOCK_PAYMENT_PAYLOAD).subscribe();

      expect(dbSpy.create).toHaveBeenCalledWith('invoices/13/mark-paid', MOCK_PAYMENT_PAYLOAD);
    });

    it('should return a success message', (done) => {
      dbSpy.create.and.returnValue(of({ message: 'Payment recorded successfully' }));

      service.markPaid(13, MOCK_PAYMENT_PAYLOAD).subscribe(result => {
        expect(result.message).toBe('Payment recorded successfully');
        done();
      });
    });

    it('should propagate a 400 error when payment fields are missing', (done) => {
      dbSpy.create.and.returnValue(throwError(() => ({
        status: 400,
        error: { message: 'Amount, payment date, and payment method are required' }
      })));

      // Incomplete payment data
      const badPayload = { amount: 0, payment_date: '', payment_method: '' };
      service.markPaid(13, badPayload).subscribe({
        next: () => fail('Expected a 400'),
        error: (err) => {
          expect(err.status).toBe(400);
          done();
        }
      });
    });

    it('should propagate a 404 when invoice is not found', (done) => {
      dbSpy.create.and.returnValue(throwError(() => ({ status: 404 })));

      service.markPaid(999, MOCK_PAYMENT_PAYLOAD).subscribe({
        next: () => fail('Expected a 404'),
        error: (err) => {
          expect(err.status).toBe(404);
          done();
        }
      });
    });

  });

  // ============================================================
  // GROUP 8: shareInvoice()
  // ============================================================
  describe('shareInvoice()', () => {

    it('should call db.create with the share endpoint', () => {
      dbSpy.create.and.returnValue(of({
        token: 'abc123',
        share_url: 'http://localhost:3000/portal/invoice/abc123'
      }));

      service.shareInvoice(13).subscribe();

      expect(dbSpy.create).toHaveBeenCalledWith('invoices/13/share', {});
    });

    it('should return a token and share URL', (done) => {
      const mockShareResponse = {
        token: 'abc123',
        share_url: 'http://localhost:3000/portal/invoice/abc123'
      };
      dbSpy.create.and.returnValue(of(mockShareResponse));

      service.shareInvoice(13).subscribe(result => {
        expect(result.token).toBe('abc123');
        expect(result.share_url).toContain('/portal/invoice/');
        done();
      });
    });

    it('should propagate a 404 when invoice is not found', (done) => {
      dbSpy.create.and.returnValue(throwError(() => ({ status: 404 })));

      service.shareInvoice(999).subscribe({
        next: () => fail('Expected a 404'),
        error: (err) => {
          expect(err.status).toBe(404);
          done();
        }
      });
    });

  });

});
