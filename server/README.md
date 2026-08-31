# Sync-server — referentie-implementatie

Dit is de server-kant van de sync-module (Fase 4). Hij slaat **uitsluitend
versleutelde data** op: cliëntnamen, notities, transcripten en audio komen
hier nooit in leesbare vorm binnen. Zie de commentaren bovenin `server.js`
en `store.js` voor het volledige "zero-knowledge"-ontwerp.

## Lokaal draaien (ontwikkelen/testen)

```bash
cd server
npm install
npm start
```

De server luistert op `http://localhost:8787`. Dit is **alleen voor lokaal
testen** — gebruik dit nooit zo in productie (geen HTTPS, geen echte
database, geen rate limiting).

## Vereisten vóór je dit écht gebruikt met cliëntgegevens

Dit zijn bewuste, niet-technische keuzes die de psycholoog/praktijk zelf
moet maken — dit valt buiten wat code kan regelen:

1. **EU-hosting.** Host deze server bij een partij die binnen de EU/EER
   draait (bijv. een Nederlandse of Duitse cloudprovider).
2. **Verwerkersovereenkomst (AVG).** Sluit met die hostingpartij een
   verwerkersovereenkomst af — verplicht bij het verwerken van bijzondere
   persoonsgegevens (gezondheidsgegevens) namens een derde.
3. **HTTPS verplicht.** Zet in productie altijd een geldig TLS-certificaat
   voor deze server (bijv. via de reverse proxy/loadbalancer van je
   hostingpartij). De app weigert data niet actief over http://, maar dit
   is een harde eis voor verantwoord gebruik.
4. **Een echte database, of op zijn minst een persistente schijf.**
   `store.js` gebruikt bewust één simpel JSON-bestand zodat het ontwerp
   makkelijk te lezen/auditen is. Op de meeste hostingplatforms (o.a.
   Render, zowel gratis als standaard betaald) is de schijf **niet
   blijvend**: bij elke herstart van de server (na inactiviteit, of bij
   een nieuwe deploy) begint het bestandssysteem leeg — dan lijken alle
   accounts en gesynchroniseerde data ineens verdwenen ("onbekend
   account" bij inloggen, terwijl het account eerder wél werkte).
   - **Snelle fix (Render):** voeg in de dashboard van je service een
     **Disk** toe (tabblad "Disks" → "Add Disk", bijv. 1GB, mount path
     `/data`) en zet de omgevingsvariabele `DATA_DIR=/data`. Herstart de
     service — vanaf nu overleeft `data/db.json` een herstart.
   - **Beter voor echt productiegebruik:** vervang `store.js` alsnog door
     een echte database (bijv. PostgreSQL) met back-ups — de
     functie-namen in `store.js` vormen het contract dat je moet
     naboetsen.
5. **Rate limiting op `/api/login`.** Deze referentie-server heeft geen
   bescherming tegen het herhaaldelijk raden van wachtwoorden. Voeg dit
   toe (bijv. `express-rate-limit`) vóór productiegebruik.

Zolang aan deze punten niet is voldaan: gebruik de sync-functie alleen met
test-/voorbeelddata, niet met echte cliëntgegevens.

## Optioneel: AI-tekstcorrectie (`/api/ai-cleanup`)

Dit is de **enige plek in de hele app** waar onversleutelde, leesbare
cliëntgerelateerde tekst (het transcript) het apparaat/de eigen server
verlaat — bewust losstaand van de zero-knowledge sync hierboven, want een
AI-dienst kan alleen corrigeren wat hij kan lézen. Sta dus zelf stil bij of
en hoe je dit inzet, los van de rest van dit document.

**Inschakelen:**
```bash
# in server/.env of als omgevingsvariabele op je hostingpartij:
ANTHROPIC_API_KEY=sk-ant-...
```
Zonder deze variabele geeft de route gewoon een nette foutmelding — de
rest van de app (incl. gewone sync) blijft dan onveranderd werken.

**Wat dit voor jou betekent:**
- De psycholoog zet dit zelf per apparaat aan (uit bij installatie) — zie
  de toggle "AI-tekstcorrectie" bij Synchronisatie-instellingen in de app.
- Elke keer dat dit aanstaat, gaat de ruwe transcript-tekst (kan een
  cliëntnaam en inhoudelijke details bevatten) naar de Anthropic API.
- Ga na of Anthropic voor jouw gebruik een passende verwerkersovereenkomst
  aanbiedt en waar de verwerking plaatsvindt, vóórdat je dit met echte
  cliëntgegevens gebruikt — net als bij de keuze van je hostingpartij is
  dit een eigen (juridische) afweging, geen technische garantie die deze
  code kan geven.
- De psycholoog blijft de gecorrigeerde tekst altijd zelf controleren vóór
  opslag (dezelfde controlestap als bij de gewone transcriptie) — AI-
  correctie is een hulpmiddel, geen automatische goedkeuring.
