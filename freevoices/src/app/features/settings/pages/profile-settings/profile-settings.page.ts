import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ReactiveFormsModule, FormBuilder, FormGroup, Validators } from '@angular/forms';
import {
  ToastController, IonButton, IonCard, IonCardContent, IonCardHeader, IonCardTitle, IonIcon,
  IonInput, IonItem, IonLabel, IonSpinner,
} from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { personOutline, lockClosedOutline, eyeOutline, eyeOffOutline } from 'ionicons/icons';
import { SettingsService } from '../../services/settings.service';

@Component({
  selector: 'app-profile-settings',
  templateUrl: './profile-settings.page.html',
  styleUrls: ['./profile-settings.page.scss'],
  standalone: true,
  imports: [
    CommonModule, ReactiveFormsModule, IonButton, IonCard, IonCardContent, IonCardHeader,
    IonCardTitle, IonIcon, IonInput, IonItem, IonLabel, IonSpinner,
  ]
})
export class ProfileSettingsPage implements OnInit {
  form!: FormGroup;
  originalEmail = '';
  pendingEmail: string | null = null;
  isLoading = true;
  isSaving = false;
  submitted = false;
  showCurrentPassword = false;
  showNewPassword = false;

  constructor(
    private fb: FormBuilder,
    private settingsService: SettingsService,
    private toastCtrl: ToastController
  ) {
    addIcons({ personOutline, lockClosedOutline, eyeOutline, eyeOffOutline });
  }

  ngOnInit() {
    this.form = this.fb.group({
      contact_person: ['', Validators.required],
      email: ['', [Validators.required, Validators.email]],
      phone: [''],
      current_password: [''],
      new_password: ['', Validators.minLength(8)],
      confirm_password: ['']
    }, { validators: this.passwordMatchValidator });

    this.settingsService.getSettings().subscribe({
      next: (data) => {
        this.originalEmail = data.email;
        this.pendingEmail = data.pending_email || null;
        this.form.patchValue({
          contact_person: data.contact_person || '',
          email: data.email || '',
          phone: data.phone || ''
        });
        this.isLoading = false;
      },
      error: () => {
        this.isLoading = false;
        this.showToast('Failed to load profile', 'danger');
      }
    });
  }

  passwordMatchValidator(group: FormGroup) {
    const np = group.get('new_password')?.value;
    const cp = group.get('confirm_password')?.value;
    if (np && np !== cp) {
      group.get('confirm_password')?.setErrors({ mismatch: true });
      return { mismatch: true };
    }
    group.get('confirm_password')?.setErrors(null);
    return null;
  }

  isInvalid(field: string): boolean {
    const ctrl = this.form.get(field);
    return !!ctrl && ctrl.invalid && (ctrl.dirty || ctrl.touched || this.submitted);
  }

  onSubmit() {
    this.submitted = true;
    if (this.form.invalid) {
      // Saving used to do nothing visible here: the page stayed put with no
      // message, which read as a silent failure.
      this.form.markAllAsTouched();
      this.showToast('Please correct the highlighted fields', 'warning');
      return;
    }

    const { contact_person, email, phone, current_password, new_password } = this.form.value;

    const payload: any = { contact_person, email, phone };
    if (email.toLowerCase() !== this.originalEmail.toLowerCase() && !current_password) {
      this.showToast('Enter your current password to change your email', 'warning'); return;
    }
    if (new_password || email.toLowerCase() !== this.originalEmail.toLowerCase()) {
      payload.current_password = current_password;
      if (new_password) payload.new_password = new_password;
    }

    this.isSaving = true;
    this.settingsService.updateProfile(payload).subscribe({
      next: (response) => {
        if (response.pending_email) { this.pendingEmail = response.pending_email; this.form.patchValue({ email: this.originalEmail }); }
        this.isSaving = false;
        this.submitted = false;
        this.form.patchValue({ current_password: '', new_password: '', confirm_password: '' });
        this.form.markAsPristine();
        this.showToast(response.message, response.emailFailed ? 'warning' : 'success');
      },
      error: (err) => {
        this.isSaving = false;
        this.showToast(err.error?.message || 'Failed to update profile', 'danger');
      }
    });
  }

  private async showToast(message: string, color: string) {
    const toast = await this.toastCtrl.create({ message, duration: 3000, color, position: 'bottom' });
    await toast.present();
  }
}
