// notes.js — aantekeningen: CRUD + lijst/detail-rendering.
// Een note wordt UITSLUITEND aangemaakt ná de verplichte controlestap in
// app.js (view-confirm) — deze module bevat zelf geen koppel-logica.
// Data blijft lokaal in IndexedDB (zie db.js). Vanaf Fase 3 worden
// transcript/audioBlob hier versleuteld vóór opslag.

import { db } from './db.js';
import { uuid, formatDateTime, formatDuration, escapeHtml } from './utils.js';

export async function addNote({ clientId, transcript, audioBlob, mimeType, durationSec }) {
  const now = new Date().toISOString();
  const note = {
    id: uuid(),
    clientId,
    transcript: transcript || '',
    audioBlob,
    mimeType,
    durationSec: durationSec || 0,
    createdAt: now,
    updatedAt: now,
    deleted: false,
  };
  await db.put('notes', note);
  return note;
}

export async function getNote(id) {
  return db.get('notes', id);
}

export async function deleteNote(id) {
  // Harde verwijdering: de audio-Blob en tekst worden echt uit IndexedDB
  // gewist, niet alleen gemarkeerd — bijzondere persoonsgegevens blijven
  // zo niet onnodig lokaal staan. (Sync-verwijdering: zie sync.js Fase 4.)
  return db.delete('notes', id);
}

export async function getNotesForClient(clientId) {
  const all = await db.getAllByIndex('notes', 'clientId', clientId);
  return all
    .filter(n => !n.deleted)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
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
