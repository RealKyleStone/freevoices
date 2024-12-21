// src/app/features/auth/pages/verify-email/verify-email.page.ts
import { Component, OnInit } from '@angular/core';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { DatabaseService } from 'src/services/database.service';
import { CommonModule } from '@angular/common';
import { IonContent, IonCard, IonCardContent, IonButton, IonIcon, IonSpinner } from '@ionic/angular/standalone';

@Component({
  selector: 'app-verify-email',
  templateUrl: './verify-email.page.html',
  styleUrls: ['./verify-email.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    IonContent,
    IonCard,
    IonCardContent,
    IonButton,
    IonIcon,
    IonSpinner
  ]
})
export class VerifyEmailPage implements OnInit {
  verificationStatus: 'verifying' | 'success' | 'error' = 'verifying';
  errorMessage = '';

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private dbService: DatabaseService
  ) {}

  ngOnInit() {
    const token = this.route.snapshot.queryParamMap.get('token');
    if (token) {
      this.verifyEmail(token);
    } else {
      this.verificationStatus = 'error';
      this.errorMessage = 'Invalid verification link';
    }
  }

  private async verifyEmail(token: string) {
    try {
      await this.dbService.query(`verify-email?token=${token}`).toPromise();
      this.verificationStatus = 'success';
    } catch (error: any) {
      this.verificationStatus = 'error';
      this.errorMessage = error.error?.message || 'Verification failed';
    }
  }
}