// service-worker.js — cachet alleen de APP-SHELL (HTML/CSS/JS/iconen),
// zodat de app ook zonder internet opstart op de telefoon.
//
// BELANGRIJK: dit cachet GEEN cliëntdata. Cliënten en aantekeningen staan
// uitsluitend in IndexedDB (zie db.js) en lopen nooit via deze cache.
// Dat betekent: opnames inspreken werkt volledig offline; alleen het
// synchroniseren tussen apparaten (sync.js, Fase 4) vereist internet.

// Ophogen bij elke deploy die de app-shell wijzigt: dat laat de browser
// de oude cache herkennen als verouderd en 'm opruimen in activate().
const CACHE_NAME = 'praktijknotities-shell-v2';

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

  // NETWORK-FIRST: bij internet altijd de nieuwste versie ophalen (en de
  // cache bijwerken) zodat een update van de app niet "vastzit" achter een
  // oude cache — pas als het netwerk faalt (= offline), terugvallen op de
  // laatst gecachte versie. Dat is precies wat "werkt ook offline" vereist
  // zonder de app te laten vastlopen op verouderde bestanden zodra er wél
  // weer verbinding is.
  event.respondWith(
    fetch(request)
      .then(resp => {
        if (resp.ok) {
          const clone = resp.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return resp;
      })
      .catch(() => caches.match(request))
  );
});
