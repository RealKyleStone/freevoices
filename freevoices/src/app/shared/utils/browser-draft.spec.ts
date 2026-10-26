import { clearDraft, clearUserDrafts, draftKey, readDraft, writeDraft } from './browser-draft';

describe('browser draft recovery', () => {
  const first = draftKey(7, 'invoice', 'new');
  const other = draftKey(8, 'invoice', 'new');
  afterEach(() => { clearDraft(first); clearDraft(other); });

  it('scopes drafts to an account and removes expired drafts', () => {
    expect(first).not.toBe(other);
    expect(writeDraft(first, { customer_id: 3, items: [{ description: 'Work' }] })).toBeTrue();
    expect(readDraft<any>(first)?.value.customer_id).toBe(3);
    expect(readDraft(other)).toBeNull();
    expect(readDraft(first, Date.now() + 31 * 24 * 60 * 60 * 1000)).toBeNull();
    expect(localStorage.getItem(first)).toBeNull();
  });

  it('ignores damaged storage', () => {
    localStorage.setItem(first, '{broken');
    expect(readDraft(first)).toBeNull();
  });
  it('clears only the closing account drafts', () => {
    writeDraft(first, { notes: 'First' });
    writeDraft(other, { notes: 'Other' });
    clearUserDrafts(7);
    expect(readDraft(first)).toBeNull();
    expect(readDraft(other)?.value).toEqual({ notes: 'Other' });
  });
});
