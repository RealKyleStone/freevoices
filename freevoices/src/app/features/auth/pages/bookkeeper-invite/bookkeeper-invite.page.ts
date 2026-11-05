import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { IonButton, IonContent, IonSpinner } from '@ionic/angular/standalone';
import { environment } from '../../../../../environments/environment';
import { AuthService } from '../../../../core/auth/services/auth.service';

interface Invitation { email: string; business_name: string; expires_at: string; }

@Component({
  selector: 'app-bookkeeper-invite',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, IonButton, IonContent, IonSpinner],
  templateUrl: './bookkeeper-invite.page.html',
  styleUrls: ['./bookkeeper-invite.page.scss'],
})
export class BookkeeperInvitePage implements OnInit {
  private token = '';
  invitation: Invitation | null = null;
  name = '';
  password = '';
  confirmPassword = '';
  busy = false;
  error = '';
  done = '';
  returnUrl = '';

  constructor(private http: HttpClient, private route: ActivatedRoute,
    private router: Router, public auth: AuthService) {}

  ngOnInit(): void {
    this.token = this.route.snapshot.queryParamMap.get('token') || '';
    if (!this.token) { this.error = 'Invitation link is missing.'; return; }
    this.returnUrl = `/bookkeeper-invite?token=${encodeURIComponent(this.token)}`;
    this.http.get<Invitation>(`${environment.apiUrl}/bookkeeper-invitations/${encodeURIComponent(this.token)}`).subscribe({
      next: invite => { this.invitation = invite; },
      error: () => { this.error = 'This invitation has expired or is unavailable.'; },
    });
  }

  accept(): void {
    if (!this.token || this.busy) return;
    this.busy = true; this.error = '';
    this.http.post<{message:string}>(`${environment.apiUrl}/bookkeeper-invitations/${encodeURIComponent(this.token)}/accept`,{}).subscribe({
      next: result => { this.busy = false; this.done = result.message; this.auth.clearLocalSession(); },
      error: (error: HttpErrorResponse) => { this.busy = false; this.error = error.error?.message || 'Could not accept invitation.'; },
    });
  }

  register(): void {
    if (!this.name || this.password.length < 8 || this.password !== this.confirmPassword || this.busy) {
      this.error = 'Enter your name and a matching password of at least 8 characters.';
      return;
    }
    this.busy = true; this.error = '';
    this.http.post<{message:string}>(`${environment.apiUrl}/bookkeeper-invitations/${encodeURIComponent(this.token)}/register`,{
      name:this.name,password:this.password,
    }).subscribe({
      next: result => { this.busy = false; this.done = result.message; this.password = ''; this.confirmPassword = ''; },
      error: (error: HttpErrorResponse) => { this.busy = false; this.error = error.error?.message || 'Could not create account.'; },
    });
  }
}
