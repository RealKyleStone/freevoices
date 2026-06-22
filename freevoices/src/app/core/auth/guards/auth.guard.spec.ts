// ============================================================
// auth.guard.spec.ts — Unit tests for AuthGuard
// ============================================================
// HOW TO RUN:
//   ng test --watch=false --browsers=ChromeHeadless
// ============================================================

import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { AuthGuard } from './auth.guard';
import { AuthService } from '../services/auth.service';
import { HttpClientTestingModule } from '@angular/common/http/testing';

describe('AuthGuard', () => {
  let guard: AuthGuard;

  // We need spies for both AuthService and Router
  // AuthService — to control isAuthenticated()
  // Router — to verify navigation happens (without actually navigating)
  let authSpy: jasmine.SpyObj<AuthService>;
  let routerSpy: jasmine.SpyObj<Router>;

  beforeEach(() => {
    authSpy  = jasmine.createSpyObj('AuthService',  ['isAuthenticated']);
    routerSpy = jasmine.createSpyObj('Router', ['navigate']);

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        AuthGuard,
        { provide: AuthService, useValue: authSpy },
        { provide: Router,      useValue: routerSpy }
      ]
    });

    guard = TestBed.inject(AuthGuard);
  });

  // ============================================================
  // GROUP 1: Service creation
  // ============================================================
  describe('guard creation', () => {

    it('should be created', () => {
      expect(guard).toBeTruthy();
    });

  });

  // ============================================================
  // GROUP 2: Authenticated user
  // ============================================================
  describe('when user IS authenticated', () => {

    beforeEach(() => {
      // Tell the spy: isAuthenticated() returns true
      authSpy.isAuthenticated.and.returnValue(true);
    });

    it('should return true', () => {
      // canActivate() must return true so Angular loads the page
      expect(guard.canActivate()).toBeTrue();
    });

    it('should NOT redirect to login', () => {
      guard.canActivate();

      // router.navigate should never be called for authenticated users
      expect(routerSpy.navigate).not.toHaveBeenCalled();
    });

  });

  // ============================================================
  // GROUP 3: Unauthenticated user
  // ============================================================
  describe('when user is NOT authenticated', () => {

    beforeEach(() => {
      // Tell the spy: isAuthenticated() returns false
      authSpy.isAuthenticated.and.returnValue(false);
    });

    it('should return false', () => {
      // canActivate() must return false so Angular blocks the page
      expect(guard.canActivate()).toBeFalse();
    });

    it('should redirect to /login', () => {
      guard.canActivate();

      // router.navigate must be called with ['/login']
      expect(routerSpy.navigate).toHaveBeenCalledWith(['/login']);
    });

  });

});
