// notes.js — aantekeningen: CRUD + lijst/detail-rendering.
// Een note wordt UITSLUITEND aangemaakt ná de verplichte controlestap in
// app.js (view-confirm) — deze module bevat zelf geen koppel-logica.
//
// Data blijft lokaal in IndexedDB (zie db.js). transcript en audioBlob
// zijn persoonsgegevens en worden vóór opslag versleuteld (crypto.js).
// Voor de lijstweergave (getNotesForClient) ontsleutelen we alleen het
// transcript, NIET de audio — dat zou onnodig traag zijn voor een lijst.
// De audio wordt pas ontsleuteld bij het daadwerkelijk openen/afspelen
// van één aantekening (getNote).

import { db } from './db.js';
import * as Crypto from './crypto.js';
import { uuid, formatDateTime, formatDuration, escapeHtml } from './utils.js';

export async function addNote({ clientId, transcript, audioBlob, mimeType, durationSec }) {
  // Een aantekening onder een gedeelde cliënt (zie sharing.js) wordt
  // automatisch met diens gedeelde sleutel versleuteld i.p.v. de
  // persoonlijke DEK — getKeyForClient regelt dat transparant.
  const key = await Crypto.getKeyForClient(clientId);
  const now = new Date().toISOString();
  const record = {
    id: uuid(),
    clientId,
    encTranscript: await Crypto.encryptFieldWithKey(transcript || '', key),
    encAudio: await Crypto.encryptBlobWithKey(audioBlob, key),
    durationSec: durationSec || 0,
    createdAt: now,
    updatedAt: now,
    deleted: false,
  };
  await db.put('notes', record);
  return { id: record.id, clientId, transcript: transcript || '', mimeType, durationSec: record.durationSec, createdAt: now };
}

