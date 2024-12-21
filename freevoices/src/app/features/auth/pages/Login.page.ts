import { Component } from '@angular/core';
import { FormBuilder, FormGroup, Validators, ReactiveFormsModule } from '@angular/forms';
import { Router, RouterModule } from '@angular/router';
import { IonContent, IonHeader, IonToolbar, IonTitle, IonButton, 
         IonItem, IonLabel, IonInput, IonText, IonCard, 
         IonCardContent } from '@ionic/angular/standalone';
import { AuthService } from '../../../core/auth/services/auth.service';
import { CommonModule } from '@angular/common';
import { DatabaseService } from 'src/services/database.service';

@Component({
    selector: 'app-login',
    templateUrl: './login/login.page.html',
    styleUrls: ['./login/login.page.scss'],
    standalone: true,
    imports: [
      CommonModule,
      ReactiveFormsModule,
      RouterModule,
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

  constructor(private dbService: DatabaseService, private fb: FormBuilder, private authService: AuthService, private router: Router) {
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
        const loginData = await this.dbService.create('auth/login', {
          email: this.loginForm.value.email,
          password: this.loginForm.value.password
        }).toPromise();

        await this.authService.handleLoginSuccess(loginData);
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