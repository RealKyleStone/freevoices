import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  // Reverse-DNS of the domain we own. This is a one-way door: once an app is
  // uploaded to Google Play, the applicationId for that listing can never be
  // changed. Must match android/app/build.gradle and strings.xml.
  appId: 'za.co.freevoices.app',
  appName: 'FreeVoices',
  webDir: 'www',
  android: {
    // The WebView serves the app from https://localhost rather than
    // http://localhost, so the page is a secure context and cleartext traffic
    // can stay disabled in the manifest.
    androidScheme: 'https'
  },
  plugins: {
    GoogleAuth: {
      // The OAuth 2.0 *Web application* client ID — same value as
      // environment.googleClientId and the server's GOOGLE_OAUTH_CLIENT_ID.
      // The Android OAuth client must also exist in the same Google Cloud
      // project (registered against the release keystore's SHA-1), but its ID
      // is never used here: it authorises the app, while this identifies the
      // audience the token is minted for.
      //
      // Leave empty and the Android build still compiles; the button just
      // fails at runtime. res/values/strings.xml has the fallback copy.
      clientId: '280963257389-mngl773qmk23mmq8irq0qsj3ph41th1q.apps.googleusercontent.com',
      scopes: ['profile', 'email'],
      // No offline access: there is no server-side Google API call to make on
      // the user's behalf, so a refresh token would be a credential held for
      // no reason.
      forceCodeForRefreshToken: false,
    },
    LocalNotifications: {
      // No smallIcon set on purpose: there is no ic_stat_* drawable in
      // res/drawable, so naming one would just log a missing-resource warning.
      // The plugin falls back to the launcher icon. Add a proper white-on-
      // transparent 24dp status-bar icon later and reference it here.
      iconColor: '#0f766e'
    }
  }
};

export default config;
