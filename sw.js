/* Service Worker – macht die App offline nutzbar.
 *
 * WICHTIG BEIM DEPLOYEN: Nach jeder Änderung an index.html, styles.css oder
 * app.js die VERSION unten hochzählen. Sonst behalten bereits installierte
 * Geräte unter Umständen den alten Stand.
 */
const VERSION = 'v5';
const CACHE = 'boulder-' + VERSION;

/* Alles, was die App zum Starten braucht. Wird bei der Installation
 * einmal komplett geladen und liegt danach auf dem Gerät. */
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.json',
  './assets/fonts/dm-sans-var.woff2',
  './assets/fonts/dm-mono-400.woff2',
  './assets/fonts/dm-mono-500.woff2',
  './assets/icons/icon-192.png',
  './assets/icons/icon-512.png',
  './assets/icons/apple-touch-icon.png'
];

/* Schriften und Icons ändern sich praktisch nie -> zuerst aus dem Speicher.
 * Für den Rest (HTML/CSS/JS) gilt: zuerst Netz, siehe unten. */
const IMMUTABLE = /\/assets\/(fonts|icons)\//;

/* Wie lange auf das Netz gewartet wird, bevor auf den Speicher
 * zurückgefallen wird. Zielt auf den Fall "eine Ecke Empfang in der Halle",
 * der schlimmer ist als gar kein Empfang: ein hängender Request würde die
 * App sonst minutenlang blockieren. */
const NET_TIMEOUT_MS = 2500;

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith('boulder-') && k !== CACHE)
            .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

function fromCache(request) {
  return caches.match(request, { ignoreSearch: true });
}

function putInCache(request, response) {
  const copy = response.clone();
  caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
}

/* Zuerst aus dem Speicher, im Hintergrund auffrischen. */
function cacheFirst(request) {
  return fromCache(request).then(cached => {
    if (cached) return cached;
    return fetch(request).then(res => {
      if (res && res.ok) putInCache(request, res);
      return res;
    });
  });
}

/* Zuerst Netz, aber mit Deckel: Wer online ist, bekommt immer den frischen
 * Stand; wer kein oder schlechtes Netz hat, bekommt nach spätestens
 * NET_TIMEOUT_MS die gespeicherte Fassung. */
function networkFirst(request) {
  return new Promise(resolve => {
    let settled = false;
    const finish = res => { if (!settled && res) { settled = true; resolve(res); } };

    const timer = setTimeout(() => {
      fromCache(request).then(finish);
    }, NET_TIMEOUT_MS);

    fetch(request).then(res => {
      clearTimeout(timer);
      if (res && res.ok) putInCache(request, res);
      finish(res);
    }).catch(() => {
      clearTimeout(timer);
      fromCache(request).then(cached => {
        if (cached) return finish(cached);
        // Beim Öffnen der App offline und ohne Treffer: auf den Einstieg zurückfallen
        if (request.mode === 'navigate') {
          return caches.match('./').then(root => finish(root || Response.error()));
        }
        finish(Response.error());
      });
    });
  });
}

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;
  // Nur eigene Dateien; alles Fremde unangetastet durchreichen
  if (new URL(request.url).origin !== self.location.origin) return;

  event.respondWith(
    IMMUTABLE.test(request.url) ? cacheFirst(request) : networkFirst(request)
  );
});
