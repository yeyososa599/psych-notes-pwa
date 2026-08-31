// nameMatch.js — probeert de cliëntnaam te herkennen in het gesproken
// transcript (meestal genoemd aan het begin van de opname).
//
// BELANGRIJK: dit is uitdrukkelijk een HULPMIDDEL, geen autoriteit. Deze
// module koppelt zelf NOOIT iets op te slaan — hij geeft alleen een
// suggestie + betrouwbaarheidsscore terug. app.js toont die suggestie
// altijd in de verplichte controlestap ("Is dit [naam]?") en slaat pas op
// na expliciete bevestiging door de psycholoog (zie view-confirm).

const CONFIDENCE_THRESHOLD = 0.72;
const WORDS_TO_SCAN = 20; // naam wordt meestal vroeg in de opname genoemd
const MAX_NAME_WORDS = 3; // "Jan de Vries" etc.

// Nederlandse tussenvoegsels/stopwoorden: te kort en te gangbaar om op
// zichzelf een cliënt te "herkennen" (bijv. "de" uit "Jan de Vries" staat
// ook zomaar in een willekeurige zin en zou anders een valse match geven).
const STOPWORDS = new Set([
  'de', 'het', 'een', 'en', 'van', 'der', 'den', 'ter', 'ten', 'te',
  'voor', 'over', 'met', 'is', 'was', 'dat', 'die', 'deze', 'dit',
  'naar', 'aan', 'op', 'in', 'om', 'er', 'ze', 'hij', 'zij', 'ik',
  'je', 'jij', 'u', 'we', 'wij', 'maar', 'als', 'dan', 'nog', 'wel',
  'niet', 'ook', 'zo', 'nu', 'dus', 'bij', 'uit', 'van de', 'even',
]);

function normalize(str) {
  return (str || '')
    .toLowerCase()
    .normalize('NFD').replace(/\p{Diacritic}/gu, '') // diakritische tekens weg
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function similarity(a, b) {
  if (!a || !b) return 0;
  const dist = levenshtein(a, b);
  return 1 - dist / Math.max(a.length, b.length);
}

/**
 * @param {string} transcript
 * @param {Array<{id:string,name:string}>} clients
 * @returns {{client: object, confidence: number} | null}
 */
export function matchClientInTranscript(transcript, clients) {
  const words = normalize(transcript).split(' ').filter(Boolean).slice(0, WORDS_TO_SCAN);
  if (words.length === 0 || clients.length === 0) return null;

  let best = null;

  for (const client of clients) {
    const normName = normalize(client.name);
    if (!normName) continue;
    const nameWordCount = normName.split(' ').length;

    let bestForClient = 0;

    // Schuif een venster van vergelijkbare lengte over het begin van de
    // transcriptie en vergelijk met de volledige naam.
    for (let start = 0; start <= words.length - 1; start++) {
      for (let len = 1; len <= Math.min(MAX_NAME_WORDS, nameWordCount + 1, words.length - start); len++) {
        const window = words.slice(start, start + len).join(' ');
        const score = similarity(window, normName);
        if (score > bestForClient) bestForClient = score;
      }
    }

    // Ook los op voornaam/achternaam matchen (herkenning is vaak
    // onvolledig, bijv. alleen de voornaam genoemd). Tussenvoegsels en
    // korte stopwoorden slaan we over: die geven anders valse matches
    // omdat ze toevallig ook in gewone tekst voorkomen.
    const nameParts = normName.split(' ').filter(p => p.length >= 3 && !STOPWORDS.has(p));
    for (const part of nameParts) {
      for (const word of words) {
        if (STOPWORDS.has(word)) continue;
        const score = similarity(word, part);
        if (score > bestForClient) bestForClient = score;
      }
    }

    if (!best || bestForClient > best.confidence) {
      best = { client, confidence: bestForClient };
    }
  }

  if (!best || best.confidence < CONFIDENCE_THRESHOLD) return null;
  return best;
}

export { CONFIDENCE_THRESHOLD };
