// Kleine, afhankelijkheidsvrije hulpfuncties. Bewust geen npm-package:
// minder toeleveringsketen-risico voor een app die medische data verwerkt.

export function uuid() {
  // crypto.randomUUID() is beschikbaar in alle moderne browsers binnen een
  // secure context (https / localhost), wat een PWA sowieso vereist.
  return crypto.randomUUID();
}

export function formatDateTime(isoString) {
  const d = new Date(isoString);
  return d.toLocaleString('nl-NL', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
}

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

export function debounce(fn, wait) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), wait);
  };
}

// Chunked base64 (de)codering — voorkomt een stack overflow bij grote
// audio-Blobs, wat een naïeve String.fromCharCode(...bytes) wél zou geven.
export function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Zet een {iv,data[,mimeType]}-versleutelobject (Uint8Arrays, zoals
// crypto.js teruggeeft) om naar JSON-veilige base64-strings en terug.
// Gedeeld door sync.js en sharing.js — beide sturen alleen ciphertext
// over het netwerk, nooit de sleutel waarmee het versleuteld is.
export function serializeEnc(enc) {
  if (!enc) return null;
  return { iv: bytesToBase64(enc.iv), data: bytesToBase64(enc.data), ...(enc.mimeType ? { mimeType: enc.mimeType } : {}) };
}

export function deserializeEnc(enc) {
  if (!enc) return null;
  return { iv: base64ToBytes(enc.iv), data: base64ToBytes(enc.data), ...(enc.mimeType ? { mimeType: enc.mimeType } : {}) };
}

/** Wire-representatie van een cliëntrecord (nog steeds ciphertext) voor over het netwerk. */
export function serializeClientRecord(r) {
  if (r.deleted) return { id: r.id, deleted: true, createdAt: r.createdAt, updatedAt: r.updatedAt };
  return {
    id: r.id, deleted: false, createdAt: r.createdAt, updatedAt: r.updatedAt,
    encName: serializeEnc(r.encName), encNote: serializeEnc(r.encNote),
  };
}
export function deserializeClientRecord(r) {
  if (r.deleted) return { id: r.id, deleted: true, createdAt: r.createdAt, updatedAt: r.updatedAt };
  return {
    id: r.id, deleted: false, createdAt: r.createdAt, updatedAt: r.updatedAt,
    encName: deserializeEnc(r.encName), encNote: deserializeEnc(r.encNote),
  };
}

/** Wire-representatie van een aantekeningrecord (nog steeds ciphertext) voor over het netwerk. */
export function serializeNoteRecord(r) {
  if (r.deleted) return { id: r.id, clientId: r.clientId, deleted: true, createdAt: r.createdAt, updatedAt: r.updatedAt };
  return {
    id: r.id, clientId: r.clientId, deleted: false, createdAt: r.createdAt, updatedAt: r.updatedAt,
    durationSec: r.durationSec, encTranscript: serializeEnc(r.encTranscript), encAudio: serializeEnc(r.encAudio),
  };
}
export function deserializeNoteRecord(r) {
  if (r.deleted) return { id: r.id, clientId: r.clientId, deleted: true, createdAt: r.createdAt, updatedAt: r.updatedAt };
  return {
    id: r.id, clientId: r.clientId, deleted: false, createdAt: r.createdAt, updatedAt: r.updatedAt,
    durationSec: r.durationSec, encTranscript: deserializeEnc(r.encTranscript), encAudio: deserializeEnc(r.encAudio),
  };
}

/** Kleine wrapper rond fetch voor de sync/sharing-API's. Gooit een leesbare fout bij een niet-2xx-status. */
export async function apiCall(serverUrl, path, { method = 'GET', body, token } = {}) {
  const res = await fetch(serverUrl.replace(/\/$/, '') + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Serverfout (${res.status})`);
  return data;
}
