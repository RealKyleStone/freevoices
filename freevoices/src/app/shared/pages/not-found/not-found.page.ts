import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { IonContent, IonButton, IonIcon } from '@ionic/angular/standalone';
import { addIcons } from 'ionicons';
import { helpCircleOutline } from 'ionicons/icons';

@Component({
    selector: 'app-not-found',
    templateUrl: './not-found.page.html',
    styleUrls: ['./not-found.page.scss'],
    standalone: true,
    imports: [RouterLink, IonContent, IonButton, IonIcon]
})
export class NotFoundPage {
    constructor() {
        // Registered here rather than relying on the app shell: this page is
        // reachable without signing in, so AppComponent's addIcons() call has
        // not necessarily run for it.
        addIcons({ helpCircleOutline });
    }
}
