import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { RouterModule } from '@angular/router';
import { IonicModule } from '@ionic/angular';
import { addIcons } from 'ionicons';
import {
  readerOutline,
  shieldCheckmarkOutline,
  documentTextOutline,
  trashOutline,
  informationCircleOutline,
  openOutline
} from 'ionicons/icons';

import { LegalService } from '../../../legal/services/legal.service';
import { LegalDocumentSummary } from '../../../legal/models/legal.models';
import { environment } from '../../../../../environments/environment';

@Component({
  selector: 'app-legal-settings',
  templateUrl: './legal-settings.page.html',
  styleUrls: ['./legal-settings.page.scss'],
  standalone: true,
  imports: [CommonModule, IonicModule, RouterModule]
})
export class LegalSettingsPage implements OnInit {
  documents: LegalDocumentSummary[] = [];
  isLoading = true;
  appVersion = environment.version;

  private readonly meta: Record<string, { icon: string; blurb: string }> = {
    privacy: {
      icon: 'shield-checkmark-outline',
      blurb: 'What we collect, why, how long we keep it, and your rights under POPIA.'
    },
    terms: {
      icon: 'document-text-outline',
      blurb: 'The agreement between you and Made On Chain for using FreeVoices.'
    },
    'delete-account': {
      icon: 'trash-outline',
      blurb: 'How to close your account and what happens to your data afterwards.'
    }
  };

  constructor(private legal: LegalService) {
    addIcons({
      readerOutline, shieldCheckmarkOutline, documentTextOutline,
      trashOutline, informationCircleOutline, openOutline
    });
  }

  ngOnInit(): void {
    this.legal.listCurrent().subscribe((docs) => {
      this.documents = docs;
      this.isLoading = false;
    });
  }

  iconFor(slug: string): string {
    return this.meta[slug]?.icon || 'reader-outline';
  }

  blurbFor(slug: string): string {
    return this.meta[slug]?.blurb || '';
  }

  effectiveDate(value: string): string {
    return this.legal.formatEffectiveDate(value);
  }
}
