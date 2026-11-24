# Cifratura end-to-end nel browser — Design / Spec

**Data:** 2026-11-24
**Task:** SHS-12 (epic SHS-6 "Security hardening")
**Stato:** approvata. SHS-13 (testo E2E) implementata e in produzione dal 2026-11-24; SHS-14 (rollout, documentazione, file lato server con ClamAV, opzione A) in corso.
**Gap chiusi (README "What it does NOT protect against"):** 1 (non è E2E), 2 (token nel path), 4 (password non parte della chiave). Riduce il gap 5 (lock abusabile) e il gap 9 (backup + link).

## 1. Sommario

Oggi il browser manda il testo in chiaro al server, il server lo cifra con una chiave derivata dal token, e il token sta nel path dell'URL. Con questa spec il browser cifra il testo prima dell'invio con WebCrypto (AES-256-GCM). La chiave vive solo nel fragment dell'URL (`/s/<id>#<chiave>`), che il browser non invia mai al server. La password, quando c'è, entra nella derivazione della chiave. Il server conserva ciphertext e metadati, e consegna il ciphertext solo a chi prova di avere il link (e la password).

Fase 1 (SHS-13): solo condivisioni di **testo**. I file restano cifrati lato server con ClamAV (sezione 9). Le share esistenti restano leggibili fino alla scadenza (sezione 8).

## 2. Modello di minaccia

| Avversario | Oggi | Dopo SHS-13 (testo) |
|---|---|---|
| Operatore passivo: legge DB, blob, log, backup, memoria del processo | Vede il testo in chiaro alla creazione e all'apertura | Non vede mai testo, chiave né password |
| Chi legge i path delle richieste (log nginx, monitoring, proxy) | Ha il token: legge, consuma, revoca senza revoke token per le share vecchie | Ha solo l'`id`: non può leggere, consumare viste né far scattare i lock |
| Dump del DB o di un backup, senza link | Niente | Niente |
| Dump del DB o di un backup, con link | Decifra, anche senza password | Senza password: decifra. Con password: deve forzarla offline (PBKDF2, 600k iterazioni) |
| Chi ha il link ma non la password | Tentativi online, limitati dai lock | Uguale: tentativi online, limitati dai lock |
| Operatore attivo: modifica il JavaScript servito | Vede tutto | Vede tutto (fuori scope, vedi sotto) |

**Resta fiducia nell'operatore contro attacchi attivi.** La stessa origine serve il JavaScript che cifra: un operatore malevolo (o chi compromette il server) può servire codice che esfiltra il fragment o la password. SRI non aiuta, perché pagina e script arrivano dalla stessa origine. La spec copre le fughe passive: DB, blob, log, backup, path delle richieste.

**Fuori scope, invariato:** cronologia del browser e appunti (contengono il link completo, fragment incluso), estensioni del browser, XSS sull'origine (mitigato dalla CSP attuale e dal rendering con escape), metadati visibili al server (dimensione del ciphertext, orari, IP, numero di viste, presenza di password).

## 3. Formato del link

```
https://share-secret.schengatto.com/s/<id>#<chiave>
```

- **`id`**: 16 byte casuali generati dal server, base64url senza padding (22 caratteri). Serve solo a trovare la riga. Non è un segreto: chi ha solo l'`id` vede la pagina della busta (stato, password sì/no, lock), come oggi chi ha il link, ma non ottiene il ciphertext.
- **`chiave`** (`K`): 32 byte casuali generati nel browser con `crypto.getRandomValues`, base64url senza padding (43 caratteri). Il browser non la invia mai: il fragment non compare nella richiesta HTTP né nel `Referer` (in più vale `Referrer-Policy: no-referrer`).
- Nessuna versione nel fragment: la versione del formato sta nella riga (`payload_format`, sezione 6), che la pagina riceve con lo stato della share.
- I link legacy `/s/<token>` (43 caratteri, nessun fragment) restano validi. Il server distingue i due tipi dalla riga, non dalla forma del link.
- Fragment mancante o malformato (non 43 caratteri base64url): la pagina mostra "link incompleto" e non chiama il server, quindi non consuma viste.

## 4. Derivazione delle chiavi

Tutto con WebCrypto (`crypto.subtle`), disponibile nel browser (contesto sicuro: HTTPS o localhost) e in Node 24, quindi lo stesso modulo gira nei test Vitest.

