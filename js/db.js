// ==========================================================================
// db.js — LOKALE OPSLAG LAAG
//
// WAAR WORDT DATA OPGESLAGEN?
//   Alle cliënt- en aantekeningdata wordt opgeslagen in IndexedDB, in de
//   database "praktijknotities-db", binnen het browserprofiel van dit
//   apparaat. Dit is lokale opslag: de data verlaat het apparaat NIET via
//   deze module. Audio wordt als Blob rechtstreeks in IndexedDB bewaard
//   (geen los bestandssysteem nodig).
//
//   Vanaf Fase 3 worden de velden die persoonsgegevens bevatten (naam,
//   notitie, transcript, audio) vóór opslag versleuteld door crypto.js —
//   deze module (db.js) weet niet of de waarden versleuteld zijn of niet,
//   ze slaat op wat haar gegeven wordt. Zie crypto.js voor de audit-trail
//   van versleuteling.
//
//   Vanaf Fase 4 leest sync.js dezelfde object stores uit om gewijzigde
//   records naar de server te sturen (altijd al versleuteld, zie sync.js).
//
// OBJECT STORES
//   clients: { id, name, note, createdAt, updatedAt, deleted }
//   notes:   { id, clientId, createdAt, updatedAt, transcript, audioBlob,
//              mimeType, durationSec, deleted }
//   meta:    { key, value }  — instellingen, auth-materiaal (Fase 3),
//              sync-cursor (Fase 4). Nooit cliëntdata.
// ==========================================================================

const DB_NAME = 'praktijknotities-db';
const DB_VERSION = 1;

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;

      if (!db.objectStoreNames.contains('clients')) {
        const store = db.createObjectStore('clients', { keyPath: 'id' });
        store.createIndex('name', 'name');
        store.createIndex('updatedAt', 'updatedAt');
      }

      if (!db.objectStoreNames.contains('notes')) {
        const store = db.createObjectStore('notes', { keyPath: 'id' });
        store.createIndex('clientId', 'clientId');
        store.createIndex('createdAt', 'createdAt');
        store.createIndex('updatedAt', 'updatedAt');
      }

      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode) {
  return openDb().then(db => db.transaction(storeName, mode).objectStore(storeName));
}

function promisifyRequest(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export const db = {
  async put(storeName, value) {
    const store = await tx(storeName, 'readwrite');
    return promisifyRequest(store.put(value));
  },

  async get(storeName, key) {
    const store = await tx(storeName, 'readonly');
    return promisifyRequest(store.get(key));
  },

  async delete(storeName, key) {
    const store = await tx(storeName, 'readwrite');
    return promisifyRequest(store.delete(key));
  },

  async getAll(storeName) {
    const store = await tx(storeName, 'readonly');
    return promisifyRequest(store.getAll());
  },

  async getAllByIndex(storeName, indexName, query) {
    const store = await tx(storeName, 'readonly');
    return promisifyRequest(store.index(indexName).getAll(query));
  },
};
