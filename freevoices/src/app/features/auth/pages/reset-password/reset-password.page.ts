import { Component, OnInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule, AbstractControl, ValidationErrors } from '@angular/forms';
import { ActivatedRoute, Router, RouterModule } from '@angular/router';
import { CommonModule } from '@angular/common';
import { IonContent, IonCard, IonCardContent, IonItem, IonLabel, IonInput,
         IonButton, IonText, IonSpinner } from '@ionic/angular/standalone';
import { ApiService } from '../../../../core/services/api.service';
import { catchError, finalize } from 'rxjs/operators';
import { of } from 'rxjs';

function passwordsMatch(group: AbstractControl): ValidationErrors | null {
  const password = group.get('password')?.value;
  const confirm = group.get('confirmPassword')?.value;
  return password === confirm ? null : { mismatch: true };
}

@Component({
  selector: 'app-reset-password',
  templateUrl: './reset-password.page.html',
  styleUrls: ['./reset-password.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    RouterModule,
    IonContent,
    IonCard,
    IonCardContent,
    IonItem,
    IonLabel,
    IonInput,
    IonButton,
    IonText,
    IonSpinner
  ]
})
export class ResetPasswordPage implements OnInit {
  form: FormGroup;
  isLoading = false;
  errorMessage = '';
  token = '';
  done = false;

  constructor(
    private fb: FormBuilder,
    private api: ApiService,
    private route: ActivatedRoute,
    private router: Router
  ) {
    this.form = this.fb.group({
      password: ['', [Validators.required, Validators.minLength(8)]],
      confirmPassword: ['', Validators.required]
    }, { validators: passwordsMatch });
  }

  ngOnInit() {
    this.token = this.route.snapshot.queryParamMap.get('token') ?? '';
    if (!this.token) {
      this.errorMessage = 'Missing or invalid reset token. Please request a new link.';
    }
  }

  isFieldInvalid(field: string): boolean {
    const control = this.form.get(field);
    return control ? control.invalid && (control.dirty || control.touched) : false;
  }

  get mismatch(): boolean {
    return !!(this.form.errors?.['mismatch'] && this.form.get('confirmPassword')?.touched);
  }

  submit() {
    if (this.form.invalid || !this.token) {
      this.form.markAllAsTouched();
      return;
    }

    this.isLoading = true;
    this.errorMessage = '';

    this.api.post<{ message: string }>('/api/auth/reset-password', {
      token: this.token,
      password: this.form.value.password
    }).pipe(
      catchError(err => {
        this.errorMessage = err.error?.message || 'Failed to reset password. The link may have expired.';
        return of(null);
      }),
      finalize(() => { this.isLoading = false; })
    ).subscribe(res => {
      if (res) {
        this.done = true;
        setTimeout(() => this.router.navigate(['/auth/login']), 3000);
      }
    });
  }
}
