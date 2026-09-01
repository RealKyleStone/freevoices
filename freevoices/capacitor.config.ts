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
