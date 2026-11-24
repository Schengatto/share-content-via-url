# Share App — Product Design

**Ultimo allineamento:** 2026-11-24 (SHS-4: visite 1–100, scadenza obbligatoria 1 ora–365 giorni, password opzionale con blocco di 5 minuti)
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

- **numero massimo di accessi** 1–100 (default 1, monouso), slider nella UI;
- **scadenza temporale** sempre presente, da 1 ora a 365 giorni (default 24 ore);
  lo slider ha gli stop 1–24 ore, poi 2, 3, 4, 5, 6, 7, 14, 30, 60, 90, 180, 365 giorni.

Opzionalmente una **password** (8–128 caratteri). È un cancello d'accesso, non
entra nella chiave di cifratura. Una password sbagliata blocca lo share per
5 minuti lato server, senza consumare visite; durante il blocco nessuna password
viene verificata. Limiti e default stanno solo in `lib/share-options.ts`.

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
| `payload_format` | INTEGER | `2` = metadati sigillati nel ciphertext; `1` = legacy, metadati nelle colonne |
| `filename` | TEXT null | solo legacy (formato 1); null per gli share nuovi |
| `mime` | TEXT null | solo legacy (formato 1); null per gli share nuovi |
| `blob_path` | TEXT | id del blob cifrato su disco (= `id`) |
| `iv` | BLOB | nonce AES-GCM (12 byte) |
| `auth_tag` | BLOB | tag GCM (16 byte) |
| `expires_at` | INTEGER null | epoch ms; sempre valorizzato per gli share nuovi (`created_at` + 1 ora–365 giorni) |
| `max_accesses` | INTEGER null | 1–100 per gli share nuovi |
| `access_count` | INTEGER | default 0 |
| `created_at` | INTEGER | epoch ms |
| `password_hash` | TEXT null | `scrypt$N$r$p$salt$hash` (`lib/password.ts`); null = senza password |
| `locked_until` | INTEGER null | epoch ms di fine blocco dopo una password sbagliata |

**Payload sigillato (formato 2).** Il plaintext cifrato è
`[uint32 BE lunghezza header][header JSON {filename, mime}][contenuto]`: nome del
file e content-type stanno solo dentro il ciphertext AES-GCM, autenticati dal tag.
La colonna `size` è stata rimossa. Le migrazioni sono versionate con
`PRAGMA user_version` (`lib/db.ts`); la 1 ricostruisce la tabella e marca le righe
esistenti come formato 1, lette ancora col percorso legacy finché scadono; la 2
aggiunge `password_hash` e `locked_until`.

**Cancellazione sicura.** La connessione apre con `PRAGMA secure_delete = ON` (le
pagine liberate sono azzerate) e dopo ogni cancellazione esegue
`wal_checkpoint(TRUNCATE)`, così il `-wal` non conserva copie delle righe
cancellate. I blob sono scritti `0600` e, prima dell'`unlink`, sovrascritti con
zeri e `fsync`. Ordine: prima la riga (commit), poi il blob; la creazione scrive
riga e blob nella stessa transazione; `purgeExpired` elimina anche i blob che
nessuna riga referenzia. Limite: su SSD o filesystem journaled la sovrascrittura
non garantisce la distruzione fisica dei blocchi; la garanzia forte resta la
chiave derivata dal token, mai salvata. In chiaro restano solo `kind`, scadenza,
contatori e `created_at`, necessari alla logica.

---

## 4. Flussi

### Creazione — `POST /api/share`
1. Rate-limit per IP (default 10/min). Superato → **429**.
2. Parsing `FormData`: `kind`, `text` **oppure** `file`, `maxAccesses` (1–100, default 1),
   `ttlSeconds` (3600–31536000, default 86400), `password?` (8–128). Fuori range → **400**;
   `expires_at` è calcolato dall'orologio del server.
3. **Content-safety** sul contenuto **in chiaro** (prima della cifratura). La password,
   se presente, è salvata solo come hash scrypt.
4. `createShare`: genera token 256-bit → HKDF-SHA256 → chiave AES-256 → sigilla
   metadati + contenuto → AES-256-GCM → salva riga (`token_hash`) + blob su disco
   nella stessa transazione.
5. Risposta `{ url: "<origin>/s/<token>" }`. Il token compare **solo** nella response.

### Accesso — `GET /s/<token>` (server component, sola lettura)
La GET chiama solo `shareStatus`: lookup per `sha256(token)` e controllo di scadenza e
visite residue, **senza** incremento, purge né decifratura. Link inesistente o già
usato (404) o scaduto/esaurito (410) → stato vuoto subito; altrimenti la busta sigillata.
La GET espone anche `passwordProtected` e la fine del blocco, così la pagina mostra
il campo password o il countdown (calcolato sul tempo del server).
Il consumo avviene solo con «Break the seal» (Server Action, POST): i bot delle
anteprime e i prefetch non possono bruciare il link.

### Apertura — Server Action `revealShare`
1. `consumeShare`: `sha256(token)` → lookup. Assente → pagina **non disponibile** (404).
2. Se `expires_at` superato **o** `access_count >= max_accesses` → **purge** + pagina gone (410).
3. Se `locked_until` è nel futuro → `locked` col tempo residuo, senza verificare la password.
4. Se c'è `password_hash`: password assente → `password-required`; sbagliata →
   `locked_until = now + 5 min` e `wrong-password`. In entrambi i casi nessuna visita consumata.
5. **Incremento atomico** di `access_count` con `UPDATE … WHERE` condizionale (race-safe).
6. Deriva la chiave, **decifra** (verifica `auth_tag`).
7. `text` → reso come testo **escaped**; `file` → download lato client (base64 → Blob).
8. Se dopo l'incremento è esaurito → **elimina riga, poi blob** (cancellazione sicura, §3).

### Revoca — `DELETE /api/share/<token>`
Elimina riga, poi blob, per token (cancellazione sicura, §3); **404** se non trovato.

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
