import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup } from '@angular/forms';
import { IonicModule, ToastController } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { notificationsOutline, mailOutline } from 'ionicons/icons';
import { SettingsService } from '../../services/settings.service';

@Component({
  selector: 'app-notification-settings',
  templateUrl: './notification-settings.page.html',
  styleUrls: ['./notification-settings.page.scss'],
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, IonicModule]
})
export class NotificationSettingsPage implements OnInit {
  form!: FormGroup;
  isLoading = true;
  isSaving = false;

  constructor(
    private fb: FormBuilder,
    private settingsService: SettingsService,
    private toastCtrl: ToastController
  ) {
    addIcons({ notificationsOutline, mailOutline });
  }

  ngOnInit() {
    this.form = this.fb.group({
      notify_invoice_sent: [true],
      notify_payment_received: [true],
      notify_invoice_overdue: [true]
    });

    this.settingsService.getSettings().subscribe({
      next: (data) => {
        this.form.patchValue({
          notify_invoice_sent: data.notify_invoice_sent !== '0',
          notify_payment_received: data.notify_payment_received !== '0',
          notify_invoice_overdue: data.notify_invoice_overdue !== '0'
        });
        this.isLoading = false;
      },
      error: () => {
        this.isLoading = false;
        this.showToast('Failed to load notification preferences', 'danger');
      }
    });
  }

  onSubmit() {
    this.isSaving = true;
    this.settingsService.updateNotifications(this.form.value).subscribe({
      next: () => {
        this.isSaving = false;
        this.form.markAsPristine();
        this.showToast('Notification preferences saved', 'success');
      },
      error: (err) => {
        this.isSaving = false;
        this.showToast(err.error?.message || 'Failed to save preferences', 'danger');
      }
    });
  }

  private async showToast(message: string, color: string) {
    const toast = await this.toastCtrl.create({ message, duration: 3000, color, position: 'bottom' });
    await toast.present();
  }
}
