import { Component, ElementRef, OnInit, ViewChild, ChangeDetectorRef, AfterViewInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonContent, IonHeader, IonToolbar, IonTitle, IonButton, 
         IonItem, IonLabel, IonInput, IonText, IonCard, 
         IonCardContent, IonSpinner } from '@ionic/angular/standalone';
import { AuthService } from '../../../core/auth/services/auth.service';
import { CommonModule } from '@angular/common';
import { CaptchaService } from '../../../core/services/captcha.service';
import { Platform } from '@ionic/angular';
import { catchError, finalize } from 'rxjs/operators';
import { of } from 'rxjs';

@Component({
    selector: 'app-login',
    templateUrl: './login/login.page.html',
    styleUrls: ['./login/login.page.scss'],
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
      IonSpinner
    ]
})
export class LoginPage implements OnInit, AfterViewInit {
  @ViewChild('recaptcha') recaptchaElement?: ElementRef;
  
  loginForm: FormGroup;
  isLoading = false;
  errorMessage = '';
  isMobile: boolean;
  captchaInitialized = false;
  
  constructor(
    private fb: FormBuilder, 
    private authService: AuthService, 
    private router: Router,
    private captchaService: CaptchaService,
    private platform: Platform,
    private cdr: ChangeDetectorRef
  ) {
    this.loginForm = this.fb.group({
      email: ['', [Validators.required, Validators.email]],
      password: ['', [Validators.required]]
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

  isFieldInvalid(fieldName: string): boolean {
    const field = this.loginForm.get(fieldName);
    return field ? field.invalid && (field.dirty || field.touched) : false;
  }

  getFieldError(fieldName: string): string {
    const control = this.loginForm.get(fieldName);
    if (control?.errors) {
      if (control.errors['required']) return `${fieldName} is required`;
      if (control.errors['email']) return 'Invalid email format';
    }
    return '';
  }

  async validateAndSubmit(event: Event) {
    event.preventDefault();
    
    if (!this.loginForm.valid) {
      this.loginForm.markAllAsTouched();
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

      this.authService.login(
        this.loginForm.value.email,
        this.loginForm.value.password,
        captchaToken
      ).pipe(
        catchError(error => {
          console.error('Login error:', error);
          this.errorMessage = error.error?.message || 'Login failed. Please try again.';
          
          if (!this.isMobile && this.captchaInitialized) {
            this.captchaService.reset();
          }
          return of(null);
        }),
        finalize(() => {
          this.isLoading = false;
          this.cdr.detectChanges();
        })
      ).subscribe(response => {
        if (response) {
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