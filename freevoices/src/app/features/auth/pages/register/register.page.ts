// src/app/features/auth/pages/register/register.page.ts
import { Component } from '@angular/core';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonContent, IonHeader, IonToolbar, IonTitle, IonButton, 
         IonItem, IonLabel, IonInput, IonText, IonCard, 
         IonCardContent, IonProgressBar } from '@ionic/angular/standalone';
import { AuthService } from '../../../../core/auth/services/auth.service';
import { DatabaseService } from '../../../../../services/database.service';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-register',
  templateUrl: './register.page.html',
  styleUrls: ['./register.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    ReactiveFormsModule,
    IonContent,
    IonHeader,
    IonToolbar,
    IonTitle,
    IonButton,
    IonItem,
    IonLabel,
    IonInput,
    IonText,
    IonCard,
    IonCardContent,
    IonProgressBar
  ]
})
export class RegisterPage {
  registerForm: FormGroup;
  isLoading = false;
  errorMessage = '';
  submitted = false;

  constructor(
    private fb: FormBuilder,
    private authService: AuthService,
    private dbService: DatabaseService,
    private router: Router
  ) {
    this.registerForm = this.fb.group({
      email: ['', [Validators.required, Validators.email]],
      password: ['', [Validators.required, Validators.minLength(8)]],
      confirmPassword: ['', [Validators.required]],
      company_name: ['', [Validators.required]],
      company_registration: [''],
      vat_number: [''],
      contact_person: ['', [Validators.required]],
      phone: ['', [Validators.required]],
      address: ['', [Validators.required]],
      bank_name: [''],
      bank_account_number: [''],
      bank_branch_code: [''],
      bank_account_type: ['']
    }, {
      validators: this.passwordMatchValidator
    });
  }

  passwordMatchValidator(g: FormGroup) {
    return g.get('password')?.value === g.get('confirmPassword')?.value
      ? null : { mismatch: true };
  }

  isFieldInvalid(fieldName: string): boolean {
    const field = this.registerForm.get(fieldName);
    return field ? (field.invalid && (field.dirty || field.touched || this.submitted)) : false;
  }

  getErrorMessage(fieldName: string): string {
    const control = this.registerForm.get(fieldName);
    if (!control) return '';
    
    if (control.hasError('required')) return `${fieldName} is required`;
    if (control.hasError('email')) return 'Invalid email address';
    if (control.hasError('minlength')) return 'Password must be at least 8 characters';
    if (fieldName === 'confirmPassword' && this.registerForm.hasError('mismatch')) 
      return 'Passwords do not match';
    
    return '';
  }

  async onSubmit() {
    this.submitted = true;
    if (this.registerForm.valid) {
      this.isLoading = true;
      this.errorMessage = '';

      try {
        const formData = { ...this.registerForm.value };
        delete formData.confirmPassword;

        const response = await this.dbService.create('auth/register', formData).toPromise();
        await this.authService.handleLoginSuccess(response);
        
        this.router.navigate(['/dashboard']);
      } catch (error: any) {
        this.errorMessage = error.error?.message || 'Registration failed. Please try again.';
      } finally {
        this.isLoading = false;
      }
    }
  }
}