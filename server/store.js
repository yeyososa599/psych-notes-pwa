// store.js — minimale bestandsgebaseerde opslag voor de REFERENTIE-server.
//
// Dit is bewust simpel gehouden (één JSON-bestand) omdat het doel van deze
// server is te LATEN ZIEN hoe de zero-knowledge sync werkt, niet om
// productieklaar schaalbaar te zijn. Voor echt gebruik: vervang dit door
// een echte database (bijv. PostgreSQL) — het contract (de functies
// hieronder) blijft dan hetzelfde, alleen de implementatie verandert.
//
// BELANGRIJK VOOR AUDIT: dit bestand (data/db.json) bevat NOOIT leesbare
// cliëntgegevens. Per account staat hier alleen:
//   - e-mailadres (accountsleutel) en een bcrypt-hash van een afgeleid
//     "inlogbewijs" (niet het wachtwoord zelf, zie crypto.js deriveLoginProof)
//   - een salt + iteratiecount (niet geheim, nodig om dezelfde sleutel
//     opnieuw af te leiden)
//   - een publieke RSA-OAEP-sleutel (niet geheim — bedoeld om gedeeld te worden)
//   - een versleutelde ("gewrapte") kopie van de data-sleutel — onleesbaar
//     zonder het wachtwoord van de psycholoog
//   - versleutelde cliënt-/aantekeningrecords (AES-GCM ciphertext, base64)
//
// GEDEELDE CLIËNTEN (zie sharing.js): wanneer een psycholoog een cliënt
// deelt met een collega, verhuist dat record naar sharedClients/
// sharedNotes, met een toegangslijst (sharedAcl) van e-mailadressen die
// erbij mogen. De inhoud blijft ciphertext, versleuteld met een eigen
// "gedeelde sleutel" per cliënt (nooit de persoonlijke sleutel van een van
// beide psychologen) — die sleutel zelf staat hier ook alleen in gewrapte
// vorm (per ontvanger apart versleuteld met hún publieke sleutel).
//
// Niemand met alleen toegang tot dit bestand (inclusief de hostingpartij)
// kan hier cliëntnamen, notities, transcripten of audio uit lezen.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// BELANGRIJK — schijfopslag op de meeste hostingplatforms (o.a. Render,
// zowel de gratis als de standaard betaalde laag zónder expliciet
// toegevoegde "Persistent Disk") is NIET blijvend: bij een herstart van de
// server (bijv. na inactiviteit, of — vaker — bij elke nieuwe deploy)
// begint het bestandssysteem gewoon opnieuw, en is data/db.json gewoon
// weer leeg — alle accounts en gesynchroniseerde data lijken dan
// "verdwenen".
//
// Drie manieren om dit op te lossen, van geen kosten tot betaald:
//   1. UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN instellen — een
//      gratis, blijvende cloud-opslag (upstash.com, geen creditcard
//      nodig, werkt ook op Render's gratis laag omdat het geen eigen
//      schijf nodig heeft). Zie server/README.md voor de setup.
//   2. DATA_DIR instellen op een echte persistente schijf (bijv. een
//      Render "Persistent Disk", alleen op betaalde plannen).
//   3. Geen van beide: lokaal bestand naast dit script — prima voor
//      ontwikkelen/testen, NIET blijvend zodra de server herstart.
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const UPSTASH_KEY = 'praktijknotities-db';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

function emptyDb() {
  return {
    accounts: {}, sessions: {}, clients: {}, notes: {},
    sharedClients: {}, sharedNotes: {}, sharedAcl: {}, sharedKeyGrants: {},
    pendingShares: {},
  };
}

let cache = null;
let writeQueue = Promise.resolve();

// Upstash's REST API: elk commando is gewoon een HTTP-aanroep, dus geen
// extra npm-dependency nodig (fetch zit al in Node) en geen aparte
// TCP-verbinding om open te houden — ideaal voor een klein server-proces
// dat toch al maar af en toe iets hoeft te lezen/schrijven.
async function upstashGet() {
  const res = await fetch(`${UPSTASH_URL}/get/${UPSTASH_KEY}`, {
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
  });
  if (!res.ok) throw new Error(`Upstash GET mislukt (${res.status})`);
  const data = await res.json();
  return data.result; // string (JSON) of null als er nog niets staat
}

