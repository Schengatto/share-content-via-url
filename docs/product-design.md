# Share App — Product Design

**Ultimo allineamento:** 2026-11-24 (SHS-13: testo cifrato end-to-end nel browser, chiave nel fragment dell'URL; SHS-4: visite 1–100, scadenza obbligatoria 1 ora–365 giorni, password opzionale con blocco di 5 minuti)
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

**Text shares are end-to-end encrypted (SHS-13).** The browser encrypts the text
with WebCrypto (AES-256-GCM) before upload. The key `K` lives only in the URL
fragment (`/s/<id>#<K>`), which browsers never send to the server. The server
stores ciphertext and metadata and hands the ciphertext only to a client that
proves it holds the link (and the password, when set). For text, the optional
password is part of the key derivation, not just an access gate. **Files** keep
the model described above: encrypted at rest on the server with a token-derived
key, scanned by content-safety/ClamAV, token in the URL path. Spec:
[`docs/superpowers/specs/2026-11-24-e2e-encryption-design.md`](superpowers/specs/2026-11-24-e2e-encryption-design.md).

---

## 2. Architettura

Stack: **Next.js 16** (App Router, React 19, Turbopack), **TypeScript**, **SQLite**
(`better-sqlite3`), blob cifrati su **filesystem**. Tutte le route che toccano
DB/crypto/FS girano nel **Node runtime** (mai Edge).

```
app/
  page.tsx                    UI creazione link (client component; cifra il testo nel browser)
  s/[token]/page.tsx          pagina accesso (server component, sola lettura: shareStatus)
  s/[token]/reveal-gate.tsx   client component: legge il fragment, deriva le prove, decifra
  s/[token]/actions.ts        Server Action revealShare (legacy/file) e revealE2eShare (testo E2E)
  s/[token]/file-download.tsx download lato client da base64
  api/share/route.ts          POST: crea condivisione → { url } (testo: e2e-v1, file: lato server)
  api/share/[token]/route.ts  DELETE: revoca
lib/
  crypto.ts          token, HKDF, AES-256-GCM (encrypt/decrypt) lato server
  e2e-crypto.ts      WebCrypto isomorfo (browser + Node): chiavi, prove, cifratura/decifratura E2E
  db.ts              connessione SQLite + migrazione schema
  blob-store.ts      persistenza blob cifrati (filesystem; interfaccia iniettabile)
  store.ts           create/consume/revoke (logica di dominio; createE2eShare, consumeE2eShare)
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
| `payload_format` | INTEGER | `3` = testo E2E (`e2e-v1`), cifrato nel browser; `2` = metadati sigillati nel ciphertext, cifrato dal server; `1` = legacy, metadati nelle colonne |
| `filename` | TEXT null | solo legacy (formato 1); null per gli share nuovi |
| `mime` | TEXT null | solo legacy (formato 1); null per gli share nuovi |
| `blob_path` | TEXT | id del blob cifrato su disco (= `id`) |
| `iv` | BLOB | nonce AES-GCM (12 byte) |
| `auth_tag` | BLOB | tag GCM (16 byte); blob vuoto (0 byte) per il formato 3: il tag GCM sta in coda al ciphertext |
| `expires_at` | INTEGER null | epoch ms; sempre valorizzato per gli share nuovi (`created_at` + 1 ora–365 giorni) |
| `max_accesses` | INTEGER null | 1–100 per gli share nuovi |
| `access_count` | INTEGER | default 0 |
| `created_at` | INTEGER | epoch ms |
| `password_hash` | TEXT null | `scrypt$N$r$p$salt$hash` (`lib/password.ts`); null = senza password |
| `locked_until` | INTEGER null | epoch ms di fine blocco dopo una password sbagliata |
| `e2e_salt` | BLOB null | formato 3: salt di 16 byte, in chiaro (salt di PBKDF2 e di HKDF); null altrove |
| `e2e_kdf_iterations` | INTEGER null | formato 3: `600000` con password, `0` senza; null altrove |
| `link_proof_hash` | TEXT null | formato 3: SHA-256 (hex) di `linkProof`; null altrove |
| `auth_hash` | TEXT null | formato 3: SHA-256 (hex) di `authKey`, solo con password; null altrove |

**Payload sigillato (formato 2).** Il plaintext cifrato è
`[uint32 BE lunghezza header][header JSON {filename, mime}][contenuto]`: nome del
file e content-type stanno solo dentro il ciphertext AES-GCM, autenticati dal tag.
La colonna `size` è stata rimossa. Le migrazioni sono versionate con
`PRAGMA user_version` (`lib/db.ts`); la 1 ricostruisce la tabella e marca le righe
esistenti come formato 1, lette ancora col percorso legacy finché scadono; la 2
aggiunge `password_hash` e `locked_until`; la 3 e la 4 aggiungono `revoke_token_hash`,
`failed_attempts` e `lockouts`; la **5** aggiunge le quattro colonne E2E (`e2e_salt`,
`e2e_kdf_iterations`, `link_proof_hash`, `auth_hash`).

**E2E text rows (format 3).** `kind = text`, `token_hash = sha256(id)` where `id` is a
16-byte random link id generated by the server (base64url, 22 characters), `blob_path`
equal to the row `id`, `iv` 12 bytes, `auth_tag` an empty blob, `filename`, `mime` and
`password_hash` null. The blob holds `ciphertext || GCM tag`. The sealed payload inside
the ciphertext has the same layout as format 2 (header `{filename: null, mime: "text/plain"}`
plus the text). A format-3 row is readable only through the E2E path, and any other row
only through the legacy path: using the wrong path answers 404.

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
2. Parsing `FormData`: `kind` (`text` | `file`), `maxAccesses` (1–100, default 1),
   `ttlSeconds` (3600–31536000, default 86400). Fuori range → **400**;
   `expires_at` è calcolato dall'orologio del server. Il resto dipende da `kind`.

**`kind=file` (cifratura lato server, invariata).**
3. `file` e `password?` (8–128). **Content-safety** (size, magic-bytes, allowlist/blocklist,
   ClamAV) sul contenuto **in chiaro** (prima della cifratura). La password, se
   presente, è salvata solo come hash scrypt.
4. `createShare`: genera token 256-bit → HKDF-SHA256 → chiave AES-256 → sigilla
   metadati + contenuto → AES-256-GCM → salva riga (`token_hash`) + blob su disco
   nella stessa transazione.
5. Risposta `{ url: "<origin>/s/<token>", revokeToken }`. Il token compare **solo** nella response.

**`kind=text` (end-to-end, format `e2e-v1`).** The server never receives the text, the
password or `K`.

*Browser side (`encryptText` in `lib/e2e-crypto.ts`):*
1. Generate `K` (32 random bytes), `salt` (16 random bytes) and `iv` (12 random bytes).
2. Without a password: `linkProof = HKDF-SHA256(K, salt, info "share-secret:e2e:v1:link-proof")`
   and `encKey = HKDF-SHA256(K, salt, info "share-secret:e2e:v1:enc")`; `kdfIterations = 0`
   and there is no `authKey`.
3. With a password (length 8–128 checked in the client first):
   `P = PBKDF2-HMAC-SHA256(UTF-8(NFC(password)), salt, 600000 iterations, 32 bytes)`.
   `linkProof` is still derived from `K` alone. `authKey` and `encKey` come from HKDF
   over `K || P` with infos `share-secret:e2e:v1:auth` and `share-secret:e2e:v1:enc`.
   Every derived value is 32 bytes. Distinct infos mean that knowing `linkProof` or
   `authKey` does not reveal `encKey`.
4. Seal the text (header `{filename: null, mime: "text/plain"}` plus content) and
   encrypt it with AES-256-GCM: key `encKey`, 12-byte `iv`, 128-bit tag, additional
   data = UTF-8 `share-secret:e2e:v1`.
5. Send `POST /api/share` as multipart `FormData`: `kind=text`, `encryption=e2e-v1`,
   `ciphertext` (file part), `iv`, `salt` (base64url), `kdfIterations`, `linkProofHash`
   (SHA-256 hex of `linkProof`), `authHash` (SHA-256 hex of `authKey`, only with a
   password), `maxAccesses`, `ttlSeconds`. The password itself is never sent.

*Server side:*
6. Rate limit and `Content-Length` pre-check as above. A text request without
   `encryption=e2e-v1` (a stale cached page or any legacy client) is refused with
   **400** `This page is out of date. Reload it and try again.`: **legacy text shares
   can no longer be created**. Malformed base64 → **400**.
7. `createE2eShare` checks the shape: `iv` 12 bytes, `salt` 16 bytes, `linkProofHash`
   and `authHash` are 64 lowercase hex characters, `kdfIterations` is `0` or `600000`,
   `authHash` is present if and only if `kdfIterations > 0`, ciphertext between 20 bytes
   and `MAX_SIZE` + 1 KB. Violations → **400** `Malformed end-to-end encrypted payload`.
   There is no content-safety or ClamAV scan for E2E text: the server cannot read it.
8. Generate `id` (16 random bytes) and the revoke token; insert the row (format 3, see §3)
   and the blob in one transaction.
9. Response `{ id, url: "<origin>/s/<id>", revokeToken }`. The browser appends `#<K>`, so
   the final link is `/s/<id>#<K>`; the fragment is never sent anywhere.

### Accesso — `GET /s/<token>` (server component, sola lettura)
La GET chiama solo `shareStatus`: lookup per `sha256(token)` e controllo di scadenza e
visite residue, **senza** incremento, purge né decifratura. Link inesistente o già
usato (404) o scaduto/esaurito (410) → stato vuoto subito; altrimenti la busta sigillata.
La GET espone anche `passwordProtected` (`password_hash` o `auth_hash` presenti) e la
fine del blocco, così la pagina mostra il campo password o il countdown (calcolato sul
tempo del server). Per gli share E2E espone inoltre `salt` e `kdfIterations`, che il
browser usa per derivare le prove.
The server component cannot see the URL fragment, so the unlock UI (`RevealGate`) runs
in the browser. For an E2E share, if the fragment is missing or is not a 43-character
base64url key, it shows **"This link is incomplete."** and never calls the server.
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

This is the path for legacy rows and files (`payload_format` 1 or 2). It answers 404 for
an E2E share.

### Apertura E2E — Server Action `revealE2eShare(linkId, linkProof, authKey)`
Browser side (`RevealGate`): read `K` from `location.hash`; derive `linkProof`, `authKey`
(empty without a password) and `encKey` from `K`, the password typed in the page, and the
`salt` and `kdfIterations` served by the page (`deriveRevealProofs`); call the action
with `linkId`, `linkProof` and `authKey`. `encKey`, `K` and the password stay in the browser.

Server side, in this order:
1. Reveal rate limit per IP (30/min) → `rate-limited`.
2. With a non-empty `authKey`: password-attempt rate limit per IP (10/min) → `rate-limited`;
   an `authKey` that is not a 43-character base64url key → **400**.
3. A `linkProof` that is not a 43-character base64url key → **404**.
4. `consumeE2eShare`: `sha256(linkId)` → lookup. Absent, or not a format-3 row → **404**.
5. `expires_at` passed **or** `access_count >= max_accesses` → **purge** + **410**. This
   runs **before** the `linkProof` check, so an expired or exhausted link answers 410
   even to a client with a wrong proof.
6. `sha256(linkProof)` compared in constant time with `link_proof_hash`. Mismatch → **404**,
   **without** touching `failed_attempts`, `lockouts`, `locked_until` or the visitor lock:
   whoever does not hold the link cannot use the endpoint to lock the real recipients out.
7. `locked_until` in the future → `locked` with the remaining time.
8. If the row has `auth_hash`: empty `authKey` → `password-required`; otherwise the same
   gate as the legacy password (per-visitor lock after 3 failures for 5 minutes, per-share
   lock after 10 failures, doubling up to 24 hours), comparing `sha256(authKey)` with
   `auth_hash`. A wrong `authKey` → `wrong-password`. None of these outcomes consumes a view.
9. **Atomic increment** of `access_count` (conditional `UPDATE`), then read the blob.
10. If this was the last view → **delete row, then blob**. The next request for the same
    link finds no row → **404**.
11. Return `{ ciphertext, iv }` (base64url). The browser decrypts with `encKey` (AES-GCM,
    same additional data) and renders the text **escaped**. If decryption fails the page
    shows an "undecryptable" state; the view has already been consumed.

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
- **Testo E2E:** il server non lo vede mai, quindi non lo scansiona: content-safety e
  ClamAV si applicano solo ai file.
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
- Chi ruba **solo DB/disco** non decifra nulla: per file e testo legacy la chiave vive solo
  nel token, per il testo E2E solo nel fragment del link.
- L'incremento accessi è **atomico** (UPDATE condizionale) → niente over-consumo in race.
- Gli scaduti/esauriti vengono **purgati** (lazy on-access + on-startup).
- **E2E text (SHS-13):**
  - The server never sees the plaintext, the password or `K`. `K` exists only in the
    link fragment and in browser memory; the password only in the browser.
  - The server stores only `sha256(linkProof)` and `sha256(authKey)`, never the values
    themselves. Both come from 256-bit secrets, so a plain SHA-256 is enough (the slow
    cost is the client-side PBKDF2). A DB or backup dump without the link gives nothing;
    with the link but without the password it still does not decrypt a
    password-protected share (offline PBKDF2 guessing is required).
  - A request that fails the `linkProof` check changes no lock state.
  - The text password length (8–128) is validated **only in the client**: the server
    cannot see the password and only checks the shape of `kdfIterations` and `authHash`.
  - Visible to the server: ciphertext size (no padding), times, IP, view count, whether a
    password is set. An active operator who serves modified JavaScript can still
    exfiltrate the fragment or the password: out of scope, as in the spec.

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
- Cifratura end-to-end nel browser per il testo, chiave nel fragment dell'URL: **fatto**
  (SHS-13, §4 e §6). Decisione sui **file** (SHS-14): restano cifrati lato server con
  scansione ClamAV, non E2E (opzione A: la scansione malware richiede il contenuto in
  chiaro sul server). Spec: `docs/superpowers/specs/2026-11-24-e2e-encryption-design.md`.
- **Coexistence with legacy:** existing legacy text shares (formats 1 and 2) still open
  through the old path until they expire (at most 365 days); no new legacy text share
  can be created.

---

## 9. Test (Vitest) — 48 test verdi

`crypto` (round-trip, derivazione, auth_tag manomesso) · `content-safety`
(size, magic-bytes, blocklist, infetto) · `clamav` (framing INSTREAM) · `db`
(schema/indice/idempotenza) · `store` (round-trip, scadenza, incremento atomico,
purge) · `cleanup` (purge expired/exhausted) · `rate-limit` (finestra, reset).
