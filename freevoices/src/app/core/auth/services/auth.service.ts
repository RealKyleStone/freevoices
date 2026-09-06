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

  /**
   * Exchange a Google ID token for a session.
   *
   * Two shapes come back. A known account returns { token, user } and is a
   * completed sign-in. An unrecognised one returns { needsRegistration: true }
   * plus the verified email — no account exists yet, and the caller routes to
   * the details step. Only the first shape opens a session, so the tap() has to
   * discriminate rather than storing whatever it is handed.
   */
  signInWithGoogle(idToken: string): Observable<any> {
    return this.dbService.create('auth/google', { idToken }).pipe(
      tap(response => {
        if (response?.token) this.handleLoginSuccess(response);
      })
    );
  }

  /** Finish a Google sign-up once the business details have been collected. */
  registerWithGoogle(idToken: string, details: Record<string, any>): Observable<any> {
    return this.dbService.create('auth/google/register', { idToken, ...details }).pipe(
      tap(response => {
        if (response?.token) this.handleLoginSuccess(response);
      })
    );
  }

  async handleLoginSuccess(response: any): Promise<void> {
    localStorage.setItem('currentUser', JSON.stringify(response.user));
    localStorage.setItem('token', response.token);
    this.currentUserSubject.next(response.user);
  }

  async logout(): Promise<void> {
    try {
      await this.dbService.create('logout', {}).toPromise();
    } catch (error) {
      console.error('Logout error:', error);
    } finally {
      this.clearLocalSession();
    }
  }

  /**
   * Drop local session state without calling the logout endpoint.
   *
   * Needed after closing an account: the server has already destroyed every
   * session, so logout() would fire a doomed request whose 401 makes the error
   * interceptor redirect immediately — yanking the page out from under the
   * confirmation dialog. Resets the BehaviorSubject too, otherwise currentUser$
   * keeps emitting and the signed-in shell stays on screen.
   */
  clearLocalSession(): void {
    localStorage.removeItem('currentUser');
    localStorage.removeItem('token');
    this.currentUserSubject.next(null);
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