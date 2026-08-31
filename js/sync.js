// ==========================================================================
// sync.js — SYNCHRONISATIE TUSSEN APPARATEN (aparte, afgebakende module)
//
// Dit is de ENIGE module die over het netwerk praat, samen met sharing.js
// (delen met een collega — zie dat bestand voor het cross-account-verhaal).
// Alle andere modules (db.js, crypto.js, clients.js, notes.js, auth.js)
// werken volledig lokaal en blijven werken als deze module nooit wordt
// aangeroepen — sync is dus nooit een vereiste om lokaal in te spreken of
// aantekeningen te bekijken, alleen om ze tussen telefoon en computer van
// DEZELFDE psycholoog te delen.
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
import * as Sharing from './sharing.js';
import {
  bytesToBase64, base64ToBytes, apiCall,
  serializeEnc, deserializeEnc, serializeClientRecord, deserializeClientRecord,
  serializeNoteRecord, deserializeNoteRecord,
} from './utils.js';

const META_KEY = 'syncAccount';

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
  await Sharing.ensureKeypairSynced();
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
  await Sharing.ensureKeypairSynced();
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

  await Sharing.ensureKeypairSynced(); // self-healing: publiceert alsnog als dat eerder niet lukte

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

  // Sleutels van gedeelde cliënten eerst opslaan, vóórdat de bijbehorende
  // (gedeelde) records ontsleuteld/weggeschreven worden — anders zou
  // Clients.putRawClientRecords niets fout doen (het schrijft alleen
  // ciphertext weg), maar zou een latere decrypt-poging in de UI stuklopen
  // omdat getKeyForClient de sleutel nog niet kent.
  for (const grant of pulled.sharedKeys || []) {
    await Crypto.storeSharedClientKey(grant.clientId, base64ToBytes(grant.wrappedKey));
  }

  await Clients.putRawClientRecords(pulled.clients.map(deserializeClientRecord));
  await Notes.putRawNoteRecords(pulled.notes.map(deserializeNoteRecord));

  await saveAccountState({ ...account, lastSyncAt: pulled.serverTime });
  return { pushed: dirtyClients.length + dirtyNotes.length, pulled: pulled.clients.length + pulled.notes.length };
}
