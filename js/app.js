// app.js — hoofdmodule: eenvoudige view-router + wiring van events.
// Bewust geen framework: de app is klein en lineair, dus vanilla state
// + DOM-manipulatie is duidelijker te auditen dan een build-toolchain.

import * as Clients from './clients.js';
import * as Notes from './notes.js';
import { createRecorder, isRecordingSupported } from './recorder.js';
import { startLiveTranscription, isTranscriptionSupported } from './transcription.js';
import { matchClientInTranscript } from './nameMatch.js';
import { initAuth, lockNow, suspendAutoLock, resumeAutoLock } from './auth.js';
import * as Sync from './sync.js';
import * as Sharing from './sharing.js';
import { formatDuration, formatDateTime, escapeHtml } from './utils.js';

const state = {
  clients: [],
  currentClient: null,
  notes: [],
  // "Werkgeheugen" van de opname die nog NIET is opgeslagen. Wordt pas een
  // echte note (db.js) na expliciete bevestiging in view-confirm.
  pending: {
    blob: null,
    mimeType: '',
    durationSec: 0,
    transcript: '',
    match: null, // { client, confidence } — resultaat van nameMatch.js
  },
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
    sync: document.getElementById('view-sync'),
  },
};

// Elke view heeft een expliciete "terug"-handler in plaats van een generieke
// geschiedenis-stack. Bij een lineaire flow onder tijdsdruk (opname →
// transcript → controlestap) is voorspelbaar per-scherm gedrag belangrijker
// dan generieke "vorige pagina"-navigatie.
let currentBackHandler = () => openClientList();

function showView(name, { title, showBack = true, onBack } = {}) {
  for (const v of Object.values(els.views)) v.classList.remove('active');
  els.views[name].classList.add('active');
  els.header.textContent = title ?? '';
  els.backBtn.hidden = !showBack;
  if (onBack) currentBackHandler = onBack;
}

function goBack() {
  currentBackHandler();
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
  showView('addClient', { title: 'Nieuwe cliënt', onBack: openClientList });
  setTimeout(() => document.getElementById('new-client-name').focus(), 50);
});

document.getElementById('cancel-add-client').addEventListener('click', goBack);

document.getElementById('add-client-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('new-client-name').value.trim();
  const note = document.getElementById('new-client-note').value.trim();
  if (!name) return;
  await Clients.addClient(name, note);
  openClientList();
});

// ---------------------------------------------------------------------
// Cliëntdetail: aantekeningen-overzicht
// ---------------------------------------------------------------------

const clientDetailNoteEl = document.getElementById('client-detail-note');
const notesListEl = document.getElementById('notes-list');
const notesListEmptyEl = document.getElementById('notes-list-empty');
const clientSharedIndicatorEl = document.getElementById('client-shared-indicator');
const shareClientBtn = document.getElementById('share-client-btn');
const deleteClientBtn = document.getElementById('delete-client-btn');

async function refreshNotes() {
  if (!state.currentClient) return;
  state.notes = await Notes.getNotesForClient(state.currentClient.id);
  Notes.renderNotesList(notesListEl, notesListEmptyEl, state.notes, openNoteDetail);
}

function openClientDetail(client) {
  state.currentClient = client;
  clientDetailNoteEl.textContent = client.note || '';
  clientSharedIndicatorEl.hidden = !client.shared;
  shareClientBtn.hidden = !!client.shared; // v1: een cliënt met precies één collega delen
  deleteClientBtn.textContent = client.shared ? 'Stop met delen (voor mij)…' : 'Cliënt verwijderen…';
  document.getElementById('share-client-form').hidden = true;
  showView('clientDetail', { title: client.name, onBack: openClientList });
  refreshNotes();
}

document.getElementById('new-note-fab').addEventListener('click', () => {
  if (!state.currentClient) return;
  openRecordView();
});

deleteClientBtn.addEventListener('click', async () => {
  const client = state.currentClient;
  if (!client) return;

  if (client.shared) {
    const ok = window.confirm(
      `Cliënt "${client.name}" wordt niet meer met jou gedeeld en verdwijnt uit jouw lijst. Je collega houdt gewoon toegang. Doorgaan?`
    );
    if (!ok) return;
    try {
      await Sharing.leaveSharedClient(client.id);
    } catch (err) {
      window.alert(err.message || 'Stoppen met delen is mislukt.');
      return;
    }
  } else {
    const ok = window.confirm(
      `Cliënt "${client.name}" en al hun aantekeningen definitief verwijderen? Dit kan niet ongedaan gemaakt worden.`
    );
    if (!ok) return;
    await Notes.deleteAllNotesForClient(client.id);
    await Clients.deleteClient(client.id);
  }
  state.currentClient = null;
  openClientList();
});

