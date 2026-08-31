// transcription.js — spraak-naar-tekst.
//
// LET OP (privacy-afweging, expliciet gedocumenteerd voor audit):
// De Web Speech API (SpeechRecognition) werkt alleen op *live* microfoon-
// invoer, niet op een reeds opgenomen audio-Blob. Daarom laten we deze
// hardloop-transcriptie MEELOPEN tijdens het opnemen (recorder.js draait
// gelijktijdig): zodra de opname stopt, is het transcript al beschikbaar.
//
// De ingebouwde SpeechRecognition van de browser (Safari/Chrome) stuurt
// audio voor herkenning naar de speech-server van de browserleverancier
// (Apple/Google) — dat is een browsereigen voorziening, geen extra
// derde-partij-script dat we zelf toevoegen, maar het IS een moment waarop
// audio het apparaat verlaat voor transcriptie. Dit is een bewuste,
// gedocumenteerde afweging omdat volledig lokale (on-device) transcriptie
// geen standaard browser-API is. Wil je dit vermijden: vervang deze module
// door een lokale/self-hosted transcriptiedienst (bijv. whisper.cpp via
// een eigen server) — de rest van de app (opslag, encryptie, koppeling)
// verandert dan niet mee, want dit is een losse module.
//
// Het transcript blijft hoe dan ook altijd bewerkbaar door de psycholoog
// vóórdat het definitief wordt opgeslagen (zie view-transcript in app.js).

const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

export function isTranscriptionSupported() {
  return !!SpeechRecognitionImpl;
}

const MAX_CONSECUTIVE_ERRORS = 3;
const RESTART_DELAY_MS = 300;

/**
 * Start live transcriptie. Geeft een controller terug met stop().
 * @param {(text:string, isFinal:boolean)=>void} onUpdate
 * @param {(reason:string)=>void} [onFatalError] — aangeroepen als spraakherkenning
 *   herhaaldelijk faalt en de app stopt met opnieuw proberen (bijv. geen
 *   internetverbinding, of — een bekende beperking van sommige browsers —
 *   wanneer de app als geïnstalleerde snelkoppeling/PWA is geopend in
 *   plaats van in een gewoon browsertabblad). De opname zelf loopt gewoon
 *   door; alleen automatische transcriptie stopt, de psycholoog kan de
 *   tekst dan na het opnemen zelf intypen.
 */
export function startLiveTranscription(onUpdate, onFatalError) {
  if (!SpeechRecognitionImpl) return null;

  const recognition = new SpeechRecognitionImpl();
  recognition.lang = 'nl-NL';
  recognition.continuous = true;
  recognition.interimResults = true;

  let finalText = '';
  let shouldRestart = true;
  let consecutiveErrors = 0;
  let lastErrorReason = '';

  recognition.addEventListener('result', (event) => {
    consecutiveErrors = 0; // een geslaagd resultaat bewijst dat herkenning weer werkt
    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result.isFinal) {
        finalText += result[0].transcript + ' ';
      } else {
        interim += result[0].transcript;
      }
    }
    onUpdate((finalText + interim).trim(), false);
  });

  recognition.addEventListener('error', (e) => {
    // "no-speech" is normaal (gewoon een stilte) en telt niet als storing.
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    consecutiveErrors++;
    lastErrorReason = e.error;
    console.warn('Spraakherkenning fout:', e.error);
  });

  // Sommige browsers stoppen 'onend' vanzelf na stiltes; herstart dan
  // automatisch zolang de opname nog loopt. MAAR: zonder limiet kan dit
  // bij een aanhoudende storing (bijv. geen internet, of — een bekende
  // beperking — de app geopend als geïnstalleerde snelkoppeling i.p.v.
  // een gewoon browsertabblad) een oneindige, razendsnelle herstart-lus
  // worden die de pagina laat "hangen". Daarom: een korte vertraging per
  // herstart en een harde stop na een paar mislukkingen op rij.
  recognition.addEventListener('end', () => {
    if (!shouldRestart) return;
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      shouldRestart = false;
      onFatalError?.(lastErrorReason || 'onbekende fout');
      return;
    }
    setTimeout(() => {
      if (!shouldRestart) return;
      try { recognition.start(); } catch { /* al bezig, negeren */ }
    }, RESTART_DELAY_MS);
  });

  try { recognition.start(); } catch { /* ignore */ }

  return {
    stop() {
      shouldRestart = false;
      try { recognition.stop(); } catch { /* ignore */ }
      return finalText.trim();
    },
  };
}
