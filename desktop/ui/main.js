// Fallback page: poll the dashboard health once a second, then redirect to it.
(function () {
  var statusEl = document.getElementById("status");
  var tries = 0;
  var invoke = window.__TAURI__ && window.__TAURI__.core && window.__TAURI__.core.invoke;

  // Preferred: ask the Rust side (knows the configured port, no CORS involved).
  function viaTauri() {
    return invoke("dashboard_status").then(function (s) {
      return { url: s.url, healthy: s.healthy };
    });
  }

  // Plain-browser fallback: opaque no-cors probe of the default port.
  function viaFetch() {
    var url = "http://127.0.0.1:4777/";
    return fetch(url + "api/health", { mode: "no-cors", cache: "no-store" }).then(
      function () { return { url: url, healthy: true }; },
      function () { return { url: url, healthy: false }; }
    );
  }

  function tick() {
    tries += 1;
    (invoke ? viaTauri() : viaFetch())
      .then(function (s) {
        if (s.healthy) {
          window.location.replace(s.url);
          return;
        }
        statusEl.textContent = "Waiting for the local server at " + s.url + " (attempt " + tries + ")." +
          (tries > 15 ? " Is Node.js installed and on PATH?" : "");
        setTimeout(tick, 1000);
      })
      .catch(function (err) {
        statusEl.textContent = "Health check failed: " + err;
        setTimeout(tick, 1000);
      });
  }

  tick();
})();
