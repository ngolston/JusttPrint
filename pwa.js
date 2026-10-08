/**
 * Register the minimal service worker (sw.js), which some browsers want before they offer to
 * install JusttPrint. It handles no requests: every page load goes to the network as before
 * (an older worker that cached pages hung Docker tabs).
 */
(function () {
  const isHttp = location.protocol === 'http:' || location.protocol === 'https:';
  if (!isHttp || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
})();