async function upstashSet(jsonString) {
  const res = await fetch(`${UPSTASH_URL}/set/${UPSTASH_KEY}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
    body: jsonString,
  });
  if (!res.ok) throw new Error(`Upstash SET mislukt (${res.status})`);
}

async function load() {
  if (cache) return cache;

  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      const raw = await upstashGet();
      cache = raw ? { ...emptyDb(), ...JSON.parse(raw) } : emptyDb();
      return cache;
    } catch (err) {
      console.warn('Upstash niet bereikbaar, val terug op een lege database voor deze sessie:', err);
      cache = emptyDb();
      return cache;
    }
  }

  try {
    const raw = await readFile(DATA_FILE, 'utf8');
    cache = { ...emptyDb(), ...JSON.parse(raw) }; // vult ontbrekende nieuwe velden aan voor bestaande data.json's
  } catch {
    cache = emptyDb();
  }
  return cache;
}

async function persist() {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    await upstashSet(JSON.stringify(cache));
    return;
  }
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(cache, null, 2), 'utf8');
}

// Simpele schrijf-queue zodat gelijktijdige requests elkaars wijzigingen
// niet overschrijven (dit bestand kent geen echte transacties).
function withWrite(fn) {
  writeQueue = writeQueue.then(async () => {
    const db = await load();
    const result = await fn(db);
    await persist();
    return result;
  });
  return writeQueue;
}

export async function getAccount(email) {
  const db = await load();
  return db.accounts[email] || null;
}

export async function createAccount(email, account) {
  return withWrite(async (db) => {
    if (db.accounts[email]) throw new Error('ACCOUNT_EXISTS');
    db.accounts[email] = account;
    db.clients[email] = {};
    db.notes[email] = {};
  });
}

// publicKeyJwk mag door iedereen (met een sessie) opgevraagd worden — dat
// is de aard van een publieke sleutel. wrappedSharingPrivateKey is
// versleuteld met de EIGEN DEK van het account (zie crypto.js) en wordt
// alleen aan het account zelf teruggegeven (voor een tweede apparaat).
export async function setSharingKeypair(email, { publicKeyJwk, wrappedSharingPrivateKey }) {
  return withWrite(async (db) => {
    if (!db.accounts[email]) throw new Error('NO_ACCOUNT');
    db.accounts[email].publicKeyJwk = publicKeyJwk;
    db.accounts[email].wrappedSharingPrivateKey = wrappedSharingPrivateKey;
  });
}

export async function getSharingKeypair(email) {
  const db = await load();
  const account = db.accounts[email];
  if (!account) return null;
  return { publicKeyJwk: account.publicKeyJwk || null, wrappedSharingPrivateKey: account.wrappedSharingPrivateKey || null };
}

export async function getPublicKey(email) {
  const db = await load();
  return db.accounts[email]?.publicKeyJwk || null;
}

export async function createSession(email, token, expiresAt) {
  return withWrite(async (db) => {
    db.sessions[token] = { email, expiresAt };
  });
}

export async function getSession(token) {
  const db = await load();
  const session = db.sessions[token];
  if (!session) return null;
  if (session.expiresAt < Date.now()) return null;
  return session;
}

// --------------------------------------------------------------------
// Push/pull — nu ACL-bewust: een record voor een clientId dat gedeeld is,
// wordt in de gedeelde emmer geschreven/gelezen i.p.v. de persoonlijke.
// --------------------------------------------------------------------

function sharedIdFor(kind, record) {
  return kind === 'clients' ? record.id : record.clientId;
}

export async function pushRecords(email, kind, records) {
  return withWrite(async (db) => {
    for (const record of records) {
      const sharedId = sharedIdFor(kind, record);
      const acl = db.sharedAcl[sharedId];
      const isShared = acl && acl.includes(email);
      const bucketRoot = isShared ? db[kind === 'clients' ? 'sharedClients' : 'sharedNotes'] : db[kind];
      const bucketKey = isShared ? sharedId : email;
      const bucket = bucketRoot[bucketKey] || (bucketRoot[bucketKey] = {});
      const existing = bucket[record.id];
      // Last-write-wins op updatedAt — voorkomt dat een trage/oude sync
      // een nieuwere wijziging van een ander apparaat/collega overschrijft.
      if (!existing || record.updatedAt > existing.updatedAt) {
        bucket[record.id] = record;
      }
    }
  });
}

export async function pullRecords(email, kind, since) {
  const db = await load();
  const personal = Object.values(db[kind][email] || {});

  const sharedRoot = db[kind === 'clients' ? 'sharedClients' : 'sharedNotes'];
  const shared = [];
  for (const [sharedId, acl] of Object.entries(db.sharedAcl)) {
    if (!acl.includes(email)) continue;
    const bucket = sharedRoot[sharedId];
    if (bucket) shared.push(...Object.values(bucket));
  }

  return [...personal, ...shared].filter(r => !since || r.updatedAt > since);
}

/** Sleutelkorrels die dit account nodig heeft om de gedeelde cliënten waar het toegang toe heeft te kunnen ontsleutelen. */
export async function pullSharedKeys(email) {
  const db = await load();
  const grants = [];
  for (const [clientId, acl] of Object.entries(db.sharedAcl)) {
    if (!acl.includes(email)) continue;
    const wrapped = db.sharedKeyGrants[clientId]?.[email];
    if (wrapped) grants.push({ clientId, wrappedKey: wrapped });
  }
  return grants;
}

// --------------------------------------------------------------------
// Delen tussen collega's
// --------------------------------------------------------------------

export async function createPendingShare(shareId, share) {
  return withWrite(async (db) => {
    db.pendingShares[shareId] = share;
  });
}

export async function getPendingSharesFor(email) {
  const db = await load();
  return Object.entries(db.pendingShares)
    .filter(([, s]) => s.toEmail === email)
    .map(([shareId, s]) => ({ shareId, ...s }));
}

export async function getPendingShare(shareId) {
  const db = await load();
  return db.pendingShares[shareId] || null;
}

/**
 * Markeert een cliënt als gedeeld en ruimt de oude, met de persoonlijke
 * sleutel versleutelde kopie op — de afzender stuurt daarna meteen (in
 * dezelfde /api/shares-aanroep) een verse, met de gedeelde sleutel
 * versleutelde snapshot mee, die via het gewone pushRecords() in de
 * nieuwe gedeelde emmer terechtkomt (nu de ACL hieronder al staat).
 */
export async function moveClientToShared(fromEmail, clientId, wrappedKeyForSender) {
  return withWrite(async (db) => {
    if (db.clients[fromEmail]) delete db.clients[fromEmail][clientId];
    const notesBucket = db.notes[fromEmail] || {};
    for (const [noteId, note] of Object.entries(notesBucket)) {
      if (note.clientId === clientId) delete notesBucket[noteId];
    }
    db.sharedAcl[clientId] = [fromEmail];
    db.sharedKeyGrants[clientId] = { [fromEmail]: wrappedKeyForSender };
  });
}

export async function acceptShare(shareId, email) {
  return withWrite(async (db) => {
    const share = db.pendingShares[shareId];
    if (!share || share.toEmail !== email) throw new Error('NOT_FOUND');
    const acl = db.sharedAcl[share.clientId] || (db.sharedAcl[share.clientId] = []);
    if (!acl.includes(email)) acl.push(email);
    (db.sharedKeyGrants[share.clientId] || (db.sharedKeyGrants[share.clientId] = {}))[email] = share.wrappedKeyForRecipient;
    delete db.pendingShares[shareId];
    return share;
  });
}

export async function declineShare(shareId, email) {
  return withWrite(async (db) => {
    const share = db.pendingShares[shareId];
    if (!share || share.toEmail !== email) throw new Error('NOT_FOUND');
    delete db.pendingShares[shareId];
  });
}

/** Een account verlaat een gedeelde cliënt (stopt met delen voor zichzelf) — de andere partij(en) houden toegang. */
export async function leaveShare(clientId, email) {
  return withWrite(async (db) => {
    const acl = db.sharedAcl[clientId];
    if (!acl) return;
    db.sharedAcl[clientId] = acl.filter(e => e !== email);
    if (db.sharedKeyGrants[clientId]) delete db.sharedKeyGrants[clientId][email];
  });
}
