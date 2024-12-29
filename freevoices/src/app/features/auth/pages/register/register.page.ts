// src/app/features/auth/pages/register/register.page.ts
import { Component, ElementRef, OnInit, ViewChild, ChangeDetectorRef } from '@angular/core';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule, AbstractControl } from '@angular/forms';
import { Router } from '@angular/router';
import { IonContent, IonHeader, IonToolbar, IonTitle, IonButton, 
         IonItem, IonLabel, IonInput, IonText, IonCard, 
         IonCardContent, IonProgressBar, IonSpinner, IonSelect, IonSelectOption } from '@ionic/angular/standalone';
import { AuthService } from '../../../../core/auth/services/auth.service';
import { DatabaseService } from '../../../../../services/database.service';
import { CommonModule } from '@angular/common';
import { CaptchaService } from '../../../../core/services/captcha.service';
import { Platform } from '@ionic/angular';
import { catchError, finalize } from 'rxjs/operators';
import { of } from 'rxjs';

interface Bank {
  id: number;
  name: string;
  swift_code: string;
  universal_branch_code: string;
}

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
    IonSpinner,
    IonSelect,
    IonSelectOption
  ]
})

export class RegisterPage implements OnInit {
  @ViewChild('recaptcha') recaptchaElement?: ElementRef;
  
  banks: Bank[] = [];
  accountTypes = [
    { value: 'current', label: 'Current Account' },
    { value: 'savings', label: 'Savings Account' },
    { value: 'cheque', label: 'Cheque Account' },
    { value: 'business', label: 'Business Account' },
    { value: 'transmission', label: 'Transmission Account' }
  ];
  
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
      password: ['', [
        Validators.required, 
        Validators.minLength(8),
        Validators.pattern(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/)
      ]],
      confirmPassword: ['', Validators.required],
      company_name: ['', [Validators.required, Validators.minLength(2)]],
      company_registration: [''],
      vat_number: [''],
      contact_person: ['', [Validators.required, Validators.minLength(2)]],
      phone: ['', [Validators.required, this.phoneNumberValidator()]],
      address: ['', Validators.required],
      bank_name: [''],
      bank_account_number: ['', [this.bankAccountValidator()]],
      bank_branch_code: [''],
      bank_account_type: ['']
    }, { validators: this.passwordMatchValidator });

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
    this.loadBanks();
  }

  private loadBanks() {
    this.dbService.query<Bank[]>('banks', { params: { active: true } })
      .pipe(
        catchError(error => {
          console.error('Failed to load banks:', error);
          this.errorMessage = 'Failed to load bank information. Please try again.';
          return of([]);
        })
      )
      .subscribe(banks => {
        this.banks = banks;
        this.cdr.detectChanges();
      });
  }

  phoneNumberValidator() {
    return (control: AbstractControl): { [key: string]: any } | null => {
      const valid = /^\+?[1-9]\d{1,14}$/.test(control.value);
      return valid ? null : { 'invalidPhone': { value: control.value } };
    };
  }

  bankAccountValidator() {
    return (control: AbstractControl): {[key: string]: any} | null => {
      if (!control.value) return null;
      const valid = /^\d{9,12}$/.test(control.value);
      return valid ? null : {'invalidAccount': {value: control.value}};
    };
  }

  passwordMatchValidator(g: FormGroup) {
    const password = g.get('password');
    const confirmPassword = g.get('confirmPassword');
    if (!password || !confirmPassword) return null;
    return password.value === confirmPassword.value ? null : { 'mismatch': true };
  }

  getPasswordErrorMessage(): string {
    const control = this.registerForm.get('password');
    if (!control?.errors) return '';
    
    if (control.errors['required']) return 'Password is required';
    if (control.errors['minlength']) return 'Password must be at least 8 characters';
    if (control.errors['pattern']) 
      return 'Password must contain uppercase, lowercase, number and special character';
    return '';
  }

  onBankSelect(event: any) {
    const bank = this.banks.find(b => b.id === event.detail.value);
    if (bank) {
      this.registerForm.patchValue({
        bank_branch_code: bank.universal_branch_code
      });
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