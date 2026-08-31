// clients.js — cliëntenbeheer: CRUD + lijst-rendering.
// Data blijft lokaal in IndexedDB (zie db.js). Vanaf Fase 3 worden
// name/note hier versleuteld vóór opslag en ontsleuteld ná ophalen.

import { db } from './db.js';
import { uuid, formatDateTime, escapeHtml } from './utils.js';

export async function addClient(name, note) {
  const now = new Date().toISOString();
  const client = {
    id: uuid(),
    name: name.trim(),
    note: (note || '').trim(),
    createdAt: now,
    updatedAt: now,
    deleted: false,
  };
  await db.put('clients', client);
  return client;
}

export async function getClient(id) {
  return db.get('clients', id);
}

export async function getAllClients() {
  const all = await db.getAll('clients');
  return all
    .filter(c => !c.deleted)
    .sort((a, b) => a.name.localeCompare(b.name, 'nl'));
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
