// ==========================================================================
// server.js — REFERENTIE zero-knowledge sync-server voor Praktijknotities.
//
// WAT DEZE SERVER WEL DOET:
//   - Accounts beheren (e-mail + een bcrypt-hash van een afgeleid
//     "inlogbewijs" — zie deriveLoginProof in crypto.js — NOOIT het
//     wachtwoord zelf).
//   - Eén versleutelde ("gewrapte") kopie van de data-sleutel bewaren per
//     account, zodat een tweede apparaat er met hetzelfde wachtwoord bij
//     kan — de server kan deze kopie niet ontsleutelen.
//   - Versleutelde cliënt- en aantekeningrecords opslaan en teruggeven
//     (push/pull), met een simpel "since"-cursor-mechanisme voor
//     incrementele synchronisatie.
//
// WAT DEZE SERVER NOOIT DOET:
//   - Nooit een wachtwoord, pincode of encryptiesleutel opslaan.
//   - Nooit cliëntgegevens ontsleutelen of proberen te lezen — alles wat
//     hier binnenkomt is AES-GCM-ciphertext (base64), voor de server
//     onleesbare ruis.
//
// PRODUCTIE-EISEN (buiten de scope van deze code, verantwoordelijkheid van
// wie dit hostet — zie server/README.md):
//   - Hosting bij een EU-partij, met een verwerkersovereenkomst (AVG).
//   - Verplicht HTTPS (nooit onversleuteld http:// gebruiken in productie).
//   - Een echte database i.p.v. store.js's JSON-bestand voor meerdere
//     gelijktijdige gebruikers/schaal.
//   - Rate limiting / account-lockout tegen brute-force op /api/login.
// ==========================================================================

import express from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import * as store from './store.js';

const PORT = process.env.PORT || 8787;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dagen

const app = express();
app.use(express.json({ limit: '25mb' })); // audio-opnames zijn base64, dus groter dan het express-default

// Minimale, handmatige CORS-afhandeling (geen extra dependency) — alleen
// nodig zolang de app en de server niet van dezelfde origin draaien.
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

// --------------------------------------------------------------------
// Account aanmaken
// --------------------------------------------------------------------
app.post('/api/register', async (req, res) => {
  const { email, encSalt, iterations, wrappedDek, loginProof } = req.body || {};
  if (!email || !encSalt || !iterations || !wrappedDek || !loginProof) {
    return badRequest(res, 'Ontbrekende velden.');
  }
  const existing = await store.getAccount(email);
  if (existing) return res.status(409).json({ error: 'Account bestaat al.' });

  const loginProofHash = await bcrypt.hash(loginProof, 12);
  await store.createAccount(email, { encSalt, iterations, wrappedDek, loginProofHash });

  const token = crypto.randomBytes(32).toString('hex');
  await store.createSession(email, token, Date.now() + SESSION_TTL_MS);
  res.json({ sessionToken: token });
});

// --------------------------------------------------------------------
// Login, stap 1: salt opvragen (niet geheim, nodig om lokaal dezelfde
// sleutels af te leiden vóór het daadwerkelijke inlogbewijs verstuurd wordt)
// --------------------------------------------------------------------
app.post('/api/login/salt', async (req, res) => {
  const { email } = req.body || {};
  const account = email && await store.getAccount(email);
  if (!account) return res.status(404).json({ error: 'Onbekend account.' });
  res.json({ encSalt: account.encSalt, iterations: account.iterations });
});

// --------------------------------------------------------------------
// Login, stap 2: inlogbewijs verifiëren
// --------------------------------------------------------------------
app.post('/api/login', async (req, res) => {
  const { email, loginProof } = req.body || {};
  const account = email && await store.getAccount(email);
  if (!account) return res.status(404).json({ error: 'Onbekend account.' });

  const ok = await bcrypt.compare(loginProof || '', account.loginProofHash);
  if (!ok) return res.status(401).json({ error: 'Onjuist wachtwoord.' });

  const token = crypto.randomBytes(32).toString('hex');
  await store.createSession(email, token, Date.now() + SESSION_TTL_MS);
  res.json({ sessionToken: token, wrappedDek: account.wrappedDek });
});

// --------------------------------------------------------------------
// Auth-middleware voor de sync-routes
// --------------------------------------------------------------------
async function requireSession(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const session = token && await store.getSession(token);
  if (!session) return res.status(401).json({ error: 'Niet ingelogd of sessie verlopen.' });
  req.email = session.email;
  next();
}

// --------------------------------------------------------------------
// Sync: push (client → server) en pull (server → client)
// Alle record-velden zijn hier al AES-GCM-ciphertext (base64) — de server
// leest of interpreteert de inhoud niet, hij bewaart alleen.
// --------------------------------------------------------------------
app.post('/api/sync/push', requireSession, async (req, res) => {
  const { clients = [], notes = [] } = req.body || {};
  await store.pushRecords(req.email, 'clients', clients);
  await store.pushRecords(req.email, 'notes', notes);
  res.json({ accepted: true });
});

app.get('/api/sync/pull', requireSession, async (req, res) => {
  const since = req.query.since || null;
  const serverTime = new Date().toISOString();
  const [clients, notes] = await Promise.all([
    store.pullRecords(req.email, 'clients', since),
    store.pullRecords(req.email, 'notes', since),
  ]);
  res.json({ clients, notes, serverTime });
});

app.listen(PORT, () => {
  console.log(`Praktijknotities sync-server (referentie-implementatie) luistert op http://localhost:${PORT}`);
  console.log('LET OP: dit is voor ontwikkeling/test. Zie server/README.md voor productie-eisen (EU-hosting, HTTPS, verwerkersovereenkomst).');
});
