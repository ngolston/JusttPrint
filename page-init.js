'use strict';

/**
 * Page wiring that used to sit in inline <script> blocks and onclick="" attributes in
 * index.html. The Content Security Policy only runs scripts from files (script-src 'self'),
 * so markup declares what a control does with data attributes and this file attaches it:
 *
 *   data-close-dialog="dialog-id"   closes that <dialog> (works for markup added later too)
 *
 * Loaded at the end of <body>, after the other app scripts.
 */
(function () {
  // Close buttons, including ones other scripts add later.
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-close-dialog]');
    if (!button) return;
    const dialog = document.getElementById(button.dataset.closeDialog);
    if (dialog && typeof dialog.close === 'function') dialog.close();
  });

  // Loading overlay: "Continue anyway" hides it.
  document.getElementById('continue-anyways')?.addEventListener('click', () => {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'none';
  });

  // Toolbar buttons.
  const send = (channel) => () => window.electron && window.electron.send(channel);
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('dup-button')?.addEventListener('click', send('open-dedup'));
    document.getElementById('tag-button')?.addEventListener('click', send('open-tag-manager'));
    document.getElementById('filament-button')?.addEventListener('click', send('open-filament-manager'));
    document.getElementById('roulette-button')?.addEventListener('click', send('start-print-roulette'));
  });

  // Loading overlay: rotate the message every 5 seconds while it is visible.
  document.addEventListener('DOMContentLoaded', () => {
    const loadingMessage = document.querySelector('#loading-overlay .spinner p');
    const messages = [
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
    const intervalId = setInterval(() => {
      if (!loadingMessage || loadingMessage.offsetParent === null) {
        clearInterval(intervalId);
        return;
      }
      loadingMessage.textContent = messages[Math.floor(Math.random() * messages.length)];
    }, 5000);
  });

  // Welcome dialog: dismiss, then open the guide.
  document.getElementById('dismiss-welcome')?.addEventListener('click', () => {
    document.getElementById('welcome-message')?.close();
    setTimeout(() => {
      if (typeof window.showGuide === 'function') window.showGuide();
    }, 500);
  });
})();
