// ==========================================================================
// crypto.js — VERSLEUTELING (Web Crypto API, geen externe crypto-library)
//
// OPZET ("zero-knowledge" ten opzichte van elke toekomstige server, zie
// sync.js):
//   1. Bij het instellen van een pincode wordt een willekeurige DEK
//      (Data Encryption Key, AES-GCM 256) gegenereerd. DEZE sleutel
//      versleutelt alle cliënt- en aantekeningdata.
//   2. De DEK wordt zelf versleuteld ("gewrapt") met een KEK (Key
//      Encryption Key) die wordt afgeleid van de pincode via PBKDF2
//      (210.000 iteraties, SHA-256) + een willekeurig salt.
//   3. Alleen de GEWRAPTE (versleutelde) DEK, het salt en de PBKDF2-
//      parameters worden opgeslagen (in IndexedDB, store "meta", zie
//      db.js) — nooit de pincode zelf, nooit de DEK in leesbare vorm.
//   4. Bij ontgrendelen wordt de KEK opnieuw afgeleid uit de ingevoerde
//      pincode en wordt geprobeerd de gewrapte DEK te ontsleutelen. Lukt
//      dit (AES-GCM authenticatie-tag klopt), dan was de pincode juist en
//      staat de DEK weer (alleen) in het geheugen van deze sessie — nooit
//      op schijf.
//   5. Waarom een aparte DEK i.p.v. direct met de KEK versleutelen? Zo kan
//      de pincode gewijzigd worden (changePin) door alleen de wrap opnieuw
//      te doen, zonder alle opgeslagen data opnieuw te hoeven versleutelen.
//
// Dit ontwerp betekent: zelfs de partij die de (toekomstige, Fase 4)
// server host kan de inhoud niet lezen, want die krijgt alleen
// AES-GCM-ciphertext te zien — de sleutel verlaat dit apparaat nooit.
//
// WAT wordt hiermee versleuteld (zie clients.js / notes.js):
//   client.name, client.note, note.transcript, note.audioBlob.
// WAT NIET (blijft plaintext, nodig voor IndexedDB-indexering, niet an
// sich herleidbaar tot een persoon):
//   id's, clientId (foreign key, willekeurige UUID), createdAt/updatedAt,
//   durationSec, mimeType, deleted-vlag.
// ==========================================================================

import { db } from './db.js';

const PBKDF2_ITERATIONS = 210_000;
const AES_ALGO = 'AES-GCM';
const IV_BYTES = 12;

let dek = null; // De ontgrendelde sleutel leeft UITSLUITEND in het geheugen.

// --------------------------------------------------------------------
// Sleutelbeheer
// --------------------------------------------------------------------

async function deriveKek(pin, salt, iterations) {
  const baseKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    baseKey,
    { name: AES_ALGO, length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function wrapDek(dekToWrap, kek) {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const raw = await crypto.subtle.exportKey('raw', dekToWrap);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: AES_ALGO, iv }, kek, raw));
  return { iv, data };
}

async function unwrapDek(wrapped, kek) {
  // Gooit een fout als de sleutel niet klopt (verkeerde pincode) — dat IS
  // de verificatie, er is geen apart "wachtwoord-hash" nodig.
  const raw = await crypto.subtle.decrypt({ name: AES_ALGO, iv: wrapped.iv }, kek, wrapped.data);
  return crypto.subtle.importKey('raw', raw, { name: AES_ALGO }, true, ['encrypt', 'decrypt']);
}

export async function isSetup() {
  return !!(await db.get('meta', 'auth'));
}

export function isUnlocked() {
  return dek !== null;
}

export function lock() {
  dek = null;
}

/** Eerste keer: pincode instellen. Ontgrendelt meteen na aanmaken. */
export async function setupPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = PBKDF2_ITERATIONS;
  const kek = await deriveKek(pin, salt, iterations);
  const newDek = await crypto.subtle.generateKey({ name: AES_ALGO, length: 256 }, true, ['encrypt', 'decrypt']);
  const wrapped = await wrapDek(newDek, kek);
  await db.put('meta', { key: 'auth', value: { salt, iterations, wrapped } });
  dek = newDek;
}

