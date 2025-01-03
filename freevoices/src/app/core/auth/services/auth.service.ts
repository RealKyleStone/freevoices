import { Injectable } from '@angular/core';
import { BehaviorSubject, Observable, from } from 'rxjs';
import { DatabaseService } from 'src/services/database.service';
import { tap } from 'rxjs/operators';

interface User {
  id: number;
  email: string;
  company_name: string;
}

@Injectable({
  providedIn: 'root'
})
export class AuthService {
  private currentUserSubject = new BehaviorSubject<User | null>(null);
  public currentUser$ = this.currentUserSubject.asObservable();

  constructor(private dbService: DatabaseService) {
    const user = localStorage.getItem('currentUser');
    if (user) {
      this.currentUserSubject.next(JSON.parse(user));
    }
  }

  login(email: string, password: string, captchaToken?: string): Observable<any> {
    return this.dbService.create('auth/login', {
      email,
      password,
      captchaToken
    }).pipe(
      tap(response => this.handleLoginSuccess(response))
    );
  }

  async handleLoginSuccess(response: any): Promise<void> {
    localStorage.setItem('currentUser', JSON.stringify(response.user));
    localStorage.setItem('token', response.token);
    this.currentUserSubject.next(response.user);
  }

  async logout(): Promise<void> {
    try {
      await this.dbService.create('auth/logout', {}).toPromise();
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      localStorage.removeItem('currentUser');
      localStorage.removeItem('token');
      this.currentUserSubject.next(null);
    }
  }

  isAuthenticated(): boolean {
    return !!this.currentUserSubject.value;
  }

  getToken(): string | null {
    return localStorage.getItem('token');
  }

  getCurrentUser(): User | null {
    return this.currentUserSubject.value;
  }
}