// ==========================================================================
// aiCleanup.js — OPTIONELE AI-TEKSTCORRECTIE (aparte, afgebakende module,
// standaard UITGESCHAKELD)
//
// BELANGRIJKE UITZONDERING op het "niets verlaat het apparaat onversleuteld"
// principe van de rest van deze app: om spelling/interpunctie te verbeteren
// en waarschijnlijk verkeerd-verstane woorden te corrigeren, moet een
// AI-dienst de tekst kunnen LEZEN. Deze module stuurt het ruwe transcript
// (leesbare tekst, geen audio) naar de eigen server van de psycholoog
// (dezelfde server als sync.js), die het vervolgens doorstuurt naar de
// Anthropic API — zie server/server.js en server/README.md voor de
// serverkant en de bijbehorende overwegingen.
//
// Dit gebeurt UITSLUITEND als de psycholoog dit zelf expliciet aanzet (zie
// de toggle bij Synchronisatie-instellingen in app.js) en vereist dat sync
// al is ingesteld — er is geen apart account/wachtwoord voor nodig, deze
// module hergebruikt de bestaande sync-sessie puur als "wie ben ik"-bewijs
// richting de eigen server.
//
// De psycholoog controleert de gecorrigeerde tekst ALTIJD zelf vóór opslag
// — dezelfde verplichte controlestap als bij de gewone transcriptie. Deze
// module slaat zelf nooit iets op en koppelt nooit iets aan een cliënt.
// ==========================================================================

import { db } from './db.js';
import { apiCall } from './utils.js';

const META_KEY = 'aiCleanupEnabled';
const SYNC_META_KEY = 'syncAccount'; // lokaal opnieuw gelezen i.p.v. sync.js te importeren, om een kringverwijzing te vermijden

export async function isEnabled() {
  const rec = await db.get('meta', META_KEY);
  return !!rec?.value;
}

export async function setEnabled(enabled) {
  await db.put('meta', { key: META_KEY, value: !!enabled });
}

/**
 * Stuurt het transcript naar de eigen server voor AI-correctie. Gooit een
 * leesbare fout als sync niet is ingesteld of de server het niet
 * ondersteunt — de aanroeper (app.js) valt dan terug op de ruwe tekst,
 * dit mag nooit het opslaan van een aantekening blokkeren.
 */
export async function cleanup(transcript) {
  const rec = await db.get('meta', SYNC_META_KEY);
  if (!rec) throw new Error('AI-correctie vereist dat synchronisatie is ingesteld (dezelfde server wordt gebruikt).');
  const account = rec.value;

  const { cleanedTranscript } = await apiCall(account.serverUrl, '/api/ai-cleanup', {
    method: 'POST', token: account.sessionToken, body: { transcript },
  });
  return cleanedTranscript;
}
