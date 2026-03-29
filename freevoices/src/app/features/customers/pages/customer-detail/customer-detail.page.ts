import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule, ActivatedRoute, Router } from '@angular/router';
import { IonicModule, AlertController, ToastController } from '@ionic/angular';
import { CustomerService, CustomerWithDocuments } from '../../services/customer.service';

@Component({
  selector: 'app-customer-detail',
  templateUrl: './customer-detail.page.html',
  styleUrls: ['./customer-detail.page.scss'],
  standalone: true,
  imports: [CommonModule, RouterModule, IonicModule]
})
export class CustomerDetailPage implements OnInit {
  customer?: CustomerWithDocuments;
  isLoading = true;
  customerId!: number;

  constructor(
    private route: ActivatedRoute,
    private router: Router,
    private customerService: CustomerService,
    private alertCtrl: AlertController,
    private toastCtrl: ToastController
  ) {}

  ngOnInit() {
    this.customerId = Number(this.route.snapshot.paramMap.get('id'));
    this.loadCustomer();
  }

  loadCustomer() {
    this.isLoading = true;
    this.customerService.getCustomer(this.customerId).subscribe({
      next: (customer) => {
        this.customer = customer;
        this.isLoading = false;
      },
      error: async () => {
        this.isLoading = false;
        const toast = await this.toastCtrl.create({ message: 'Failed to load customer', duration: 3000, color: 'danger', position: 'bottom' });
        await toast.present();
        this.router.navigate(['/customers']);
      }
    });
  }

  async confirmDelete() {
    const alert = await this.alertCtrl.create({
      header: 'Delete Customer',
      message: `Remove ${this.customer?.name} from your customers? Their invoice history will be preserved.`,
      buttons: [
        { text: 'Cancel', role: 'cancel' },
        {
          text: 'Delete',
          role: 'destructive',
          handler: () => this.deleteCustomer()
        }
      ]
    });
    await alert.present();
  }

  deleteCustomer() {
    this.customerService.deleteCustomer(this.customerId).subscribe({
      next: async () => {
        const toast = await this.toastCtrl.create({ message: 'Customer deleted', duration: 2500, color: 'success', position: 'bottom' });
        await toast.present();
        this.router.navigate(['/customers']);
      },
      error: async () => {
        const toast = await this.toastCtrl.create({ message: 'Failed to delete customer', duration: 3000, color: 'danger', position: 'bottom' });
        await toast.present();
      }
    });
  }

  getStatusColor(status: string): string {
    const map: Record<string, string> = {
      DRAFT: 'medium',
      SENT: 'primary',
      PAID: 'success',
      OVERDUE: 'warning',
      CANCELLED: 'danger'
    };
    return map[status] ?? 'medium';
  }
}
