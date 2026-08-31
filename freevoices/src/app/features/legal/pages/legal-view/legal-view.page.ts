import { Component, OnInit } from '@angular/core';
import { CommonModule } from '@angular/common';
import { ActivatedRoute, RouterModule } from '@angular/router';
import { IonicModule } from '@ionic/angular';
import { addIcons } from 'ionicons';
import { cloudOfflineOutline, documentTextOutline, timeOutline } from 'ionicons/icons';

import { LegalService, LegalUnpublishedError } from '../../services/legal.service';
import { LegalDocument, LegalSlug } from '../../models/legal.models';

/**
 * Renders a legal document, pre- or post-login.
 *
 * It carries its own ion-header with a back button because it is reachable from
 * both shells — inside the split-pane when signed in, and bare from the login
 * and register pages when not.
 */
@Component({
  selector: 'app-legal-view',
  templateUrl: './legal-view.page.html',
  styleUrls: ['./legal-view.page.scss'],
  standalone: true,
  imports: [CommonModule, IonicModule, RouterModule]
})
export class LegalViewPage implements OnInit {
  doc?: LegalDocument;
  isLoading = true;
  /** Set when no version is published, as opposed to a load failure. */
  unpublished = false;
  loadFailed = false;

  constructor(private route: ActivatedRoute, private legal: LegalService) {
    addIcons({ cloudOfflineOutline, documentTextOutline, timeOutline });
  }

  ngOnInit(): void {
    // paramMap, not a snapshot: /legal/privacy -> /legal/terms reuses this
    // component instance, and a snapshot read would keep showing the old doc.
    this.route.paramMap.subscribe((params) => {
      const slug = params.get('slug') as LegalSlug | null;
      if (!slug) return;
      this.load(slug);
    });
  }

  private load(slug: LegalSlug): void {
    this.isLoading = true;
    this.unpublished = false;
    this.loadFailed = false;
    this.doc = undefined;

    this.legal.get(slug).subscribe({
      next: (doc) => {
        this.doc = doc;
        this.isLoading = false;
      },
      error: (err) => {
        if (err instanceof LegalUnpublishedError) this.unpublished = true;
        else this.loadFailed = true;
        this.isLoading = false;
      }
    });
  }

  get effectiveDate(): string {
    return this.doc ? this.legal.formatEffectiveDate(this.doc.effective_date) : '';
  }

  retry(): void {
    const slug = this.route.snapshot.paramMap.get('slug') as LegalSlug | null;
    if (!slug) return;
    this.legal.invalidate(slug);
    this.load(slug);
  }
}
