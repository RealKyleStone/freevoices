import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import { DatabaseService } from '../../../../services/database.service';
import { Product } from '../../../../models/database.models';

export interface ProductListResponse {
  data: Product[];
  total: number;
  page: number;
  limit: number;
}

@Injectable({
  providedIn: 'root'
})
export class ProductService {
  constructor(private db: DatabaseService) {}

  getProducts(search = '', page = 1, limit = 20): Observable<ProductListResponse> {
    return this.db.query<ProductListResponse>('products', { params: { search, page, limit } });
  }

  getProduct(id: number): Observable<Product> {
    return this.db.query<Product>(`products/${id}`);
  }

  createProduct(data: Partial<Product>): Observable<Product> {
    return this.db.create<Product>('products', data);
  }

  updateProduct(id: number, data: Partial<Product>): Observable<Product> {
    return this.db.update<Product>('products', id, data);
  }

  deleteProduct(id: number): Observable<{ message: string }> {
    return this.db.delete<{ message: string }>('products', id);
  }
}
