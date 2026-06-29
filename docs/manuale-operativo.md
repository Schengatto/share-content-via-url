# Share App — Manuale Operativo

**Ultimo allineamento:** 2026-06-29

Manuale d'uso (utente finale) e guida di sviluppo/manutenzione.

---

## Parte A — Uso (utente finale)

### Creare un link
1. Apri la home `/`.
2. Scegli **Testo** o **File**.
3. Incolla il testo oppure trascina/seleziona un file nella dropzone (max **25 MB**).
   I tipi accettati sono mostrati come badge sotto l'area ("Supportati: PNG, JPG,
   GIF, WebP, BMP, PDF, TXT, CSV, ZIP"); file non supportati o troppo grandi sono
   segnalati subito, prima dell'invio.
4. (Opzionale) imposta una **scadenza** (data/ora) e/o gli **accessi massimi**
   (1 = monouso, fino a 3). Le due regole sono **combinabili**.
5. Premi **Genera link**: appare il link. **Copialo subito** — è mostrato una sola volta.

### Aprire un link
- Apri l'URL ricevuto (`/s/<token>`).
- **Testo**: viene mostrato a schermo.
- **File**: il download parte automaticamente (con pulsante "Scarica di nuovo").
- ⚠️ L'apertura **consuma un accesso**. Per un link monouso, dopo la prima
  apertura il contenuto non è più disponibile (la pagina mostra "non disponibile").

### Messaggi di errore
| Situazione | Cosa vedi |
|---|---|
| Link inesistente o già usato | "Questo link non esiste o è già stato utilizzato." |
| Link scaduto/esaurito | "Questo link è scaduto o ha esaurito gli accessi." |
| File troppo grande (>25 MB) | errore in fase di creazione |
| Tipo non consentito / eseguibile | errore in fase di creazione |

---

## Parte B — Sviluppo & manutenzione

### Prerequisiti
- Node.js ≥ 20 (testato su v24), **npm**.
- `better-sqlite3` è un modulo nativo: `npm install` ne esegue la build
  automaticamente (non serve configurazione aggiuntiva).
- Le versioni delle dipendenze sono **freezate** (esatte, senza `^`/`~`) in
  `package.json`; `package-lock.json` è la fonte di verità.

### Comandi
```bash
npm install       # installa e builda i moduli nativi
npm run dev       # sviluppo (http://localhost:3000)
npm test          # unit + integrazione (Vitest)
npm run lint      # ESLint (flat config, next/core-web-vitals + typescript)
npm run build     # build di produzione
npm start         # server di produzione
```

### Variabili d'ambiente
| Variabile | Default | Uso |
|---|---|---|
| `DATA_DIR` | `./data` | cartella di `share.db` e dei blob cifrati |
| `RATE_LIMIT` | `10` | creazioni/minuto per IP |
| `CLAMAV_ENABLED` | _(off)_ | `true` per attivare la scansione clamd |
| `CLAMAV_HOST` | `127.0.0.1` | host di `clamd` |
| `CLAMAV_PORT` | `3310` | porta di `clamd` |

### Dati e persistenza
- `data/share.db` — metadati (SQLite, WAL).
- `data/blobs/<id>` — blob cifrati (AES-256-GCM).
- L'intera cartella `data/` è **gitignored**: non committarla.
- **Backup/restore** richiede sia `share.db` sia `data/blobs/` coerenti.
  Senza i token (mai salvati) i blob **non sono decifrabili**: il backup serve
  solo a non perdere i dati cifrati, non a leggerli.

### Cleanup
- Automatico: **lazy** (a ogni accesso che trova un record scaduto) e
  **on-startup** (`ensureStarted()` in `lib/app.ts`).
- Manuale (one-off): `purgeExpired(db, blobs)` da `lib/cleanup.ts`.
- Un cron schedulato è una possibile estensione futura.

### Abilitare ClamAV
1. Avvia un `clamd` raggiungibile in TCP.
2. Imposta `CLAMAV_ENABLED=true` (+ `CLAMAV_HOST`/`CLAMAV_PORT` se diversi).
3. All'upload, i contenuti vengono scansionati via INSTREAM; un esito *FOUND*
   restituisce **422** e blocca la condivisione.

### Note di deploy
- Eseguire come **singola istanza** (rate-limit e singleton sono in-memory).
- Garantire un volume persistente per `DATA_DIR`.
- Servire **HTTPS**: il token viaggia nell'URL ed è un segreto.

### Dove intervenire (mappa rapida)
| Voglio cambiare… | File |
|---|---|
| Regole di cifratura / derivazione chiave | `lib/crypto.ts` |
| Limiti di dimensione / allow-blocklist | `lib/content-safety.ts` |
| Logica scadenza / accessi / purge | `lib/store.ts`, `lib/cleanup.ts` |
| Schema DB | `lib/db.ts` |
| Rate-limit | `lib/rate-limit.ts` |
| Form di creazione | `app/page.tsx` |
| Pagina di accesso | `app/s/[token]/page.tsx` |
| Header di sicurezza (CSP/nosniff) | `next.config.mjs` |
