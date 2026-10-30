/*
 * The color scheme before the first paint, from what the last visit chose (startup/theme.ts keeps
 * it in localStorage; the saved setting replaces it once it loads). Without it, a dark-scheme page
 * would flash light while loading.
 */
(function () {
  var preference = 'light';
  try {
    preference = localStorage.getItem('jp-color-scheme') || 'light';
  } catch (_) {
    /* storage refused: light until the setting loads */
  }
  var dark = preference === 'dark' || (preference === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-color-scheme', dark ? 'dark' : 'light');
})();
