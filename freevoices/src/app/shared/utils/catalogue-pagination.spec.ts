import { of, throwError } from 'rxjs';
import { CustomerService } from '../../features/customers/services/customer.service';
import { ProductService } from '../../features/products/services/product.service';
import { DatabaseService } from '../../../services/database.service';

describe('document catalogue loading', () => {
  it('makes customers beyond the first 100 selectable', () => {
    const db = jasmine.createSpyObj<DatabaseService>('DatabaseService', ['query']);
    db.query.and.callFake(<T>(_endpoint: string, options: any) => {
      const page = options.params.page;
      const start = (page - 1) * 100;
      return of({data: Array.from({length: Math.min(100, 205 - start)}, (_, i) => ({id: start + i + 1})), total: 205, page, limit: 100} as T);
    });
    new CustomerService(db).getAllCustomers().subscribe(rows => {
      expect(rows.length).toBe(205);
      expect(rows[rows.length - 1]?.id).toBe(205);
    });
    expect(db.query).toHaveBeenCalledTimes(3);
  });

  it('makes products beyond the first 100 selectable', () => {
    const db = jasmine.createSpyObj<DatabaseService>('DatabaseService', ['query']);
    db.query.and.returnValues(
      of({data: Array.from({length: 100}, (_, i) => ({id: i + 1})), total: 101, page: 1, limit: 100}),
      of({data: [{id: 101}], total: 101, page: 2, limit: 100})
    );
    new ProductService(db).getAllProducts().subscribe(rows => {
      expect(rows.length).toBe(101);
      expect(rows[rows.length - 1]?.id).toBe(101);
    });
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('reports a later-page failure instead of silently presenting an incomplete catalogue', () => {
    const db = jasmine.createSpyObj<DatabaseService>('DatabaseService', ['query']);
    db.query.and.returnValues(
      of({data: [{id: 1}], total: 101, page: 1, limit: 100}),
      throwError(() => new Error('Offline'))
    );
    new CustomerService(db).getAllCustomers().subscribe({next: () => fail('Expected loading failure'), error: e => expect(e.message).toBe('Offline')});
  });
});
