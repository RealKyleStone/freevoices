import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { of, throwError } from 'rxjs';
import { SetupChecklistComponent } from './setup-checklist.component';
import { SettingsService } from '../../../features/settings/services/settings.service';
import { UserSettings } from '../../../features/settings/services/settings.service';

describe('setup checklist', () => {
  const ready = { company_name: 'Business', address: 'Cape Town', invoice_vat_rate: '0', default_currency_id: '1',
    bank_name: 'Bank', bank_account_number: '123', bank_branch_code: '456', invoice_prefix: 'INV', invoice_payment_terms: '0' } as UserSettings;
  let settings: jasmine.SpyObj<SettingsService>;
  beforeEach(() => {
    settings = jasmine.createSpyObj('SettingsService', ['getSettings', 'getCurrencies']);
    settings.getSettings.and.returnValue(of(ready));
    settings.getCurrencies.and.returnValue(of([{ id: 1, code: 'ZAR', name: 'Rand', symbol: 'R', is_active: true, created_at: '' }]));
    TestBed.configureTestingModule({ imports: [SetupChecklistComponent], providers: [provideRouter([]), { provide: SettingsService, useValue: settings }] });
  });
  it('shows completed essentials separately from optional branding and links to the right settings', () => {
    const fixture = TestBed.createComponent(SetupChecklistComponent); fixture.detectChanges();
    expect(fixture.componentInstance.completed).toBe(5);
    expect(fixture.nativeElement.querySelector('details').open).toBeFalse();
    expect(fixture.nativeElement.textContent).toContain('Optional');
    expect(fixture.nativeElement.querySelector('a').getAttribute('href')).toBe('/settings/company');
    fixture.destroy();
  });
  it('rechecks saved settings when returning from configuration', () => {
    settings.getSettings.and.returnValues(of({} as UserSettings), of(ready));
    const fixture = TestBed.createComponent(SetupChecklistComponent); fixture.detectChanges();
    expect(fixture.componentInstance.completed).toBe(0);
    fixture.componentInstance.refresh(); fixture.detectChanges();
    expect(fixture.componentInstance.completed).toBe(5); fixture.destroy();
  });
  it('offers retry on failure instead of treating unknown settings as complete', () => {
    settings.getSettings.and.returnValues(throwError(() => new Error('Offline')), of(ready));
    const fixture = TestBed.createComponent(SetupChecklistComponent); fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Could not check your setup');
    fixture.nativeElement.querySelector('button').click(); fixture.detectChanges();
    expect(fixture.componentInstance.completed).toBe(5); expect(fixture.componentInstance.error).toBeFalse(); fixture.destroy();
  });
});
