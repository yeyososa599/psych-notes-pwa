// ==========================================================================
// sharing.js — CLIËNTEN DELEN MET EEN COLLEGA (aparte, afgebakende module)
//
// Dit is iets anders dan sync.js: sync.js deelt ALLES tussen JOUW EIGEN
// apparaten via één gedeelde sleutel. Delen met een collega is
// cross-account — twee verschillende psychologen, elk met hun eigen,
// onafhankelijke encryptiesleutel — en betreft bewust maar één (of een
// paar) losse, expliciet gekozen cliënten, nooit de hele cliëntenlijst.
//
// HOE DIT ZONDER DE SERVER TE HOEVEN VERTROUWEN WERKT:
//   1. Elk account heeft een RSA-OAEP-sleutelpaar (zie crypto.js). De
//      publieke helft mag iedereen kennen (staat plain op de server); de
//      privé-helft verlaat dit apparaat nooit onversleuteld.
//   2. Om cliënt X te delen, genereren we een GLASHELDER NIEUWE, eigen
//      sleutel voor DIE ENE cliënt (een "gedeelde-cliëntsleutel", SCK) —
//      nooit de persoonlijke DEK van de afzender. Cliënt X (en zijn
//      aantekeningen) wordt opnieuw versleuteld met die SCK.
//   3. De SCK zelf wordt tweemaal "gewrapt" (versleuteld): één keer met de
//      publieke sleutel van de ontvanger, één keer met onze eigen publieke
//      sleutel (zodat wijzelf 'm ook op andere apparaten kunnen
//      terugvinden). Beide gewrapte kopieën gaan naar de server — die kan
//      er niets mee zonder de bijbehorende privésleutel.
//   4. De ontvanger moet expliciet accepteren (zie view-sync in app.js)
//      vóórdat de cliënt in hun lijst verschijnt — net als de naam-
//      controlestap bij het inspreken zelf: niets wordt automatisch
//      gekoppeld zonder een bewuste tik.
//   5. Ná acceptatie routeren toekomstige aantekeningen van BEIDE
//      psychologen voor die cliënt automatisch via de SCK (zie
//      crypto.js getKeyForClient) — de gewone sync.js-pushes/pulls werken
//      dan gewoon door, de server bepaalt zelf (via een toegangslijst)
//      wie welke gedeelde records mag zien.
// ==========================================================================

import { db } from './db.js';
import * as Crypto from './crypto.js';
import * as Clients from './clients.js';
import * as Notes from './notes.js';
import {
  bytesToBase64, base64ToBytes, apiCall,
  serializeEnc, deserializeEnc, serializeClientRecord, deserializeClientRecord, serializeNoteRecord,
} from './utils.js';

const SYNC_META_KEY = 'syncAccount'; // zelfde meta-record als sync.js — lokaal opnieuw gelezen om een kringverwijzing sync.js↔sharing.js te vermijden

async function getAccountState() {
  const rec = await db.get('meta', SYNC_META_KEY);
  if (!rec) throw new Error('Synchronisatie moet eerst ingesteld zijn voor je kunt delen met een collega.');
  return rec.value;
}

// --------------------------------------------------------------------
// Eigen sleutelpaar publiceren/ophalen (zelf-herstellend: veilig vaak aan te roepen)
// --------------------------------------------------------------------

export async function ensureKeypairSynced() {
  const rec = await db.get('meta', SYNC_META_KEY);
  if (!rec) return; // geen sync ingesteld — delen is dan sowieso niet mogelijk
  const account = rec.value;

  const local = await Crypto.getSharingKeypairRecord();
  const server = await apiCall(account.serverUrl, '/api/sharingkey', { token: account.sessionToken });

  if (server.wrappedSharingPrivateKey) {
    if (!local) {
      await Crypto.importSharingKeypairFromAccount(server.publicKeyJwk, deserializeEnc(server.wrappedSharingPrivateKey));
    }
    return;
  }

  // De server kent nog geen sleutelpaar voor dit account: alsnog aanmaken
  // (of, in het zeldzame geval dat we er lokaal al één hebben maar het
  // publiceren eerder niet lukte, dat opnieuw proberen) en publiceren.
  if (!local) await Crypto.ensureSharingKeypair();
  const record = await Crypto.getSharingKeypairRecord();
  await apiCall(account.serverUrl, '/api/sharingkey', {
    method: 'POST', token: account.sessionToken,
    body: { publicKeyJwk: record.publicKeyJwk, wrappedSharingPrivateKey: serializeEnc(record.encPrivateKeyJwk) },
  });
}

// --------------------------------------------------------------------
// Een cliënt delen
// --------------------------------------------------------------------

