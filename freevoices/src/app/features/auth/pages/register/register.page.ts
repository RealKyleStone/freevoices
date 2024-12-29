// src/app/features/auth/pages/register/register.page.ts
import { Component, ElementRef, OnInit, ViewChild, ChangeDetectorRef } from '@angular/core';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonContent, IonHeader, IonToolbar, IonTitle, IonButton, 
         IonItem, IonLabel, IonInput, IonText, IonCard, 
         IonCardContent, IonProgressBar, IonSpinner } from '@ionic/angular/standalone';
import { AuthService } from '../../../../core/auth/services/auth.service';
import { DatabaseService } from '../../../../../services/database.service';
import { CommonModule } from '@angular/common';
import { CaptchaService } from '../../../../core/services/captcha.service';
import { Platform } from '@ionic/angular';
import { catchError, finalize } from 'rxjs/operators';
import { of } from 'rxjs';

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
    IonProgressBar,
    IonSpinner
  ]
})
export class RegisterPage implements OnInit {
  @ViewChild('recaptcha') recaptchaElement?: ElementRef;
  
  registerForm: FormGroup;
  isLoading = false;
  errorMessage = '';
  submitted = false;
  isMobile: boolean;
  captchaInitialized = false;

  constructor(
    private fb: FormBuilder,
    private authService: AuthService,
    private dbService: DatabaseService,
    private router: Router,
    private captchaService: CaptchaService,
    private platform: Platform,
    private cdr: ChangeDetectorRef
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

    this.isMobile = this.platform.is('ios') || this.platform.is('android');
  }

  async ngOnInit() {
    if (!this.isMobile) {
      try {
        await this.captchaService.loadScript();
      } catch (error) {
        console.error('Error loading reCAPTCHA script:', error);
        this.errorMessage = 'Error loading security verification. Please refresh the page.';
        this.cdr.detectChanges();
      }
    }
  }

  async ngAfterViewInit() {
    if (!this.isMobile && this.recaptchaElement) {
      try {
        await this.captchaService.render(this.recaptchaElement.nativeElement);
        this.captchaInitialized = true;
        this.cdr.detectChanges();
      } catch (error) {
        console.error('Error initializing reCAPTCHA:', error);
        this.errorMessage = 'Error initializing security verification. Please refresh the page.';
        this.cdr.detectChanges();
      }
    }
  }

  passwordMatchValidator(g: FormGroup) {
    return g.get('password')?.value === g.get('confirmPassword')?.value
      ? null : { mismatch: true };
  }

  isFieldInvalid(fieldName: string): boolean {
    const field = this.registerForm.get(fieldName);
    return field ? (field.invalid && (field.dirty || field.touched || this.submitted)) : false;
  }

  getFieldError(fieldName: string): string {
    const control = this.registerForm.get(fieldName);
    if (!control) return '';
    
    if (control.hasError('required')) return `${fieldName} is required`;
    if (control.hasError('email')) return 'Invalid email address';
    if (control.hasError('minlength')) return 'Password must be at least 8 characters';
    if (fieldName === 'confirmPassword' && this.registerForm.hasError('mismatch')) 
      return 'Passwords do not match';
    
    return '';
  }

  async validateAndSubmit(event: Event) {
    event.preventDefault();
    this.submitted = true;
    
    if (!this.registerForm.valid) {
      this.registerForm.markAllAsTouched();
      return;
    }

    this.isLoading = true;
    this.errorMessage = '';

    try {
      let captchaToken = '';
      
      if (!this.isMobile && this.captchaInitialized) {
        try {
          captchaToken = await this.captchaService.execute();
        } catch (error) {
          console.error('CAPTCHA execution error:', error);
          this.errorMessage = 'Security verification failed. Please try again.';
          this.isLoading = false;
          return;
        }
      }

      const formData = { ...this.registerForm.value };
      delete formData.confirmPassword;
      formData.captchaToken = captchaToken;

      this.dbService.create('auth/register', formData).pipe(
        catchError(error => {
          console.error('Registration error:', error);
          this.errorMessage = error.error?.message || 'Registration failed. Please try again.';
          
          if (!this.isMobile && this.captchaInitialized) {
            this.captchaService.reset();
          }
          return of(null);
        }),
        finalize(() => {
          this.isLoading = false;
          this.cdr.detectChanges();
        })
      ).subscribe(async response => {
        if (response) {
          await this.authService.handleLoginSuccess(response);
          this.router.navigate(['/dashboard']);
        }
      });
    } catch (error) {
      console.error('Validation error:', error);
      this.errorMessage = 'An error occurred. Please try again.';
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }
}