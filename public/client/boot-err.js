// Chatter Bots — early boot error capture. Loaded first, as an EXTERNAL script so the page
// needs no 'unsafe-inline' in its Content-Security-Policy. Records any error thrown before
// the 3D client finishes loading, for diagnostics via window.__bootErr.
(function () {
  window.addEventListener('error', function (e) {
    window.__bootErr = (window.__bootErr || []).concat(
      e.message + ' @ ' + ((e.filename || '').split('/').pop()) + ':' + e.lineno
    );
  });
  window.addEventListener('unhandledrejection', function (e) {
    window.__bootErr = (window.__bootErr || []).concat(
      'REJ:' + ((e.reason && e.reason.stack) || e.reason)
    );
  });
})();
