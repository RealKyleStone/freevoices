// ============================================================
// auth.service.spec.ts  — Unit tests for AuthService
// ============================================================
// HOW TO RUN:
//   ng test                              (watch mode, opens browser)
//   ng test --watch=false --browsers=ChromeHeadless   (one-shot, no browser)
// ============================================================

import { TestBed } from '@angular/core/testing';
import { HttpClientTestingModule } from '@angular/common/http/testing';
import { AuthService } from './auth.service';
import { DatabaseService } from 'src/services/database.service';
import { of, throwError } from 'rxjs';

// ---------------------------------------------------------------
// A shared mock user we reuse across multiple tests
// ---------------------------------------------------------------
const MOCK_USER = {
  id: 1,
  email: 'bubbles@freevoices.test',
  company_name: 'Bubbles Inc'
};

const MOCK_LOGIN_RESPONSE = {
  user: MOCK_USER,
  token: 'fake-jwt-token-abc123'
};

// ---------------------------------------------------------------
// describe() groups related tests together.
// Think of it like a "chapter heading" for your tests.
// ---------------------------------------------------------------
describe('AuthService', () => {

  // These variables are declared here so every test inside can use them
  let service: AuthService;
  let dbSpy: jasmine.SpyObj<DatabaseService>;

  // ---------------------------------------------------------------
  // beforeEach() runs BEFORE every single it() test below.
  // We use it to create a clean slate for each test —
  // no leftover state from previous tests can bleed through.
  // ---------------------------------------------------------------
  beforeEach(() => {
    // jasmine.createSpyObj creates a fake DatabaseService.
    // The second argument lists the methods we want to fake out.
    // Now dbSpy.create, dbSpy.query etc. are spies we control.
    dbSpy = jasmine.createSpyObj('DatabaseService', ['create', 'query', 'update', 'delete']);

    TestBed.configureTestingModule({
      imports: [HttpClientTestingModule],
      providers: [
        AuthService,
        // Tell Angular: whenever something asks for DatabaseService,
        // give it our fake dbSpy instead.
        { provide: DatabaseService, useValue: dbSpy }
      ]
    });

    // TestBed.inject() is how we get the real service instance from Angular's DI
    service = TestBed.inject(AuthService);

    // Always start with a clean localStorage so tests don't affect each other
    localStorage.clear();
  });

  // afterEach runs AFTER every test — good for any extra cleanup
  afterEach(() => {
    localStorage.clear();
  });


  // ==============================================================
  // GROUP 1: Basic creation
  // ==============================================================
  describe('service creation', () => {

    it('should be created successfully', () => {
      // The simplest possible test — did Angular create the service?
      expect(service).toBeTruthy();
    });

    it('should start with no authenticated user', () => {
      expect(service.isAuthenticated()).toBeFalse();
    });

    it('should start with null getCurrentUser()', () => {
      expect(service.getCurrentUser()).toBeNull();
    });

    it('should start with null getToken()', () => {
      expect(service.getToken()).toBeNull();
    });

    it('should restore user from localStorage if it exists on startup', () => {
      // Simulate a page reload where user data was already saved
      localStorage.setItem('currentUser', JSON.stringify(MOCK_USER));
      localStorage.setItem('token', 'existing-token');

      // Re-create the service so its constructor runs again and reads localStorage
      const freshService = new AuthService(dbSpy);

      expect(freshService.isAuthenticated()).toBeTrue();
      expect(freshService.getCurrentUser()?.email).toBe('bubbles@freevoices.test');
    });

  });


  // ==============================================================
  // GROUP 2: login()
  // ==============================================================
  describe('login()', () => {

    it('should call DatabaseService.create with correct endpoint and credentials', () => {
      // Tell the spy: when create() is called, return a fake successful response
      dbSpy.create.and.returnValue(of(MOCK_LOGIN_RESPONSE));

      service.login('bubbles@freevoices.test', 'password123').subscribe();

      // Check that the spy was actually called — and with what arguments
      expect(dbSpy.create).toHaveBeenCalledWith('auth/login', {
        email: 'bubbles@freevoices.test',
        password: 'password123',
        captchaToken: undefined
      });
    });

    it('should pass captchaToken to the API when provided', () => {
      dbSpy.create.and.returnValue(of(MOCK_LOGIN_RESPONSE));

      service.login('bubbles@freevoices.test', 'password123', 'token-xyz').subscribe();

      expect(dbSpy.create).toHaveBeenCalledWith('auth/login', {
        email: 'bubbles@freevoices.test',
        password: 'password123',
        captchaToken: 'token-xyz'
      });
    });

    it('should set isAuthenticated() to true after successful login', (done) => {
      dbSpy.create.and.returnValue(of(MOCK_LOGIN_RESPONSE));

      // done() is a callback Jasmine gives us for async tests —
      // we call done() to tell Jasmine "we're finished now"
      service.login('bubbles@freevoices.test', 'password123').subscribe(() => {
        expect(service.isAuthenticated()).toBeTrue();
        done();
      });
    });

    it('should store the JWT token in localStorage after login', (done) => {
      dbSpy.create.and.returnValue(of(MOCK_LOGIN_RESPONSE));

      service.login('bubbles@freevoices.test', 'password123').subscribe(() => {
        expect(localStorage.getItem('token')).toBe('fake-jwt-token-abc123');
        done();
      });
    });

    it('should store the user object in localStorage after login', (done) => {
      dbSpy.create.and.returnValue(of(MOCK_LOGIN_RESPONSE));

      service.login('bubbles@freevoices.test', 'password123').subscribe(() => {
        const stored = JSON.parse(localStorage.getItem('currentUser') || '{}');
        expect(stored.email).toBe('bubbles@freevoices.test');
        expect(stored.company_name).toBe('Bubbles Inc');
        done();
      });
    });

    it('should expose the logged-in user via getCurrentUser()', (done) => {
      dbSpy.create.and.returnValue(of(MOCK_LOGIN_RESPONSE));

      service.login('bubbles@freevoices.test', 'password123').subscribe(() => {
        const user = service.getCurrentUser();
        expect(user?.id).toBe(1);
        expect(user?.email).toBe('bubbles@freevoices.test');
        done();
      });
    });

    it('should expose the token via getToken() after login', (done) => {
      dbSpy.create.and.returnValue(of(MOCK_LOGIN_RESPONSE));

      service.login('bubbles@freevoices.test', 'password123').subscribe(() => {
        expect(service.getToken()).toBe('fake-jwt-token-abc123');
        done();
      });
    });

    it('should propagate errors from DatabaseService when login fails', (done) => {
      // Simulate the server returning a 401 Unauthorized
      const errorResponse = { status: 401, message: 'Invalid credentials' };
      dbSpy.create.and.returnValue(throwError(() => errorResponse));

      service.login('wrong@test.com', 'wrongpass').subscribe({
        next: () => fail('Expected an error but got success'),
        error: (err) => {
          // The error should flow through unchanged
          expect(err.status).toBe(401);
          // And the user should NOT be logged in
          expect(service.isAuthenticated()).toBeFalse();
          done();
        }
      });
    });

    it('should NOT store any data in localStorage when login fails', (done) => {
      dbSpy.create.and.returnValue(throwError(() => new Error('Unauthorized')));

      service.login('wrong@test.com', 'wrongpass').subscribe({
        error: () => {
          expect(localStorage.getItem('token')).toBeNull();
          expect(localStorage.getItem('currentUser')).toBeNull();
          done();
        }
      });
    });

    it('should emit updated user to currentUser$ observable after login', (done) => {
      dbSpy.create.and.returnValue(of(MOCK_LOGIN_RESPONSE));

      // Subscribe to the stream before triggering login
      service.currentUser$.subscribe(user => {
        if (user !== null) {
          expect(user.email).toBe('bubbles@freevoices.test');
          done();
        }
      });

      service.login('bubbles@freevoices.test', 'password123').subscribe();
    });

  });


  // ==============================================================
  // GROUP 3: logout()
  // ==============================================================
  describe('logout()', () => {

    // Helper: log in first so we have a user to log out
    async function loginFirst() {
      dbSpy.create.and.returnValue(of(MOCK_LOGIN_RESPONSE));
      await service.login('bubbles@freevoices.test', 'password123').toPromise();
    }

    it('should set isAuthenticated() to false after logout', async () => {
      await loginFirst();
      expect(service.isAuthenticated()).toBeTrue(); // confirm we're logged in first

      dbSpy.create.and.returnValue(of({})); // logout endpoint returns empty object
      await service.logout();

      expect(service.isAuthenticated()).toBeFalse();
    });

    it('should remove token from localStorage after logout', async () => {
      await loginFirst();

      dbSpy.create.and.returnValue(of({}));
      await service.logout();

      expect(localStorage.getItem('token')).toBeNull();
    });

    it('should remove currentUser from localStorage after logout', async () => {
      await loginFirst();

      dbSpy.create.and.returnValue(of({}));
      await service.logout();

      expect(localStorage.getItem('currentUser')).toBeNull();
    });

    it('should set getCurrentUser() to null after logout', async () => {
      await loginFirst();

      dbSpy.create.and.returnValue(of({}));
      await service.logout();

      expect(service.getCurrentUser()).toBeNull();
    });

    it('should call the logout API endpoint', async () => {
      await loginFirst();

      dbSpy.create.and.returnValue(of({}));
      await service.logout();

      // The second call to create() should be the logout endpoint
      expect(dbSpy.create).toHaveBeenCalledWith('auth/logout', {});
    });

    it('should still clear local state even if the logout API call fails', async () => {
      // This is an important edge case — even if the server errors,
      // the user should still be logged out locally.
      await loginFirst();

      dbSpy.create.and.returnValue(throwError(() => new Error('Network error')));
      await service.logout(); // should not throw

      // State must still be cleared thanks to the finally{} block in the service
      expect(service.isAuthenticated()).toBeFalse();
      expect(localStorage.getItem('token')).toBeNull();
    });

  });


  // ==============================================================
  // GROUP 4: handleLoginSuccess()
  // ==============================================================
  describe('handleLoginSuccess()', () => {

    it('should update the currentUserSubject with the user from response', async () => {
      await service.handleLoginSuccess(MOCK_LOGIN_RESPONSE);

      expect(service.getCurrentUser()?.id).toBe(1);
      expect(service.getCurrentUser()?.company_name).toBe('Bubbles Inc');
    });

    it('should save token to localStorage', async () => {
      await service.handleLoginSuccess(MOCK_LOGIN_RESPONSE);

      expect(localStorage.getItem('token')).toBe('fake-jwt-token-abc123');
    });

    it('should save currentUser JSON to localStorage', async () => {
      await service.handleLoginSuccess(MOCK_LOGIN_RESPONSE);

      const parsed = JSON.parse(localStorage.getItem('currentUser') || '{}');
      expect(parsed.email).toBe('bubbles@freevoices.test');
    });

  });


  // ==============================================================
  // GROUP 5: getToken()
  // ==============================================================
  describe('getToken()', () => {

    it('should return null when no token is stored', () => {
      expect(service.getToken()).toBeNull();
    });

    it('should return the token string when one is in localStorage', () => {
      localStorage.setItem('token', 'my-stored-token');
      expect(service.getToken()).toBe('my-stored-token');
    });

  });


  // ==============================================================
  // GROUP 6: isAuthenticated()
  // ==============================================================
  describe('isAuthenticated()', () => {

    it('should return false when no user is in memory', () => {
      expect(service.isAuthenticated()).toBeFalse();
    });

    it('should return true after a successful login', (done) => {
      dbSpy.create.and.returnValue(of(MOCK_LOGIN_RESPONSE));

      service.login('bubbles@freevoices.test', 'password123').subscribe(() => {
        expect(service.isAuthenticated()).toBeTrue();
        done();
      });
    });

    it('should return false after logout', async () => {
      // Log in first
      dbSpy.create.and.returnValue(of(MOCK_LOGIN_RESPONSE));
      await service.login('bubbles@freevoices.test', 'password123').toPromise();

      // Then log out
      dbSpy.create.and.returnValue(of({}));
      await service.logout();

      expect(service.isAuthenticated()).toBeFalse();
    });

  });

});
