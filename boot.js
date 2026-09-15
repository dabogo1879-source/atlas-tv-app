/* boot.js — shell versionado de Atlas TV
   Embeber en el APK. Busca app.json remoto; si hay versión superior a la
   del bundle, carga los assets versionados; si no, usa los locales. */
(function () {
  'use strict';
  var BASE = 'https://dabogo1879-source.github.io/atlas-tv-app/';
  var VERSION = 4; /* versión del bundle embebido — recompilar si cambia */
  var MANIFEST = BASE + 'app.json';
  var injected = false;

  function parseManifest() {
    return fetch(MANIFEST, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('no manifest');
        return r.json();
      })
      .catch(function () { return null; });
  }

  function inject(cssUrl, jsUrl) {
    if (injected) return;
    injected = true;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = cssUrl;
    document.head.appendChild(link);
    var script = document.createElement('script');
    script.src = jsUrl;
    document.body.appendChild(script);
  }

  parseManifest().then(function (m) {
    if (m && m.version > VERSION && m.js && m.css) {
      inject(BASE + m.css, BASE + m.js);
    } else {
      inject('styles.css', 'app.js');
    }
  });

  /* actualización en caliente: al volver a primer plano, si subió la
     versión remota recarga la página para tomar los assets nuevos. */
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState !== 'visible') return;
    parseManifest().then(function (m) {
      if (!m || m.version <= VERSION) return;
      var seen = Number(localStorage.getItem('atlas-ver') || 0);
      if (m.version > seen) {
        localStorage.setItem('atlas-ver', m.version);
        location.reload();
      }
    });
  });
})();