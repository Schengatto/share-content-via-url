# Security Hardening Round 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three residual gaps of the README threat model: XSS reading the E2E key from the fragment, text ciphertext size revealing the exact secret length, and file shares whose password is only a gate.

**Architecture:** Task 1 pads the E2E sealed payload in the browser (no server or schema change). Task 2 derives the file-share AES key from the token *and* the password (schema v6 adds `password_key_salt`). Task 3 replaces the static CSP with a per-request nonce CSP set in `proxy.ts`.

**Tech Stack:** Next.js 16.2 (App Router, `proxy.ts`), React 19, better-sqlite3, Node `crypto`, WebCrypto, Vitest.

**Spec:** board epic SHS-16 (tasks SHS-17, SHS-18, SHS-19) and README "What it does NOT protect against". Next guide: `node_modules/next/dist/docs/01-app/02-guides/content-security-policy.md`.

## Global Constraints

- Branch `fix/shs-security-round-2`. Subagents never checkout, branch, commit or push; the controller commits.
- No code comments (only public-API doc comments already present stay).
- English identifiers. Tests in `test/*.test.ts` (Vitest). Run only the test files you touched: `npx vitest run test/<file>.test.ts`.
- Read files with Read offset/limit or Grep, never `cat`/`sed`/`head`; one Edit per file where possible.
- Existing shares in production must keep opening: e2e-v1 payloads without padding, file/legacy rows without `password_key_salt`.

## Review Focus

- Existing e2e-v1 ciphertext (header without `length`) must still decode to the exact text: test in Task 1.
- Text whose sealed payload is already above the 1 MiB step or near `MAX_SIZE` must not be padded past `MAX_SIZE` (server rejects > `MAX_SIZE + 1024`): test in Task 1.
- Password-protected file share created before v6 (no `password_key_salt`) must still open with the right password: test in Task 2.
- A wrong password must still count toward the per-IP and share-wide lock and never reach decryption: existing store tests must stay green in Task 2.
- Static assets, `/_next/*`, icons and the OG image must keep working under the new CSP; the reveal page must decrypt and the file download must work: browser check in Task 3.

---

### Task 1 (SHS-17): Pad E2E text payloads

**Files:**
- Modify: `lib/e2e-crypto.ts` (`sealPayloadBytes` :56, `openPayloadBytes` :65)
- Test: `test/e2e-crypto.test.ts`
- Docs: `README.md` (threat model line "Some metadata stays visible to the server…": the size is now a bucket, not exact)

**Interfaces:**
- Produces: `export function paddedPayloadLength(unpaddedLength: number): number` in `lib/e2e-crypto.ts`. `sealPayloadBytes` / `openPayloadBytes` keep their signatures.

- [ ] **Step 1: Tests**
  - `paddedPayloadLength`: `1 → 1024`, `1024 → 1024`, `1025 → 2048`, `700_000 → 1_048_576`, `1_048_577 → 2_097_152`, `MAX_SIZE - 10 → MAX_SIZE`, `MAX_SIZE + 50 → MAX_SIZE + 50`.
  - `sealPayloadBytes` output length equals `paddedPayloadLength(unpadded)` and two texts of 3 and 300 bytes give the same sealed length.
  - Round trip: `openPayloadBytes(sealPayloadBytes(meta, content)).content` equals `content` byte for byte (include content that ends with `0x00`).
  - Old format: a payload built by hand as `uint32 headerLength + JSON {filename,mime} + content` (no `length`) opens to exactly `content`.
  - A header `length` larger than the remaining bytes throws.
- [ ] **Step 2: Implement.** Bucket rule on the unpadded sealed length `L`: `L ≤ 1024 → 1024`; `L ≤ 1 MiB → next power of two ≥ L`; else round up to a multiple of 1 MiB; if the bucket exceeds `MAX_SIZE` (import from `lib/file-support.ts`) use `max(L, MAX_SIZE)`. `sealPayloadBytes` writes `{filename, mime, length: content.length}` in the header and appends zero bytes up to the bucket. `openPayloadBytes` slices `length` bytes after the header when `length` is a number, else the whole remainder.
- [ ] **Step 3: Run** `npx vitest run test/e2e-crypto.test.ts` → PASS.
- [ ] **Step 4: README** one-line update of the metadata bullet: size visible only as a bucket (1 KiB floor, powers of two to 1 MiB, then 1 MiB steps) for text; files unpadded.

### Task 2 (SHS-18): Password-bound key for file shares

**Files:**
- Modify: `lib/password.ts` (export a key-derivation helper), `lib/crypto.ts`, `lib/db.ts` (`MIGRATIONS` :30), `lib/store.ts` (`ShareRow`, `createShare` :208, `consumeShare` :408)
- Test: `test/crypto.test.ts`, `test/store.test.ts`, `test/db.test.ts`
- Docs: `README.md` (bullet "For files and legacy text, the password is an access gate…"), `docs/product-design.md` (data model: column, schema v6, bump "Ultimo allineamento"), `docs/manuale-operativo.md` (schema v6; rollback = code and data together)

