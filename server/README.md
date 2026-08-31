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
4. **Een echte database.** `store.js` gebruikt bewust één simpel
   JSON-bestand zodat het ontwerp makkelijk te lezen/auditen is. Vervang
   dit voor productiegebruik door een echte database (bijv. PostgreSQL)
   met back-ups — de functie-namen in `store.js` vormen het contract dat
   je moet naboetsen.
5. **Rate limiting op `/api/login`.** Deze referentie-server heeft geen
   bescherming tegen het herhaaldelijk raden van wachtwoorden. Voeg dit
   toe (bijv. `express-rate-limit`) vóór productiegebruik.

Zolang aan deze punten niet is voldaan: gebruik de sync-functie alleen met
test-/voorbeelddata, niet met echte cliëntgegevens.
