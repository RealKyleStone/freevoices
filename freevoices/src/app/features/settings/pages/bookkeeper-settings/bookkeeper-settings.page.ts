import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { IonButton, IonSpinner } from '@ionic/angular/standalone';
import { environment } from '../../../../../environments/environment';

interface Bookkeeper { id: number; email: string; granted_at: string; }
interface Invitation { id: number; email: string; expires_at: string; delivery_status: string; }

@Component({
  selector: 'app-bookkeeper-settings',
  standalone: true,
  imports: [CommonModule, FormsModule, IonButton, IonSpinner],
  templateUrl: './bookkeeper-settings.page.html',
  styleUrls: ['./bookkeeper-settings.page.scss'],
})
export class BookkeeperSettingsPage implements OnInit {
  private readonly url = `${environment.apiUrl}/business/bookkeepers`;
  private readonly invitationUrl = `${environment.apiUrl}/business/bookkeeper-invitations`;
  bookkeepers: Bookkeeper[] = [];
  invitations: Invitation[] = [];
  email = '';
  password = '';
  busy = false;
  error = '';
  message = '';
  previewUrl = '';

  constructor(private http: HttpClient) {}
  ngOnInit(): void { this.load(); }
  load(): void {
    this.http.get<Bookkeeper[]>(this.url).subscribe({
      next: rows => { this.bookkeepers = rows; },
      error: () => { this.error = 'Could not load bookkeepers.'; },
    });
    this.http.get<Invitation[]>(this.invitationUrl).subscribe({
      next: rows => { this.invitations = rows; },
      error: () => { this.error = 'Could not load invitations.'; },
    });
  }
  invite(): void {
    if (!this.email || !this.password || this.busy) return;
    this.busy = true; this.error = ''; this.message = ''; this.previewUrl = '';
    this.http.post<{message:string;preview_url?:string}>(this.invitationUrl, { email: this.email, password: this.password }).subscribe({
      next: result => { this.busy = false; this.email = ''; this.password = ''; this.message = result.message; this.previewUrl = result.preview_url || ''; this.load(); },
      error: (error: HttpErrorResponse) => { this.busy = false; this.error = error.error?.message || 'Could not send invitation.'; },
    });
  }
  cancel(entry: Invitation): void {
    if (!this.password || this.busy) { this.error = 'Enter your password to cancel the invitation.'; return; }
    this.busy = true; this.error = ''; this.message = '';
    this.http.request<{message:string}>('DELETE', `${this.invitationUrl}/${entry.id}`, { body: { password: this.password } }).subscribe({
      next: result => { this.busy = false; this.password = ''; this.previewUrl = ''; this.message = result.message; this.load(); },
      error: (error: HttpErrorResponse) => { this.busy = false; this.error = error.error?.message || 'Could not cancel invitation.'; },
    });
  }
  revoke(entry: Bookkeeper): void {
    if (!this.password || this.busy) { this.error = 'Enter your password to revoke access.'; return; }
    this.busy = true; this.error = ''; this.message = '';
    this.http.request<{message:string}>('DELETE', `${this.url}/${entry.id}`, { body: { password: this.password } }).subscribe({
      next: result => { this.busy = false; this.password = ''; this.message = result.message; this.load(); },
      error: (error: HttpErrorResponse) => { this.busy = false; this.error = error.error?.message || 'Could not revoke access.'; },
    });
  }
}
