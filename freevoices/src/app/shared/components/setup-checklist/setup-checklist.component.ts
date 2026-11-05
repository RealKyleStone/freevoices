import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { forkJoin, Subscription } from 'rxjs';
import { SettingsService } from '../../../features/settings/services/settings.service';
import { businessSetup, SetupStep } from '../../utils/business-setup';

@Component({
  selector: 'app-setup-checklist', standalone: true, imports: [CommonModule, RouterLink],
  template: `
    <section class="setup" aria-label="Business setup">
      <p *ngIf="loading" role="status">Checking your business setup...</p>
      <p *ngIf="error" role="alert">Could not check your setup. <button type="button" (click)="refresh()">Retry</button></p>
      <details *ngIf="!loading && !error" [open]="completed < required">
        <summary><strong>{{ completed === required ? 'Business essentials are ready' : 'Get your business ready to invoice' }}</strong>
          <span>{{ completed }} of {{ required }} essentials complete</span></summary>
        <p>Set up the details you need now. You can keep working and return to the rest later.</p>
        <progress [max]="required" [value]="completed" aria-label="Business setup essentials"></progress>
        <ul><li *ngFor="let step of steps">
          <span class="status" [class.done]="step.done">{{ step.done ? 'Done' : step.required ? 'To do' : 'Optional' }}</span>
          <div><a [routerLink]="step.route">{{ step.title }}</a><p>{{ step.detail }}</p></div>
        </li></ul>
      </details>
    </section>`,
  styles: [`
    .setup { border: 1px solid var(--ion-color-light-shade, #d1d5db); border-radius: 12px; padding: 20px; margin-bottom: 24px; background: var(--fv-surface-subtle, var(--ion-background-color, white)); }
    summary { cursor: pointer; min-height: 44px; }
    summary span { display: block; margin-top: 6px; }
    progress { width: 100%; accent-color: var(--ion-color-primary, #0f766e); }
    ul { list-style: none; padding: 0; margin-bottom: 0; }
    li { display: flex; gap: 16px; padding: 12px 0; }
    li + li { border-top: 1px solid var(--ion-color-light-shade, #d1d5db); }
    a { display: inline-block; padding: 8px 0; color: var(--ion-color-primary, #0f766e); font-weight: 600; }
    p { margin: 4px 0 12px; }
    .status { min-width: 64px; font-size: .85rem; padding-top: 10px; }
    .done { color: var(--fv-success-text, #166534); }
    button { min-height: 44px; padding: 8px 16px; }
  `]
})
export class SetupChecklistComponent implements OnInit, OnDestroy {
  loading = true;
  error = false;
  steps: SetupStep[] = [];
  private request?: Subscription;
  constructor(private settings: SettingsService) {}
  get required() { return this.steps.filter(step => step.required).length; }
  get completed() { return this.steps.filter(step => step.required && step.done).length; }
  ngOnInit() { this.refresh(); }
  refresh() {
    this.request?.unsubscribe(); this.loading = true; this.error = false;
    this.request = forkJoin({ settings: this.settings.getSettings(), currencies: this.settings.getCurrencies() }).subscribe({
      next: data => { this.steps = businessSetup(data.settings, data.currencies); this.loading = false; },
      error: () => { this.loading = false; this.error = true; }
    });
  }
  ngOnDestroy() { this.request?.unsubscribe(); }
}
