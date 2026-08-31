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
//   - een versleutelde ("gewrapte") kopie van de data-sleutel — onleesbaar
//     zonder het wachtwoord van de psycholoog
//   - versleutelde cliënt-/aantekeningrecords (AES-GCM ciphertext, base64)
//
// Niemand met alleen toegang tot dit bestand (inclusief de hostingpartij)
// kan hier cliëntnamen, notities, transcripten of audio uit lezen.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');

function emptyDb() {
  return { accounts: {}, sessions: {}, clients: {}, notes: {} };
}

let cache = null;
let writeQueue = Promise.resolve();

async function load() {
  if (cache) return cache;
  try {
    const raw = await readFile(DATA_FILE, 'utf8');
    cache = JSON.parse(raw);
  } catch {
    cache = emptyDb();
  }
  return cache;
}

async function persist() {
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

export async function pushRecords(email, kind, records) {
  return withWrite(async (db) => {
    const bucket = db[kind][email] || (db[kind][email] = {});
    for (const record of records) {
      const existing = bucket[record.id];
      // Last-write-wins op updatedAt — voorkomt dat een trage/oude sync
      // een nieuwere wijziging van het andere apparaat overschrijft.
      if (!existing || record.updatedAt > existing.updatedAt) {
        bucket[record.id] = record;
      }
    }
  });
}

export async function pullRecords(email, kind, since) {
  const db = await load();
  const bucket = db[kind][email] || {};
  return Object.values(bucket).filter(r => !since || r.updatedAt > since);
}
