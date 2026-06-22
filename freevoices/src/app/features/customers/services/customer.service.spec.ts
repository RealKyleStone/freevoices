// ============================================================
// customer.service.spec.ts — Unit tests for CustomerService
// ============================================================
// HOW TO RUN:
//   ng test --watch=false --browsers=ChromeHeadless
// ============================================================

import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { CustomerService } from './customer.service';
import { DatabaseService } from 'src/services/database.service';
import { of, throwError } from 'rxjs';
import { Customer } from 'src/models/database.models';

// ── Shared mock data ──────────────────────────────────────────
const MOCK_CUSTOMER: Customer = {
  id: 1,
  user_id: 23,
  name: 'Bubbles Corp',
  email: 'bubbles@test.com',
  phone: '0658185514',
  billing_address: '2858 F Baart Street Mabopane',
  active: true,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString()
};

const MOCK_LIST_RESPONSE = {
  data: [MOCK_CUSTOMER],
  total: 1,
  page: 1,
  limit: 20
};

// ── Tests ─────────────────────────────────────────────────────
describe('CustomerService', () => {
  let service: CustomerService;
  let dbSpy: jasmine.SpyObj<DatabaseService>;

  beforeEach(() => {
    dbSpy = jasmine.createSpyObj('DatabaseService', ['create', 'query', 'update', 'delete']);

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        CustomerService,
        { provide: DatabaseService, useValue: dbSpy }
      ]
    });

    service = TestBed.inject(CustomerService);
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
  // GROUP 2: getCustomers()
  // ============================================================
  describe('getCustomers()', () => {

    it('should call db.query with the customers endpoint', () => {
      // Tell the spy what to return when query() is called
      dbSpy.query.and.returnValue(of(MOCK_LIST_RESPONSE));

      service.getCustomers().subscribe();

      // Verify query() was called, and that 'customers' was the endpoint
      expect(dbSpy.query).toHaveBeenCalledWith('customers', jasmine.objectContaining({
        params: jasmine.objectContaining({ search: '', page: 1, limit: 20 })
      }));
    });

    it('should pass search term to the query params', () => {
      dbSpy.query.and.returnValue(of(MOCK_LIST_RESPONSE));

      service.getCustomers('bubbles').subscribe();

      expect(dbSpy.query).toHaveBeenCalledWith('customers', jasmine.objectContaining({
        params: jasmine.objectContaining({ search: 'bubbles' })
      }));
    });

    it('should pass page and limit to the query params', () => {
      dbSpy.query.and.returnValue(of(MOCK_LIST_RESPONSE));

      service.getCustomers('', 2, 10).subscribe();

      expect(dbSpy.query).toHaveBeenCalledWith('customers', jasmine.objectContaining({
        params: jasmine.objectContaining({ page: 2, limit: 10 })
      }));
    });

    it('should return the list response from DatabaseService', (done) => {
      dbSpy.query.and.returnValue(of(MOCK_LIST_RESPONSE));

      service.getCustomers().subscribe(result => {
        expect(result.data.length).toBe(1);
        expect(result.total).toBe(1);
        expect(result.data[0].name).toBe('Bubbles Corp');
        done();
      });
    });

    it('should propagate errors from DatabaseService', (done) => {
      dbSpy.query.and.returnValue(throwError(() => ({ status: 500 })));

      service.getCustomers().subscribe({
        next: () => fail('Expected an error'),
        error: (err) => {
          expect(err.status).toBe(500);
          done();
        }
      });
    });

  });

  // ============================================================
  // GROUP 3: getCustomer()
  // ============================================================
  describe('getCustomer()', () => {

    it('should call db.query with the correct customer endpoint', () => {
      dbSpy.query.and.returnValue(of({ ...MOCK_CUSTOMER, documents: [] }));

      service.getCustomer(1).subscribe();

      expect(dbSpy.query).toHaveBeenCalledWith('customers/1');
    });

    it('should return the customer with their documents', (done) => {
      const mockResponse = { ...MOCK_CUSTOMER, documents: [] };
      dbSpy.query.and.returnValue(of(mockResponse));

      service.getCustomer(1).subscribe(result => {
        expect(result.name).toBe('Bubbles Corp');
        expect(result.documents).toEqual([]);
        done();
      });
    });

    it('should propagate a 404 error when customer is not found', (done) => {
      dbSpy.query.and.returnValue(throwError(() => ({ status: 404 })));

      service.getCustomer(999).subscribe({
        next: () => fail('Expected a 404 error'),
        error: (err) => {
          expect(err.status).toBe(404);
          done();
        }
      });
    });

  });

  // ============================================================
  // GROUP 4: createCustomer()
  // ============================================================
  describe('createCustomer()', () => {

    const NEW_CUSTOMER = {
      name: 'New Client',
      email: 'new@client.com',
      billing_address: '123 Test Street'
    };

    it('should call db.create with the customers endpoint and data', () => {
      dbSpy.create.and.returnValue(of(MOCK_CUSTOMER));

      service.createCustomer(NEW_CUSTOMER).subscribe();

      expect(dbSpy.create).toHaveBeenCalledWith('customers', NEW_CUSTOMER);
    });

    it('should return the created customer from the server', (done) => {
      dbSpy.create.and.returnValue(of(MOCK_CUSTOMER));

      service.createCustomer(NEW_CUSTOMER).subscribe(result => {
        expect(result.id).toBe(1);
        expect(result.name).toBe('Bubbles Corp');
        done();
      });
    });

    it('should propagate a 400 error when required fields are missing', (done) => {
      dbSpy.create.and.returnValue(throwError(() => ({ status: 400, message: 'Name is required' })));

      service.createCustomer({}).subscribe({
        next: () => fail('Expected a 400 error'),
        error: (err) => {
          expect(err.status).toBe(400);
          done();
        }
      });
    });

  });

  // ============================================================
  // GROUP 5: updateCustomer()
  // ============================================================
  describe('updateCustomer()', () => {

    const UPDATED_DATA = { name: 'Updated Name', email: 'updated@test.com', billing_address: '456 New Street' };

    it('should call db.update with the customers endpoint, id, and data', () => {
      dbSpy.update.and.returnValue(of({ ...MOCK_CUSTOMER, name: 'Updated Name' }));

      service.updateCustomer(1, UPDATED_DATA).subscribe();

      expect(dbSpy.update).toHaveBeenCalledWith('customers', 1, UPDATED_DATA);
    });

    it('should return the updated customer', (done) => {
      const updated = { ...MOCK_CUSTOMER, name: 'Updated Name' };
      dbSpy.update.and.returnValue(of(updated));

      service.updateCustomer(1, UPDATED_DATA).subscribe(result => {
        expect(result.name).toBe('Updated Name');
        done();
      });
    });

    it('should propagate a 404 error when customer does not exist', (done) => {
      dbSpy.update.and.returnValue(throwError(() => ({ status: 404 })));

      service.updateCustomer(999, UPDATED_DATA).subscribe({
        next: () => fail('Expected a 404'),
        error: (err) => {
          expect(err.status).toBe(404);
          done();
        }
      });
    });

  });

  // ============================================================
  // GROUP 6: deleteCustomer()
  // ============================================================
  describe('deleteCustomer()', () => {

    it('should call db.delete with the customers endpoint and id', () => {
      dbSpy.delete.and.returnValue(of({ message: 'Customer deleted successfully' }));

      service.deleteCustomer(1).subscribe();

      expect(dbSpy.delete).toHaveBeenCalledWith('customers', 1);
    });

    it('should return a success message', (done) => {
      dbSpy.delete.and.returnValue(of({ message: 'Customer deleted successfully' }));

      service.deleteCustomer(1).subscribe(result => {
        expect(result.message).toBe('Customer deleted successfully');
        done();
      });
    });

    it('should propagate a 404 error when customer does not exist', (done) => {
      dbSpy.delete.and.returnValue(throwError(() => ({ status: 404 })));

      service.deleteCustomer(999).subscribe({
        next: () => fail('Expected a 404'),
        error: (err) => {
          expect(err.status).toBe(404);
          done();
        }
      });
    });

  });

});
