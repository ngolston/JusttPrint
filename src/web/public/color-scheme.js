/*
 * The color scheme before the first paint, from what the last visit chose (startup/theme.ts keeps
 * it in localStorage; the saved setting replaces it once it loads). Without it, a light-theme page
 * would flash dark while loading.
 */
(function () {
  var preference = 'dark';
  try {
    preference = localStorage.getItem('jp-color-scheme') || 'dark';
  } catch (_) {
    /* storage refused: dark until the setting loads */
  }
  var light = preference === 'light' || (preference === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches);
  document.documentElement.setAttribute('data-color-scheme', light ? 'light' : 'dark');
})();
