/** Browser-only recovery for unsaved document forms. Never contains auth tokens. */
export interface BrowserDraft<T> { savedAt: number; value: T; }

const PREFIX = 'freevoices:document-draft:v1:';
const MAX_AGE = 30 * 24 * 60 * 60 * 1000;

export function draftKey(userId: number, kind: 'invoice' | 'quote', identity: string): string {
  return `${PREFIX}${userId}:${kind}:${identity}`;
}

export function readDraft<T>(key: string, now = Date.now()): BrowserDraft<T> | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const draft = JSON.parse(raw) as BrowserDraft<T>;
    if (!Number.isFinite(draft.savedAt) || draft.savedAt > now || now - draft.savedAt > MAX_AGE || !draft.value || typeof draft.value !== 'object') {
      localStorage.removeItem(key);
      return null;
    }
    return draft;
  } catch { return null; }
}

export function writeDraft<T>(key: string, value: T): boolean {
  try { localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), value })); return true; }
  catch { return false; }
}

export function clearDraft(key: string): void {
  try { localStorage.removeItem(key); } catch { /* Storage may be disabled. */ }
}

export function clearUserDrafts(userId: number): void {
  try {
    const userPrefix = `${PREFIX}${userId}:`;
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key?.startsWith(userPrefix)) localStorage.removeItem(key);
    }
  } catch { /* Storage may be disabled. */ }
}