**Interfaces:**
- Produces: `export function derivePasswordSecret(password: string, salt: Buffer): Buffer` in `lib/password.ts` (32 bytes, same scrypt parameters as `hashPassword`: N=2^15, r=8, p=1).
- Produces: `export const PASSWORD_KEY_SALT_BYTES = 16` and `export function derivePasswordBoundKey(token: string, password: string, keySalt: Buffer): Buffer` in `lib/crypto.ts`: HKDF-SHA256, ikm = `deriveKey(token) ‖ derivePasswordSecret(password, keySalt)`, salt `"share-app:hkdf:v1"`, info `"share-app:aes-256-gcm:password:v1"`, 32 bytes.
- Schema: new migration `ALTER TABLE shares ADD COLUMN password_key_salt BLOB;` appended to `MIGRATIONS` (becomes schema v6 if the current head is v5: verify with the existing db test).

- [ ] **Step 1: Tests**
  - crypto: `derivePasswordBoundKey` is deterministic, differs from `deriveKey(token)`, and differs for another password or another salt.
  - db: a fresh DB reaches the new `user_version` and has column `password_key_salt`; the existing migration test from the previous version still passes.
  - store: password-protected file share → row has a 16-byte `password_key_salt`; `decrypt(blob, deriveKey(token), iv, authTag)` throws (DB + token alone is not enough); `consumeShare` with the right password opens the exact content.
  - store: share without password → `password_key_salt` is NULL and opens as before.
  - store: pre-v6 row simulation: create without password, then `UPDATE shares SET password_hash = hashPassword("pw-1234")` → `consumeShare(..., "pw-1234")` opens.
- [ ] **Step 2: Implement.** `createShare`: when `input.password` is set, generate the salt with `randomBytes(PASSWORD_KEY_SALT_BYTES)`, encrypt with `derivePasswordBoundKey`, insert `password_key_salt`. `consumeShare`: after the gate and `claimView`, key = `row.password_key_salt ? derivePasswordBoundKey(token, password, row.password_key_salt) : deriveKey(token)`. Gate, lock and attempt logic untouched.
- [ ] **Step 3: Run** `npx vitest run test/crypto.test.ts test/db.test.ts test/store.test.ts test/share-api.test.ts` → PASS.
- [ ] **Step 4: Docs** as listed above.

### Task 3 (SHS-19): Nonce-based CSP

**Files:**
- Create: `lib/content-security-policy.ts`, `proxy.ts` (repo root, next to `app/`), `test/content-security-policy.test.ts`, `test/proxy.test.ts`
- Modify: `next.config.mjs` (remove `isDev`, `scriptSrc`, `csp`, the comment and the CSP header; keep nosniff, Referrer-Policy, no-store), `test/next-config.test.ts` (CSP no longer in next.config), `app/layout.tsx` (force dynamic rendering: `await connection()` from `next/server` in an async `RootLayout`)
- Docs: `README.md` (bullet on XSS: inline scripts now blocked, nonce CSP), `docs/product-design.md` (security headers)

**Interfaces:**
- Produces: `export function generateNonce(): string` (16 random bytes from `crypto.getRandomValues`, base64) and `export function buildContentSecurityPolicy(nonce: string, isDev: boolean): string` in `lib/content-security-policy.ts`.
- Produces: `export function proxy(request: NextRequest): NextResponse` and `export const config` (matcher excluding `api`, `_next/static`, `_next/image`, `favicon.ico`, and prefetch requests, as in the Next guide).

- [ ] **Step 1: Tests**
  - `buildContentSecurityPolicy("abc", false)` contains exactly these directives: `default-src 'self'`, `script-src 'self' 'nonce-abc' 'strict-dynamic'`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' data: blob:`, `font-src 'self'`, `connect-src 'self'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'self'`, `frame-ancestors 'none'`; it does not contain `'unsafe-inline'` inside `script-src` nor `'unsafe-eval'`.
  - With `isDev = true` the `script-src` also has `'unsafe-eval'`.
  - `generateNonce()` returns base64 of 16 bytes and two calls differ.
  - `proxy(new NextRequest("http://localhost/s/x"))`: response `Content-Security-Policy` contains `'nonce-` and two calls give different nonces.
  - next-config: `/:path*` keeps nosniff and `no-referrer` and no longer sets `Content-Security-Policy`.
- [ ] **Step 2: Implement** following the Next guide section "Adding a nonce with Proxy": set `x-nonce` and `Content-Security-Policy` on the forwarded request headers and the CSP on the response. If `app/s/[token]/file-download.tsx` or any client code fetches `blob:` or `data:` URLs, add that source to `connect-src` and to the test.
- [ ] **Step 3: Run** `npx vitest run test/content-security-policy.test.ts test/proxy.test.ts test/next-config.test.ts` → PASS.
- [ ] **Step 4: Build check** `npx next build`: every page route listed as dynamic (ƒ).
- [ ] **Step 5: Browser check (controller, via the `browser` agent)** on `next start`: create a text share with and without password, reveal both, create and download a file share; no CSP violation in the console; the response CSP has a fresh nonce on each load.
- [ ] **Step 6: Docs** as listed above.

### Final gates (controller)

- [ ] `gate-runner`: lint, tsc, full suite, build on the branch head.
- [ ] Security review of the branch diff (crypto + CSP surface).
- [ ] PR, merge after green gates; deployment is a human step (ssh), with backup before deploy because schema goes to v6.
