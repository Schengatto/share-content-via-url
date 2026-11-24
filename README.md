# Share Secret

Share a piece of text or a file through a link that burns after a set number of views or a set time.

## What it does

- Shares **text** or a **file** (up to 25 MB) through a single link. Text is end-to-end encrypted in the browser; files are encrypted on the server (see [Security model](#security-model)).
- The link burns after **1 to 100 views** (default 1, a one-time link) or after **1 hour to 365 days** (default 24 hours), whichever comes first.
- An optional **password** (minimum 8 characters, maximum 128) guards the link. For text it is also part of the encryption key and never leaves the browser. Three wrong guesses lock that visitor out for 5 minutes; every ten wrong guesses lock the link for everyone, each time for longer.
- When the last view is used or the time runs out, the content is deleted from disk.

Stack: Next.js 16 (App Router, React 19), TypeScript, SQLite (better-sqlite3), encrypted blobs on the local filesystem, Vitest.

## How it works

**Text shares (end-to-end encrypted).**

- **Link format.** `/s/<id>#<K>`. The `id` is a random 128-bit identifier chosen by the server. `K` is a random 256-bit key generated in the browser and kept in the URL fragment, which browsers never send to the server.
- **Encryption in the browser.** WebCrypto encrypts the text with AES-256-GCM before upload. The key is derived from `K` with HKDF-SHA256, using a random salt and a random 12-byte IV per share. The server receives only ciphertext, IV, salt and hashes.
- **Optional password.** The browser stretches the password with PBKDF2-HMAC-SHA256 (600,000 iterations) and mixes it into the key derivation. The password is never sent.
- **Proofs instead of secrets.** To open a share the browser sends a proof derived from `K` (and, with a password, a second proof derived from `K` and the password). The server stores only `SHA-256` of each proof and compares them in constant time. The `id` alone gives no access, does not consume views and cannot trigger locks.
- **Lookup by hash.** The database stores only `SHA-256(id)`, never the id itself.
- **Sealed metadata.** The MIME type is encrypted together with the text, inside the same authenticated ciphertext.

**Files (and legacy text shares), encrypted on the server.**

- **Capability URL.** Each share gets a random 256-bit token, placed in the URL path: `/s/<token>`. The token is both the identifier and the secret.
- **Encryption at rest.** The key is derived from the token with HKDF-SHA256 and the content is encrypted with AES-256-GCM, using a random 12-byte IV per share. The key is never stored.
- **Lookup by hash.** The database stores only `SHA-256(token)`, never the token itself.
- **Sealed metadata.** The file name and MIME type are encrypted together with the content, inside the same authenticated ciphertext.

**Both kinds.**

- **Blob files.** Encrypted blobs are written to `DATA_DIR/blobs` with mode `0600`.
- **Atomic view counting.** A view is consumed by one conditional `UPDATE`, so two concurrent opens cannot both use the last view.
- **Secure delete.** SQLite runs with `secure_delete = ON` and the WAL is checkpointed after a purge. Each blob is overwritten with zeros before it is removed.
- **Cleanup.** Expired and used-up shares are purged on access, at startup and then every hour.

## Security model

### What it protects against

- **A stolen disk or database dump.** Without the link, the stored data cannot be decrypted. For text the key exists only in the link fragment and is never stored or sent to the server. For files the key exists only in the token, and only its hash is stored.
- **A passive operator: logs, backups, process memory, request paths.** Text is encrypted in the browser, so the server, its database, blobs, backups and logs never hold the text, the key or the password, and request paths carry only the `id`, which cannot read, consume or lock a share.
- **Link previews and prefetchers.** Opening a link with GET never consumes a view. A view is consumed only by an explicit POST (a Next.js server action) when the reader presses the button.
- **Guessing links.** A random 128-bit id (text) or 256-bit token (files) cannot be enumerated.
- **Password guessing on text.** Someone who has a database or backup dump and the link must guess the password offline against PBKDF2 (600,000 iterations); without the link there is nothing to guess against. Online guesses go through the same locks described below.
- **Password guessing.** Passwords need at least 8 characters (for text, checked only in the browser, because the server never sees the password). For files and legacy text the password is stored as a salted scrypt hash (N=2^15, r=8, p=1) and compared in constant time. Two server-side locks limit guessing. Three wrong guesses from one IP lock that IP out of that share for 5 minutes; other visitors are not affected. Every ten wrong guesses, from any number of IPs and however far apart, lock the share for everyone: 5 minutes the first time, doubling on each new lock up to 24 hours. That caps guessing at about 3,700 tries over the longest lifetime of 365 days, so pick a password that is not common or guessable. While locked, no password is checked at all. A wrong guess does not use a view, and the locks do not change the views or the expiry. The per-IP lock lives in memory (single node); the share-wide lock is stored with the share.
- **Browser-side attacks.** Every response sends a Content-Security-Policy (`default-src 'self'`, `script-src 'self' 'unsafe-inline'`, `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`), `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`. Shared text is always rendered as escaped text, never as HTML. Share pages (`/s/*`) are marked `noindex`.
- **Hostile uploads.** Uploads are capped at 25 MB, the MIME type must be on an allowlist (PNG, JPEG, GIF, WebP, BMP, PDF, ZIP, plain text, CSV), executable and script extensions are blocked, and the real type is checked against the magic bytes. An optional ClamAV scan runs on the plaintext of files before encryption. Text is not scanned: the server cannot read it, and it is always shown as escaped text, never executed or downloaded.
- **Bulk creation.** Creating shares is rate limited to 10 per minute per IP (`RATE_LIMIT`).
- **Brute force and abuse of the link endpoints.** Per IP and per minute, opening a share is limited to 30 requests, password attempts to 10 and revoke requests (`DELETE /api/share/<id>`) to 20. Past a limit the reveal screen asks the visitor to wait and `DELETE` answers `429` with `Retry-After`, with the same response for existing and unknown shares and without consuming a view. The limits live in memory (single node).

### What it does NOT protect against, and trust assumptions

- **The operator who serves the JavaScript is still trusted.** Text shares are end-to-end encrypted in the browser, but the same origin serves the code that encrypts. A malicious or compromised operator can serve modified JavaScript that steals the link fragment or the password. Subresource Integrity does not help, because the page and the script come from the same origin. The protection covers passive leaks (database, blobs, logs, backups, request paths), not an active operator.
- **Files are not end-to-end encrypted.** Files are encrypted on the server, so ClamAV scanning and the file-type checks keep working. The operator sees the file contents when a file is uploaded and when it is opened, and you have to trust the operator for files. Making files end-to-end would remove those server-side checks, so this is a deliberate choice.
- **Legacy text shares stay readable until they expire.** Text shares created before the end-to-end release (2026-11-24) are still encrypted on the server, with the token in the URL path, and still open until they expire (at most 365 days). The server creates no new text share of that kind: a stale page that tries to is refused and must be reloaded.
- **Some metadata stays visible to the server.** For every share the server sees the ciphertext size (for text only a bucket: 1 KiB floor, powers of two up to 1 MiB, then 1 MiB steps; files are not padded), times, IP addresses, the view count and whether a password is set. After a successful reveal the page removes the fragment from the address bar and from the current history entry, but the browser's global history, the clipboard and the message the link was sent in can still hold the full link, and browser extensions or XSS on the origin can read it; these are out of scope.
- **For files and legacy text, the token is in the URL path, not in the fragment.** Anything that logs request paths can see it: reverse proxies, access logs, monitoring. The production nginx config has `access_log off`. Share pages (`/s/*`) and share API responses (`/api/share/*`) are sent with `Cache-Control: no-store`, so browsers and proxies do not keep a copy of the page or the revealed content. The link also stays in the browser history of everyone who opens it.
- **There are no accounts.** Anyone who holds the link can read the share. Only the creator can revoke it: creation returns a separate random revoke token (stored only as a hash) that the "Burn it now" button sends in the `X-Revoke-Token` header of `DELETE /api/share/<id>` (or `<token>` for files and legacy text). A wrong or missing revoke token gets the same `404` as an unknown share. Shares created before revoke tokens existed (before schema version 3) have none and can still be revoked by anyone with the link until they expire.
- **For files and legacy text, the password is an access gate, not part of the key.** It is checked by the server before decryption. Someone with the database and the token does not need the password to decrypt. For text the password is part of the key, and the server sees only a derived proof of it.
- **The share-wide lock can be abused.** Someone who has the link but not the password, and who can send guesses from several IPs, can still trigger the share-wide lock with ten wrong guesses, and each new lock lasts longer (up to 24 hours). This nuisance denial of service is an accepted trade-off: it is what bounds distributed guessing.
- **A link page reveals whether a share is password protected or locked.** This is needed to show the right form or the countdown before any view is used.
- **Single-node design.** The rate limiter lives in memory and the data is in a local SQLite file. Running several instances weakens the rate limit and needs shared storage.
- **Rate limits and the per-IP lock trust the proxy.** They key on the first `X-Forwarded-For` address, so the reverse proxy must overwrite that header with the real client address.
- **Deletion depends on the storage.** Overwriting with zeros does not guarantee erasure on SSDs, copy-on-write filesystems or backups. Backups keep ciphertext of shares that have since expired or been burned. They hold no keys, but whoever has both an old link and a backup can decrypt that share (for text with a password, they must also guess the password offline). The production retention below bounds this window to 7 days.

## Reporting a vulnerability

Please report security issues privately through [GitHub security advisories](https://github.com/Schengatto/share-content-via-url/security/advisories/new). For anything that is not sensitive, open an [issue](https://github.com/Schengatto/share-content-via-url/issues).

## Quick start

Requires Node.js 20 or later. `npm install` also builds the native `better-sqlite3` module.

```bash
npm install
npm run dev
```

Then open http://localhost:3000.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Starts the development server |
| `npm run build` | Builds for production |
| `npm run start` | Serves the production build |
| `npm test` | Runs the Vitest suite once |
| `npm run lint` | Runs ESLint |

## Configuration

All settings are environment variables.

| Variable | Default | Meaning |
|---|---|---|
| `DATA_DIR` | `./data` | Folder for the SQLite database and the encrypted blobs |
| `PUBLIC_ORIGIN` | origin of the request | Origin used to build share links, for example `https://share.example.com` |
| `RATE_LIMIT` | `10` | Shares one IP can create per minute |
| `CLEANUP_INTERVAL_MS` | `3600000` | Interval of the background purge; `0` turns it off |
| `CLAMAV_ENABLED` | off | Set to `true` to scan uploads with clamd |
| `CLAMAV_HOST` | `127.0.0.1` | clamd host |
| `CLAMAV_PORT` | `3310` | clamd port |
| `CLAMAV_TIMEOUT_MS` | `10000` | clamd scan timeout |

## Docker and deploy

The `Dockerfile` builds on `node:24-bookworm-slim`, runs the test suite before the production build, and runs the app as the non-root `node` user on port 3000. Mount a volume at `/app/data` to keep the data. `docker-compose.yml` and `deploy/nginx-share-secret.conf` show the production setup behind nginx.

### Backup retention

Data backups exist only to roll back a deploy, so production keeps one, for at most 7 days.

- Before each deploy, stop the container (`docker compose stop app`) and run `deploy/backup-data.sh pre-<task>`. It writes `/root/backups/share-secret-data-pre-<task>-<UTC>.tgz` with mode `0600`, checks that the archive contains `share.db`, then deletes every other `share-secret-data-*.tgz` in that directory.
- A daily cron runs `deploy/backup-data.sh --prune`, which deletes backups older than 7 days. After a week a data rollback would also drop a week of new shares.
- Tag the running image as `share-secret:pre-<task>` before the build, and remove older `share-secret:pre-*` tags once the deploy is verified. Images hold no share data (`data/` is a volume and is in `.dockerignore`), but an image only rolls back together with the backup of the same deploy when the schema changed.
- `DATA_DIR`, `BACKUP_DIR` and `MAX_AGE_DAYS` override the defaults (`/root/share-secret/data`, `/root/backups`, `7`).

## Documentation

Design notes and the operations manual are in [`docs/`](docs/).
