// service-worker.js — cachet alleen de APP-SHELL (HTML/CSS/JS/iconen),
// zodat de app ook zonder internet opstart op de telefoon.
//
// BELANGRIJK: dit cachet GEEN cliëntdata. Cliënten en aantekeningen staan
// uitsluitend in IndexedDB (zie db.js) en lopen nooit via deze cache.
// Dat betekent: opnames inspreken werkt volledig offline; alleen het
// synchroniseren tussen apparaten (sync.js, Fase 4) vereist internet.

const CACHE_NAME = 'praktijknotities-shell-v1';

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css',
  './js/app.js',
  './js/db.js',
  './js/utils.js',
  './js/clients.js',
  './js/notes.js',
  './js/recorder.js',
  './js/transcription.js',
  './js/nameMatch.js',
  './js/crypto.js',
  './js/auth.js',
  './js/sync.js',
  './js/sharing.js',
  './icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.allSettled(SHELL_FILES.map(f => cache.add(f))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(names =>
      Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // nooit externe requests cachen/afvangen

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request)
        .then(resp => {
          if (resp.ok) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return resp;
        })
        .catch(() => cached);
    })
  );
});
