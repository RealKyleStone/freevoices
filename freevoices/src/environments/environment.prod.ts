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
  // reCAPTCHA is off on the web build, deliberately.
  //
  // It was never a security boundary here: reCAPTCHA v2 cannot run in the
  // Capacitor shell, so the server has to accept requests that carry no token
  // (see enforceCaptcha in server.js) — which means omitting the token bypasses
  // it entirely. The controls that actually work are the rate limiter and the
  // per-account lockout, both of which are enforced server-side.
  //
  // Against that, keeping it required 'unsafe-inline' in script-src (gutting the
  // main XSS protection), put a Google dependency on the critical login path,
  // and sent every visitor's IP to Google.
  //
  // To re-enable: register this exact site key for freevoices.co.za in the
  // reCAPTCHA admin console (bare hostname, no scheme), confirm it is a v2
  // Invisible key, set this to false, and rebuild. Verify the CSP still holds.
  bypassCaptcha: true,
};