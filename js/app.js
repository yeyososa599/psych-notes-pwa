// app.js — hoofdmodule: eenvoudige view-router + wiring van events.
// Bewust geen framework: de app is klein en lineair, dus vanilla state
// + DOM-manipulatie is duidelijker te auditen dan een build-toolchain.

import * as Clients from './clients.js';
import * as Notes from './notes.js';
import { createRecorder, isRecordingSupported } from './recorder.js';
import { startLiveTranscription, isTranscriptionSupported } from './transcription.js';
import { matchClientInTranscript } from './nameMatch.js';
import { initAuth, lockNow, suspendAutoLock, resumeAutoLock } from './auth.js';
import { formatDuration, formatDateTime } from './utils.js';

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

async function refreshNotes() {
  if (!state.currentClient) return;
  state.notes = await Notes.getNotesForClient(state.currentClient.id);
  Notes.renderNotesList(notesListEl, notesListEmptyEl, state.notes, openNoteDetail);
}

function openClientDetail(client) {
  state.currentClient = client;
  clientDetailNoteEl.textContent = client.note || '';
  showView('clientDetail', { title: client.name, onBack: openClientList });
  refreshNotes();
}

document.getElementById('new-note-fab').addEventListener('click', () => {
  if (!state.currentClient) return;
  openRecordView();
});

document.getElementById('delete-client-btn').addEventListener('click', async () => {
  const client = state.currentClient;
  if (!client) return;
  const ok = window.confirm(
    `Cliënt "${client.name}" en al hun aantekeningen definitief verwijderen? Dit kan niet ongedaan gemaakt worden.`
  );
  if (!ok) return;
  await Notes.deleteAllNotesForClient(client.id);
  await Clients.deleteClient(client.id);
  state.currentClient = null;
  openClientList();
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
// Init
// ---------------------------------------------------------------------
// De rest van de app (cliëntgegevens!) wordt pas getoond/geladen NADAT de
// pincode (of biometrie) is bevestigd — zie auth.js. Vóór dat moment staat
// alleen het vergrendelscherm op het scherm.

initAuth(() => {
  openClientList();
});

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('service-worker.js').catch(err => {
      console.warn('Service worker registratie mislukt:', err);
    });
  });
}

export { showView, goBack, state, els, openClientList, openClientDetail };
