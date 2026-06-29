# Share App — Design / Spec

**Data:** 2026-06-29
**Stato:** approvato per la stesura del piano di implementazione
**Obiettivo:** MVP funzionante e deployabile

## 1. Sommario

Web app per condividere risorse (file, immagini o contenuto testuale) tramite un
**URL impredicibile** ("capability URL"). L'URL contiene un token casuale ad alta
entropia che funge sia da identificatore sia da segreto. Il contenuto è cifrato a
riposo con una chiave **derivata dal token**, quindi il server non è in grado di
leggerlo senza il link. Ogni condivisione può avere regole di scadenza
**combinabili**: una scadenza temporale (timestamp) e/o un numero massimo di
accessi (1–3).

## 2. Decisioni chiave

| Tema | Decisione |
|---|---|
| Natura del progetto | MVP da usare/deployare davvero |
| Stack | **Next.js 15** (App Router, React 19), TypeScript, full-stack |
| Persistenza metadati | **SQLite** (`better-sqlite3`) |
| Persistenza contenuti | **filesystem** (blob cifrati su disco) |
| Modello URL | **token random per risorsa** (capability URL, 256 bit) |
| Cifratura | **AES-256-GCM**, chiave **derivata dal token** (HKDF-SHA256) |
| Regole scadenza | **combinabili**: timestamp e/o max accessi |
| Accessi | configurabili **1–3** (default 1); **consumo alla prima apertura** |
| Creazione | **aperta a chiunque** + rate-limiting |
| Dimensione max file | **25 MB** |
| Sicurezza contenuti | **validazione statica + ClamAV opzionale** (scansione all'upload) |

## 3. Architettura & struttura

Tutte le route che toccano DB / crypto / filesystem girano nel **Node.js runtime**
di Next.js (non Edge).

```
share-app/
├─ app/
│  ├─ page.tsx                  # UI creazione link (form)
│  ├─ s/[token]/page.tsx        # pagina accesso risorsa (consuma alla prima apertura)
│  └─ api/
│     ├─ share/route.ts         # POST: crea condivisione → ritorna URL
│     └─ share/[token]/route.ts # GET: recupera+decifra; DELETE: revoca
├─ lib/
│  ├─ db.ts                     # connessione SQLite + migrazione schema
│  ├─ crypto.ts                 # token, HKDF, AES-256-GCM encrypt/decrypt
│  ├─ store.ts                  # create/consume/expire (logica dominio, testabile)
│  ├─ content-safety.ts         # validazione tipi, magic-bytes, ClamAV opzionale
│  ├─ rate-limit.ts             # rate-limiting in-memory sulla creazione
│  └─ cleanup.ts                # purge degli scaduti/esauriti
├─ data/                        # share.db + blob cifrati (gitignored)
├─ test/                        # unit + integrazione (Vitest)
└─ ...config (next.config, tsconfig, tailwind, vitest)
```

**Principio di isolamento:** `crypto.ts`, `store.ts` e `content-safety.ts` non
conoscono Next.js (pura logica di dominio, testabile in isolamento); le route sono
sottili adattatori HTTP.

## 4. Modello dati

Tabella `shares` (SQLite):

| campo | tipo | note |
|---|---|---|
| `id` | TEXT (uuid) | id interno, non esposto |
| `token_hash` | TEXT | SHA-256 del token → usato per il lookup |
| `kind` | TEXT | `text` \| `file` (immagine = file) |
| `filename` | TEXT null | nome originale (file) |
| `mime` | TEXT | content-type |
| `blob_path` | TEXT | percorso del file cifrato su disco |
| `iv` | BLOB | nonce AES-GCM |
| `auth_tag` | BLOB | tag GCM (integrità) |
| `size` | INTEGER | byte del contenuto in chiaro |
| `expires_at` | INTEGER null | epoch ms; null = nessuna scadenza temporale |
| `max_accesses` | INTEGER null | 1–3; null = illimitati |
| `access_count` | INTEGER | default 0 |
| `created_at` | INTEGER | epoch ms |

**Invarianti:**
- Il **token non è mai persistito** (si salva solo `token_hash`).
- Nessun campo `secret` o `used` separato: l'esaurimento si calcola da
  `access_count` / `expires_at`.

## 5. Flusso di sicurezza

### 5.1 Creazione (POST /api/share)
1. Valida input (`kind`, contenuto, `expiresAt?`, `maxAccesses?` ∈ 1–3).
2. **Content-safety** sul contenuto in chiaro (vedi §6) — *prima* della cifratura.
3. Genera `token = randomBytes(32)` → `tokenUrl = base64url(token)` (256 bit).
4. `key = HKDF-SHA256(token, salt, info)` → chiave AES a 256 bit.
5. Cifra il contenuto con **AES-256-GCM** → blob + `iv` + `auth_tag`.
6. Salva la riga con `token_hash = sha256(token)` e il blob su disco.
7. Ritorna `{ url: "https://host/s/<tokenUrl>" }`. Il token compare **solo** nella
   response, **mai nei log**.

### 5.2 Accesso (GET /s/<token> → GET /api/share/<token>)
1. `sha256(token)` → lookup riga. Se assente → **404**.
2. Valida scadenza: se `expires_at` superato **oppure**
   `access_count >= max_accesses` → **410 Gone** (e purge).
3. **Incremento atomico** di `access_count` (transazione SQLite) per evitare race
   su accessi concorrenti.
4. Deriva di nuovo la chiave dal token, **decifra** (verifica `auth_tag`),
   restituisce il contenuto.
5. Se dopo l'incremento il link risulta esaurito → **elimina blob + riga**.

### 5.3 Conseguenze e caveat
- Chi ruba **solo il DB/disco** non può decifrare nulla: la chiave vive solo nel
  token, che non è mai salvato.
- Il `token_hash` consente il lookup ma non l'inversione del token.
- ⚠️ **Caveat noto** (scelta consapevole "consumo alla prima apertura"): prefetch
  del browser, scanner antivirus o anteprime di chat possono consumare un accesso.
  Documentato; una pagina di conferma esplicita è un'estensione futura.

## 6. Sicurezza dei contenuti

La scansione avviene **all'upload, sul contenuto in chiaro, prima della
cifratura** (vincolo architetturale: dopo la cifratura il server non può più
leggere il contenuto).

**File / immagini:**
1. Limite **25 MB** (rifiuto in streaming oltre soglia → `413`).
2. **Magic-bytes sniffing** (`file-type`): il tipo reale deve combaciare col tipo
   dichiarato.
3. **Allowlist** MIME (documenti, immagini, testo, pdf, archivi comuni) e
   **blocklist** eseguibili/script (`.exe`, `.bat`, `.sh`, `.js`, `.html`, …) →
   violazione `415`.
4. **ClamAV opzionale**: se `CLAMAV_ENABLED=true`, scansione via `clamd`; esito
   infetto → `422`. Se disabilitato, si procede con la sola validazione statica.

**Testo:**
- Mai renderizzato come HTML: sempre mostrato come testo **escaped**.
- Header `Content-Security-Policy` e `X-Content-Type-Options: nosniff`.

**Serving sicuro (file):** sempre `Content-Disposition: attachment` (mai
inline-render).

## 7. UI (React / Next)

**Pagina creazione (`/`):**
- Toggle **Testo / File**; area testo oppure dropzone.
- Controlli scadenza (opzionali e **combinabili**): date-time picker per il
  timestamp, select **1–3** per gli accessi.
- Bottone **Genera link** → card con URL, pulsante copia e avviso "salvalo, è
  mostrato una sola volta".

**Pagina accesso (`/s/[token]`):**
- Mostra il contenuto (testo escaped o pulsante di download) e un avviso se il link
  è monouso.
- Stati: valido / scaduto (410) / inesistente (404) / infetto / troppo grande.

## 8. Ciclo di vita & gestione errori

- **Cleanup** (`lib/cleanup.ts`): purge dei record con `expires_at` superato o
  accessi esauriti; eseguito **lazy** (on-access) e **on-startup**. Un cron è
  un'estensione futura opzionale.
- **Rate-limiting** in-memory sulla creazione (creazione aperta a chiunque).
- **Codici di errore:**
  - `400` input non valido
  - `404` token assente
  - `410` scaduto / esaurito
  - `413` contenuto troppo grande
  - `415` tipo non consentito
  - `422` contenuto infetto (ClamAV)
  - `429` rate-limit superato

## 9. Testing (Vitest)

- **crypto:** round-trip cifratura/decifratura, derivazione chiave da token,
  fallimento su `auth_tag` manomesso.
- **store:** scadenza per timestamp, incremento atomico, esaurimento accessi e
  purge, accessi concorrenti.
- **content-safety:** mismatch magic-bytes, blocklist eseguibili, limite
  dimensione.
- **integrazione route:** create → access → re-access esaurito; timestamp scaduto;
  tipo non consentito.

## 10. Fuori scope (estensioni future)

- Pagina di conferma esplicita prima del consumo (mitiga il caveat §5.3).
- Account utente / login.
- Cron di cleanup schedulato.
- Object storage cloud (S3) al posto del filesystem.
- Integrazione VirusTotal.