/** @returns {Promise<boolean>} true als de pincode klopte (app is nu ontgrendeld). */
export async function unlockWithPin(pin) {
  const rec = await db.get('meta', 'auth');
  if (!rec) return false;
  const { salt, iterations, wrapped } = rec.value;
  try {
    const kek = await deriveKek(pin, salt, iterations);
    dek = await unwrapDek(wrapped, kek);
    return true;
  } catch {
    return false;
  }
}

/** Wijzigt de pincode. De onderliggende DEK (en dus alle data) blijft gelijk. */
export async function changePin(oldPin, newPin) {
  const ok = await unlockWithPin(oldPin);
  if (!ok) return false;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = PBKDF2_ITERATIONS;
  const kek = await deriveKek(newPin, salt, iterations);
  const wrapped = await wrapDek(dek, kek);
  await db.put('meta', { key: 'auth', value: { salt, iterations, wrapped } });
  return true;
}

/**
 * Stelt een lokale pincode in voor de HUIDIGE (al ontgrendelde) DEK, zonder
 * een nieuwe DEK te genereren. Nodig wanneer een tweede apparaat via
 * sync.js inlogt op een bestaand account: dat apparaat moet dezelfde DEK
 * gebruiken als het eerste apparaat (anders kan het diens versleutelde
 * data nooit lezen), maar krijgt wél zijn eigen lokale pincode voor snel
 * dagelijks ontgrendelen.
 */
export async function setupPinForExistingDek(pin) {
  requireUnlocked();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iterations = PBKDF2_ITERATIONS;
  const kek = await deriveKek(pin, salt, iterations);
  const wrapped = await wrapDek(dek, kek);
  await db.put('meta', { key: 'auth', value: { salt, iterations, wrapped } });
}

// --------------------------------------------------------------------
// Sleuteldeling tussen apparaten (gebruikt door sync.js — Fase 4)
//
// De DEK verlaat dit apparaat NOOIT in leesbare vorm. Om de DEK toch
// veilig te delen tussen de telefoon en de computer van dezelfde
// psycholoog, wordt een TWEEDE, aparte gewrapte kopie gemaakt — ditmaal
// met een sleutel afgeleid van het sync-accountwachtwoord (los van de
// lokale pincode). Alleen deze gewrapte kopie (onleesbare ciphertext)
// wordt via de server gedeeld; zie sync.js voor het registratie/login-
// protocol en server/server.js voor wat de server daadwerkelijk opslaat
// (nooit het wachtwoord, nooit de sleutel zelf).
// --------------------------------------------------------------------

/** Wrapt de huidige (ontgrendelde) DEK met een van het sync-wachtwoord afgeleide sleutel. */
export async function wrapDekWithPassword(password, salt, iterations) {
  requireUnlocked();
  const kek = await deriveKek(password, salt, iterations);
  return wrapDek(dek, kek);
}

/** Ontgrendelt (zet de actieve DEK) met een gewrapte kopie + het sync-wachtwoord. Gooit een fout bij een onjuist wachtwoord. */
export async function unwrapDekWithPassword(wrapped, password, salt, iterations) {
  const kek = await deriveKek(password, salt, iterations);
  dek = await unwrapDek(wrapped, kek); // gooit bij verkeerd wachtwoord (AES-GCM auth-tag mismatch)
}

/**
 * Leidt een "inlogbewijs" af van het sync-wachtwoord — dit is NIET het
 * wachtwoord zelf en NIET de KEK die de DEK wrapt, maar een derde,
 * cryptografisch onafhankelijke afleiding (andere PBKDF2-context) die wél
 * naar de server mag om in te loggen. De server slaat hier op zijn beurt
 * weer een bcrypt-hash van op — het wachtwoord zelf komt dus nooit ergens
 * in leesbare vorm terecht, ook niet tijdens transport.
 */
export async function deriveLoginProof(password, salt, iterations) {
  const baseKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode('login:' + password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, baseKey, 256
  );
  return new Uint8Array(bits);
}

// --------------------------------------------------------------------
// Veld- en Blob-encryptie (gebruikt de ontgrendelde DEK uit het geheugen)
// --------------------------------------------------------------------

