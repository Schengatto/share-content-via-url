# Share App — Product Design

**Ultimo allineamento:** 2026-06-29 (toolchain: npm + dipendenze freezate all'ultima versione, Next 16 / Tailwind 4; UI upload: dropzone drag&drop + badge tipi supportati da `lib/file-support.ts`)
**Stato:** MVP implementato (lib + route + UI), build e test verdi.

Documento canonico e sempre aggiornato dell'app: architettura, modello dati,
mappa delle funzionalità, invarianti e roadmap. Riferimento della spec:
[`docs/superpowers/specs/2026-06-29-share-app-design.md`](superpowers/specs/2026-06-29-share-app-design.md).

---

## 1. Cosa fa

Web app per condividere **testo** o **file** tramite un **link impredicibile**
("capability URL"). L'URL contiene un token casuale a 256 bit che funge sia da
identificatore sia da segreto. Il contenuto è **cifrato a riposo** con una chiave
**derivata dal token**: senza il link, nemmeno il server può leggerlo.

Ogni condivisione ha regole di scadenza **combinabili**:

- **numero massimo di accessi** 1–3 (default 1, monouso) — consumo alla prima apertura;
- **scadenza temporale** opzionale (timestamp).

---

## 2. Architettura

Stack: **Next.js 16** (App Router, React 19, Turbopack), **TypeScript**, **SQLite**
(`better-sqlite3`), blob cifrati su **filesystem**. Tutte le route che toccano
DB/crypto/FS girano nel **Node runtime** (mai Edge).

```
app/
  page.tsx                    UI creazione link (client component)
  s/[token]/page.tsx          pagina accesso (server component, consuma all'apertura)
  s/[token]/file-download.tsx download lato client da base64
  api/share/route.ts          POST: crea condivisione → { url }
  api/share/[token]/route.ts  DELETE: revoca
lib/
  crypto.ts          token, HKDF, AES-256-GCM (encrypt/decrypt)
  db.ts              connessione SQLite + migrazione schema
  blob-store.ts      persistenza blob cifrati (filesystem; interfaccia iniettabile)
  store.ts           create/consume/revoke (logica di dominio)
  file-support.ts    allowlist tipi/estensioni + MAX_SIZE (client-safe, condivisa UI↔server)
  content-safety.ts  size, magic-bytes, allow/blocklist, hook ClamAV (deriva da file-support)
  clamav.ts          client clamd INSTREAM (TCP, nessuna dipendenza)
  rate-limit.ts      rate-limiting in-memory (finestra fissa)
  cleanup.ts         purge degli scaduti/esauriti
  app.ts             wiring runtime (singleton DB/blob + cleanup on-startup)
test/                unit + integrazione (Vitest)
data/                share.db + blob cifrati (gitignored)
```

**Principio di isolamento:** `crypto`, `store`, `content-safety`, `cleanup`,
`rate-limit` non conoscono Next.js (logica pura, testabile in isolamento); le
route/pagine sono adattatori sottili. `store` riceve `db` e `BlobStore` per
dependency injection (test con SQLite `:memory:` + blob store in-memory).

---

## 3. Modello dati

Tabella `shares` (SQLite), indice unico su `token_hash`:

| campo | tipo | note |
|---|---|---|
| `id` | TEXT (uuid) | id interno, non esposto |
| `token_hash` | TEXT | SHA-256 del token → lookup |
| `kind` | TEXT | `text` \| `file` |
| `filename` | TEXT null | nome originale (file) |
| `mime` | TEXT | content-type |
| `blob_path` | TEXT | id del blob cifrato su disco (= `id`) |
| `iv` | BLOB | nonce AES-GCM (12 byte) |
| `auth_tag` | BLOB | tag GCM (16 byte) |
| `size` | INTEGER | byte del contenuto in chiaro |
| `expires_at` | INTEGER null | epoch ms; null = nessuna scadenza temporale |
| `max_accesses` | INTEGER null | 1–3; null = illimitati (UI usa sempre 1–3) |
| `access_count` | INTEGER | default 0 |
| `created_at` | INTEGER | epoch ms |

---

## 4. Flussi

### Creazione — `POST /api/share`
1. Rate-limit per IP (default 10/min). Superato → **429**.
2. Parsing `FormData`: `kind`, `text` **oppure** `file`, `expiresAt?`, `maxAccesses` (default 1).
3. **Content-safety** sul contenuto **in chiaro** (prima della cifratura).
4. `createShare`: genera token 256-bit → HKDF-SHA256 → chiave AES-256 → AES-256-GCM →
   salva riga (`token_hash`) + blob su disco.
5. Risposta `{ url: "<origin>/s/<token>" }`. Il token compare **solo** nella response.

### Accesso — `GET /s/<token>` (server component)
1. `consumeShare`: `sha256(token)` → lookup. Assente → pagina **non disponibile** (404).
2. Se `expires_at` superato **o** `access_count >= max_accesses` → **purge** + pagina gone (410).
3. **Incremento atomico** di `access_count` con `UPDATE … WHERE` condizionale (race-safe).
4. Deriva la chiave, **decifra** (verifica `auth_tag`).
5. `text` → reso come testo **escaped**; `file` → download lato client (base64 → Blob).
6. Se dopo l'incremento è esaurito → **elimina blob + riga**.

### Revoca — `DELETE /api/share/<token>`
Elimina riga + blob per token; **404** se non trovato.

---

## 5. Sicurezza dei contenuti

Scansione **all'upload, sul contenuto in chiaro, prima della cifratura** (dopo non
è più leggibile dal server).

