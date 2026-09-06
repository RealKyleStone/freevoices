// This file can be replaced during build by using the `fileReplacements` array.
// `ng build` replaces `environment.ts` with `environment.prod.ts`.
// The list of file replacements can be found in `angular.json`.

export const environment = {
  production: false,
  apiUrl: 'http://localhost:3000/api',
  version: '1.0.0',
  recaptchaSiteKey: '6LecjacqAAAAAH-qxIbyNMeNnvU4fwYcuIxKNKnC',
  bypassCaptcha: true,
  // OAuth 2.0 *Web application* client ID from Google Cloud Console. Public by
  // design — it identifies the app, it does not authorise anything. The server
  // checks incoming ID tokens against GOOGLE_OAUTH_CLIENT_ID, so the two must
  // match. Empty disables the "Continue with Google" buttons entirely.
  googleClientId: '280963257389-mngl773qmk23mmq8irq0qsj3ph41th1q.apps.googleusercontent.com',
};
/*
 * For easier debugging in development mode, you can import the following file
 * to ignore zone related error stack frames such as `zone.run`, `zoneDelegate.invokeTask`.
 *
 * This import should be commented out in production mode because it will have a negative impact
 * on performance if an error is thrown.
 */
// import 'zone.js/plugins/zone-error';  // Included with Angular CLI.