/** Deelt één cliënt (+ diens bestaande aantekeningen) met een collega, op e-mailadres. */
export async function shareClient(clientId, recipientEmail) {
  const account = await getAccountState();
  await ensureKeypairSynced();

  if (await Crypto.hasSharedClientKey(clientId)) {
    throw new Error('Deze cliënt is al gedeeld. Nogmaals delen met een andere collega wordt nog niet ondersteund.');
  }

  const { publicKeyJwk: recipientPublicKeyJwk } = await apiCall(
    account.serverUrl, `/api/publickey?email=${encodeURIComponent(recipientEmail)}`, { token: account.sessionToken }
  );

  const client = await Clients.getClient(clientId);
  if (!client) throw new Error('Cliënt niet gevonden.');
  const noteSummaries = await Notes.getNotesForClient(clientId);

  const { key: sck, raw: sckRaw } = await Crypto.generateSharedClientKey();
  const now = new Date().toISOString();

  const clientRecord = {
    id: clientId, deleted: false, createdAt: client.createdAt, updatedAt: now,
    encName: await Crypto.encryptFieldWithKey(client.name, sck),
    encNote: await Crypto.encryptFieldWithKey(client.note, sck),
  };

  const noteRecords = [];
  for (const summary of noteSummaries) {
    const full = await Notes.getNote(summary.id);
    noteRecords.push({
      id: full.id, clientId, deleted: false, createdAt: full.createdAt, updatedAt: new Date().toISOString(),
      durationSec: full.durationSec,
      encTranscript: await Crypto.encryptFieldWithKey(full.transcript, sck),
      encAudio: await Crypto.encryptBlobWithKey(full.audioBlob, sck),
    });
  }

  const ownRecord = await Crypto.getSharingKeypairRecord();
  const wrappedForRecipient = await Crypto.wrapKeyForPublicKey(sckRaw, recipientPublicKeyJwk);
  const wrappedForSender = await Crypto.wrapKeyForPublicKey(sckRaw, ownRecord.publicKeyJwk);

  await apiCall(account.serverUrl, '/api/shares', {
    method: 'POST', token: account.sessionToken,
    body: {
      clientId, recipientEmail,
      wrappedKeyForRecipient: bytesToBase64(wrappedForRecipient),
      wrappedKeyForSender: bytesToBase64(wrappedForSender),
      encClientSnapshot: serializeClientRecord(clientRecord),
      encNotesSnapshot: noteRecords.map(serializeNoteRecord),
    },
  });

  // Lokaal overschakelen op de gedeelde sleutel voor deze cliënt, en de
  // net met die sleutel versleutelde records meteen zelf ook opslaan.
  await Crypto.storeSharedClientKey(clientId, wrappedForSender);
  await Clients.putRawClientRecords([clientRecord]);
  await Notes.putRawNoteRecords(noteRecords);
}

// --------------------------------------------------------------------
// Binnengekomen uitnodigingen
// --------------------------------------------------------------------

/** Haalt openstaande uitnodigingen op en ontsleutelt lokaal alvast de cliëntnaam, voor een preview vóór acceptatie. */
export async function getPendingShares() {
  const rec = await db.get('meta', SYNC_META_KEY);
  if (!rec) return [];
  const account = rec.value;
  await ensureKeypairSynced();

  const { shares } = await apiCall(account.serverUrl, '/api/shares/pending', { token: account.sessionToken });
  const result = [];
  for (const share of shares) {
    try {
      const rawKey = await Crypto.unwrapKeyWithOwnPrivateKey(base64ToBytes(share.wrappedKeyForRecipient));
      const sck = await Crypto.importAesKey(rawKey);
      const snapshot = deserializeClientRecord(share.encClientSnapshot);
      const previewName = await Crypto.decryptFieldWithKey(snapshot.encName, sck);
      result.push({ shareId: share.shareId, fromEmail: share.fromEmail, clientId: share.clientId, previewName, createdAt: share.createdAt });
    } catch (err) {
      console.warn('Kon uitnodiging niet lokaal ontsleutelen:', err);
    }
  }
  return result;
}

/**
 * Accepteert een uitnodiging: slaat de sleutel + de cliënt-snapshot lokaal
 * op. Roep daarna Sync.syncNow() aan (in app.js) om ook meteen de
 * bijbehorende aantekeningen op te halen.
 */
export async function acceptShare(shareId) {
  const account = await getAccountState();
  const { shares } = await apiCall(account.serverUrl, '/api/shares/pending', { token: account.sessionToken });
  const share = shares.find(s => s.shareId === shareId);
  if (!share) throw new Error('Uitnodiging niet meer beschikbaar (mogelijk ingetrokken).');

  await Crypto.storeSharedClientKey(share.clientId, base64ToBytes(share.wrappedKeyForRecipient));
  await apiCall(account.serverUrl, `/api/shares/${shareId}/accept`, { method: 'POST', token: account.sessionToken });
  await Clients.putRawClientRecords([deserializeClientRecord(share.encClientSnapshot)]);
  return share.clientId;
}

export async function declineShare(shareId) {
  const account = await getAccountState();
  await apiCall(account.serverUrl, `/api/shares/${shareId}/decline`, { method: 'POST', token: account.sessionToken });
}

// --------------------------------------------------------------------
// Stoppen met delen (voor jezelf — de andere partij(en) houden toegang)
// --------------------------------------------------------------------

export async function leaveSharedClient(clientId) {
  const account = await getAccountState();
  await apiCall(account.serverUrl, '/api/shares/leave', {
    method: 'POST', token: account.sessionToken, body: { clientId },
  });
  await Crypto.removeSharedClientKey(clientId);
  // Zelfde tombstone-mechanisme als een gewone verwijdering: onze lokale
  // kopie van naam/notitie/audio/transcript wordt echt gewist.
  await Clients.deleteClient(clientId);
  await Notes.deleteAllNotesForClient(clientId);
}
