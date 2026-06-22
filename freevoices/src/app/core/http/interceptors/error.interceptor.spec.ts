// ============================================================
// error.interceptor.spec.ts — Unit tests for ErrorInterceptor
// ============================================================

import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse, HttpHandler, HttpRequest } from '@angular/common/http';
import { Router } from '@angular/router';
import { ToastController } from '@ionic/angular/standalone';
import { ErrorInterceptor } from './error.interceptor';
import { Observable, throwError, of } from 'rxjs';

// Build a fake HttpErrorResponse for a given status code
function makeError(status: number, message?: string): HttpErrorResponse {
  return new HttpErrorResponse({
    status,
    error: message ? { message } : null,
    url: 'http://localhost:3000/api/test'
  });
}

// Build a fake HttpHandler that throws the given error
function makeHandler(error: HttpErrorResponse): HttpHandler {
  return {
    handle: (): Observable<any> => throwError(() => error)
  } as unknown as HttpHandler;
}

// Build a fake HttpHandler that returns success
function makeSuccessHandler(): HttpHandler {
  return {
    handle: (): Observable<any> => of({})
  } as unknown as HttpHandler;
}

// A dummy request — we cast to unknown first to avoid strict overload checking
const DUMMY_REQUEST = {} as unknown as HttpRequest<any>;

describe('ErrorInterceptor', () => {
  let interceptor: ErrorInterceptor;
  let routerSpy: jasmine.SpyObj<Router>;
  let toastCtrlSpy: jasmine.SpyObj<ToastController>;
  let mockToast: any;

  beforeEach(() => {
    routerSpy = jasmine.createSpyObj('Router', ['navigate']);

    mockToast = jasmine.createSpyObj('HTMLIonToastElement', ['present']);
    mockToast.present.and.returnValue(Promise.resolve());

    toastCtrlSpy = jasmine.createSpyObj('ToastController', ['create']);
    toastCtrlSpy.create.and.returnValue(Promise.resolve(mockToast));

    TestBed.configureTestingModule({
      providers: [
        ErrorInterceptor,
        { provide: Router,          useValue: routerSpy },
        { provide: ToastController, useValue: toastCtrlSpy }
      ]
    });

    interceptor = TestBed.inject(ErrorInterceptor);
  });

  afterEach(() => {
    localStorage.clear();
  });

  // ============================================================
  // GROUP 1: Creation
  // ============================================================
  describe('interceptor creation', () => {
    it('should be created', () => {
      expect(interceptor).toBeTruthy();
    });
  });

  // ============================================================
  // GROUP 2: 401 Unauthorized
  // ============================================================
  describe('401 Unauthorized', () => {

    it('should redirect to /login', (done) => {
      interceptor.intercept(DUMMY_REQUEST, makeHandler(makeError(401))).subscribe({
        error: () => {
          expect(routerSpy.navigate).toHaveBeenCalledWith(['/login']);
          done();
        }
      });
    });

    it('should remove the token from localStorage', (done) => {
      localStorage.setItem('token', 'expired-token');

      interceptor.intercept(DUMMY_REQUEST, makeHandler(makeError(401))).subscribe({
        error: () => {
          expect(localStorage.getItem('token')).toBeNull();
          done();
        }
      });
    });

    it('should NOT show a toast for 401', (done) => {
      interceptor.intercept(DUMMY_REQUEST, makeHandler(makeError(401))).subscribe({
        error: () => {
          expect(toastCtrlSpy.create).not.toHaveBeenCalled();
          done();
        }
      });
    });

    it('should re-throw the error after handling', (done) => {
      interceptor.intercept(DUMMY_REQUEST, makeHandler(makeError(401))).subscribe({
        next: () => fail('Expected error to be re-thrown'),
        error: (err) => {
          expect(err.status).toBe(401);
          done();
        }
      });
    });

  });

  // ============================================================
  // GROUP 3: 403 Forbidden
  // ============================================================
  describe('403 Forbidden', () => {

    it('should show a toast with permission error message', (done) => {
      interceptor.intercept(DUMMY_REQUEST, makeHandler(makeError(403))).subscribe({
        error: async () => {
          await Promise.resolve();
          expect(toastCtrlSpy.create).toHaveBeenCalledWith(
            jasmine.objectContaining({
              message: 'You do not have permission to perform this action.'
            })
          );
          done();
        }
      });
    });

    it('should NOT redirect to login for 403', (done) => {
      interceptor.intercept(DUMMY_REQUEST, makeHandler(makeError(403))).subscribe({
        error: () => {
          expect(routerSpy.navigate).not.toHaveBeenCalled();
          done();
        }
      });
    });

  });

  // ============================================================
  // GROUP 4: 404 Not Found
  // ============================================================
  describe('404 Not Found', () => {

    it('should show a toast with not found message', (done) => {
      interceptor.intercept(DUMMY_REQUEST, makeHandler(makeError(404))).subscribe({
        error: async () => {
          await Promise.resolve();
          expect(toastCtrlSpy.create).toHaveBeenCalledWith(
            jasmine.objectContaining({
              message: 'The requested resource was not found.'
            })
          );
          done();
        }
      });
    });

  });

  // ============================================================
  // GROUP 5: 500 Server Error
  // ============================================================
  describe('500 Server Error', () => {

    it('should show a toast with server error message', (done) => {
      interceptor.intercept(DUMMY_REQUEST, makeHandler(makeError(500))).subscribe({
        error: async () => {
          await Promise.resolve();
          expect(toastCtrlSpy.create).toHaveBeenCalledWith(
            jasmine.objectContaining({
              message: 'A server error occurred. Please try again later.'
            })
          );
          done();
        }
      });
    });

    it('should use the server message when provided in the response body', (done) => {
      interceptor.intercept(DUMMY_REQUEST, makeHandler(makeError(500, 'Database connection failed'))).subscribe({
        error: async () => {
          await Promise.resolve();
          expect(toastCtrlSpy.create).toHaveBeenCalledWith(
            jasmine.objectContaining({
              message: 'Database connection failed'
            })
          );
          done();
        }
      });
    });

  });

  // ============================================================
  // GROUP 6: 0 — No connection
  // ============================================================
  describe('status 0 — no connection', () => {

    it('should show a toast about being unable to reach the server', (done) => {
      interceptor.intercept(DUMMY_REQUEST, makeHandler(makeError(0))).subscribe({
        error: async () => {
          await Promise.resolve();
          expect(toastCtrlSpy.create).toHaveBeenCalledWith(
            jasmine.objectContaining({
              message: 'Unable to reach the server. Check your connection.'
            })
          );
          done();
        }
      });
    });

  });

  // ============================================================
  // GROUP 7: Successful request
  // ============================================================
  describe('successful request', () => {

    it('should pass through without intercepting when there is no error', (done) => {
      interceptor.intercept(DUMMY_REQUEST, makeSuccessHandler()).subscribe({
        next: () => {
          expect(routerSpy.navigate).not.toHaveBeenCalled();
          expect(toastCtrlSpy.create).not.toHaveBeenCalled();
          done();
        }
      });
    });

  });

});
