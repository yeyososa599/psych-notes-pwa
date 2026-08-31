// clients.js — cliëntenbeheer: CRUD + lijst-rendering.
// Data blijft lokaal in IndexedDB (zie db.js). name/note zijn persoons-
// gegevens en worden vóór opslag versleuteld (crypto.js, AES-GCM met een
// sleutel die alleen in het geheugen leeft na pincode-ontgrendeling) en
// ná ophalen weer ontsleuteld. Op schijf (IndexedDB) staat dus nooit een
// leesbare naam — alleen id/createdAt/updatedAt/deleted blijven plaintext.

import { db } from './db.js';
import * as Crypto from './crypto.js';
import { uuid, formatDateTime, escapeHtml } from './utils.js';

export async function addClient(name, note) {
  const now = new Date().toISOString();
  const record = {
    id: uuid(),
    encName: await Crypto.encryptField(name.trim()),
    encNote: await Crypto.encryptField((note || '').trim()),
    createdAt: now,
    updatedAt: now,
    deleted: false,
  };
  await db.put('clients', record);
  return { id: record.id, name: name.trim(), note: (note || '').trim(), createdAt: now, updatedAt: now };
}

async function decryptClientRecord(record) {
  return {
    id: record.id,
    name: await Crypto.decryptField(record.encName),
    note: await Crypto.decryptField(record.encNote),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deleted: record.deleted,
  };
}

export async function getClient(id) {
  const record = await db.get('clients', id);
  return record ? decryptClientRecord(record) : null;
}

export async function getAllClients() {
  const all = await db.getAll('clients');
  const decrypted = await Promise.all(all.filter(c => !c.deleted).map(decryptClientRecord));
  return decrypted.sort((a, b) => a.name.localeCompare(b.name, 'nl'));
}

// Harde verwijdering: cliënt + al hun aantekeningen (audio + transcript)
// worden echt uit IndexedDB gewist. Het cascaderen naar notes.js gebeurt
// in app.js, zodat clients.js niet van notes.js hoeft af te hangen.
export async function deleteClient(id) {
  return db.delete('clients', id);
}

/** Render de cliëntenlijst in <ul id="client-list">, gefilterd op zoekterm. */
export function renderClientList(listEl, emptyEl, clients, filterText, onSelect) {
  const filter = (filterText || '').trim().toLowerCase();
  const filtered = filter
    ? clients.filter(c =>
        c.name.toLowerCase().includes(filter) ||
        (c.note || '').toLowerCase().includes(filter))
    : clients;

  listEl.innerHTML = '';
  emptyEl.hidden = filtered.length > 0;

  for (const client of filtered) {
    const li = document.createElement('li');
    li.innerHTML = `
      <span class="item-title">${escapeHtml(client.name)}</span>
      ${client.note ? `<span class="item-sub">${escapeHtml(client.note)}</span>` : ''}
    `;
    li.addEventListener('click', () => onSelect(client));
    listEl.appendChild(li);
  }
}

/** Simpele lijst-render voor de handmatige cliëntkeuze in de controlestap. */
export function renderClientPickList(listEl, clients, filterText, onSelect) {
  const filter = (filterText || '').trim().toLowerCase();
  const filtered = filter
    ? clients.filter(c => c.name.toLowerCase().includes(filter))
    : clients;

  listEl.innerHTML = '';
  for (const client of filtered) {
    const li = document.createElement('li');
    li.innerHTML = `<span class="item-title">${escapeHtml(client.name)}</span>`;
    li.addEventListener('click', () => onSelect(client));
    listEl.appendChild(li);
  }
}

export { formatDateTime };
