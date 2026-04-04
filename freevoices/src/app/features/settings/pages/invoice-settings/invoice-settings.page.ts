import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import { IonicModule, ToastController } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { documentTextOutline } from 'ionicons/icons';
import { forkJoin } from 'rxjs';
import { SettingsService } from '../../services/settings.service';
import { Currency } from '../../../../../models/database.models';

@Component({
  selector: 'app-invoice-settings',
  templateUrl: './invoice-settings.page.html',
  styleUrls: ['./invoice-settings.page.scss'],
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, IonicModule]
})
export class InvoiceSettingsPage implements OnInit {
  form!: FormGroup;
  isLoading = true;
  isSaving = false;
  submitted = false;
  currencies: Currency[] = [];

  constructor(
    private fb: FormBuilder,
    private settingsService: SettingsService,
    private toastCtrl: ToastController
  ) {
    addIcons({ documentTextOutline });
  }

  ngOnInit() {
    this.form = this.fb.group({
      invoice_prefix: ['INV', Validators.required],
      invoice_next_number: [1, [Validators.required, Validators.min(1)]],
      invoice_payment_terms: [30, [Validators.required, Validators.min(0)]],
      invoice_vat_rate: [15, [Validators.required, Validators.min(0), Validators.max(100)]],
      invoice_notes: [''],
      default_currency_id: [1, Validators.required]
    });

    forkJoin({
      settings: this.settingsService.getSettings(),
      currencies: this.settingsService.getCurrencies()
    }).subscribe({
      next: ({ settings, currencies }) => {
        this.currencies = currencies;
        this.form.patchValue({
          invoice_prefix: settings.invoice_prefix || 'INV',
          invoice_next_number: parseInt(settings.invoice_next_number || '1', 10),
          invoice_payment_terms: parseInt(settings.invoice_payment_terms || '30', 10),
          invoice_vat_rate: parseFloat(settings.invoice_vat_rate || '15'),
          invoice_notes: settings.invoice_notes || '',
          default_currency_id: parseInt(settings.default_currency_id || '1', 10)
        });
        this.isLoading = false;
      },
      error: () => {
        this.isLoading = false;
        this.showToast('Failed to load invoice defaults', 'danger');
      }
    });
  }

  isInvalid(field: string): boolean {
    const ctrl = this.form.get(field);
    return !!ctrl && ctrl.invalid && (ctrl.dirty || ctrl.touched || this.submitted);
  }

  onSubmit() {
    this.submitted = true;
    if (this.form.invalid) return;

    this.isSaving = true;
    this.settingsService.updateInvoiceDefaults(this.form.value).subscribe({
      next: () => {
        this.isSaving = false;
        this.submitted = false;
        this.form.markAsPristine();
        this.showToast('Invoice defaults saved', 'success');
      },
      error: (err) => {
        this.isSaving = false;
        this.showToast(err.error?.message || 'Failed to save invoice defaults', 'danger');
      }
    });
  }

  private async showToast(message: string, color: string) {
    const toast = await this.toastCtrl.create({ message, duration: 3000, color, position: 'bottom' });
    await toast.present();
  }
}
