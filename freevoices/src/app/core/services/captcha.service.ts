import { Injectable } from '@angular/core';
import { environment } from '../../../environments/environment';
import { Subject } from 'rxjs';

declare global {
  interface Window {
    grecaptcha: any;
    onCaptchaLoad?: () => void;
  }
}

@Injectable({
  providedIn: 'root'
})
export class CaptchaService {
  private loaded = false;
  private widgetId: number | null = null;
  private tokenSubject = new Subject<string>();
  public token$ = this.tokenSubject.asObservable();

  public loadScript(): Promise<void> {
    return new Promise((resolve) => {
      if (window.grecaptcha) {
        this.loaded = true;
        resolve();
        return;
      }

      window.onCaptchaLoad = () => {
        this.loaded = true;
        resolve();
      };

      const script = document.createElement('script');
      script.src = `https://www.google.com/recaptcha/api.js?onload=onCaptchaLoad&render=explicit`;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    });
  }

  public render(element: HTMLElement): Promise<number> {
    return new Promise((resolve) => {
      if (!this.loaded) {
        throw new Error('reCAPTCHA has not been loaded');
      }

      this.widgetId = window.grecaptcha.render(element, {
        sitekey: environment.recaptchaSiteKey,
        size: 'invisible',
        badge: 'bottomright',
        callback: (token: string) => {
          console.log('Received token:', token);
          this.tokenSubject.next(token);
        }
      });

      if (this.widgetId !== null) {
        resolve(this.widgetId);
      } else {
        throw new Error('Failed to render reCAPTCHA');
      }
    });
  }

  public execute(): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.loaded || this.widgetId === null) {
        reject(new Error('reCAPTCHA has not been properly initialized'));
        return;
      }

      const token$ = this.token$.subscribe(token => {
        token$.unsubscribe();
        resolve(token);
      });

      window.grecaptcha.execute(this.widgetId);
    });
  }

  public reset(): void {
    if (this.widgetId !== null) {
      window.grecaptcha.reset(this.widgetId);
    }
  }

  public getResponse(): string | null {
    if (this.widgetId !== null) {
      return window.grecaptcha.getResponse(this.widgetId);
    }
    return null;
  }
}