import { Component, ElementRef, OnInit, ViewChild, ChangeDetectorRef, AfterViewInit } from '@angular/core';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { IonContent, IonButton, IonInput, IonSpinner, IonIcon } from '@ionic/angular/standalone';
import { AuthService } from '../../../core/auth/services/auth.service';
import { CommonModule } from '@angular/common';
import { CaptchaService } from '../../../core/services/captcha.service';
import { Platform } from '@ionic/angular';
import { environment } from '../../../../environments/environment';
import { catchError, finalize } from 'rxjs/operators';
import { of } from 'rxjs';
import { addIcons } from 'ionicons';
import { documentTextOutline, sunnyOutline, moonOutline } from 'ionicons/icons';

@Component({
  selector: 'app-login',
  templateUrl: './login/Login.page.html',
  styleUrls: ['./login/Login.page.scss'],
  standalone: true,
  imports: [CommonModule, ReactiveFormsModule, RouterLink, IonContent, IonButton, IonInput, IonSpinner, IonIcon]
})
export class LoginPage implements OnInit, AfterViewInit {
  @ViewChild('recaptcha') recaptchaElement?: ElementRef;

  loginForm: FormGroup;
  isLoading = false;
  errorMessage = '';
  isMobile: boolean;
  captchaInitialized = false;
  isDarkMode = false;

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
    addIcons({ documentTextOutline, sunnyOutline, moonOutline });

    const saved = localStorage.getItem('fv-theme');
    if (saved) {
      this.isDarkMode = saved === 'dark';
    } else {
      // Default to dark mode on login page always
      this.isDarkMode = true;
    }
    this.applyTheme();
  }

  applyTheme() {
    const toggle = this.isDarkMode;
    document.body.classList.toggle('ion-palette-dark', toggle);
    document.documentElement.classList.toggle('ion-palette-dark', toggle);
    const ionApp = document.querySelector('ion-app');
    if (ionApp) ionApp.classList.toggle('ion-palette-dark', toggle);
  }

  toggleTheme() {
    this.isDarkMode = !this.isDarkMode;
    localStorage.setItem('fv-theme', this.isDarkMode ? 'dark' : 'light');
    this.applyTheme();
  }

  async ngOnInit() {
    if (!this.isMobile && !environment.bypassCaptcha) {
      try { await this.captchaService.loadScript(); }
      catch (error) {
        this.errorMessage = 'Error loading security verification. Please refresh the page.';
        this.cdr.detectChanges();
      }
    }
  }

  async ngAfterViewInit() {
    if (!this.isMobile && !environment.bypassCaptcha && this.recaptchaElement) {
      try {
        await this.captchaService.render(this.recaptchaElement.nativeElement);
        this.captchaInitialized = true;
        this.cdr.detectChanges();
      } catch (error) {
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
    if (!this.loginForm.valid) { this.loginForm.markAllAsTouched(); return; }
    this.isLoading = true;
    this.errorMessage = '';
    try {
      let captchaToken = '';
      if (!this.isMobile && !environment.bypassCaptcha && this.captchaInitialized) {
        try { captchaToken = await this.captchaService.execute(); }
        catch (error) {
          this.errorMessage = 'Security verification failed. Please try again.';
          this.isLoading = false;
          return;
        }
      }
      this.authService.login(this.loginForm.value.email, this.loginForm.value.password, captchaToken)
        .pipe(
          catchError(error => {
            this.errorMessage = error.error?.message || 'Login failed. Please try again.';
            if (!this.isMobile && !environment.bypassCaptcha && this.captchaInitialized) this.captchaService.reset();
            return of(null);
          }),
          finalize(() => { this.isLoading = false; this.cdr.detectChanges(); })
        ).subscribe(response => {
          if (response) this.router.navigate(['/dashboard']);
        });
    } catch (error) {
      this.errorMessage = 'An error occurred. Please try again.';
      this.isLoading = false;
      this.cdr.detectChanges();
    }
  }
}