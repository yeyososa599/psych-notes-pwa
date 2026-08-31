// recorder.js — audio opnemen via de MediaRecorder API.
// Geeft alleen een Blob + duur terug; slaat zelf niets op (dat doet notes.js
// pas ná de verplichte controlestap in app.js).

export function isRecordingSupported() {
  return !!(navigator.mediaDevices && window.MediaRecorder);
}

/**
 * Maakt een recorder-instantie.
 * @param {(seconds:number)=>void} onTick — aangeroepen elke seconde tijdens opname.
 */
export function createRecorder(onTick) {
  let stream = null;
  let mediaRecorder = null;
  let chunks = [];
  let startedAt = 0;
  let tickInterval = null;

  async function start() {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    const mimeType = pickMimeType();
    mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    mediaRecorder.addEventListener('dataavailable', (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    });
    mediaRecorder.start();
    startedAt = Date.now();
    tickInterval = setInterval(() => {
      onTick?.((Date.now() - startedAt) / 1000);
    }, 250);
  }

  function stop() {
    return new Promise((resolve) => {
      if (!mediaRecorder) return resolve(null);
      mediaRecorder.addEventListener('stop', () => {
        clearInterval(tickInterval);
        stream.getTracks().forEach(t => t.stop());
        const durationSec = (Date.now() - startedAt) / 1000;
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        resolve({ blob, durationSec, mimeType: blob.type });
      }, { once: true });
      mediaRecorder.stop();
    });
  }

  function cancel() {
    clearInterval(tickInterval);
    if (mediaRecorder && mediaRecorder.state !== 'inactive') mediaRecorder.stop();
    stream?.getTracks().forEach(t => t.stop());
  }

  return { start, stop, cancel };
}

function pickMimeType() {
  const candidates = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/mp4',
  ];
  for (const c of candidates) {
    if (window.MediaRecorder?.isTypeSupported?.(c)) return c;
  }
  return '';
}
