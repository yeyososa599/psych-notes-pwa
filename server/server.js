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
// UITZONDERING — AI-tekstcorrectie (optioneel, standaard uit):
//   /api/ai-cleanup krijgt WEL een leesbaar transcript binnen (de
//   psycholoog moet het immers kunnen laten corrigeren) en stuurt dat door
//   naar de Anthropic API om spelling/interpunctie te verbeteren en
//   waarschijnlijk verkeerd-verstane woorden te corrigeren. Dit is de
//   ENIGE plek in de hele app waar onversleutelde cliëntgerelateerde tekst
//   het apparaat/de eigen server verlaat — bewust apart gehouden van de
//   zero-knowledge sync hierboven. Zie ook js/aiCleanup.js (clientkant) en
//   server/README.md (welke stappen dit voor de praktijk betekent).
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
  const [clients, notes, sharedKeys] = await Promise.all([
    store.pullRecords(req.email, 'clients', since),
    store.pullRecords(req.email, 'notes', since),
    store.pullSharedKeys(req.email),
  ]);
  res.json({ clients, notes, sharedKeys, serverTime });
});

// --------------------------------------------------------------------
// Delen met een collega (zie js/sharing.js voor de clientkant)
//
// Alles wat hier binnenkomt is al ciphertext of een publieke sleutel —
// deze server ziet nooit een cliëntnaam, notitie, transcript of audio,
// ook niet van gedeelde cliënten.
// --------------------------------------------------------------------

// Eigen sleutelpaar instellen/bijwerken (publieke sleutel + de EIGEN
// versleutelde privésleutel, voor bootstrap op een tweede apparaat).
app.post('/api/sharingkey', requireSession, async (req, res) => {
  const { publicKeyJwk, wrappedSharingPrivateKey } = req.body || {};
  if (!publicKeyJwk || !wrappedSharingPrivateKey) return badRequest(res, 'Ontbrekende velden.');
  await store.setSharingKeypair(req.email, { publicKeyJwk, wrappedSharingPrivateKey });
  res.json({ ok: true });
});

// Eigen sleutelpaar ophalen (alleen voor jezelf — nodig op een nieuw apparaat).
app.get('/api/sharingkey', requireSession, async (req, res) => {
  const keypair = await store.getSharingKeypair(req.email);
  res.json(keypair || { publicKeyJwk: null, wrappedSharingPrivateKey: null });
});

// Publieke sleutel van een COLLEGA opvragen, om iets met hen te kunnen delen.
app.get('/api/publickey', requireSession, async (req, res) => {
  const email = req.query.email;
  const publicKeyJwk = email && await store.getPublicKey(email);
  if (!publicKeyJwk) return res.status(404).json({ error: 'Geen (bekend) account met publieke sleutel voor dit e-mailadres.' });
  res.json({ publicKeyJwk });
});

app.post('/api/shares', requireSession, async (req, res) => {
  const { clientId, recipientEmail, wrappedKeyForRecipient, wrappedKeyForSender, encClientSnapshot, encNotesSnapshot } = req.body || {};
  if (!clientId || !recipientEmail || !wrappedKeyForRecipient || !wrappedKeyForSender || !encClientSnapshot) {
    return badRequest(res, 'Ontbrekende velden.');
  }
  if (recipientEmail === req.email) return badRequest(res, 'Je kunt niet met jezelf delen.');
  const recipientKey = await store.getPublicKey(recipientEmail);
  if (!recipientKey) return res.status(404).json({ error: 'Onbekende collega (nog geen account of nog niet online geweest).' });

  await store.moveClientToShared(req.email, clientId, wrappedKeyForSender);
  // De initiële snapshot komt meteen ook in de gedeelde emmer terecht, zodat
  // de afzender zelf niet los nog een keer hoeft te pushen.
  await store.pushRecords(req.email, 'clients', [encClientSnapshot]);
  if (Array.isArray(encNotesSnapshot) && encNotesSnapshot.length) {
    await store.pushRecords(req.email, 'notes', encNotesSnapshot);
  }

  const shareId = crypto.randomBytes(16).toString('hex');
  await store.createPendingShare(shareId, {
    clientId, fromEmail: req.email, toEmail: recipientEmail,
    wrappedKeyForRecipient, encClientSnapshot, createdAt: new Date().toISOString(),
  });
  res.json({ shareId });
});

