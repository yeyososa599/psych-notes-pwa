// ==========================================================================
// sync.js — SYNCHRONISATIE TUSSEN APPARATEN (aparte, afgebakende module)
//
// Dit is de ENIGE module die over het netwerk praat. Alle andere modules
// (db.js, crypto.js, clients.js, notes.js, auth.js) werken volledig lokaal
// en blijven werken als deze module nooit wordt aangeroepen — sync is dus
// nooit een vereiste voor het lokaal inspreken/bekijken van aantekeningen,
// alleen voor het delen ervan tussen telefoon en computer.
//
// WAT VERLAAT HET APPARAAT via deze module:
//   - Bij registratie/login: e-mailadres + een AFGELEID "inlogbewijs"
//     (nooit het wachtwoord zelf, zie crypto.js deriveLoginProof) + een
//     versleutelde ("gewrapte") kopie van de datasleutel.
//   - Bij push: cliënt-/aantekeningrecords, ALTIJD al AES-GCM-versleuteld
//     door crypto.js vóórdat ze hier binnenkomen (via clients.js/notes.js
//     se "Raw"-functies, die zelf nooit ontsleutelen).
// Er verlaat dus nooit een leesbare naam, notitie, transcript of audio-
// fragment dit apparaat. Zie server/server.js voor de serverkant van dit
// contract.
//
// OFFLINE-EERST: als er geen internet is (of geen sync is ingesteld) werkt
// de rest van de app gewoon door — nieuwe aantekeningen blijven lokaal
// staan (met een bijgewerkte updatedAt) totdat een volgende sync-poging
// slaagt.
// ==========================================================================

import { db } from './db.js';
import * as Crypto from './crypto.js';
import * as Clients from './clients.js';
import * as Notes from './notes.js';

const META_KEY = 'syncAccount';

// --------------------------------------------------------------------
// Base64-helpers (chunked, zodat ook grote audio-Blobs geen stack-
// overflow veroorzaken bij het coderen).
// --------------------------------------------------------------------

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function serializeEnc(enc) {
  if (!enc) return null;
  return { iv: bytesToBase64(enc.iv), data: bytesToBase64(enc.data), ...(enc.mimeType ? { mimeType: enc.mimeType } : {}) };
}

function deserializeEnc(enc) {
  if (!enc) return null;
  return { iv: base64ToBytes(enc.iv), data: base64ToBytes(enc.data), ...(enc.mimeType ? { mimeType: enc.mimeType } : {}) };
}

function serializeClientRecord(r) {
  if (r.deleted) return { id: r.id, deleted: true, createdAt: r.createdAt, updatedAt: r.updatedAt };
  return {
    id: r.id, deleted: false, createdAt: r.createdAt, updatedAt: r.updatedAt,
    encName: serializeEnc(r.encName), encNote: serializeEnc(r.encNote),
  };
}
function deserializeClientRecord(r) {
  if (r.deleted) return { id: r.id, deleted: true, createdAt: r.createdAt, updatedAt: r.updatedAt };
  return {
    id: r.id, deleted: false, createdAt: r.createdAt, updatedAt: r.updatedAt,
    encName: deserializeEnc(r.encName), encNote: deserializeEnc(r.encNote),
  };
}

function serializeNoteRecord(r) {
  if (r.deleted) return { id: r.id, clientId: r.clientId, deleted: true, createdAt: r.createdAt, updatedAt: r.updatedAt };
  return {
    id: r.id, clientId: r.clientId, deleted: false, createdAt: r.createdAt, updatedAt: r.updatedAt,
    durationSec: r.durationSec, encTranscript: serializeEnc(r.encTranscript), encAudio: serializeEnc(r.encAudio),
  };
}
function deserializeNoteRecord(r) {
  if (r.deleted) return { id: r.id, clientId: r.clientId, deleted: true, createdAt: r.createdAt, updatedAt: r.updatedAt };
  return {
    id: r.id, clientId: r.clientId, deleted: false, createdAt: r.createdAt, updatedAt: r.updatedAt,
    durationSec: r.durationSec, encTranscript: deserializeEnc(r.encTranscript), encAudio: deserializeEnc(r.encAudio),
  };
}

