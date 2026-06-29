# Share App

Condivisione sicura di **testo** e **file** tramite un **link impredicibile**
(capability URL). L'URL contiene un token casuale a 256 bit che è insieme
identificatore e segreto: il contenuto è cifrato a riposo con una chiave
**derivata dal token** (AES-256-GCM + HKDF-SHA256), quindi senza il link nemmeno
il server può leggerlo. Ogni link può scadere per **numero di accessi** (1–3,
default monouso) e/o per **timestamp**.

> Stack: Next.js 15 (App Router, React 19) · TypeScript · SQLite (better-sqlite3)
> · blob cifrati su filesystem · Vitest. Dettagli in
> [`docs/product-design.md`](docs/product-design.md).

---

## Prerequisiti

- **Node.js ≥ 20** (testato su v24)
- **npm** (incluso in Node)
- Un toolchain per la build del modulo nativo `better-sqlite3`
  (su Windows è incluso in Node; non serve installare altro nei casi normali).

---

## Avvio rapido (locale)

```bash
# 1. Installa le dipendenze (compila anche better-sqlite3)
npm install

# 2. Avvia in sviluppo
npm run dev
```

Apri **http://localhost:3000** e:

1. scegli **Testo** o **File**;
2. (opzionale) imposta scadenza e/o accessi massimi;
3. premi **Genera link** e copialo — viene mostrato una sola volta;
4. apri il link (`/s/<token>`) per leggere il testo o scaricare il file.
   ⚠️ L'apertura **consuma un accesso**: un link monouso, dopo la prima
   visita, non è più disponibile.

> **better-sqlite3 non compila?** `npm install` esegue da sé lo script di build
> del modulo nativo. Se necessario forza la ricompilazione con
> `npm rebuild better-sqlite3`.

---

## Comandi

| Comando | Cosa fa |
|---|---|
| `npm run dev` | server di sviluppo (http://localhost:3000) |
| `npm run build` | build di produzione |
| `npm start` | server di produzione (default porta 3000, override con `PORT`) |
| `npm test` | unit + integrazione (Vitest) |
| `npm run lint` | ESLint |

Esecuzione in produzione locale:

```bash
npm run build
PORT=3000 npm start
```

---

## Configurazione (variabili d'ambiente)

Tutte opzionali: l'app funziona senza configurazione.

| Variabile | Default | Descrizione |
|---|---|---|
| `DATA_DIR` | `./data` | cartella di `share.db` e dei blob cifrati |
| `RATE_LIMIT` | `10` | creazioni di link al minuto per IP |
| `CLAMAV_ENABLED` | _(off)_ | `true` per scansionare gli upload con ClamAV |
| `CLAMAV_HOST` | `127.0.0.1` | host di `clamd` |
| `CLAMAV_PORT` | `3310` | porta di `clamd` |

Esempio:

```bash
DATA_DIR=./data RATE_LIMIT=20 npm run dev
```

I dati persistono in `DATA_DIR` (`share.db` + `data/blobs/`). L'intera cartella
`data/` è **gitignored**: non viene committata. Senza i token (mai salvati) i
blob non sono decifrabili.

---

## Sicurezza in breve

- Token **mai persistito** (si salva solo `sha256(token)` per il lookup).
- Contenuto cifrato **AES-256-GCM**; chiave derivata dal token via **HKDF**.
- Validazione upload: limite **25 MB**, controllo magic-bytes, allowlist MIME +
  blocklist eseguibili, ClamAV opzionale.
- Testo sempre **escaped** (mai HTML); header `Content-Security-Policy` e
  `X-Content-Type-Options: nosniff`.
- **Servire sempre in HTTPS** in produzione: il token viaggia nell'URL.
- Pensato per **singola istanza** (rate-limit e cleanup sono in-memory/lazy).

Procedure operative e di manutenzione complete in
[`docs/manuale-operativo.md`](docs/manuale-operativo.md).
