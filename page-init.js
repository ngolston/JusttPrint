'use strict';

/**
 * Page wiring that used to sit in inline <script> blocks and onclick="" attributes in
 * index.html (the Content Security Policy only runs scripts from files: script-src 'self'):
 * the loading overlay. Loaded at the end of <body>, after the other app scripts.
 */
(function () {
  // Loading overlay: "Continue anyway" hides it.
  document.getElementById('continue-anyways')?.addEventListener('click', () => {
    const overlay = document.getElementById('loading-overlay');
    if (overlay) overlay.style.display = 'none';
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
})();
