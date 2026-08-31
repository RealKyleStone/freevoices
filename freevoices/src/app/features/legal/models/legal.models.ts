export type LegalSlug = 'privacy' | 'terms' | 'delete-account';

/** Summary of a published document, as returned by GET /api/legal. */
export interface LegalDocumentSummary {
  slug: LegalSlug;
  version: string;
  title: string;
  /** 'YYYY-MM-DD'. Deliberately a string — see LegalService.formatEffectiveDate. */
  effective_date: string;
  summary_html: string | null;
}

/** A full document, as returned by GET /api/legal/:slug. */
export interface LegalDocument extends LegalDocumentSummary {
  content_html: string;
  /**
   * Set when the content came from the copy bundled with the app rather than
   * from the server. The UI must say so, and must not let the user record
   * acceptance of a version it cannot confirm is current.
   */
  bundled?: boolean;
}
