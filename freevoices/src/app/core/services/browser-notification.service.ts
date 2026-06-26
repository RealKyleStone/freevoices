import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class BrowserNotificationService {

  // Call this once on app start to request permission from the browser
  async requestPermission(): Promise<void> {
    if (!('Notification' in window)) {
      console.log('Browser notifications not supported');
      return;
    }
    if (Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  }

  // Fire a browser notification immediately
  // Works even when the tab is minimized or in the background
  notify(title: string, body: string, icon = '/assets/icon/favicon.png'): void {
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') {
      console.warn('Browser notification permission not granted');
      return;
    }
    new Notification(title, { body, icon });
  }
}