app.get('/api/shares/pending', requireSession, async (req, res) => {
  const shares = await store.getPendingSharesFor(req.email);
  res.json({ shares });
});

app.post('/api/shares/:id/accept', requireSession, async (req, res) => {
  try {
    await store.acceptShare(req.params.id, req.email);
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Uitnodiging niet gevonden of al verwerkt.' });
  }
});

app.post('/api/shares/:id/decline', requireSession, async (req, res) => {
  try {
    await store.declineShare(req.params.id, req.email);
    res.json({ ok: true });
  } catch {
    res.status(404).json({ error: 'Uitnodiging niet gevonden of al verwerkt.' });
  }
});

app.post('/api/shares/leave', requireSession, async (req, res) => {
  const { clientId } = req.body || {};
  if (!clientId) return badRequest(res, 'clientId ontbreekt.');
  await store.leaveShare(clientId, req.email);
  res.json({ ok: true });
});

// --------------------------------------------------------------------
// AI-tekstcorrectie (optioneel — zie de toelichting bovenaan dit bestand)
//
// Vereist een ANTHROPIC_API_KEY omgevingsvariabele op de server. Zonder
// die variabele blijft deze route gewoon een nette foutmelding geven —
// de rest van de app (incl. gewone sync) functioneert dan onveranderd.
// --------------------------------------------------------------------
const AI_CLEANUP_SYSTEM_PROMPT = `Je krijgt een ruw, automatisch getranscribeerd fragment van een gesproken werkaantekening van een psycholoog (Nederlands).

Corrigeer ALLEEN:
- spelling en interpunctie
- hoofdlettergebruik
- overduidelijke verkeerd-verstane woorden — gebruik de context om aannemelijk te maken wat er waarschijnlijk gezegd is

Verzin NOOIT nieuwe inhoud, namen, diagnoses of andere details die niet al in de tekst aanwezig zijn. Verander de betekenis niet en laat twijfelachtige stukken liever ongewijzigd dan te gokken.

Geef UITSLUITEND de gecorrigeerde tekst terug — geen inleiding, geen uitleg, geen aanhalingstekens.`;

app.post('/api/ai-cleanup', requireSession, async (req, res) => {
  const { transcript } = req.body || {};
  if (!transcript || !transcript.trim()) return badRequest(res, 'Geen transcript meegegeven.');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(503).json({ error: 'AI-correctie is niet geconfigureerd op deze server (ANTHROPIC_API_KEY ontbreekt).' });
  }

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: AI_CLEANUP_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: transcript }],
      }),
    });
    const data = await aiRes.json();
    if (!aiRes.ok) {
      console.warn('Anthropic API-fout bij AI-correctie:', data);
      return res.status(502).json({ error: 'AI-correctie is mislukt bij de AI-dienst.' });
    }
    const cleanedTranscript = data.content?.[0]?.text?.trim();
    if (!cleanedTranscript) return res.status(502).json({ error: 'AI-correctie gaf geen bruikbaar resultaat terug.' });
    res.json({ cleanedTranscript });
  } catch (err) {
    console.warn('AI-correctie mislukt:', err);
    res.status(502).json({ error: 'AI-correctie is mislukt (netwerkfout naar de AI-dienst).' });
  }
});

app.listen(PORT, () => {
  console.log(`Praktijknotities sync-server (referentie-implementatie) luistert op http://localhost:${PORT}`);
  console.log('LET OP: dit is voor ontwikkeling/test. Zie server/README.md voor productie-eisen (EU-hosting, HTTPS, verwerkersovereenkomst).');
});
