import { Component, inject } from '@angular/core';
import { By } from '@angular/platform-browser';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter, Router, RouterLink, Routes } from '@angular/router';
import { provideIonicAngular, IonicRouteStrategy, AlertController } from '@ionic/angular/standalone';
import { RouteReuseStrategy } from '@angular/router';
import { BehaviorSubject, of } from 'rxjs';
import { AppComponent } from './app.component';
import { AuthService } from './core/auth/services/auth.service';
import { LocalNotificationService } from './core/services/local-notification.service';
import { BrowserNotificationService } from './core/services/browser-notification.service';
import { InvoiceService } from './features/invoices/services/invoice.service';
import { DashboardPage } from './features/dashboard/pages/dashboard/dashboard.page';
import { DashboardService } from './features/dashboard/services/dashboard.service';
import { ReportsPage } from './features/reports/pages/reports/reports.page';
import { ReportsService } from './features/reports/services/reports.service';
import { SettingsMainPage } from './features/settings/pages/settings-main/settings-main.page';
import { SettingsService } from './features/settings/services/settings.service';
import { CataloguePickerComponent } from './shared/components/catalogue-picker/catalogue-picker.component';
import { CustomerService } from './features/customers/services/customer.service';
import { ProductService } from './features/products/services/product.service';
import { FormControl, FormGroup, ReactiveFormsModule } from '@angular/forms';
import { unsavedChangesGuard } from './shared/guards/unsaved-changes.guard';

@Component({ standalone: true, imports: [RouterLink], template: '<h1>{{ title }}</h1><a routerLink="/dashboard">Dashboard</a>' })
class DestinationPage { title = inject(ActivatedRoute).snapshot.data['title']; }

@Component({ standalone: true, imports: [ReactiveFormsModule, CataloguePickerComponent], template: `
  <h1>Draft navigation fixture</h1><form [formGroup]="form"><app-catalogue-picker formControlName="customer"></app-catalogue-picker></form>` })
class DraftPage {
  form = new FormGroup({ customer: new FormControl<number | null>(null) });
  hasUnsavedChanges() { return this.form.dirty; }
}

const settingsPaths = ['profile', 'company', 'invoice', 'payment', 'notifications', 'privacy', 'legal'];
const testRoutes: Routes = [
  { path: 'dashboard', component: DashboardPage },
  { path: 'reports', component: ReportsPage },
  { path: 'invoices/new', component: DraftPage, canDeactivate: [unsavedChangesGuard] },
  ...['customers', 'products', 'invoices', 'quotes', 'login'].map(path => ({ path, component: DestinationPage, data: { title: path } })),
  { path: 'settings', component: SettingsMainPage, children: [
    ...settingsPaths.map(path => ({ path, component: DestinationPage, data: { title: path } })),
    { path: '', redirectTo: 'profile', pathMatch: 'full' }
  ] }
];

