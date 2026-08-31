// app.js — hoofdmodule: eenvoudige view-router + wiring van events.
// Bewust geen framework: de app is klein en lineair, dus vanilla state
// + DOM-manipulatie is duidelijker te auditen dan een build-toolchain.

import * as Clients from './clients.js';
import { escapeHtml } from './utils.js';

const state = {
  clients: [],
  currentClient: null,
};

const els = {
  header: document.getElementById('header-title'),
  backBtn: document.getElementById('back-btn'),
  views: {
    clients: document.getElementById('view-clients'),
    addClient: document.getElementById('view-add-client'),
    clientDetail: document.getElementById('view-client-detail'),
    record: document.getElementById('view-record'),
    transcript: document.getElementById('view-transcript'),
    confirm: document.getElementById('view-confirm'),
    noteDetail: document.getElementById('view-note-detail'),
  },
};

// Navigatiegeschiedenis binnen de app (los van browser-history) zodat de
// "terug"-knop in de header altijd voorspelbaar het vorige scherm toont.
const navStack = [];

function showView(name, { title, showBack = true, push = true } = {}) {
  for (const v of Object.values(els.views)) v.classList.remove('active');
  els.views[name].classList.add('active');
  els.header.textContent = title ?? '';
  els.backBtn.hidden = !showBack;
  if (push) navStack.push(name);
}

function goBack() {
  navStack.pop(); // huidige view eraf
  const prev = navStack.pop();
  if (prev === 'clientDetail' && state.currentClient) {
    openClientDetail(state.currentClient, { push: true });
  } else {
    openClientList();
  }
}

els.backBtn.addEventListener('click', goBack);

// ---------------------------------------------------------------------
// Cliëntenlijst
// ---------------------------------------------------------------------

const clientListEl = document.getElementById('client-list');
const clientListEmptyEl = document.getElementById('client-list-empty');
const clientSearchEl = document.getElementById('client-search');

async function refreshClients() {
  state.clients = await Clients.getAllClients();
  Clients.renderClientList(
    clientListEl, clientListEmptyEl, state.clients,
    clientSearchEl.value, openClientDetail
  );
}

function openClientList() {
  showView('clients', { title: 'Cliënten', showBack: false });
  refreshClients();
}

clientSearchEl.addEventListener('input', () => {
  Clients.renderClientList(
    clientListEl, clientListEmptyEl, state.clients,
    clientSearchEl.value, openClientDetail
  );
});

document.getElementById('add-client-fab').addEventListener('click', () => {
  document.getElementById('new-client-name').value = '';
  document.getElementById('new-client-note').value = '';
  showView('addClient', { title: 'Nieuwe cliënt' });
  setTimeout(() => document.getElementById('new-client-name').focus(), 50);
});

document.getElementById('cancel-add-client').addEventListener('click', goBack);

document.getElementById('add-client-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('new-client-name').value.trim();
  const note = document.getElementById('new-client-note').value.trim();
  if (!name) return;
  const client = await Clients.addClient(name, note);
  navStack.pop(); // addClient view eraf, we vervangen 'm door clients
  openClientList();
  window.__notifyClientAdded?.(client);
});

// ---------------------------------------------------------------------
// Cliëntdetail (aantekeningen-overzicht — verder ingevuld in Fase 2)
// ---------------------------------------------------------------------

const clientDetailNoteEl = document.getElementById('client-detail-note');

function openClientDetail(client, { push = true } = {}) {
  state.currentClient = client;
  clientDetailNoteEl.textContent = client.note || '';
  showView('clientDetail', { title: client.name, push });
  window.__notifyClientOpened?.(client);
}

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------

openClientList();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(err => {
      console.warn('Service worker registratie mislukt:', err);
    });
  });
}

// Voor latere fasen (notes.js, recorder.js, etc.) exporteren we de kern
// van de router zodat andere modules views kunnen tonen zonder dat app.js
// alle logica zelf hoeft te bevatten.
export { showView, goBack, state, els, openClientList, openClientDetail, navStack };
