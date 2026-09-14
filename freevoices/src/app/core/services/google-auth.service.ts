import { Injectable } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { GoogleAuth } from '@codetrix-studio/capacitor-google-auth';
import { environment } from '../../../environments/environment';

declare global {
  interface Window {
    google?: any;
  }
}

const GIS_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

/**
 * Obtains a Google ID token, which the server then verifies.
 *
 * Two implementations behind one interface, because the platforms genuinely
 * differ rather than out of preference:
 *
 *   web    — Google Identity Services. GIS only hands back an ID token through
 *            a button it renders itself, so `renderButton` mounts Google's own
 *            widget rather than styling our own. That also keeps us inside
 *            Google's branding rules, which forbid a hand-rolled Google button.
 *   native — @codetrix-studio/capacitor-google-auth, which drives the Android
 *            account picker and returns the equivalent token.
 *
 * Either way the client never sees anything it is trusted on: the ID token goes
 * to the server, and the server decides who that is.
 */
@Injectable({ providedIn: 'root' })
export class GoogleAuthService {
  private scriptPromise: Promise<void> | null = null;
  private nativeInitialised = false;

  /** False when no client ID is configured, which is how the UI hides the buttons. */
  get isConfigured(): boolean {
    return !!environment.googleClientId;
  }

  get isNative(): boolean {
    return Capacitor.isNativePlatform();
  }

  /**
   * Native sign-in. Resolves with an ID token, or null if the user simply
   * dismissed the account picker — a cancellation is not an error worth
   * showing them a red banner over.
   */
  async signInNative(): Promise<string | null> {
    if (!this.isConfigured) throw new Error('Google sign-in is not configured');

    if (!this.nativeInitialised) {
      // serverClientId is the *Web* client ID on purpose: the Android client
      // authorises the app, but the token has to be minted for the audience the
      // server checks. Using the Android client ID here yields tokens the
      // backend will reject.
      await GoogleAuth.initialize({
        clientId: environment.googleClientId,
        scopes: ['profile', 'email'],
        grantOfflineAccess: false,
      });
      this.nativeInitialised = true;
    }

    try {
      const user = await GoogleAuth.signIn();
      return user?.authentication?.idToken ?? null;
    } catch (error: any) {
      const message = String(error?.message ?? error ?? '').toLowerCase();
      if (message.includes('cancel') || message.includes('12501')) return null;
      throw error;
    }
  }

  /**
   * Web sign-in. Renders Google's button into `element` and calls back with an
   * ID token once the user completes the flow.
   */
  async renderButton(element: HTMLElement, onCredential: (idToken: string) => void): Promise<void> {
    if (!this.isConfigured) throw new Error('Google sign-in is not configured');
    await this.loadScript();

    window.google.accounts.id.initialize({
      client_id: environment.googleClientId,
      callback: (response: { credential?: string }) => {
        if (response?.credential) onCredential(response.credential);
      },
      // One Tap is suppressed: it pops up unprompted on page load, and on a
      // sign-in screen that already shows a button it is just a second, more
      // startling way to do the same thing.
      auto_select: false,
      cancel_on_tap_outside: true,
    });

    this.mountButton(element);
  }

  /**
   * Draw (or redraw) Google's widget into `element`.
   *
   * Split out from renderButton so the caller can redraw it after the user
   * changes theme or resizes, without re-running initialize().
   */
  mountButton(element: HTMLElement): void {
    if (!window.google?.accounts?.id) return;

    // GIS renders its own button and only offers a fixed set of themes.
    // 'outline' is white with dark text, which is a bright slab against the
    // app's #111111 dark panel; 'filled_black' is Google's dark-UI variant.
    const dark = document.documentElement.classList.contains('ion-palette-dark')
      || document.body.classList.contains('ion-palette-dark');

    // The widget is a fixed-width iframe measured once at render time, and
    // GIS caps it at 400px. Clamp to that so a wide form column does not ask
    // for a width Google silently ignores, leaving the button narrower than
    // the buttons around it.
    const width = Math.min(Math.max(element.offsetWidth || 320, 200), 400);

    element.replaceChildren();
    window.google.accounts.id.renderButton(element, {
      type: 'standard',
      theme: dark ? 'filled_black' : 'outline',
      size: 'large',
      text: 'continue_with',
      shape: 'rectangular',
      logo_alignment: 'left',
      width,
    });
  }

  /** Load the GIS client once, reusing the in-flight promise on repeat calls. */
  private loadScript(): Promise<void> {
    if (window.google?.accounts?.id) return Promise.resolve();
    if (this.scriptPromise) return this.scriptPromise;

    this.scriptPromise = new Promise<void>((resolve, reject) => {
      const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SCRIPT_SRC}"]`);
      if (existing) {
        existing.addEventListener('load', () => resolve());
        existing.addEventListener('error', () => reject(new Error('Failed to load Google sign-in')));
        return;
      }

      const script = document.createElement('script');
      script.src = GIS_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      script.onload = () => resolve();
      script.onerror = () => {
        // Let a later attempt retry rather than caching the failure forever.
        this.scriptPromise = null;
        reject(new Error('Failed to load Google sign-in'));
      };
      document.head.appendChild(script);
    });

    return this.scriptPromise;
  }
}
