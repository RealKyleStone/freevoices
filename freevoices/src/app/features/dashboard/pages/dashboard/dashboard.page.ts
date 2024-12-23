// src/app/features/dashboard/pages/dashboard/dashboard.page.ts
import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { IonicModule } from '@ionic/angular';
import { CurrencyPipe } from '@angular/common';

@Component({
  selector: 'app-dashboard',
  templateUrl: './dashboard.page.html',
  styleUrls: ['./dashboard.page.scss'],
  standalone: true,
  imports: [
    CommonModule,
    RouterModule,
    IonicModule,
    CurrencyPipe
  ]
})
export class DashboardPage implements OnInit {
  selectedCurrency = 'ZAR';
  darkMode = false;

  // Placeholder data
  stats = {
    totalRevenue: 125000,
    totalCustomers: 48,
    pendingInvoices: 12,
    overdueinvoices: 3
  };

  constructor() {
    // Check system theme preference
    this.darkMode = window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  ngOnInit() {}
}