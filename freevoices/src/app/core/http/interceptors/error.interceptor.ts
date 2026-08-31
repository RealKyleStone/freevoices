import { Injectable } from '@angular/core';
import {
  HttpInterceptor, HttpRequest, HttpHandler,
  HttpEvent, HttpErrorResponse
} from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { Router } from '@angular/router';
import { ToastController } from '@ionic/angular/standalone';

@Injectable()
export class ErrorInterceptor implements HttpInterceptor {
  constructor(
    private router: Router,
    private toastCtrl: ToastController
  ) {}

  intercept(request: HttpRequest<any>, next: HttpHandler): Observable<HttpEvent<any>> {
    return next.handle(request).pipe(
      catchError((error: HttpErrorResponse) => {
        // ACCOUNT_CLOSED is a 403, not a 401: the token was valid, the account
        // is not. Treated like a forced sign-out so the user isn't left staring
        // at a permission toast on every request.
        if (error.status === 403 && error.error?.code === 'ACCOUNT_CLOSED') {
          this.clearSession();
          this.router.navigate(['/login'], { queryParams: { closed: '1' } });
        } else if (error.status === 401) {
          this.clearSession();
          this.router.navigate(['/login']);
        } else {
          const message = error.error?.message || this.defaultMessage(error.status);
          this.showToast(message);
        }
        return throwError(() => error);
      })
    );
  }

  /**
   * Clear both keys. Removing only `token` left `currentUser` behind, so
   * AuthService.isAuthenticated() kept reporting true after a forced sign-out
   * and AuthGuard would wave the user straight back through.
   */
  private clearSession(): void {
    localStorage.removeItem('token');
    localStorage.removeItem('currentUser');
  }

  private defaultMessage(status: number): string {
    if (status === 0) return 'Unable to reach the server. Check your connection.';
    if (status === 403) return 'You do not have permission to perform this action.';
    if (status === 404) return 'The requested resource was not found.';
    if (status >= 500) return 'A server error occurred. Please try again later.';
    return 'An unexpected error occurred.';
  }

  private async showToast(message: string): Promise<void> {
    const toast = await this.toastCtrl.create({
      message,
      duration: 4000,
      position: 'bottom',
      color: 'danger',
      buttons: [{ icon: 'close', role: 'cancel' }]
    });
    await toast.present();
  }
}
