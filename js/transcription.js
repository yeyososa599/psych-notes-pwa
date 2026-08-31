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

/**
 * Start live transcriptie. Geeft een controller terug met stop().
 * @param {(text:string, isFinal:boolean)=>void} onUpdate
 */
export function startLiveTranscription(onUpdate) {
  if (!SpeechRecognitionImpl) return null;

  const recognition = new SpeechRecognitionImpl();
  recognition.lang = 'nl-NL';
  recognition.continuous = true;
  recognition.interimResults = true;

  let finalText = '';

  recognition.addEventListener('result', (event) => {
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

  // Sommige browsers stoppen 'onend' vanzelf na stiltes; herstart dan
  // automatisch zolang de opname nog loopt (wordt gestopt via stop()).
  let shouldRestart = true;
  recognition.addEventListener('end', () => {
    if (shouldRestart) {
      try { recognition.start(); } catch { /* al bezig, negeren */ }
    }
  });
  recognition.addEventListener('error', (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    console.warn('Spraakherkenning fout:', e.error);
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
