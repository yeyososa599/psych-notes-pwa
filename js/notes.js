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
  const now = new Date().toISOString();
  const record = {
    id: uuid(),
    clientId,
    encTranscript: await Crypto.encryptField(transcript || ''),
    encAudio: await Crypto.encryptBlob(audioBlob),
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
  const [transcript, audioBlob] = await Promise.all([
    Crypto.decryptField(record.encTranscript),
    Crypto.decryptBlob(record.encAudio),
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
  return Promise.all(active.map(async (record) => ({
    id: record.id,
    clientId: record.clientId,
    transcript: await Crypto.decryptField(record.encTranscript),
    durationSec: record.durationSec,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  })));
}

export function renderNotesList(listEl, emptyEl, notes, onSelect) {
  listEl.innerHTML = '';
  emptyEl.hidden = notes.length > 0;
  for (const note of notes) {
    const li = document.createElement('li');
    const preview = (note.transcript || '(geen transcript)').slice(0, 90);
    li.innerHTML = `
      <span class="item-title">${formatDateTime(note.createdAt)}</span>
      <span class="item-sub">${escapeHtml(preview)}${note.transcript?.length > 90 ? '…' : ''} · ${formatDuration(note.durationSec)}</span>
    `;
    li.addEventListener('click', () => onSelect(note));
    listEl.appendChild(li);
  }
}

export function audioBlobUrl(note) {
  return URL.createObjectURL(note.audioBlob);
}

export { formatDateTime, formatDuration };
