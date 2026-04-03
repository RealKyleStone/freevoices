import { Component } from '@angular/core';
import { Router, RouterModule } from '@angular/router';
import { IonApp, IonSplitPane, IonMenu, IonContent, IonList,
         IonMenuToggle, IonItem, IonIcon, IonLabel, IonFooter,
         IonRouterOutlet, MenuController } from '@ionic/angular/standalone';
import { AuthService } from './core/auth/services/auth.service';
import {
  walletOutline,
  gridOutline,
  cashOutline,
  businessOutline,
  barChartOutline,
  logOutOutline,
  notificationsOutline,
  personCircleOutline,
  addCircleOutline,
  personAddOutline,
  documentTextOutline,
  alertCircleOutline,
  peopleOutline,
  receiptOutline,
  cubeOutline,
  settingsOutline
} from 'ionicons/icons';
import { addIcons } from 'ionicons';

@Component({
  selector: 'app-root',
  templateUrl: './app.component.html',
  styleUrls: ['./app.component.scss'],
  standalone: true,
  imports: [
    RouterModule,
    IonApp,
    IonSplitPane,
    IonMenu,
    IonContent,
    IonList,
    IonMenuToggle,
    IonItem,
    IonIcon,
    IonLabel,
    IonFooter,
    IonRouterOutlet
  ]
})
export class AppComponent {
  constructor(
    private authService: AuthService,
    private router: Router,
    private menuCtrl: MenuController
  ) {
    addIcons({
      'wallet-outline': walletOutline,
      'grid-outline': gridOutline,
      'cash-outline': cashOutline,
      'business-outline': businessOutline,
      'bar-chart-outline': barChartOutline,
      'log-out-outline': logOutOutline,
      'notifications-outline': notificationsOutline,
      'person-circle-outline': personCircleOutline,
      'add-circle-outline': addCircleOutline,
      'person-add-outline': personAddOutline,
      'document-text-outline': documentTextOutline,
      'alert-circle-outline': alertCircleOutline,
      'people-outline': peopleOutline,
      'receipt-outline': receiptOutline,
      'cube-outline': cubeOutline,
      'settings-outline': settingsOutline
    });
  }

  async closeMenu() {
    await this.menuCtrl.close();
  }

  async logout() {
    await this.authService.logout();
    this.router.navigate(['/login']);
  }
}