// ---------------------------------------------------------------------
// Cliënt delen met een collega
// ---------------------------------------------------------------------

const shareClientFormEl = document.getElementById('share-client-form');
const shareClientEmailEl = document.getElementById('share-client-email');
const shareClientErrorEl = document.getElementById('share-client-error');
const shareClientSubmitBtn = document.getElementById('share-client-submit');

shareClientBtn.addEventListener('click', () => {
  shareClientEmailEl.value = '';
  shareClientErrorEl.textContent = '';
  shareClientFormEl.hidden = false;
  setTimeout(() => shareClientEmailEl.focus(), 50);
});

document.getElementById('share-client-cancel').addEventListener('click', () => {
  shareClientFormEl.hidden = true;
});

shareClientSubmitBtn.addEventListener('click', async () => {
  const client = state.currentClient;
  const email = shareClientEmailEl.value.trim();
  shareClientErrorEl.textContent = '';
  if (!client) return;
  if (!email) {
    shareClientErrorEl.textContent = 'Vul het e-mailadres van je collega in.';
    return;
  }
  shareClientSubmitBtn.disabled = true;
  try {
    await Sharing.shareClient(client.id, email);
    shareClientFormEl.hidden = true;
    await trySync();
    openClientDetail({ ...client, shared: true });
  } catch (err) {
    console.warn('Delen mislukt:', err);
    shareClientErrorEl.textContent = err.message || 'Delen is mislukt.';
  } finally {
    shareClientSubmitBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------
// Opname maken
// ---------------------------------------------------------------------

const recordStartBtn = document.getElementById('record-start-btn');
const recordTimerEl = document.getElementById('record-timer');
const recordControlsEl = document.getElementById('record-controls');
const recordReviewEl = document.getElementById('record-review-controls');
const recordPlaybackEl = document.getElementById('record-playback');
const recordHintEl = document.getElementById('record-hint');
const recordVisualizerEl = document.getElementById('record-visualizer');

let recorder = null;
let liveTranscription = null;
let isRecording = false;

function resetRecordView() {
  isRecording = false;
  recordStartBtn.classList.remove('recording');
  recordVisualizerEl.classList.remove('pulsing');
  recordStartBtn.setAttribute('aria-label', 'Start opname');
  recordTimerEl.textContent = '00:00';
  recordControlsEl.hidden = false;
  recordReviewEl.hidden = true;
  if (recordPlaybackEl.src) {
    URL.revokeObjectURL(recordPlaybackEl.src);
    recordPlaybackEl.removeAttribute('src');
  }
  state.pending.blob = null;
  state.pending.mimeType = '';
  state.pending.durationSec = 0;
  state.pending.transcript = '';
  state.pending.match = null;
}

function openRecordView() {
  resetRecordView();
  if (!isRecordingSupported()) {
    recordHintEl.textContent = 'Opnemen wordt niet ondersteund in deze browser.';
    recordStartBtn.disabled = true;
  } else {
    recordHintEl.textContent = 'Noem aan het begin de naam van de cliënt, spreek daarna je aantekening in.';
    recordStartBtn.disabled = false;
  }
  showView('record', {
    title: 'Nieuwe aantekening',
    onBack: () => {
      if (isRecording) { recorder?.cancel(); resumeAutoLock(); }
      liveTranscription?.stop();
      openClientDetail(state.currentClient);
    },
  });
}

recordStartBtn.addEventListener('click', async () => {
  if (!isRecording) {
    try {
      recorder = createRecorder((seconds) => {
        recordTimerEl.textContent = formatDuration(seconds);
      });
      await recorder.start();
    } catch (err) {
      recordHintEl.textContent = 'Kon de microfoon niet gebruiken. Controleer de toestemming.';
      console.warn('getUserMedia mislukt:', err);
      return;
    }
    if (isTranscriptionSupported()) {
      liveTranscription = startLiveTranscription((text) => {
        state.pending.transcript = text;
      });
    } else {
      liveTranscription = null;
    }
    isRecording = true;
    suspendAutoLock(); // een lopende opname mag nooit door auto-lock afgebroken worden
    recordStartBtn.classList.add('recording');
    recordVisualizerEl.classList.add('pulsing');
    recordStartBtn.setAttribute('aria-label', 'Stop opname');
  } else {
    isRecording = false;
    resumeAutoLock();
    const result = await recorder.stop();
    const transcript = liveTranscription ? liveTranscription.stop() : '';
    if (transcript) state.pending.transcript = transcript;

    state.pending.blob = result.blob;
    state.pending.mimeType = result.mimeType;
    state.pending.durationSec = result.durationSec;

    recordPlaybackEl.src = URL.createObjectURL(result.blob);
    recordControlsEl.hidden = true;
    recordReviewEl.hidden = false;
    recordStartBtn.classList.remove('recording');
    recordVisualizerEl.classList.remove('pulsing');
  }
});

document.getElementById('record-discard-btn').addEventListener('click', () => {
  openRecordView();
});

document.getElementById('record-continue-btn').addEventListener('click', () => {
  openTranscriptView();
});

// ---------------------------------------------------------------------
// Transcript nakijken
// ---------------------------------------------------------------------

const transcriptTextEl = document.getElementById('transcript-text');
const transcribeStatusEl = document.getElementById('transcribe-status');

function openTranscriptView() {
  transcriptTextEl.value = state.pending.transcript;
  transcribeStatusEl.textContent = isTranscriptionSupported()
    ? 'Automatisch getranscribeerd — controleer en corrigeer waar nodig.'
    : 'Automatische transcriptie is niet beschikbaar in deze browser — typ de tekst zelf.';
  showView('transcript', {
    title: 'Transcript',
    onBack: () => {
      recordControlsEl.hidden = true;
      recordReviewEl.hidden = false;
      showView('record', { title: 'Nieuwe aantekening', onBack: () => openClientDetail(state.currentClient) });
    },
  });
  setTimeout(() => transcriptTextEl.focus(), 50);
}

document.getElementById('transcript-back-btn').addEventListener('click', goBack);

document.getElementById('transcript-continue-btn').addEventListener('click', () => {
  state.pending.transcript = transcriptTextEl.value;
  openConfirmView();
});

// ---------------------------------------------------------------------
// Verplichte controlestap: naam bevestigen vóór opslag
// ---------------------------------------------------------------------

const confirmNameEl = document.getElementById('confirm-name');
const confirmUncertainEl = document.getElementById('confirm-uncertain');
const confirmYesBtn = document.getElementById('confirm-yes-btn');
const confirmManualEl = document.getElementById('confirm-manual');
const confirmManualSearchEl = document.getElementById('confirm-manual-search');
const confirmManualListEl = document.getElementById('confirm-manual-list');

function openConfirmView() {
  const match = matchClientInTranscript(state.pending.transcript, state.clients);
  state.pending.match = match ? match.client : null;

  if (match) {
    confirmNameEl.textContent = match.client.name;
    confirmUncertainEl.hidden = true;
    confirmYesBtn.hidden = false;
    confirmManualEl.open = false;
  } else {
    confirmNameEl.textContent = '—';
    confirmUncertainEl.hidden = false;
    confirmYesBtn.hidden = true; // geen suggestie: er is niets te "bevestigen"
    confirmManualEl.open = true; // direct de handmatige lijst tonen
  }

  confirmManualSearchEl.value = '';
  renderConfirmManualList();

  showView('confirm', {
    title: 'Cliënt controleren',
    onBack: () => {
      showView('transcript', {
        title: 'Transcript', onBack: () => {
          recordControlsEl.hidden = true;
          recordReviewEl.hidden = false;
          showView('record', { title: 'Nieuwe aantekening', onBack: () => openClientDetail(state.currentClient) });
        },
      });
    },
  });
}

function renderConfirmManualList() {
  // Cliënt van de geopende pagina (indien aanwezig) bovenaan voor snelheid —
  // maar dit is uitsluitend een sortering, GEEN automatische koppeling.
  const ordered = [...state.clients].sort((a, b) => {
    if (state.currentClient) {
      if (a.id === state.currentClient.id) return -1;
      if (b.id === state.currentClient.id) return 1;
    }
    return 0;
  });
  Clients.renderClientPickList(confirmManualListEl, ordered, confirmManualSearchEl.value, async (client) => {
    await saveConfirmedNote(client);
  });
}

confirmManualSearchEl.addEventListener('input', renderConfirmManualList);

confirmYesBtn.addEventListener('click', async () => {
  if (!state.pending.match) return;
  await saveConfirmedNote(state.pending.match);
});

document.getElementById('confirm-cancel-btn').addEventListener('click', () => {
  // Niets opslaan — expliciete keuze van de psycholoog.
  resetRecordView();
  openClientDetail(state.currentClient);
});

async function saveConfirmedNote(client) {
  await Notes.addNote({
    clientId: client.id,
    transcript: state.pending.transcript,
    audioBlob: state.pending.blob,
    mimeType: state.pending.mimeType,
    durationSec: state.pending.durationSec,
  });
  resetRecordView();
  openClientDetail(client);
}

// ---------------------------------------------------------------------
// Aantekening bekijken
// ---------------------------------------------------------------------

const noteDetailDateEl = document.getElementById('note-detail-date');
const noteDetailAudioEl = document.getElementById('note-detail-audio');
const noteDetailTranscriptEl = document.getElementById('note-detail-transcript');
const noteDeleteBtn = document.getElementById('note-delete-btn');

let openNoteId = null;

async function openNoteDetail(noteSummary) {
  openNoteId = noteSummary.id;
  // De lijst bevat alleen het (al ontsleutelde) transcript, niet de audio —
  // die halen en ontsleutelen we pas nu, bij het daadwerkelijk openen.
  const note = await Notes.getNote(noteSummary.id);
  if (!note || note.id !== openNoteId) return; // ondertussen iets anders geopend
  noteDetailDateEl.textContent = `${formatDateTime(note.createdAt)} · ${formatDuration(note.durationSec)}`;
  if (noteDetailAudioEl.src) URL.revokeObjectURL(noteDetailAudioEl.src);
  noteDetailAudioEl.src = Notes.audioBlobUrl(note);
  noteDetailTranscriptEl.textContent = note.transcript || '(geen transcript)';
  showView('noteDetail', { title: 'Aantekening', onBack: () => openClientDetail(state.currentClient) });
}

noteDeleteBtn.addEventListener('click', async () => {
  if (!openNoteId) return;
  const ok = window.confirm('Deze aantekening definitief verwijderen? Dit kan niet ongedaan gemaakt worden.');
  if (!ok) return;
  await Notes.deleteNote(openNoteId);
  openNoteId = null;
  openClientDetail(state.currentClient);
});

document.getElementById('lock-now-btn').addEventListener('click', lockNow);

// ---------------------------------------------------------------------
// Synchronisatie-instellingen
// ---------------------------------------------------------------------

const syncIndicatorBtn = document.getElementById('sync-indicator-btn');
const syncStatusEl = document.getElementById('sync-status');
const syncConfiguredActionsEl = document.getElementById('sync-configured-actions');
const syncSetupFormEl = document.getElementById('sync-setup-form');
const syncLastResultEl = document.getElementById('sync-last-result');
const syncSetupErrorEl = document.getElementById('sync-setup-error');

function setSyncIndicator(state) {
  // state: 'off' | 'idle' | 'syncing' | 'offline'
  syncIndicatorBtn.classList.remove('syncing', 'offline', 'synced');
  if (state === 'syncing') syncIndicatorBtn.classList.add('syncing');
  else if (state === 'offline') syncIndicatorBtn.classList.add('offline');
  else if (state === 'idle') syncIndicatorBtn.classList.add('synced');
  syncIndicatorBtn.title = {
    off: 'Sync niet ingesteld', idle: 'Gesynchroniseerd', syncing: 'Bezig met synchroniseren…', offline: 'Sync mislukt / offline',
  }[state] || 'Synchronisatie-instellingen';
}

async function refreshSyncView() {
  const account = await Sync.getAccountState();
  syncSetupErrorEl.textContent = '';
  if (account) {
    syncStatusEl.textContent = `Ingelogd als ${account.email} op ${account.serverUrl}.` +
      (account.lastSyncAt ? ` Laatst gesynchroniseerd: ${formatDateTime(account.lastSyncAt)}.` : ' Nog niet gesynchroniseerd.');
    syncConfiguredActionsEl.hidden = false;
    syncSetupFormEl.hidden = true;
    setSyncIndicator('idle');
    await refreshPendingShares();
  } else {
    syncStatusEl.textContent = 'Synchronisatie is nog niet ingesteld. Dit apparaat werkt gewoon lokaal door.';
    syncConfiguredActionsEl.hidden = true;
    syncSetupFormEl.hidden = false;
    setSyncIndicator('off');
  }
}

// ---------------------------------------------------------------------
// Ontvangen deel-uitnodigingen (zie sharing.js)
// ---------------------------------------------------------------------

const pendingSharesSectionEl = document.getElementById('pending-shares-section');
const pendingSharesListEl = document.getElementById('pending-shares-list');

async function refreshPendingShares() {
  let shares = [];
  try {
    shares = await Sharing.getPendingShares();
  } catch (err) {
    console.warn('Ophalen van uitnodigingen mislukt:', err);
  }
  pendingSharesSectionEl.hidden = shares.length === 0;
  pendingSharesListEl.innerHTML = '';
  for (const share of shares) {
    const li = document.createElement('li');
    li.className = 'pending-share-item';
    li.innerHTML = `
      <span class="item-title">${escapeHtml(share.previewName)}</span>
      <span class="item-sub">Gedeeld door ${escapeHtml(share.fromEmail)}</span>
      <div class="pending-share-actions">
        <button class="btn btn-secondary" data-action="decline">Afwijzen</button>
        <button class="btn btn-primary" data-action="accept">Accepteren</button>
      </div>
    `;
    li.querySelector('[data-action="accept"]').addEventListener('click', async () => {
      try {
        await Sharing.acceptShare(share.shareId);
        await trySync();
        await refreshSyncView();
      } catch (err) {
        window.alert(err.message || 'Accepteren is mislukt.');
      }
    });
    li.querySelector('[data-action="decline"]').addEventListener('click', async () => {
      try {
        await Sharing.declineShare(share.shareId);
        await refreshPendingShares();
      } catch (err) {
        window.alert(err.message || 'Afwijzen is mislukt.');
      }
    });
    pendingSharesListEl.appendChild(li);
  }
}

function openSyncView() {
  showView('sync', { title: 'Synchronisatie', onBack: () => openClientList() });
  refreshSyncView();
}

syncIndicatorBtn.addEventListener('click', openSyncView);

document.getElementById('sync-setup-register-btn').addEventListener('click', async () => {
  const serverUrl = document.getElementById('sync-setup-server').value.trim();
  const email = document.getElementById('sync-setup-email').value.trim();
  const password = document.getElementById('sync-setup-password').value;
  syncSetupErrorEl.textContent = '';
  if (!serverUrl || !email || !password) {
    syncSetupErrorEl.textContent = 'Vul server, e-mail en wachtwoord in.';
    return;
  }
  try {
    await Sync.registerAccount(serverUrl, email, password);
    await trySync();
    await refreshSyncView();
  } catch (err) {
    console.warn('Sync-registratie mislukt:', err);
    syncSetupErrorEl.textContent = err.message || 'Account aanmaken mislukt.';
  }
});

document.getElementById('sync-now-btn').addEventListener('click', async () => {
  await trySync();
  await refreshSyncView();
});

document.getElementById('sync-signout-btn').addEventListener('click', async () => {
  const ok = window.confirm(
    'Uitloggen op dit apparaat? De lokale cliëntgegevens blijven gewoon staan; alleen het automatisch synchroniseren stopt.'
  );
  if (!ok) return;
  await Sync.signOut();
  await refreshSyncView();
});

async function trySync() {
  if (!(await Sync.isEnabled())) return;
  setSyncIndicator('syncing');
  try {
    const result = await Sync.syncNow();
    syncLastResultEl.textContent = `Laatste sync: ${result.pushed} verstuurd, ${result.pulled} ontvangen.`;
    setSyncIndicator('idle');
    // Lokale wijzigingen die net zijn binnengehaald (bijv. van het andere
    // apparaat) direct zichtbaar maken in het huidige scherm.
    if (els.views.clients.classList.contains('active')) refreshClients();
    if (els.views.clientDetail.classList.contains('active')) refreshNotes();
  } catch (err) {
    console.warn('Synchroniseren mislukt:', err);
    syncLastResultEl.textContent = `Synchroniseren mislukt: ${err.message || err}`;
    setSyncIndicator('offline');
  }
}

window.addEventListener('online', () => { trySync(); });
setInterval(() => { trySync(); }, 5 * 60 * 1000); // elke 5 minuten een stille poging, geen effect als sync niet is ingesteld of er geen internet is

// ---------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------
// De rest van de app (cliëntgegevens!) wordt pas getoond/geladen NADAT de
// pincode (of biometrie) is bevestigd — zie auth.js. Vóór dat moment staat
// alleen het vergrendelscherm op het scherm.

initAuth(() => {
  openClientList();
  Sync.isEnabled().then(enabled => setSyncIndicator(enabled ? 'idle' : 'off'));
  trySync();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(err => {
      console.warn('Service worker registratie mislukt:', err);
    });
  });
}

export { showView, goBack, state, els, openClientList, openClientDetail };
