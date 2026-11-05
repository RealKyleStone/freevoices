import { of, throwError } from 'rxjs';
import { QuotePortalPage } from './quote-portal.page';

describe('customer quote portal', () => {
  const route = { snapshot: { paramMap: { get: () => 'test-token' } } } as any;
  const quote = { document_number: 'QUO-1', status: 'SENT', items: [], total: 100 } as any;

  it('loads a quote and records an acceptance before refreshing the status', () => {
    const http = jasmine.createSpyObj('HttpClient', ['get', 'post']);
    http.get.and.returnValues(of(quote), of({ ...quote, status: 'ACCEPTED' }));
    http.post.and.returnValue(of({ message: 'Quote accepted' }));
    const page = new QuotePortalPage(route, http);
    page.ngOnInit();
    expect(page.quote?.status).toBe('SENT');
    page.decide('ACCEPTED');
    expect(http.post).toHaveBeenCalledWith(jasmine.stringMatching(/\/public\/quote\/test-token\/decision$/), { decision: 'ACCEPTED' });
    expect(page.quote?.status).toBe('ACCEPTED');
    expect(page.decisionMessage).toBe('Quote accepted');
  });

  it('keeps the customer informed when a decision fails', () => {
    const http = jasmine.createSpyObj('HttpClient', ['get', 'post']);
    http.get.and.returnValue(of(quote));
    http.post.and.returnValue(throwError(() => ({ error: { message: 'This quote has expired' } })));
    const page = new QuotePortalPage(route, http);
    page.ngOnInit();
    page.decide('ACCEPTED');
    expect(page.error).toBe('This quote has expired');
    expect(page.isSubmitting).toBeFalse();
  });
});
