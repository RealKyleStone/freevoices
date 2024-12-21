// src/services/database.service.ts
import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../environments/environment';

interface QueryOptions {
  params?: any;
  cache?: boolean;
  timeout?: number;
}

@Injectable({
  providedIn: 'root'
})
export class DatabaseService {
  private apiUrl = environment.apiUrl;
  private defaultTimeout = 30000; // 30 seconds

  constructor(private http: HttpClient) {}

  query<T>(endpoint: string, options: QueryOptions = {}): Observable<T> {
    const url = `${this.apiUrl}/${endpoint}`;
    const timeout = options.timeout || this.defaultTimeout;

    return this.http.get<T>(url, {
      params: options.params,
      headers: this.getHeaders()
    });
  }

  create<T>(endpoint: string, data: any, options: QueryOptions = {}): Observable<T> {
    const url = `${this.apiUrl}/${endpoint}`;
    
    return this.http.post<T>(url, data, {
      headers: this.getHeaders()
    });
  }

  update<T>(endpoint: string, id: number | string, data: any, options: QueryOptions = {}): Observable<T> {
    const url = `${this.apiUrl}/${endpoint}/${id}`;
    
    return this.http.put<T>(url, data, {
      headers: this.getHeaders()
    });
  }

  delete<T>(endpoint: string, id: number | string, options: QueryOptions = {}): Observable<T> {
    const url = `${this.apiUrl}/${endpoint}/${id}`;
    
    return this.http.delete<T>(url, {
      headers: this.getHeaders()
    });
  }

  private getHeaders() {
    const token = localStorage.getItem('token');
    return {
      'Content-Type': 'application/json',
      'Authorization': token ? `Bearer ${token}` : ''
    };
  }
}