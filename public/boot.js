// This guard runs independently of the module graph. A missing file after an
// update, or a browser that cannot evaluate a module, must not leave the splash
// screen visible forever.
(function () {
  var screen = document.getElementById('boot-screen');
  if (!screen) return;
  var timer;
  function stop() {
    clearTimeout(timer);
    window.removeEventListener('error', failedScript, true);
    document.removeEventListener('watchlocal-ready', stop);
  }
  function showError(message) {
    stop();
    if (!screen.isConnected) return;
    screen.className = 'boot boot-error';
    screen.innerHTML = '<img class="brand-mark" src="/brand.svg" alt="watch.local" width="422" height="72"><h1>Unable to open your library</h1><p role="alert"></p><button class="btn primary" type="button">Try again</button><a class="text-link" href="/health" target="_blank" rel="noopener">Check server status</a>';
    screen.querySelector('p').textContent = message;
    screen.querySelector('button').onclick = function () { location.reload(); };
  }
  function failedScript(event) {
    // HLS is only needed during playback; a failed video library must not
    // prevent browsing. The module entry also reports failed imported files.
    if (event.target && event.target.tagName === 'SCRIPT' && /\/app\.js(?:\?|$)/.test(event.target.src)
      || event.filename && /\/(?:app\.js|[^/]+\.mjs)(?:\?|$)/.test(event.filename)) {
      showError('The app could not start. Reload this page. If this began after an update, restart watch.local on the server. An older browser may also need an update.');
    }
  }
  window.addEventListener('error', failedScript, true);
  document.addEventListener('watchlocal-ready', stop);
  timer = setTimeout(function () {
    showError('The app is taking too long to start. Check that the server is running, then try again.');
  }, 20000);
})();
