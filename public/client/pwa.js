/* Registers the root-scope service worker so Chatter Bots is installable.
   Kept in its own file because the page CSP is script-src 'self' (no inline scripts). */
(function () {
  'use strict';
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(function () { /* non-fatal */ });
  });
})();