```
K        = 32 byte casuali (fragment)
salt     = 16 byte casuali (generati alla creazione, salvati in chiaro)
P        = PBKDF2-HMAC-SHA256(UTF-8(NFC(password)), salt, 600000 iterazioni, 32 byte)   solo con password
ikm      = K || P   con password,   K   senza password

linkProof = HKDF-SHA256(ikm = K,   salt, info = "share-secret:e2e:v1:link-proof", 32 byte)
authKey   = HKDF-SHA256(ikm,       salt, info = "share-secret:e2e:v1:auth",       32 byte)   solo con password
encKey    = HKDF-SHA256(ikm,       salt, info = "share-secret:e2e:v1:enc")  -> chiave AES-GCM 256

iv         = 12 byte casuali
ciphertext = AES-256-GCM(encKey, iv, additionalData = UTF-8("share-secret:e2e:v1"), sealedPayload)   tag di 16 byte in coda
```

- **`sealedPayload`** è il formato attuale di `lib/sealed-payload.ts` (4 byte di lunghezza dell'header, header JSON `{filename, mime}`, contenuto), portato su `Uint8Array` in un modulo isomorfo. Per il testo: `{ filename: null, mime: "text/plain" }`. Lo stesso formato servirà ai file se l'owner sceglie E2E anche per loro, senza una v2.
- Le tre chiavi vengono da `info` diversi: conoscere `linkProof` o `authKey` non dà `encKey`.
- `linkProof` dipende solo da `K`: prova il possesso del link, anche senza password.

### Scelta del KDF: PBKDF2-HMAC-SHA256, 600.000 iterazioni

| | PBKDF2 (WebCrypto) | Argon2id (WASM) |
|---|---|---|
| Dipendenze | nessuna | libreria WASM (es. `hash-wasm`), ~25-30 KB in più |
| CSP | invariata | serve `'wasm-unsafe-eval'` in `script-src` |
| Resistenza a GPU/ASIC | bassa (non memory-hard) | alta |
| Costo su mobile | ~0,5-1,5 s per tentativo | regolabile, simile |

**Decisione: PBKDF2.** Il KDF conta solo per chi ha **sia** il link **sia** una copia del DB o di un backup: senza il DB il brute force è online e lo limitano i lock; senza il link `K` (256 bit) non si indovina. Per quel caso residuo PBKDF2 a 600.000 iterazioni (valore OWASP 2023 per HMAC-SHA256) basta per password non banali, e la CSP non si allarga. Le iterazioni sono salvate per riga (`e2e_kdf_iterations`), quindi si possono alzare, o si può passare ad Argon2id con un nuovo `payload_format`, senza toccare le share esistenti.

**Password:** stesse regole di oggi (8-128 caratteri), normalizzata NFC. Il server non vede la password, quindi la lunghezza minima la controlla solo il client: un client modificato può creare share con password corte, a danno solo di chi le crea.

## 5. Flussi

### Creazione — `POST /api/share` (testo)

1. Il browser genera `K` e `salt`, calcola `P` (se c'è la password), `linkProof`, `authKey`, `encKey`, cifra il sealed payload.
2. Invia `FormData`: `kind=text`, `encryption=e2e-v1`, `ciphertext` (Blob binario, niente base64), `iv`, `salt` (base64url), `kdfIterations` (`0` senza password, `600000` con password), `linkProofHash` = hex `SHA-256(linkProof)`, `authHash` = hex `SHA-256(authKey)` solo con password, `maxAccesses`, `ttlSeconds`. **Nessuna** password, chiave, `linkProof` o `authKey` in chiaro.
3. Il server: rate limit di creazione (invariato), cap su `Content-Length` (invariato), validazione di forma (lunghezze di `iv` 12, `salt` 16, hash 64 hex, `kdfIterations` in `{0, 600000}` per la v1, `authHash` presente se e solo se `kdfIterations > 0`), `ciphertext.size <= MAX_SIZE + 1024` (overhead di header e tag), opzioni (`assertValidShareOptions` senza password).
4. Genera `id` e revoke token, salva riga + blob nella stessa transazione, come oggi.
5. Risponde `{ id, url: "<origin>/s/<id>", revokeToken }`. Il browser mostra e copia `url + "#" + base64url(K)`.
6. `kind=text` **senza** `encryption=e2e-v1` → `400` ("ricarica la pagina"). Dopo il deploy di SHS-13 il server non crea più share di testo lato server: serve a fissare la data in cui scade l'ultima share di testo legacy (sezione 8). Una scheda aperta da prima del deploy riceve l'errore e basta ricaricare.

### Accesso — `GET /s/<id>` (sola lettura, invariato nel principio)

`shareStatus` aggiunge `format` (`"legacy"` o `"e2e-v1"`), e per le E2E `salt` e `kdfIterations` (non segreti: servono al client per derivare le prove). `passwordProtected` vale `password_hash IS NOT NULL OR auth_hash IS NOT NULL`. Nessun consumo, purge o decifratura, come oggi. La pagina sceglie il flusso legacy o E2E in base a `format`.

### Apertura — Server Action `revealE2eShare(id, linkProof, authKey?)`

Ordine dei controlli (la regola "limiter prima della ricerca della share" resta):

1. `revealLimiter` per IP (30/min). Superato → `rate-limited`.
2. Se arriva `authKey`: `passwordAttemptLimiter` per IP (10/min). Superato → `rate-limited`.
3. Ricerca per `sha256(id)`. Assente → `404`. Scaduta o esaurita → purge e `410`.
4. `SHA-256(linkProof)` confrontato in tempo costante con `link_proof_hash`. Diverso → `404`, **identico** a una share inesistente, senza toccare contatori né lock.
5. Lock della share attivo → `locked` (invariato).
6. Se la share ha `auth_hash`: senza `authKey` → `password-required`. Lock per IP attivo → `locked`. Poi la stessa logica di oggi (claim su `failed_attempts`, confronto in tempo costante di `SHA-256(authKey)` con `auth_hash`, `wrong-password` con lock per IP e lock della share, reset del lock per IP al successo).
7. Consumo atomico della vista con lo stesso `UPDATE` condizionale di oggi. Purge dopo l'ultima vista.
8. Risposta `{ ok: true, format: "e2e-v1", ciphertext (base64), iv }`. Il browser deriva `encKey` e decifra. Se la decifratura fallisce (ciphertext manomesso), la vista è già consumata e la pagina mostra un errore: succede solo se qualcuno ha alterato i dati sul server.

`authHash` è `SHA-256` semplice, non scrypt: `authKey` ha 256 bit di entropia (deriva da `K`), quindi un hash lento non serve. Il costo lento è già nel PBKDF2 lato client.

### Revoca — `DELETE /api/share/<id>`

Invariata: header `x-revoke-token`, ricerca per `sha256(id)`. `tokenFromShareUrl` (in `lib/share-options.ts`) deve ignorare il fragment: oggi la regex finisce con `$` e non accetta `#...`.

## 6. Modello dati — migrazione 5

```sql
ALTER TABLE shares ADD COLUMN e2e_salt BLOB;
ALTER TABLE shares ADD COLUMN e2e_kdf_iterations INTEGER;
ALTER TABLE shares ADD COLUMN link_proof_hash TEXT;
ALTER TABLE shares ADD COLUMN auth_hash TEXT;
```

- Nuovo `payload_format = 3` (`E2E_V1_PAYLOAD_FORMAT`). Le righe 1 e 2 restano lato server.
- Per le righe E2E: `token_hash = sha256(id)` (stessa colonna e stesso indice unico, quindi `shareStatus`, revoca e cleanup cercano tutto nello stesso modo); `iv` = IV del client; `auth_tag` = blob vuoto (il tag è in coda al ciphertext nel blob); `filename` e `mime` NULL (sono nel sealed payload cifrato); `password_hash` NULL.
- Blob su disco: il ciphertext del client, mode `0600`, sovrascritto con zeri alla cancellazione, come oggi.
- **Rollback:** il guard di versione impedisce all'immagine pre-SHS-13 di aprire un DB v5. Rollback di codice e dati insieme, con il backup pre-deploy; le share E2E create dopo il deploy si perdono, accettato.

## 7. Rate limit e lock

| Meccanismo | Oggi | E2E |
|---|---|---|
| Creazione (10/min per IP) | invariato | invariato |
| Reveal (30/min per IP) | ogni apertura | ogni apertura, prima della ricerca |
| Tentativi password (10/min per IP) | quando arriva una password | quando arriva `authKey` |
| Lock per IP (3 errori → 5 min) | errori di password | errori di `authKey`, solo dopo `linkProof` valido |
| Lock della share (10 errori → 5 min, raddoppio fino a 24 h) | chiunque abbia il token | solo chi ha il link completo |
| Revoca (20/min per IP) | invariato | invariato |

Effetto sul gap 5: un `linkProof` sbagliato non conta come errore, quindi chi ha solo l'`id` (log, monitoring) non può far scattare i lock. Resta l'abuso da parte di chi ha il link completo ma non la password, accettato come oggi.

## 8. Compatibilità con le share legacy

- Le righe `payload_format` 1 e 2 restano leggibili con il flusso attuale (`revealShare`, password verificata dal server), finché scadono. La TTL massima è 365 giorni.
- Dal deploy di SHS-13 (giorno D) il server crea testo solo E2E: l'ultima share di testo legacy scade al più tardi in D + 365 giorni. SHS-14 registra la data sul board.
- I file restano `payload_format` 2 (sezione 9), quindi il codice di cifratura lato server (`lib/crypto.ts`, `lib/password.ts`, `contentOf`) resta finché i file non diventano E2E. A D + 365 si può togliere solo ciò che serve esclusivamente al testo legacy.
- `payload_format` 1 (pre-sealed): SHS-14 verifica in prod con `SELECT payload_format, kind, count(*), max(expires_at) FROM shares GROUP BY 1, 2` e, se non restano righe, rimuove il ramo.

## 9. File e ClamAV

**Ipotesi di lavoro (decisione dell'owner in SHS-14):** in fase 1 i file restano cifrati lato server.

- Oggi ClamAV (`CLAMAV_ENABLED=true`) scansiona il contenuto in chiaro di **entrambi** i tipi, testo compreso (`lib/content-safety.ts`, passo 4). Con E2E il testo non viene più scansionato e resta solo il controllo di dimensione, sul ciphertext. Impatto basso: il testo è sempre mostrato con escape, mai eseguito né scaricato come file.
- **Opzione A — file lato server (consigliata per ora):** restano magic bytes, allowlist MIME, blocco delle estensioni e ClamAV. Il README deve dire chiaramente che i file non sono E2E e che l'operatore li vede.
- **Opzione B — file E2E:** stesso schema del testo (il sealed payload porta già `filename` e `mime`). Il server perde magic bytes, allowlist, blocco estensioni e ClamAV: i controlli nel client sono solo consigli, perché un client modificato li salta. Il destinatario scarica un file che nessuno ha controllato. Serve anche lo streaming o il chunking per i 25 MB: oggi il file torna in base64 dentro la risposta della Server Action.

## 10. CSP e dipendenze

Nessuna modifica alla CSP e nessuna nuova dipendenza: WebCrypto è nativo. Il modulo crittografico client (`lib/e2e-crypto.ts`) usa solo `globalThis.crypto.subtle`, `TextEncoder` e `Uint8Array`, così gira nel browser e nei test sotto Node.

## 11. Piano per SHS-13 e SHS-14

### SHS-13 — implementazione E2E per il testo

| File | Modifica |
|---|---|
| `lib/e2e-crypto.ts` (nuovo) | generazione di `K` e `salt`, PBKDF2, HKDF, `linkProof`/`authKey`/`encKey`, cifratura/decifratura, base64url, sealed payload su `Uint8Array` |
| `lib/db.ts` | migrazione 5, `E2E_V1_PAYLOAD_FORMAT = 3` |
| `lib/store.ts` | `createE2eShare`, `consumeE2eShare` (ordine della sezione 5), `shareStatus` con `format`, `salt`, `kdfIterations` |
| `app/api/share/route.ts` | ramo `encryption=e2e-v1`, rifiuto del testo legacy, risposta con `id` |
| `app/page.tsx` | cifratura nel browser prima del POST, link con fragment |
| `app/s/[token]/page.tsx`, `reveal-gate.tsx`, `actions.ts` | lettura del fragment, stato "link incompleto", `revealE2eShare`, decifratura nel browser; flusso legacy invariato |
| `lib/share-options.ts` | `tokenFromShareUrl` ignora il fragment |
| test | `e2e-crypto` (round trip, password giusta/sbagliata, `info` separati, fragment malformato), `db` (migrazione 5), `store` (creazione, prova di link sbagliata = 404 senza lock, password sbagliata senza consumo, lock), API (nessun campo in chiaro, rifiuto del testo legacy), `share-options` |

Definition of Done: il POST e il DB non contengono mai testo, chiave o password (test + ispezione del body nel browser); una password sbagliata non consuma viste; un `linkProof` sbagliato non tocca i lock; lint, tsc, suite completa e build verdi; deploy con la procedura di migrazione (backup pre-SHS-13, schema v5).

### SHS-14 — rollout, legacy, documentazione, decisione sui file

- Verificare in prod che una share legacy creata prima del deploy si apra ancora dopo.
- Registrare sul board la data D + 365 giorni per la rimozione del ramo testo legacy; verificare `payload_format` 1.
- Riscrivere nel README "What it does NOT protect against" con il modello della sezione 2 (gap 1, 2, 4 chiusi per il testo; operatore attivo ancora fidato; file secondo la decisione).
- Applicare la decisione dell'owner sui file (opzione A o B).
- Aggiornare `docs/product-design.md` (flussi, modello dati, invarianti).

## 12. Decisioni da approvare

1. **KDF:** PBKDF2-HMAC-SHA256 a 600.000 iterazioni, niente WASM e niente modifica alla CSP.
2. **Prova di possesso in due livelli:** `linkProof` (solo link) e `authKey` (link + password); un `linkProof` sbagliato risponde `404` e non tocca i lock.
3. **Link:** `/s/<id>#<chiave>`, `id` di 128 bit dal server, chiave di 256 bit dal browser, nessuna versione nel fragment.
4. **Niente più testo lato server dopo il deploy:** il testo legacy scade entro D + 365 giorni.
5. **File:** opzione A in fase 1; decisione definitiva in SHS-14.
6. **Rischi accettati:** dimensione del ciphertext visibile al server (nessun padding); lunghezza minima della password controllata solo dal client; operatore attivo ancora fidato.
