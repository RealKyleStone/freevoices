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
    .setup {
      border: none;
      border-radius: var(--fv-radius-lg);
      padding: var(--fv-space-5);
      margin-bottom: var(--fv-section-gap);
      background: var(--ion-card-background);
      box-shadow: var(--fv-elevation);
    }
    :host-context(.ion-palette-dark) .setup { border: 1px solid var(--fv-border); }
    summary { cursor: pointer; min-height: 44px; font-size: var(--fv-text-md); font-weight: var(--fv-weight-semibold); }
    summary span { display: block; margin-top: 6px; font-size: var(--fv-text-sm); font-weight: var(--fv-weight-regular); color: var(--ion-color-medium); }
    progress { width: 100%; height: 4px; margin-top: var(--fv-space-3); accent-color: var(--ion-color-primary); }
    ul { list-style: none; padding: 0; margin-bottom: 0; }
    li { display: flex; gap: var(--fv-space-4); padding: var(--fv-space-3) 0; }
    li + li { border-top: 1px solid var(--fv-border); }
    a { display: inline-block; padding: var(--fv-space-2) 0; color: var(--ion-text-color); font-weight: var(--fv-weight-semibold); }
    p { margin: 4px 0 12px; font-size: var(--fv-text-sm); color: var(--ion-color-medium); }
    .status {
      min-width: 64px;
      padding-top: 10px;
      font-size: var(--fv-text-2xs);
      font-weight: var(--fv-weight-semibold);
      letter-spacing: var(--fv-tracking-label);
      text-transform: uppercase;
      color: var(--ion-color-medium);
    }
    .done { color: var(--fv-paid); }
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
