import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

import { ApiService } from '../../../core/services/api.service';
import { environment } from '../../../../environments/environment';

export interface AccountStatus {
  status: 'ACTIVE' | 'CLOSED' | 'ANONYMISED';
  closed_at: string | null;
  anonymise_due_at: string | null;
  last_login_at: string | null;
  terms_accepted_at: string | null;
  privacy_accepted_at: string | null;
  privacy_policy_version: string | null;
  grace_days: number;
}

export interface CloseAccountResult {
  message: string;
  closed_at: string;
  anonymise_due_at: string;
  grace_days: number;
}

@Injectable({ providedIn: 'root' })
export class AccountService {
  constructor(private api: ApiService) {}

  getStatus(): Observable<AccountStatus> {
    return this.api.get<AccountStatus>('/account/status');
  }

  closeAccount(password: string): Observable<CloseAccountResult> {
    return this.api.post<CloseAccountResult>('/account/close', { password, confirm: 'DELETE' });
  }

  reactivate(email: string, password: string): Observable<{ message: string; token: string; user: any }> {
    return this.api.post('/account/reactivate', { email, password });
  }

  /**
   * Download the POPIA data export as a file.
   *
   * Uses fetch rather than HttpClient because the response is a file download
   * rather than JSON to bind — the same approach the invoice and receipt PDF
   * downloads already take. The Authorization header is set by hand for the
   * same reason: a raw fetch bypasses AuthInterceptor.
   */
  async downloadExport(): Promise<void> {
    const token = localStorage.getItem('token');
    const response = await fetch(`${environment.apiUrl}/account/export`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      let message = 'Could not build your export. Please try again.';
      try {
        const body = await response.json();
        if (body?.message) message = body.message;
      } catch {
        /* non-JSON error body; keep the default */
      }
      throw new Error(message);
    }

    const blob = await response.blob();
    // Prefer the filename the server chose, so the date in it is the server's.
    const disposition = response.headers.get('content-disposition') || '';
    const match = disposition.match(/filename="([^"]+)"/);
    const filename = match ? match[1] : 'freevoices-export.json';

    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}
