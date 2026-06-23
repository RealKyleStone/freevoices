import { Injectable } from '@angular/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { Capacitor } from '@capacitor/core';
import { ApiService } from './api.service';

@Injectable({
  providedIn: 'root'
})
export class PushNotificationService {

  constructor(private api: ApiService) {}

  // Entry point — call this once when the app starts
  async initPush(): Promise<void> {
    // Push notifications only work on a real native device (Android/iOS)
    // not in a browser, so we check first before doing anything
    if (!Capacitor.isNativePlatform()) {
      console.log('Push notifications not available on web — skipping');
      return;
    }

    await this.addListeners();
    await this.registerNotifications();
  }

  // Set up all the event listeners BEFORE requesting permission
  private async addListeners(): Promise<void> {

    // Fires when the device successfully registers with FCM and gets a token
    await PushNotifications.addListener('registration', token => {
      console.log('FCM device token:', token.value);
      this.saveToken(token.value);
    });

    // Fires if registration with FCM fails for any reason
    await PushNotifications.addListener('registrationError', error => {
      console.error('Push registration error:', error);
    });

    // Fires when a push notification arrives while the app is OPEN (foreground)
    await PushNotifications.addListener('pushNotificationReceived', notification => {
      console.log('Notification received in foreground:', notification);
      // The notification is received but NOT shown automatically in foreground
      // You can show an Ionic toast or alert here if you want
    });

    // Fires when the user TAPS a notification (app was in background or closed)
    await PushNotifications.addListener('pushNotificationActionPerformed', action => {
      console.log('Notification tapped:', action.notification);
      // You can navigate to a specific page here based on the notification data
    });
  }

  // Ask the user for permission, then trigger FCM registration
  private async registerNotifications(): Promise<void> {
    // Check current permission status first
    let permStatus = await PushNotifications.checkPermissions();

    // If not granted yet, prompt the user
    if (permStatus.receive === 'prompt') {
      permStatus = await PushNotifications.requestPermissions();
    }

    // If user denied, we can't proceed
    if (permStatus.receive !== 'granted') {
      console.warn('Push notification permission denied by user');
      return;
    }

    // Permission granted — register with FCM
    // This triggers the 'registration' listener above which gives us the token
    await PushNotifications.register();
  }

  // Send the FCM device token to our backend so it knows which device to notify
  private saveToken(token: string): void {
    this.api.post('/users/device-token', { token }).subscribe({
      next: () => console.log('Device token saved to backend successfully'),
      error: (err) => console.error('Failed to save device token:', err)
    });
  }
}
