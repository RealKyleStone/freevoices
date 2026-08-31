import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, of, throwError } from 'rxjs';
import { catchError, map, shareReplay } from 'rxjs/operators';

import { ApiService } from '../../../core/services/api.service';
import { LegalDocument, LegalDocumentSummary, LegalSlug } from '../models/legal.models';

/** Not published yet — distinct from a network failure, and shown differently. */
export class LegalUnpublishedError extends Error {
  constructor(public slug: string) {
    super('This document has not been published yet');
  }
}

@Injectable({ providedIn: 'root' })
export class LegalService {
  private readonly cache = new Map<LegalSlug, Observable<LegalDocument>>();

  // ApiService, not a hand-rolled header builder: the legal endpoints are
  // public, so they must work with no token, and letting AuthInterceptor decide
  // is what makes that work in both states.
  constructor(private api: ApiService, private http: HttpClient) {}

  listCurrent(): Observable<LegalDocumentSummary[]> {
    return this.api.get<LegalDocumentSummary[]>('/legal').pipe(catchError(() => of([])));
  }

  get(slug: LegalSlug): Observable<LegalDocument> {
    if (!this.cache.has(slug)) {
      this.cache.set(
        slug,
        this.api.get<LegalDocument>(`/legal/${slug}`).pipe(
          catchError((err) => {
            // 503 means "no version published" — falling back to a stale
            // bundled copy would be worse than saying so plainly.
            if (err?.status === 503) return throwError(() => new LegalUnpublishedError(slug));
            return this.bundled(slug);
          }),
          shareReplay({ bufferSize: 1, refCount: false })
        )
      );
    }
    return this.cache.get(slug)!;
  }

  /** Force the next get() to re-fetch — e.g. after the app comes back online. */
  invalidate(slug?: LegalSlug): void {
    if (slug) this.cache.delete(slug);
    else this.cache.clear();
  }

  /**
   * Copy shipped inside the app, written by scripts/seed-legal.js from the same
   * source as the database rows. Offline reading only: the version is unknown,
   * so acceptance must not be recorded against it.
   */
  private bundled(slug: LegalSlug): Observable<LegalDocument> {
    return this.http.get(`assets/legal/${slug}.html`, { responseType: 'text' }).pipe(
      map((content_html) => ({
        slug,
        version: 'bundled',
        title: this.titleFor(slug),
        effective_date: '',
        summary_html: null,
        content_html,
        bundled: true,
      } as LegalDocument))
    );
  }

  private titleFor(slug: LegalSlug): string {
    return { privacy: 'Privacy Policy', terms: 'Terms of Service', 'delete-account': 'Delete Your Account' }[slug];
  }

  /**
   * 'YYYY-MM-DD' -> '17 August 2026', without constructing a Date.
   * `new Date('2026-08-17')` parses as UTC midnight and then renders as the
   * previous day for any viewer west of Greenwich, which is not acceptable on a
   * published legal document.
   */
  formatEffectiveDate(value: string): string {
    if (!value) return '';
    const [y, m, d] = value.split('-');
    const months = ['January', 'February', 'March', 'April', 'May', 'June',
      'July', 'August', 'September', 'October', 'November', 'December'];
    const month = months[parseInt(m, 10) - 1];
    if (!month) return value;
    return `${parseInt(d, 10)} ${month} ${y}`;
  }
}
