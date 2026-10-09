/**
 * Page wiring outside React (the page's CSP runs no inline scripts): the loading overlay's
 * "Continue anyway" button and its rotating messages, and the minimal service worker (sw.js),
 * which some browsers want before they offer to install JusttPrint. The worker handles no
 * requests: every page load goes to the network (an older worker that cached pages hung tabs).
 */

const LOADING_MESSAGES = [
  'Layering up your models...',
  'Slicing through the data...',
  'Extruding models for you...',
  'Assembling your assets...',
  'Loading model database...',
  'Rendering your repositories...',
  'Constructing your creations...',
  'Manifesting your models...',
  'Loading your models...',
  'Preparing your prints...',
  'Optimizing your assets...',
  'Compiling your collections...'
];

export function initPage() {
  document.getElementById('continue-anyways')?.addEventListener('click', () => {
    document.getElementById('loading-overlay')?.style.setProperty('display', 'none');
  });

  // A new message every 5 seconds while the overlay shows.
  const message = document.querySelector<HTMLElement>('#loading-overlay .spinner p');
  const interval = setInterval(() => {
    if (!message || message.offsetParent === null) {
      clearInterval(interval);
      return;
    }
    message.textContent = LOADING_MESSAGES[Math.floor(Math.random() * LOADING_MESSAGES.length)];
  }, 5000);

  const isHttp = location.protocol === 'http:' || location.protocol === 'https:';
  if (isHttp && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
}
