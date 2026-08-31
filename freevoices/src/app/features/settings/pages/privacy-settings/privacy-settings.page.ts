import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { Router, RouterModule } from '@angular/router';
import { AlertController, IonicModule, ToastController } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  shieldCheckmarkOutline,
  downloadOutline,
  warningOutline,
  trashOutline,
  documentTextOutline,
  informationCircleOutline,
  timeOutline
} from 'ionicons/icons';

import { AccountService, AccountStatus } from '../../services/account.service';
import { AuthService } from '../../../../core/auth/services/auth.service';
import { LegalService } from '../../../legal/services/legal.service';

@Component({
  selector: 'app-privacy-settings',
  templateUrl: './privacy-settings.page.html',
  styleUrls: ['./privacy-settings.page.scss'],
  standalone: true,
  imports: [CommonModule, IonicModule, RouterModule]
})
export class PrivacySettingsPage implements OnInit {
  status?: AccountStatus;
  isLoading = true;
  isExporting = false;

  constructor(
    private accountService: AccountService,
    private authService: AuthService,
    private legal: LegalService,
    private alertCtrl: AlertController,
    private toastCtrl: ToastController,
    private router: Router
  ) {
    addIcons({
      shieldCheckmarkOutline, downloadOutline, warningOutline,
      trashOutline, documentTextOutline, informationCircleOutline, timeOutline
    });
  }

  ngOnInit(): void {
    this.accountService.getStatus().subscribe({
      next: (status) => {
        this.status = status;
        this.isLoading = false;
      },
      error: () => {
        this.isLoading = false;
        this.showToast('Could not load your account status', 'danger');
      }
    });
  }

  formatDate(value: string | null): string {
    if (!value) return '—';
    // Timestamps here are full ISO datetimes, so a Date is safe. (Date-only
    // columns are formatted by LegalService, which avoids the UTC shift.)
    return new Date(value).toLocaleDateString('en-ZA', { day: '2-digit', month: 'long', year: 'numeric' });
  }

  async downloadData(): Promise<void> {
    this.isExporting = true;
    try {
      await this.accountService.downloadExport();
      this.showToast('Your data export has been downloaded', 'success');
    } catch (err: any) {
      this.showToast(err?.message || 'Export failed', 'danger');
    } finally {
      this.isExporting = false;
    }
  }

  /**
   * Two-step, deliberately. The first alert explains what closure does and what
   * survives it; only then do we ask for the password. Following the existing
   * AlertController destructive-confirm pattern rather than introducing a modal,
   * since the app has no ModalController usage anywhere.
   */
  async confirmClose(): Promise<void> {
    const explain = await this.alertCtrl.create({
      header: 'Close your account?',
      message:
        'You will be signed out everywhere and recurring invoices will stop. ' +
        `We delete or anonymise your personal information after ${this.status?.grace_days ?? 30} days. ` +
        'Invoices and payment records are kept for 7 years because tax law requires it. ' +
        'You can reactivate with your password during the grace period.',
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        { text: 'Continue', handler: () => { this.promptForPassword(); } }
      ]
    });
    await explain.present();
  }

  private async promptForPassword(): Promise<void> {
    const alert = await this.alertCtrl.create({
      header: 'Confirm closure',
      message: 'Enter your password and type DELETE to confirm.',
      inputs: [
        { name: 'password', type: 'password', placeholder: 'Your password', attributes: { autocomplete: 'current-password' } },
        { name: 'confirm', type: 'text', placeholder: 'Type DELETE' }
      ],
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Close my account',
          role: 'destructive',
          handler: (data) => {
            if (!data.password) {
              this.showToast('Your password is required', 'warning');
              return false;
            }
            if (data.confirm !== 'DELETE') {
              this.showToast('Type DELETE exactly to confirm', 'warning');
              return false;
            }
            this.closeAccount(data.password);
            return true;
          }
        }
      ]
    });
    await alert.present();
  }

  private closeAccount(password: string): void {
    this.accountService.closeAccount(password).subscribe({
      next: async (result) => {
        // Local-only clear. Calling logout() would POST to /logout, which now
        // 401s because the sessions are already gone, and that 401 would make
        // the error interceptor navigate away before this dialog is dismissed.
        this.authService.clearLocalSession();
        const done = await this.alertCtrl.create({
          header: 'Account closed',
          message:
            `Your personal information will be deleted or anonymised after ${this.formatDate(result.anonymise_due_at)}. ` +
            'We have emailed you a confirmation. You can reactivate with your password until then.',
          buttons: [{ text: 'OK', handler: () => this.router.navigate(['/login']) }],
          backdropDismiss: false
        });
        await done.present();
      },
      error: (err) => {
        this.showToast(err?.error?.message || 'Could not close your account', 'danger');
      }
    });
  }

  private async showToast(message: string, color: string): Promise<void> {
    const toast = await this.toastCtrl.create({ message, duration: 3500, color, position: 'bottom' });
    await toast.present();
  }
}
