import { Component } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { IonicModule } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  personOutline,
  businessOutline,
  documentTextOutline,
  cardOutline,
  notificationsOutline,
  menuOutline
} from 'ionicons/icons';

@Component({
  selector: 'app-settings-main',
  templateUrl: './settings-main.page.html',
  styleUrls: ['./settings-main.page.scss'],
  standalone: true,
  imports: [CommonModule, IonicModule, RouterModule]
})
export class SettingsMainPage {
  navItems = [
    { label: 'Profile', path: 'profile', icon: 'person-outline' },
    { label: 'Company', path: 'company', icon: 'business-outline' },
    { label: 'Invoice Defaults', path: 'invoice', icon: 'document-text-outline' },
    { label: 'Payment Details', path: 'payment', icon: 'card-outline' },
    { label: 'Notifications', path: 'notifications', icon: 'notifications-outline' }
  ];

  constructor() {
    addIcons({ personOutline, businessOutline, documentTextOutline, cardOutline, notificationsOutline, menuOutline });
  }
}