describe('application navigation at the browser viewport', () => {
  beforeAll(() => console.info(`Navigation viewport: ${window.innerWidth} x ${window.innerHeight}`));
  let fixture: ComponentFixture<AppComponent>;
  let router: Router;
  let menu: HTMLIonMenuElement;
  let authState: BehaviorSubject<any>;
  let previousBody: string | null;
  let alerts: jasmine.SpyObj<AlertController>;
  let originalStorage: { theme: string | null; checked: string | null; htmlDark: boolean; bodyDark: boolean };
  const pause = () => new Promise(resolve => setTimeout(resolve, 20));
  async function until(condition: () => boolean | Promise<boolean>, description: string) {
    for (let i = 0; i < 100; i++) { fixture.detectChanges(); if (await condition()) return; await pause(); }
    throw new Error(`Timed out: ${description} at ${window.innerWidth}px`);
  }
  async function navigate(url: string) {
    await fixture.ngZone!.run(() => router.navigateByUrl(url));
    await until(() => router.url === url || (url === '/settings' && router.url === '/settings/profile'), `route ${url}`);
    await pause(); fixture.detectChanges();
  }
  function menuLink(url: string): HTMLElement {
    const link = fixture.nativeElement.querySelector(`ion-menu ion-item[routerlink="${url}"]`);
    if (!link) throw new Error(`Missing menu link: ${url}`);
    return link;
  }
  async function chooseMenu(url: string) {
    if (await menu.isActive()) await menu.open(false);
    fixture.ngZone!.run(() => menuLink(url).click());
    await until(() => router.url === url || (url === '/settings' && router.url === '/settings/profile'), `menu ${url}`);
    if (await menu.isActive()) await until(async () => !(await menu.isOpen()), `menu closes after ${url}`);
  }
  async function assertNavigationAvailable() {
    const permanent = window.matchMedia('(min-width: 992px)').matches;
    await until(() => fixture.nativeElement.querySelector('ion-split-pane').classList.contains('split-pane-visible') === permanent, 'split-pane breakpoint');
    if (permanent) {
      await until(() => menu.getBoundingClientRect().width > 0, 'visible desktop sidebar');
      expect(menu.getBoundingClientRect().width).toBeGreaterThan(0);
      expect(await menu.isActive()).toBeFalse();
    } else {
      await until(() => {
        const buttons = Array.from(fixture.nativeElement.querySelectorAll('ion-menu-button')) as HTMLElement[];
        return buttons.some(button => button.getBoundingClientRect().width > 0 && getComputedStyle(button).visibility !== 'hidden');
      }, 'visible menu button while sidebar is collapsed');
      const buttons = Array.from(fixture.nativeElement.querySelectorAll('ion-menu-button')) as HTMLElement[];
      const button = buttons.find(b => b.getBoundingClientRect().width > 0)!;
      const actualButton = button.shadowRoot?.querySelector('button');
      expect(actualButton).toBeTruthy();
      fixture.ngZone!.run(() => (actualButton as HTMLButtonElement).click());
      await until(() => menu.isOpen(), 'menu button opens menu');
      await menu.close(false);
    }
  }

  beforeEach(async () => {
    previousBody = document.body.getAttribute('style');
    document.body.style.cssText = 'display:block;height:100vh;margin:0;';
    originalStorage = { theme: localStorage.getItem('fv-theme'), checked: localStorage.getItem('fv-overdue-checked'), htmlDark: document.documentElement.classList.contains('ion-palette-dark'), bodyDark: document.body.classList.contains('ion-palette-dark') };
    authState = new BehaviorSubject({ id: 1, company_name: 'Regression business', email: 'test@example.test' });
    const auth = { currentUser$: authState.asObservable(), getCurrentUser: () => authState.value,
      logout: async () => { authState.next(null); } };
    alerts = jasmine.createSpyObj('AlertController', ['create']);
    alerts.create.and.returnValue(Promise.resolve({ present: async () => {}, onDidDismiss: async () => ({ role: 'cancel' }) } as any));
    await TestBed.configureTestingModule({ imports: [AppComponent], providers: [
      provideRouter(testRoutes), provideIonicAngular({ animated: false }), { provide: RouteReuseStrategy, useClass: IonicRouteStrategy },
      { provide: AuthService, useValue: auth }, { provide: AlertController, useValue: alerts },
      { provide: LocalNotificationService, useValue: { initNotifications: () => {} } },
      { provide: BrowserNotificationService, useValue: { requestPermission: () => {}, notify: () => {} } },
      { provide: InvoiceService, useValue: { getInvoices: () => of({ data: [] }) } },
      { provide: DashboardService, useValue: { getSummary: () => of({ monthRevenue: 0, totalCustomers: 0, openInvoices: 0, overdueInvoices: 0, recentActivity: [] }) } },
      { provide: ReportsService, useValue: { getCurrencies: () => of([]), getRevenueByMonth: () => of([]), getInvoiceStatus: () => of([]), getTopCustomers: () => of([]), getVatSummary: () => of([]) } },
      { provide: SettingsService, useValue: { getSettings: () => of({}), getCurrencies: () => of([]) } },
      { provide: CustomerService, useValue: { getCustomers: () => of({ data: [], total: 0, page: 1, limit: 20 }) } },
      { provide: ProductService, useValue: {} }
    ] }).compileComponents();
    fixture = TestBed.createComponent(AppComponent); router = TestBed.inject(Router); fixture.autoDetectChanges();
    menu = fixture.nativeElement.querySelector('ion-menu');
    await until(() => typeof menu.isActive === 'function', 'menu hydration');
    await navigate('/dashboard');
  });
  afterEach(async () => {
    if (menu && typeof menu.close === 'function') await menu.close(false);
    fixture?.destroy(); authState.complete();
    document.documentElement.classList.toggle('ion-palette-dark', originalStorage.htmlDark);
    document.body.classList.toggle('ion-palette-dark', originalStorage.bodyDark);
    if (previousBody === null) document.body.removeAttribute('style'); else document.body.setAttribute('style', previousBody);
    for (const [key, value] of [['fv-theme', originalStorage.theme], ['fv-overdue-checked', originalStorage.checked]]) {
      if (value === null) localStorage.removeItem(key!); else localStorage.setItem(key!, value!);
    }
  });

  it('keeps dashboard navigation reachable when the sidebar collapses', async () => { expect(fixture.nativeElement.querySelectorAll('ion-router-outlet').length).toBe(1); await assertNavigationAvailable(); });
  it('keeps empty reports usable and navigation reachable when the sidebar collapses', async () => { await navigate('/reports'); await assertNavigationAvailable(); expect(fixture.nativeElement.textContent).toContain('No payments recorded yet.'); });
  it('navigates through every main menu entry and closes its overlay', async () => {
    for (const path of ['/customers', '/invoices', '/quotes', '/products', '/reports', '/settings', '/dashboard']) {
      await chooseMenu(path); expect(router.url).toBe(path === '/settings' ? '/settings/profile' : path);
    }
    await navigate('/reports');
    if (await menu.isActive()) await menu.open(false);
    fixture.ngZone!.run(() => (fixture.nativeElement.querySelector('.menu-header') as HTMLButtonElement).click());
    await until(() => router.url === '/dashboard', 'brand link returns home');
    if (await menu.isActive()) await until(async () => !(await menu.isOpen()), 'brand link closes menu');
    expect(router.url).toBe('/dashboard');
  });
  it('closes the mobile menu after the Legal & privacy footer link', async () => { await chooseMenu('/settings/legal'); expect(router.url).toBe('/settings/legal'); });
  it('opens each settings section without duplicating the global menu', async () => {
    await chooseMenu('/settings');
    for (const path of settingsPaths) {
      const link = fixture.nativeElement.querySelector(`.settings-nav ion-item[ng-reflect-router-link="${path}"]`) ||
        Array.from(fixture.nativeElement.querySelectorAll('.settings-nav ion-item')).find((item: any) => item.textContent.trim() === ({ profile: 'Profile', company: 'Company', invoice: 'Invoice defaults', payment: 'Payment details', notifications: 'Notifications', privacy: 'Privacy & data', legal: 'Legal' } as any)[path]);
      expect(link).toBeTruthy(); fixture.ngZone!.run(() => (link as HTMLElement).click());
      await until(() => router.url === `/settings/${path}`, `settings ${path}`);
      expect(fixture.nativeElement.querySelectorAll('ion-menu').length).toBe(1);
    }
  });
  it('returns to a usable menu after opening and cancelling the catalogue picker', async () => {
    await navigate('/invoices/new');
    const trigger = fixture.nativeElement.querySelector('.picker-trigger') as HTMLButtonElement;
    await until(() => !!fixture.nativeElement.querySelector('.picker-trigger'), 'draft picker');
    fixture.ngZone!.run(() => trigger.click()); await until(() => !!fixture.nativeElement.querySelector('dialog[open]'), 'picker opens');
    const close = fixture.nativeElement.querySelector('dialog header button') as HTMLButtonElement;
    fixture.ngZone!.run(() => close.click());
    await until(() => !fixture.nativeElement.querySelector('dialog[open]'), 'picker closes');
    await chooseMenu('/customers'); expect(router.url).toBe('/customers');
  });
  it('keeps a dirty draft when navigation is cancelled, then allows a confirmed discard', async () => {
    await navigate('/invoices/new');
    const instance = fixture.debugElement.query(By.directive(DraftPage)).componentInstance as DraftPage;
    instance.form.markAsDirty();
    expect(await fixture.ngZone!.run(() => router.navigateByUrl('/customers'))).toBeFalse();
    expect(router.url).toBe('/invoices/new');
    alerts.create.and.returnValue(Promise.resolve({ present: async () => {}, onDidDismiss: async () => ({ role: 'destructive' }) } as any));
    await navigate('/customers'); expect(router.url).toBe('/customers');
  });
  it('switches between signed-out and signed-in shells with exactly one router outlet', async () => {
    authState.next(null); await navigate('/login');
    expect(fixture.nativeElement.querySelectorAll('ion-router-outlet').length).toBe(1);
    authState.next({ id: 1, company_name: 'Regression business', email: 'test@example.test' });
    await navigate('/dashboard');
    menu = fixture.nativeElement.querySelector('ion-menu');
    await until(() => typeof menu.isActive === 'function', 'new signed-in menu hydration');
    expect(fixture.nativeElement.querySelectorAll('ion-router-outlet').length).toBe(1);
    await assertNavigationAvailable();
  });
  it('keeps reports and the menu usable after toggling the theme', async () => {
    await navigate('/reports');
    const initial = fixture.componentInstance.isDarkMode;
    if (await menu.isActive()) await menu.open(false);
    const toggle = Array.from(fixture.nativeElement.querySelectorAll('ion-menu ion-footer ion-item')).find((item: any) => /Light mode|Dark mode/.test(item.textContent)) as HTMLElement;
    fixture.ngZone!.run(() => toggle.click()); await pause();
    expect(fixture.componentInstance.isDarkMode).toBe(!initial);
    expect(router.url).toBe('/reports');
    fixture.ngZone!.run(() => toggle.click()); await pause();
    expect(fixture.componentInstance.isDarkMode).toBe(initial);
    await chooseMenu('/dashboard'); expect(router.url).toBe('/dashboard');
  });
  it('removes authenticated navigation on sign out', async () => {
    await navigate('/invoices/new');
    const draft = fixture.debugElement.query(By.directive(DraftPage)).componentInstance as DraftPage;
    draft.form.markAsDirty();
    if (await menu.isActive()) await menu.open(false);
    const logout = Array.from(fixture.nativeElement.querySelectorAll('ion-menu ion-footer ion-item')).find((item: any) => item.textContent.includes('Sign out')) as HTMLElement;
    fixture.ngZone!.run(() => logout.click());
    await until(() => router.url === '/login' && !fixture.nativeElement.querySelector('ion-menu'), 'sign out returns to login without menu');
    expect(fixture.nativeElement.querySelectorAll('ion-router-outlet').length).toBe(1);
    await until(() => !fixture.debugElement.query(By.directive(DraftPage)), 'private draft cache cleared on logout');
    expect(alerts.create).not.toHaveBeenCalled();
  });
});