- **Limite 25 MB** → `413`.
- **Magic-bytes** (`file-type`): il tipo reale deve combaciare col dichiarato.
- **Allowlist** MIME (png/jpeg/gif/webp/bmp, pdf, zip, text/plain, text/csv) e
  **blocklist** estensioni eseguibili/script (`exe, bat, js, html, svg, …`) → `415`.
  L'allowlist è definita una sola volta in `lib/file-support.ts`: la UI di upload
  ne deriva i badge "Supportati", il filtro `accept` e un pre-controllo lato
  client, mentre `content-safety.ts` ne deriva il check magic-bytes server-side.
- **ClamAV opzionale**: con `CLAMAV_ENABLED=true`, scansione `clamd` INSTREAM;
  infetto → `422`. Hook iniettabile (test) con default disabilitato.
- **Testo:** mai HTML, sempre escaped. Header `Content-Security-Policy`
  (con `frame-ancestors 'none'` anti-clickjacking), `Referrer-Policy: no-referrer`
  (il token sta nell'URL, non deve trapelare via `Referer`) e
  `X-Content-Type-Options: nosniff` (in `next.config.mjs`). La CSP include
  `script-src 'self' 'unsafe-inline'` (necessario agli script inline di Next;
  `'unsafe-eval'` solo in dev per l'HMR) — l'XSS sul testo è già neutralizzato
  dall'escaping di React, la CSP resta difesa in profondità.

**Codici errore:** `400` input · `404` token assente · `410` scaduto/esaurito ·
`413` troppo grande · `415` tipo non consentito · `422` infetto · `429` rate-limit.

---

## 6. Invarianti

- Il **token non è mai persistito** (solo `token_hash` per il lookup).
- Nessun campo `used`/`secret`: l'esaurimento si calcola da `access_count`/`expires_at`.
- Chi ruba **solo DB/disco** non decifra nulla: la chiave vive solo nel token.
- L'incremento accessi è **atomico** (UPDATE condizionale) → niente over-consumo in race.
- Gli scaduti/esauriti vengono **purgati** (lazy on-access + on-startup).

---

## 7. Caveat noti

- **Consumo alla prima apertura**: prefetch del browser, scanner antivirus o
  anteprime di chat possono consumare un accesso. Documentato; mitigazione
  (pagina di conferma) è roadmap.
- **Download file via base64**: il contenuto decifrato viene inviato alla pagina
  come base64 (semplicità MVP). Adeguato entro il limite di 25 MB.
- **Stato in-memory**: rate-limit e singleton sono per-processo → pensato per
  **singola istanza**.

---

## 8. Roadmap (fuori scope MVP)

- Pagina di conferma esplicita prima del consumo (mitiga il caveat).
- Streaming del download file (evita il base64 in pagina).
- Account utente / login.
- Cron di cleanup schedulato.
- Object storage cloud (S3) al posto del filesystem.
- Integrazione VirusTotal.

---

## 9. Test (Vitest) — 48 test verdi

`crypto` (round-trip, derivazione, auth_tag manomesso) · `content-safety`
(size, magic-bytes, blocklist, infetto) · `clamav` (framing INSTREAM) · `db`
(schema/indice/idempotenza) · `store` (round-trip, scadenza, incremento atomico,
purge) · `cleanup` (purge expired/exhausted) · `rate-limit` (finestra, reset).
