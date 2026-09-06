import { Component, OnInit, ChangeDetectorRef } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule, AbstractControl } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { IonContent, IonButton, IonInput, IonSpinner } from '@ionic/angular/standalone';
import { catchError, finalize } from 'rxjs/operators';
import { of } from 'rxjs';
import { AuthService } from '../../../../core/auth/services/auth.service';

/**
 * Second half of a Google sign-up.
 *
 * Google gives us a verified email and a display name, but an invoice needs a
 * company name, a contact number and an address — so the account is not created
 * until those exist. Nothing has been written to the database by the time this
 * page loads; the Google ID token is carried here in router state and posted
 * back with the details as a single create call.
 *
 * Router state rather than storage on purpose: the token is short-lived and
 * there is no reason to persist a credential across reloads. A refresh loses it
 * and sends the user back to /login, which is the correct outcome.
 */
@Component({
  selector: 'app-google-complete',
  templateUrl: './google-complete.page.html',
  styleUrls: ['./google-complete.page.scss'],
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, RouterLink, IonContent, IonButton, IonInput, IonSpinner],
})
export class GoogleCompletePage implements OnInit {
  form: FormGroup;
  isLoading = false;
  submitted = false;
  errorMessage = '';
  email = '';

  private idToken = '';

  constructor(
    private fb: FormBuilder,
    private authService: AuthService,
    private router: Router,
    private cdr: ChangeDetectorRef
  ) {
    const state = this.router.getCurrentNavigation()?.extras?.state as
      | { idToken?: string; email?: string; name?: string }
      | undefined;

    this.idToken = state?.idToken ?? '';
    this.email = state?.email ?? '';

    this.form = this.fb.group({
      company_name: ['', [Validators.required, Validators.minLength(2)]],
      company_registration: [''],
      vat_number: [''],
      // Google's display name is a sensible default for the contact person,
      // and it is the one field here they can usually accept as-is.
      contact_person: [state?.name ?? '', [Validators.required, Validators.minLength(2)]],
      phone: ['', [Validators.required, this.phoneNumberValidator()]],
      address: ['', Validators.required],
    });
  }

  ngOnInit() {
    // Reached directly, or refreshed. There is no token to register with, so
    // there is nothing this page can do.
    if (!this.idToken) {
      this.router.navigate(['/login'], {
        state: { message: 'Your Google sign-in expired. Please try again.' },
      });
    }
  }

  phoneNumberValidator() {
    return (control: AbstractControl): { [key: string]: any } | null => {
      const stripped = typeof control.value === 'string' ? control.value.replace(/[\s-]/g, '') : control.value;
      return /^\+?[1-9]\d{1,14}$/.test(stripped) ? null : { invalidPhone: { value: control.value } };
    };
  }

  isFieldInvalid(field: string): boolean {
    const control = this.form.get(field);
    return control ? control.invalid && (control.dirty || control.touched || this.submitted) : false;
  }

  getFieldError(field: string): string {
    const control = this.form.get(field);
    if (!control?.errors) return '';
    if (control.errors['required']) return 'This field is required';
    if (control.errors['minlength']) return 'That looks too short';
    if (control.errors['invalidPhone']) return 'Enter your number in international format, e.g. +27821234567';
    return 'Invalid value';
  }

  onSubmit(event: Event) {
    event.preventDefault();
    this.submitted = true;
    if (this.form.invalid) { this.form.markAllAsTouched(); return; }

    this.isLoading = true;
    this.errorMessage = '';

    const details = { ...this.form.value };
    details.phone = String(details.phone).replace(/[\s-]/g, '');

    this.authService.registerWithGoogle(this.idToken, details)
      .pipe(
        catchError(error => {
          this.errorMessage = error.error?.message || 'We could not finish creating your account. Please try again.';
          return of(null);
        }),
        finalize(() => { this.isLoading = false; this.cdr.detectChanges(); })
      )
      .subscribe(response => {
        if (response) this.router.navigate(['/dashboard']);
      });
  }
}
