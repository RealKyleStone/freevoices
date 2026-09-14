import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup } from '@angular/forms';
import { IonicModule, ToastController } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { cardOutline, lockClosedOutline } from 'ionicons/icons';
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
  payfastForm!: FormGroup;
  isLoading = true;
  isSaving = false;
  isSavingPayfast = false;

  // What the server says it holds. The secrets themselves never reach the
  // browser, so these drive a masked placeholder instead of a value.
  payfastKeySet = false;
  payfastPassphraseSet = false;

  accountTypes = ['Cheque', 'Savings', 'Current', 'Transmission'];

  constructor(
    private fb: FormBuilder,
    private settingsService: SettingsService,
    private toastCtrl: ToastController
  ) {
    addIcons({ cardOutline, lockClosedOutline });
  }

  ngOnInit() {
    this.form = this.fb.group({
      bank_name: [''],
      bank_account_number: [''],
      bank_branch_code: [''],
      bank_account_type: ['Cheque']
    });

    this.payfastForm = this.fb.group({
      payfast_enabled: [false],
      payfast_merchant_id: [''],
      payfast_merchant_key: [''],
      payfast_passphrase: ['']
    });

    this.settingsService.getSettings().subscribe({
      next: (data) => {
        this.form.patchValue({
          bank_name: data.bank_name || '',
          bank_account_number: data.bank_account_number || '',
          bank_branch_code: data.bank_branch_code || '',
          bank_account_type: data.bank_account_type || 'Cheque'
        });
        this.payfastForm.patchValue({
          payfast_enabled: !!data.payfast_enabled,
          payfast_merchant_id: data.payfast_merchant_id || ''
        });
        this.payfastKeySet = !!data.payfast_merchant_key_set;
        this.payfastPassphraseSet = !!data.payfast_passphrase_set;
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

  /**
   * Save PayFast credentials.
   *
   * A secret field is sent ONLY when the user actually typed in it. The server
   * reads an omitted field as "leave unchanged" and an empty string as "clear",
   * so blindly sending the whole form would wipe the stored key and passphrase
   * every time someone toggled the switch.
   */
  onSubmitPayfast() {
    const value = this.payfastForm.value;
    const payload: {
      payfast_enabled: boolean;
      payfast_merchant_id: string;
      payfast_merchant_key?: string;
      payfast_passphrase?: string;
    } = {
      payfast_enabled: !!value.payfast_enabled,
      payfast_merchant_id: (value.payfast_merchant_id || '').trim()
    };
    if (this.payfastForm.get('payfast_merchant_key')?.dirty) {
      payload.payfast_merchant_key = (value.payfast_merchant_key || '').trim();
    }
    if (this.payfastForm.get('payfast_passphrase')?.dirty) {
      payload.payfast_passphrase = (value.payfast_passphrase || '').trim();
    }

    this.isSavingPayfast = true;
    this.settingsService.updatePayfast(payload).subscribe({
      next: (res) => {
        this.isSavingPayfast = false;
        this.payfastKeySet = res.payfast_merchant_key_set;
        this.payfastPassphraseSet = res.payfast_passphrase_set;
        // Never leave a secret sitting in the DOM after it has been stored.
        this.payfastForm.patchValue({ payfast_merchant_key: '', payfast_passphrase: '' });
        this.payfastForm.markAsPristine();
        this.showToast(res.message, 'success');
      },
      error: (err) => {
        this.isSavingPayfast = false;
        this.showToast(err.error?.message || 'Failed to save PayFast settings', 'danger');
      }
    });
  }

  private async showToast(message: string, color: string) {
    const toast = await this.toastCtrl.create({ message, duration: 3000, color, position: 'bottom' });
    await toast.present();
  }
}
