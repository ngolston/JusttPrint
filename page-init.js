'use strict';

/**
 * Page wiring that used to sit in inline <script> blocks and onclick="" attributes in
 * index.html. The Content Security Policy only runs scripts from files (script-src 'self'),
 * so markup declares what a control does with data attributes and this file attaches it:
 *
 *   data-close-dialog="dialog-id"   closes that <dialog> (works for markup added later too)
 *   data-action="functionName"      calls window.functionName() if the page defines it
 *
 * Loaded at the end of <body>, after the other app scripts.
 */
(function () {
  // Close buttons, including ones other scripts add later (preview.js builds some).
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-close-dialog]');
    if (!button) return;
    const dialog = document.getElementById(button.dataset.closeDialog);
    if (dialog && typeof dialog.close === 'function') dialog.close();
  });

  // Buttons that call a page function. Attached directly (not delegated) so they run before
  // listeners other scripts add on DOMContentLoaded, as the inline handlers did.
  document.querySelectorAll('[data-action]').forEach((element) => {
    element.addEventListener('click', (event) => {
      const action = window[element.dataset.action];
      if (typeof action === 'function') action(event);
    });
  });

  // Test AI settings: the button sits inside the settings form; keep the click to itself.
  document.getElementById('test-ai-config')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (typeof window.testAIConfigFromDialog === 'function') window.testAIConfigFromDialog();
  });

  // STL Home: gray out the path-metadata options after the checkbox has changed.
  document.getElementById('stl-home-path-metadata-enabled')?.addEventListener('click', () => {
    setTimeout(() => {
      if (window.updateStlHomePathMetadataGrayed) window.updateStlHomePathMetadataGrayed();
    }, 0);
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
