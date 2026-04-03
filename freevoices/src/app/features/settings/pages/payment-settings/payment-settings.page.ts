import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup } from '@angular/forms';
import { IonicModule, ToastController } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { cardOutline } from 'ionicons/icons';
import { SettingsService } from '../../services/settings.service';

@Component({
  selector: 'app-payment-settings',
  templateUrl: './payment-settings.page.html',
  styleUrls: ['./payment-settings.page.scss'],
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, IonicModule]
})
export class PaymentSettingsPage implements OnInit {
  form!: FormGroup;
  isLoading = true;
  isSaving = false;

  accountTypes = ['Cheque', 'Savings', 'Current', 'Transmission'];

  constructor(
    private fb: FormBuilder,
    private settingsService: SettingsService,
    private toastCtrl: ToastController
  ) {
    addIcons({ cardOutline });
  }

  ngOnInit() {
    this.form = this.fb.group({
      bank_name: [''],
      bank_account_number: [''],
      bank_branch_code: [''],
      bank_account_type: ['Cheque']
    });

    this.settingsService.getSettings().subscribe({
      next: (data) => {
        this.form.patchValue({
          bank_name: data.bank_name || '',
          bank_account_number: data.bank_account_number || '',
          bank_branch_code: data.bank_branch_code || '',
          bank_account_type: data.bank_account_type || 'Cheque'
        });
        this.isLoading = false;
      },
      error: () => {
        this.isLoading = false;
        this.showToast('Failed to load payment details', 'danger');
      }
    });
  }

  onSubmit() {
    this.isSaving = true;
    this.settingsService.updatePayment(this.form.value).subscribe({
      next: () => {
        this.isSaving = false;
        this.form.markAsPristine();
        this.showToast('Payment details saved', 'success');
      },
      error: (err) => {
        this.isSaving = false;
        this.showToast(err.error?.message || 'Failed to save payment details', 'danger');
      }
    });
  }

  private async showToast(message: string, color: string) {
    const toast = await this.toastCtrl.create({ message, duration: 3000, color, position: 'bottom' });
    await toast.present();
  }
}
