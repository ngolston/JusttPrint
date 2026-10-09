/**
 * Puter sign-in popup (puter-signin.html). Signs in with Puter.js and hands the login token to the
 * library page that opened it (same origin only), then closes. See src/web/ai/puterAuth.ts.
 */
(function () {
  'use strict';

  const MESSAGE = 'justtprint-puter-signin';
  const button = document.getElementById('puter-signin-button');
  const status = document.getElementById('status');

  function show(text, isError) {
    status.textContent = text;
    status.className = isError ? 'error' : '';
  }

  function finish(token) {
    if (!window.opener) {
      show('Signed in. Go back to JusttPrint and try again.');
      return;
    }
    window.opener.postMessage({ type: MESSAGE, token }, window.location.origin);
    show('Signed in. This window closes now.');
    setTimeout(() => window.close(), 600);
  }

  if (!window.puter || !window.puter.auth) {
    button.disabled = true;
    show('Puter.js could not be loaded. Check that this computer can reach js.puter.com.', true);
    return;
  }

  // Signing out from JusttPrint opens this page with ?signout=1.
  if (new URLSearchParams(window.location.search).get('signout') === '1') {
    window.puter.auth.signOut();
    window.close();
    return;
  }

  if (window.puter.auth.isSignedIn() && window.puter.authToken) {
    finish(window.puter.authToken);
    return;
  }

  // Puter opens its own sign-in window, which browsers only allow from a click.
  button.addEventListener('click', async () => {
    button.disabled = true;
    show('Waiting for Puter...');
    try {
      await window.puter.auth.signIn();
      if (!window.puter.authToken) throw new Error('Puter did not return a login.');
      finish(window.puter.authToken);
    } catch (error) {
      button.disabled = false;
      const message = (error && (error.msg || error.message)) || 'Sign-in was cancelled.';
      show(message, true);
    }
  });
})();
