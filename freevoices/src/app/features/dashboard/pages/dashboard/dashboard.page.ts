import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { IonicModule } from '@ionic/angular';

@Component({
    selector: 'app-dashboard',
    templateUrl: './dashboard.page.html',
    styleUrls: ['./dashboard.page.scss'],
    standalone: true,
    imports: [CommonModule, IonicModule],
})
export class DashboardPage implements OnInit {

    constructor() { }

    ngOnInit(): void {
        // Initialization logic here
    }

}