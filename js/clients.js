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
  // Gedeelde cliënten (zie sharing.js) zijn versleuteld met een eigen
  // sleutel per cliënt i.p.v. de persoonlijke DEK — getKeyForClient kiest
  // automatisch de juiste, transparant voor de rest van deze module.
  const key = await Crypto.getKeyForClient(record.id);
  const shared = await Crypto.hasSharedClientKey(record.id);
  return {
    id: record.id,
    name: await Crypto.decryptFieldWithKey(record.encName, key),
    note: await Crypto.decryptFieldWithKey(record.encNote, key),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    deleted: record.deleted,
    shared,
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

// We wissen name/note écht (het record wordt overschreven zónder de
// encName/encNote-velden) — er blijft alleen een klein "tombstone"-
// markertje over (id + deleted:true + updatedAt). Dat merkertje is nodig
// zodat de verwijdering ook naar het andere apparaat kan synchroniseren
// (sync.js, Fase 4): zonder marker zou de server nooit weten dát er iets
// verwijderd is en zou de cliënt op het andere apparaat blijven staan.
// Het cascaderen naar notes.js gebeurt in app.js.
export async function deleteClient(id) {
  const existing = await db.get('clients', id);
  if (!existing) return;
  await db.put('clients', {
    id,
    deleted: true,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  });
}

// --------------------------------------------------------------------
// Rauwe (nog versleutelde) toegang — uitsluitend voor sync.js. Deze
// functies ontsleutelen NIETS: sync.js verplaatst alleen ciphertext en
// weet niet wat erin staat (zero-knowledge blijft zo ook binnen de app-
// architectuur gehandhaafd, niet alleen richting de server).
// --------------------------------------------------------------------

export async function getAllClientsRaw() {
  return db.getAll('clients');
}

/** Schrijft binnengehaalde (al versleutelde) records weg met last-write-wins op updatedAt. */
export async function putRawClientRecords(records) {
  for (const incoming of records) {
    const local = await db.get('clients', incoming.id);
    if (!local || incoming.updatedAt > local.updatedAt) {
      await db.put('clients', incoming);
    }
  }
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
      <span class="item-title">${escapeHtml(client.name)}${client.shared ? ' <span class="shared-badge" title="Gedeeld met een collega">🔗</span>' : ''}</span>
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
