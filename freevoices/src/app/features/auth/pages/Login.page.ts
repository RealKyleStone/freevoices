import { Component } from '@angular/core';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { IonContent, IonHeader, IonToolbar, IonTitle, IonButton, 
         IonItem, IonLabel, IonInput, IonText, IonCard, 
         IonCardContent } from '@ionic/angular/standalone';
import { AuthService } from '../../../core/auth/services/auth.service';
import { CommonModule } from '@angular/common';

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
      IonCardContent
    ]
  })
  export class LoginPage {
    loginForm: FormGroup;
  isLoading = false;
  errorMessage = '';

  constructor(private fb: FormBuilder, private authService: AuthService, private router: Router) {
    this.loginForm = this.fb.group({
      email: ['', [Validators.required, Validators.email]],
      password: ['', [Validators.required]]
    });
  }

  isFieldInvalid(fieldName: string): boolean {
    const field = this.loginForm.get(fieldName);
    return field ? field.invalid && (field.dirty || field.touched) : false;
  }

  async onSubmit() {
    if (this.loginForm.valid) {
      this.isLoading = true;
      this.errorMessage = '';

      try {
        await this.authService.login(
          this.loginForm.value.email,
          this.loginForm.value.password
        ).toPromise();
        
        this.router.navigate(['/dashboard']);
      } catch (error: any) {
        this.errorMessage = error.error?.message || 'Login failed. Please try again.';
      } finally {
        this.isLoading = false;
      }
    } else {
      this.loginForm.markAllAsTouched();
    }
  }
}