function requireUnlocked() {
  if (!dek) throw new Error('App is vergrendeld — kan niet (ont)versleutelen zonder geldige pincode.');
}

export async function encryptField(plaintext) {
  requireUnlocked();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new Uint8Array(
    await crypto.subtle.encrypt({ name: AES_ALGO, iv }, dek, new TextEncoder().encode(plaintext ?? ''))
  );
  return { iv, data };
}

export async function decryptField(enc) {
  if (!enc) return '';
  requireUnlocked();
  const buf = await crypto.subtle.decrypt({ name: AES_ALGO, iv: enc.iv }, dek, enc.data);
  return new TextDecoder().decode(buf);
}

export async function encryptBlob(blob) {
  requireUnlocked();
  const buf = await blob.arrayBuffer();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: AES_ALGO, iv }, dek, buf));
  return { iv, data, mimeType: blob.type };
}

export async function decryptBlob(enc) {
  requireUnlocked();
  const buf = await crypto.subtle.decrypt({ name: AES_ALGO, iv: enc.iv }, dek, enc.data);
  return new Blob([buf], { type: enc.mimeType });
}

// --------------------------------------------------------------------
// Biometrisch ontgrendelen (WebAuthn PRF-extensie) — BEST EFFORT
//
// Web Crypto/WebAuthn geeft normaliter geen herbruikbaar geheim terug; dat
// kan alleen via de PRF-extensie (ondersteuning varieert per platform/
// browserversie). Is PRF niet beschikbaar, dan verschijnt de biometrie-
// knop simpelweg niet (zie auth.js) en blijft de pincode altijd de
// gegarandeerde ontgrendelmethode.
// --------------------------------------------------------------------

const PRF_SALT = new TextEncoder().encode('praktijknotities-prf-salt-v1');

export async function isBiometricSupported() {
  if (!window.PublicKeyCredential) return false;
  try {
    return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

/** Registreert een platform-credential en wrapt de huidige DEK ermee. Vereist dat de app al ontgrendeld is. */
export async function registerBiometric() {
  requireUnlocked();
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rp: { name: 'Praktijknotities' },
      user: {
        id: crypto.getRandomValues(new Uint8Array(16)),
        name: 'psycholoog',
        displayName: 'Psycholoog',
      },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required' },
      extensions: { prf: {} },
      timeout: 60000,
    },
  });
  if (!cred) throw new Error('WebAuthn-registratie geannuleerd');

  const prfEnabled = cred.getClientExtensionResults()?.prf?.enabled;
  if (!prfEnabled) throw new Error('Deze authenticator ondersteunt geen PRF — biometrisch ontgrendelen niet mogelijk.');

  const kek = await deriveKekFromAssertion(cred.rawId);
  if (!kek) throw new Error('Kon geen sleutel afleiden van de authenticator.');
  const wrapped = await wrapDek(dek, kek);

  await db.put('meta', {
    key: 'authBiometric',
    value: { credentialId: new Uint8Array(cred.rawId), wrapped },
  });
}

export async function isBiometricRegistered() {
  return !!(await db.get('meta', 'authBiometric'));
}

async function deriveKekFromAssertion(credentialIdBytes) {
  const assertion = await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ type: 'public-key', id: credentialIdBytes }],
      userVerification: 'required',
      extensions: { prf: { eval: { first: PRF_SALT } } },
      timeout: 60000,
    },
  });
  const prfResult = assertion?.getClientExtensionResults()?.prf?.results?.first;
  if (!prfResult) return null;
  // PRF-output is 32 bytes ruwe entropie — direct bruikbaar als AES-sleutel.
  return crypto.subtle.importKey('raw', prfResult, { name: AES_ALGO }, false, ['encrypt', 'decrypt']);
}

export async function unlockWithBiometric() {
  const rec = await db.get('meta', 'authBiometric');
  if (!rec) return false;
  try {
    const kek = await deriveKekFromAssertion(rec.value.credentialId);
    if (!kek) return false;
    dek = await unwrapDek(rec.value.wrapped, kek);
    return true;
  } catch {
    return false;
  }
}