// --------------------------------------------------------------------
// Account-status (lokaal opgeslagen in IndexedDB meta-store; bevat GEEN
// wachtwoord, alleen serverURL/e-mail/sessietoken/salt/laatste-syncmoment)
// --------------------------------------------------------------------

export async function getAccountState() {
  const rec = await db.get('meta', META_KEY);
  return rec ? rec.value : null;
}

async function saveAccountState(value) {
  await db.put('meta', { key: META_KEY, value });
}

export async function isEnabled() {
  return !!(await getAccountState());
}

export async function signOut() {
  await db.delete('meta', META_KEY);
}

// --------------------------------------------------------------------
// Registratie / login
// --------------------------------------------------------------------

async function apiCall(serverUrl, path, { method = 'GET', body, token } = {}) {
  const res = await fetch(serverUrl.replace(/\/$/, '') + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Serverfout (${res.status})`);
  return data;
}

/** Nieuw sync-account aanmaken. Vereist dat de app al lokaal ontgrendeld is. */
export async function registerAccount(serverUrl, email, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = 210_000;
  const wrapped = await Crypto.wrapDekWithPassword(password, salt, iterations);
  const loginProof = await Crypto.deriveLoginProof(password, salt, iterations);

  const { sessionToken } = await apiCall(serverUrl, '/api/register', {
    method: 'POST',
    body: {
      email,
      encSalt: bytesToBase64(salt),
      iterations,
      wrappedDek: serializeEnc(wrapped),
      loginProof: bytesToBase64(loginProof),
    },
  });

  await saveAccountState({ serverUrl, email, sessionToken, encSalt: salt, iterations, lastSyncAt: null });
}

/**
 * Inloggen op een BESTAAND account (typisch: tweede apparaat). Zet de
 * gedeelde DEK actief. Als dit apparaat nog geen lokale pincode heeft,
 * moet daarna Crypto.setupPinForExistingDek(pin) aangeroepen worden
 * (zie auth.js) — dat gebeurt hier bewust niet, want dat is een UI-keuze.
 */
export async function loginAccount(serverUrl, email, password) {
  const { encSalt, iterations } = await apiCall(serverUrl, '/api/login/salt', {
    method: 'POST', body: { email },
  });
  const salt = base64ToBytes(encSalt);
  const loginProof = await Crypto.deriveLoginProof(password, salt, iterations);

  const { sessionToken, wrappedDek } = await apiCall(serverUrl, '/api/login', {
    method: 'POST', body: { email, loginProof: bytesToBase64(loginProof) },
  });

  await Crypto.unwrapDekWithPassword(deserializeEnc(wrappedDek), password, salt, iterations);
  await saveAccountState({ serverUrl, email, sessionToken, encSalt: salt, iterations, lastSyncAt: null });
}

// --------------------------------------------------------------------
// Push + pull
// --------------------------------------------------------------------

/**
 * Synchroniseert nu. Faalt stil-ish (gooit een fout die de aanroeper kan
 * tonen) als er geen internet is — de rest van de app blijft ondertussen
 * gewoon lokaal werken.
 */
export async function syncNow() {
  const account = await getAccountState();
  if (!account) throw new Error('Sync is niet ingesteld.');

  const [rawClients, rawNotes] = await Promise.all([
    Clients.getAllClientsRaw(),
    Notes.getAllNotesRaw(),
  ]);

  const since = account.lastSyncAt;
  const dirtyClients = rawClients.filter(r => !since || r.updatedAt > since).map(serializeClientRecord);
  const dirtyNotes = rawNotes.filter(r => !since || r.updatedAt > since).map(serializeNoteRecord);

  if (dirtyClients.length || dirtyNotes.length) {
    await apiCall(account.serverUrl, '/api/sync/push', {
      method: 'POST', token: account.sessionToken,
      body: { clients: dirtyClients, notes: dirtyNotes },
    });
  }

  const pulled = await apiCall(account.serverUrl, `/api/sync/pull?since=${encodeURIComponent(since || '')}`, {
    token: account.sessionToken,
  });

  await Clients.putRawClientRecords(pulled.clients.map(deserializeClientRecord));
  await Notes.putRawNoteRecords(pulled.notes.map(deserializeNoteRecord));

  await saveAccountState({ ...account, lastSyncAt: pulled.serverTime });
  return { pushed: dirtyClients.length + dirtyNotes.length, pulled: pulled.clients.length + pulled.notes.length };
}