/** Volledige, ontsleutelde note inclusief afspeelbare audio-Blob. */
export async function getNote(id) {
  const record = await db.get('notes', id);
  if (!record) return null;
  if (record.purgedLocally) {
    // Audio/transcript zijn hier bewust al lokaal gewist (zie
    // purgeExpiredLocalCopies) — er valt niets meer te ontsleutelen.
    return {
      id: record.id, clientId: record.clientId, purgedLocally: true,
      transcript: null, audioBlob: null, mimeType: null,
      durationSec: record.durationSec, createdAt: record.createdAt, updatedAt: record.updatedAt,
    };
  }
  const key = await Crypto.getKeyForClient(record.clientId);
  const [transcript, audioBlob] = await Promise.all([
    Crypto.decryptFieldWithKey(record.encTranscript, key),
    Crypto.decryptBlobWithKey(record.encAudio, key),
  ]);
  return {
    id: record.id,
    clientId: record.clientId,
    transcript,
    audioBlob,
    mimeType: record.encAudio.mimeType,
    durationSec: record.durationSec,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export async function deleteNote(id) {
  // We wissen audio + transcript écht (het record wordt overschreven
  // zónder encTranscript/encAudio) — er blijft alleen een klein
  // "tombstone"-markertje over. Dat is nodig zodat de verwijdering ook
  // naar het andere apparaat kan synchroniseren (sync.js, Fase 4): zonder
  // marker zou de aantekening op het andere apparaat blijven staan.
  const existing = await db.get('notes', id);
  if (!existing) return;
  await db.put('notes', {
    id,
    clientId: existing.clientId,
    deleted: true,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  });
}

/** Verwijdert alle aantekeningen van een cliënt (bijv. als de cliënt zelf verwijderd wordt). */
export async function deleteAllNotesForClient(clientId) {
  const all = await db.getAllByIndex('notes', 'clientId', clientId);
  await Promise.all(all.filter(n => !n.deleted).map(n => deleteNote(n.id)));
}

// --------------------------------------------------------------------
// Rauwe (nog versleutelde) toegang — uitsluitend voor sync.js (zie de
// toelichting bovenaan clients.js: sync.js ontsleutelt nooit iets).
// --------------------------------------------------------------------

export async function getAllNotesRaw() {
  return db.getAll('notes');
}

/** Schrijft binnengehaalde (al versleutelde) records weg met last-write-wins op updatedAt. */
export async function putRawNoteRecords(records) {
  for (const incoming of records) {
    const local = await db.get('notes', incoming.id);
    if (!local || incoming.updatedAt > local.updatedAt) {
      await db.put('notes', incoming);
    }
  }
}

/** Lijst-weergave: ontsleutelt alléén het transcript (snel, geen audio). */
export async function getNotesForClient(clientId) {
  const all = await db.getAllByIndex('notes', 'clientId', clientId);
  const active = all.filter(n => !n.deleted).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const key = await Crypto.getKeyForClient(clientId); // één keer per cliënt, niet per aantekening
  return Promise.all(active.map(async (record) => {
    if (record.purgedLocally) {
      return { id: record.id, clientId: record.clientId, purgedLocally: true, transcript: null, durationSec: record.durationSec, createdAt: record.createdAt, updatedAt: record.updatedAt };
    }
    return {
      id: record.id,
      clientId: record.clientId,
      transcript: await Crypto.decryptFieldWithKey(record.encTranscript, key),
      durationSec: record.durationSec,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
    };
  }));
}

export function renderNotesList(listEl, emptyEl, notes, onSelect) {
  listEl.innerHTML = '';
  emptyEl.hidden = notes.length > 0;
  for (const note of notes) {
    const li = document.createElement('li');
    if (note.purgedLocally) {
      li.innerHTML = `
        <span class="item-title">${formatDateTime(note.createdAt)}</span>
        <span class="item-sub">🔒 Alleen nog op je computer — automatisch opgeschoond na synchronisatie</span>
      `;
    } else {
      const preview = (note.transcript || '(geen transcript)').slice(0, 90);
      li.innerHTML = `
        <span class="item-title">${formatDateTime(note.createdAt)}</span>
        <span class="item-sub">${escapeHtml(preview)}${note.transcript?.length > 90 ? '…' : ''} · ${formatDuration(note.durationSec)}</span>
      `;
    }
    li.addEventListener('click', () => onSelect(note));
    listEl.appendChild(li);
  }
}

// --------------------------------------------------------------------
// Automatisch lokaal opschonen op dit apparaat (optioneel, per apparaat
// in te stellen — zie app.js / het "autoPurgeEnabled"-scherm bij
// Synchronisatie-instellingen). Bedoeld voor bijv. de telefoon: audio +
// transcript verdwijnen hier lokaal een vast aantal uren NADAT ze
// bevestigd zijn gesynchroniseerd, en blijven daarna alleen nog op de
// andere apparaten (bijv. de computer) staan. De cliëntnaam zelf blijft
// gewoon staan — die is nodig om de app te kunnen blijven gebruiken.
//
// BELANGRIJK: dit is een puur LOKALE bewerking. Het overschreven record
// behoudt zijn originele updatedAt, dus sync.js's "is dit gewijzigd
// sinds de laatste sync"-check (updatedAt > since) ziet dit NIET als een
// wijziging — er wordt dus nooit per ongeluk een verwijdering naar de
// server (en daarmee naar andere apparaten) gestuurd.
// --------------------------------------------------------------------

const AUTO_PURGE_META_KEY = 'autoPurgeEnabled';
export const AUTO_PURGE_RETENTION_HOURS = 48;

export async function isAutoPurgeEnabled() {
  const rec = await db.get('meta', AUTO_PURGE_META_KEY);
  return !!rec?.value;
}

export async function setAutoPurgeEnabled(enabled) {
  await db.put('meta', { key: AUTO_PURGE_META_KEY, value: !!enabled });
}

/** Markeert lokale notes die net bevestigd zijn gesynchroniseerd, zodat de bewaartermijn vanaf nu kan gaan lopen. */
export async function markSyncedIfNeeded(lastSyncAt) {
  if (!lastSyncAt) return;
  const all = await db.getAll('notes');
  const now = new Date().toISOString();
  for (const record of all) {
    if (record.deleted || record.purgedLocally || record.syncedAt) continue;
    if (record.updatedAt <= lastSyncAt) {
      await db.put('notes', { ...record, syncedAt: now });
    }
  }
}

/** Wist audio+transcript lokaal voor notes die langer dan retentionHours geleden bevestigd zijn gesynchroniseerd. Geeft het aantal opgeschoonde notes terug. */
export async function purgeExpiredLocalCopies(retentionHours) {
  const all = await db.getAll('notes');
  const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;
  let purged = 0;
  for (const record of all) {
    if (record.deleted || record.purgedLocally || !record.syncedAt) continue;
    if (new Date(record.syncedAt).getTime() > cutoff) continue;
    await db.put('notes', {
      id: record.id, clientId: record.clientId, deleted: false, purgedLocally: true,
      durationSec: record.durationSec, createdAt: record.createdAt, updatedAt: record.updatedAt,
    });
    purged++;
  }
  return purged;
}

export function audioBlobUrl(note) {
  return URL.createObjectURL(note.audioBlob);
}

export { formatDateTime, formatDuration };
