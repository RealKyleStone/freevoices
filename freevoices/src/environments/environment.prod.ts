export const environment = {
  production: true,
  // server.js serves BOTH the Angular bundle (www/) and /api, so there is one
  // origin and no need for a separate api. subdomain — which is just as well,
  // because api.freevoices.co.za resolves to a non-routable private address.
  //
  // Absolute, not relative: the native shell loads from https://localhost, so
  // '/api' would resolve against that instead of the server.
  apiUrl: 'https://freevoices.co.za/api',
  version: '1.0.0',
  recaptchaSiteKey: '6LecjacqAAAAAH-qxIbyNMeNnvU4fwYcuIxKNKnC',
  bypassCaptcha: false,
};