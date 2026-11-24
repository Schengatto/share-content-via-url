# E2E encryption for text shares (SHS-13) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** text shares are encrypted in the browser with WebCrypto; the server stores only ciphertext and proof hashes, and the key travels only in the URL fragment (`/s/<id>#<K>`).

**Architecture:** one isomorphic module (`lib/e2e-crypto.ts`) does key generation, PBKDF2/HKDF derivation, AES-GCM and base64url, used by the create page, the reveal gate and the tests. The server gets a new row format (`payload_format = 3`, migration 5), a create branch in `POST /api/share` and a new Server Action `revealE2eShare` that checks `linkProof` before any lock logic. Legacy rows (formats 1 and 2) keep the current flow; files stay server-side.

**Tech Stack:** Next.js 16 (App Router, Server Actions), React 19, TypeScript 6, better-sqlite3, Vitest 4 (node environment, no jsdom), WebCrypto (`globalThis.crypto.subtle`, Node 24 and browser).

**Spec:** `docs/superpowers/specs/2026-11-24-e2e-encryption-design.md` (sections 3-7 and 11). Read it before each task.

## Global Constraints

- Link: `/s/<id>#<K>`. `id` = 16 random bytes from the server, base64url without padding (22 chars). `K` = 32 random bytes from the browser, base64url without padding (43 chars). No version in the fragment.
- `salt` 16 bytes; `iv` 12 bytes; AES-256-GCM tag 16 bytes appended to the ciphertext.
- `P = PBKDF2-HMAC-SHA256(UTF-8(NFC(password)), salt, 600000, 32 bytes)` only with a password. `ikm = K || P` with a password, `K` without.
- HKDF-SHA256 with `salt`: `linkProof` (ikm = `K` only, info `share-secret:e2e:v1:link-proof`, 32 bytes), `authKey` (ikm, info `share-secret:e2e:v1:auth`, 32 bytes, only with a password), `encKey` (ikm, info `share-secret:e2e:v1:enc`, AES-GCM 256).
- AAD = UTF-8 `share-secret:e2e:v1`. Plaintext = sealed payload (`lib/sealed-payload.ts` format) with `{ filename: null, mime: "text/plain" }`.
- Server stores `link_proof_hash = hex SHA-256(linkProof)`, `auth_hash = hex SHA-256(authKey)` (plain SHA-256), `token_hash = sha256(id)` via the existing `hashToken`.
- `kdfIterations` is `0` without a password and `600000` with one; nothing else is accepted in v1.
- No new dependency, no CSP change. `lib/e2e-crypto.ts` uses only `globalThis.crypto`, `TextEncoder`/`TextDecoder`, `btoa`/`atob`, `Uint8Array`: no `Buffer`, no `node:` imports.
- Password rules unchanged (8-128 chars, `isValidPassword`), checked only in the client for E2E.
- No code comments (user rule); English identifiers; UI copy in English like the rest of the app.
- `test/create-layout.test.ts` reads `app/page.tsx` source: keep `const LEAD = "..."` and its classes intact.
- Branch `feat/shs-13-e2e-text` from `main` (`e0ac6e4`). Test runs per task: only the files the task touches, `npx vitest run <files>`. Full suite, lint, `tsc --noEmit` and build run once at the end through `gate-runner`.

## Review Focus

1. **Legacy action on an E2E id.** `revealShare(id)` (old tab, or someone with only the id from a log) must return 404 and must not increment `access_count`: today `consumeShare` would count the view and then fail to decrypt. Test in Task 2.
2. **Fragment present but wrong** (well-formed 43 chars, other key): `linkProof` mismatch gives 404, no `failed_attempts`, no visitor lock, no view used. Test in Task 2 and Task 4.
3. **Password typed in another Unicode form** (`é` precomposed vs `e` + U+0301): same keys after NFC. Test in Task 1.
4. **Large text near 25 MB:** base64url of a multi-MB `Uint8Array` must not throw `RangeError` (no spread of the whole array into `String.fromCharCode`). Test in Task 1 with 3 MiB.
5. **Truncated or inconsistent upload:** ciphertext shorter than 20 bytes (4-byte header length + 16-byte tag), `authHash` with `kdfIterations=0`, or no `authHash` with `600000` give 400 and no row. Test in Task 2 and Task 3.

---

### Task 1: isomorphic E2E crypto module

**Files:**
- Create: `lib/e2e-crypto.ts`
- Test: `test/e2e-crypto.test.ts`

**Interfaces:**
- Consumes: `PayloadMetadata` type from `lib/sealed-payload.ts`.
- Produces:
  - constants `E2E_FORMAT = "e2e-v1"`, `E2E_KDF_ITERATIONS = 600_000`, `E2E_SALT_BYTES = 16`, `E2E_IV_BYTES = 12`, `E2E_MIN_CIPHERTEXT_BYTES = 20`
  - `toBase64Url(bytes: Uint8Array): string` and `fromBase64Url(text: string): Uint8Array` (throws `Error` on chars outside `[A-Za-z0-9_-]`)
  - `isWellFormedKey(text: string): boolean` — true only for `/^[A-Za-z0-9_-]{43}$/` (used for `K`, `linkProof`, `authKey`)
  - `sealPayloadBytes(metadata: PayloadMetadata, content: Uint8Array): Uint8Array`, `openPayloadBytes(payload: Uint8Array): PayloadMetadata & { content: Uint8Array }`
  - `sha256Hex(bytes: Uint8Array): Promise<string>`
  - `interface E2eTextUpload { fragmentKey: string; ciphertext: Uint8Array; iv: string; salt: string; kdfIterations: number; linkProofHash: string; authHash: string | null }` (`iv`, `salt`, `fragmentKey` base64url)
  - `encryptText(text: string, password?: string): Promise<E2eTextUpload>` (empty or undefined password = no password)
  - `interface RevealProofs { linkProof: string; authKey: string; encKey: CryptoKey }` (`authKey` is `""` without password)
  - `deriveRevealProofs(fragmentKey: string, salt: string, kdfIterations: number, password: string): Promise<RevealProofs>` — uses PBKDF2 iff `kdfIterations > 0`
  - `decryptText(encKey: CryptoKey, ciphertext: string, iv: string): Promise<string>` (base64url inputs; throws on a bad tag)

- [ ] **Step 1: Write the failing tests** in `test/e2e-crypto.test.ts`:
  - `round trip without password`: `encryptText("lantern-orbit")` → `kdfIterations === 0`, `authHash === null`, `isWellFormedKey(fragmentKey)`, `fromBase64Url(salt).length === 16`, `fromBase64Url(iv).length === 12`, `linkProofHash` matches `/^[0-9a-f]{64}$/`; `deriveRevealProofs(fragmentKey, salt, 0, "")` gives `authKey === ""`, `await sha256Hex(fromBase64Url(linkProof)) === linkProofHash`, and `decryptText` returns `"lantern-orbit"`.
  - `round trip with password`: `encryptText("s3cret text", "correct horse")` → `kdfIterations === 600000`, `sha256Hex(fromBase64Url(authKey)) === authHash`, decrypts.
  - `wrong password`: same `linkProof` as the right one (it depends only on `K`), different `authKey`, `decryptText` rejects.
  - `separate infos`: with a password, `linkProof`, `authKey` and the raw `encKey` differ pairwise (derive `encKey` as extractable only inside the test, or compare `linkProof !== authKey` and that decrypting with a key imported from `linkProof` bytes rejects).
  - `NFC`: upload with `"café-pass"`, reveal with `"café-pass"` → same `authKey`, decrypts.
  - `ciphertext carries the tag`: `ciphertext.length === sealPayloadBytes({filename:null,mime:"text/plain"}, utf8(text)).length + 16`.
  - `sealed payload compatible`: `sealPayloadBytes(meta, bytes)` equals `sealPayload(meta, Buffer.from(bytes))` byte for byte, and `openPayloadBytes` inverts it.
  - `malformed fragment`: `isWellFormedKey` false for `""`, 42 chars, 44 chars, a 43-char string with `+` or `=`; `fromBase64Url("ab+c")` throws.
  - `large payload`: `toBase64Url` / `fromBase64Url` round trip of 3 MiB random bytes (fill with `crypto.getRandomValues` in 65536-byte chunks) without throwing.
  - `tampered ciphertext`: flip one byte → `decryptText` rejects.

- [ ] **Step 2:** Run `npx vitest run test/e2e-crypto.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement `lib/e2e-crypto.ts`.** HKDF: `importKey("raw", ikm, "HKDF", false, ["deriveBits","deriveKey"])`, then `deriveBits({name:"HKDF",hash:"SHA-256",salt,info},256)` for proofs and `deriveKey(..., {name:"AES-GCM",length:256}, false, ["encrypt","decrypt"])` for `encKey`. PBKDF2 via `deriveBits({name:"PBKDF2",hash:"SHA-256",salt,iterations},256)` on `TextEncoder().encode(password.normalize("NFC"))`. AES-GCM with `additionalData = utf8("share-secret:e2e:v1")`, `tagLength: 128`. Base64url via `btoa`/`atob` over chunks of 32768 bytes.

- [ ] **Step 4:** Run `npx vitest run test/e2e-crypto.test.ts` → PASS.

- [ ] **Step 5: Commit** `feat(e2e): isomorphic WebCrypto module for text shares (SHS-13)`.

---

### Task 2: migration 5 and E2E store

**Files:**
- Modify: `lib/db.ts` (constants near :26-27, `MIGRATIONS` :29-59)
- Modify: `lib/store.ts` (`ShareStatus` :86-88, `shareStatus` :103-113, `consumeShare` :219-286 refactor, new exports)
- Test: `test/db.test.ts`, `test/store.test.ts`

**Interfaces:**
- Consumes: `E2E_KDF_ITERATIONS`, `E2E_SALT_BYTES`, `E2E_IV_BYTES`, `E2E_MIN_CIPHERTEXT_BYTES`, `toBase64Url` from Task 1 (in tests also `encryptText`, `deriveRevealProofs`, `fromBase64Url`).
- Produces:
  - `lib/db.ts`: `export const E2E_V1_PAYLOAD_FORMAT = 3`; migration 5 = the four `ALTER TABLE` of spec section 6 (`e2e_salt BLOB`, `e2e_kdf_iterations INTEGER`, `link_proof_hash TEXT`, `auth_hash TEXT`).
  - `lib/store.ts`:
    - `interface CreateE2eInput { ciphertext: Buffer; iv: Buffer; salt: Buffer; kdfIterations: number; linkProofHash: string; authHash: string | null; maxAccesses: number; ttlSeconds: number }`
    - `interface CreateE2eResult { linkId: string; revokeToken: string }`
    - `assertValidE2eInput(input: CreateE2eInput): void` — throws `ShareError(..., 400, "BAD_E2E_PAYLOAD")`; rules of spec 5.3: iv 12, salt 16, `linkProofHash` and `authHash` `/^[0-9a-f]{64}$/`, `kdfIterations` in `{0, 600000}`, `authHash !== null` iff `kdfIterations > 0`, `E2E_MIN_CIPHERTEXT_BYTES <= ciphertext.length <= MAX_SIZE + 1024`; then `assertValidShareOptions` without password.
    - `createE2eShare(db: DB, blobs: BlobStore, input: CreateE2eInput): CreateE2eResult` — `linkId = toBase64Url(16 random bytes)` (use `randomBytes(16).toString("base64url")`), row id `randomUUID()`, `token_hash = hashToken(linkId)`, `payload_format = 3`, `iv` client IV, `auth_tag = Buffer.alloc(0)`, `filename`/`mime`/`password_hash` NULL, revoke token as today; row and blob in one transaction.
    - `ShareStatus` available variant gains `format: "legacy"` or `format: "e2e-v1"; salt: string; kdfIterations: number` (salt base64url); `passwordProtected = password_hash !== null || auth_hash !== null`.
    - `type E2eConsumeOutcome = { status: "opened"; ciphertext: Buffer; iv: Buffer } | Exclude<ConsumeOutcome, { status: "opened" }>`
    - `consumeE2eShare(db: DB, blobs: BlobStore, linkId: string, linkProof: Buffer, authKey: Buffer | null, visitor = "local"): E2eConsumeOutcome` — throws `ShareError` 404/410.

- [ ] **Step 1: Write the failing tests.**
  - `test/db.test.ts`: a fresh DB reaches `user_version` 5 and has the four columns (`PRAGMA table_info(shares)`); a v4 DB with one row migrates to 5 keeping the row; a DB at `user_version` 6 is refused with the existing "newer than this app supports" error.
  - `test/store.test.ts` (new `describe("e2e shares")`, helper `e2eInput(upload: E2eTextUpload, over?)` that maps base64url fields to Buffers):
    - `createE2eShare` stores the client ciphertext byte for byte as the blob, `payload_format 3`, `auth_tag` length 0, `mime`/`filename`/`password_hash` NULL, `token_hash = hashToken(linkId)`, `linkId` 22 chars; no column or blob contains the UTF-8 plaintext.
    - `shareStatus(db, linkId)` → `{ available: true, format: "e2e-v1", salt, kdfIterations, passwordProtected }` with the upload values; a legacy share gives `format: "legacy"`.
    - right `linkProof`, no password → `opened` with the stored ciphertext and iv; client `decryptText` gives the text; `maxAccesses: 1` → second call throws 410.
    - wrong `linkProof` (from another `encryptText`) → throws 404; `failed_attempts`, `locked_until`, `access_count` unchanged; same for a share with password and a wrong `authKey` sent together with the wrong link proof.
    - password share, `authKey` null → `password-required`, no view used.
    - wrong `authKey` → `wrong-password`, `access_count` unchanged; 3 failures from the same visitor → `locked`; 10 failures across visitors → share lock with `lockouts = 1` (same numbers as the legacy tests).
    - right `authKey` after a failure → `opened` and the visitor lock is cleared.
    - `consumeShare(db, blobs, linkId)` on an E2E row → throws 404 and `access_count` stays 0 (Review Focus 1); `consumeE2eShare` on a legacy token → throws 404.
    - `assertValidE2eInput` → 400 for: iv 11 bytes, salt 15, hash of 63 chars, `kdfIterations` 1000, `authHash` with 0, no `authHash` with 600000, ciphertext of 19 bytes, ciphertext of `MAX_SIZE + 1025` bytes; `createE2eShare` writes no row in those cases.
    - revoke and cleanup find E2E rows (`revokeShare(db, blobs, linkId, revokeToken)` → true).

- [ ] **Step 2:** Run `npx vitest run test/db.test.ts test/store.test.ts` → new tests FAIL.

- [ ] **Step 3: Implement.** Extract from `consumeShare` two private helpers and use them from both consume functions: `passwordGate(db, row, visitor, now, supplied: boolean, matches: () => boolean): ConsumeOutcome | null` (the `password-required` / visitor lock / claim / compare / `wrongPasswordOutcome` / reset block of :246-260, guarded by "row has a secret") and `claimView(db, blobs, row, now): void` (atomic `UPDATE` of :263-275, purge and 410 on 0 changes). The caller reads the blob, then purges when `access_count + 1 >= max_accesses` (as :280-283). `consumeE2eShare` order: lookup by `hashToken(linkId)` → 404 if absent or not format 3; `isUsedUp` → purge, 410; `hashesMatch(row.link_proof_hash, sha256hex(linkProof))` false → 404; share lock → `locked`; `passwordGate` with `auth_hash`; `claimView`; return blob and iv. `consumeShare` throws 404 for format 3 right after the lookup.

- [ ] **Step 4:** Run `npx vitest run test/db.test.ts test/store.test.ts` → PASS (old tests included).

- [ ] **Step 5: Commit** `feat(store): migration 5 and E2E share create/consume (SHS-13)`.

---

### Task 3: create API and share URL parsing

**Files:**
- Modify: `app/api/share/route.ts` (text branch :53-59, response :88)
- Modify: `lib/share-options.ts` (`tokenFromShareUrl` :72-75)
- Test: `test/share-api.test.ts`, `test/share-options.test.ts`

**Interfaces:**
- Consumes: `assertValidE2eInput`, `createE2eShare` (Task 2); `encryptText`, `fromBase64Url`, `E2E_FORMAT` (Task 1).
- Produces: `POST /api/share` with `kind=text` accepts only `encryption=e2e-v1` and answers `{ id: linkId, url: "<origin>/s/<linkId>", revokeToken }`; `kind=file` unchanged. `tokenFromShareUrl` ignores `#...`.

- [ ] **Step 1: Write the failing tests.**
  - `test/share-api.test.ts`: helper `postE2e(upload: E2eTextUpload, fields?)` building the FormData of spec 5.2 (`kind=text`, `encryption=e2e-v1`, `ciphertext` as `new Blob([upload.ciphertext])`, `iv`, `salt`, `kdfIterations`, `linkProofHash`, `authHash` only when not null, `maxAccesses`, `ttlSeconds`). Tests:
    - 200 with `id` (22 chars) and `url` ending in `/s/${id}`; the stored blob equals the uploaded ciphertext; no DB column and no blob contains the plaintext, the password, `fragmentKey`, `linkProof` or `authKey`.
    - the FormData built by `postE2e` has no entry whose value contains the plaintext, the password or the fragment key (Definition of Done "POST without plaintext").
    - legacy `kind=text` + `text` without `encryption` → 400 with error `"This page is out of date. Reload it and try again."`, no row.
    - `encryption=e2e-v1` without `ciphertext` file → 400; `kdfIterations=0` with `authHash` → 400; ciphertext of 19 bytes → 400; no row in each case.
    - full round trip: `postE2e` then `revealE2eShare` is covered in Task 4, not here.
    - existing text tests that post plain `text` are rewritten to post E2E (options defaults, TTL, views); file tests unchanged.
  - `test/share-options.test.ts`: `tokenFromShareUrl("https://h/s/abc_-1#K43chars...")` → `"abc_-1"`; `"https://h/s/abc/#x"` → `"abc"`; legacy `"https://h/s/abc"` still works; `"https://h/x/abc#k"` → null.

- [ ] **Step 2:** Run `npx vitest run test/share-api.test.ts test/share-options.test.ts` → FAIL.

- [ ] **Step 3: Implement.** In the route, when `kind === "text"`: `encryption !== "e2e-v1"` → 400 with the copy above; `ciphertext` must be a `File` (Blob); decode `iv`/`salt` with `fromBase64Url` (decode error → 400 `"Invalid encrypted payload"`); `kdfIterations` via `numberField(..., NaN)`; build `CreateE2eInput`, call `createE2eShare` (it validates), respond `{ id, url: shareUrl(origin, linkId), revokeToken }`. Text no longer goes through `validateContent`. Regex of `tokenFromShareUrl`: `/\/s\/([A-Za-z0-9_-]+)\/?(?:#.*)?$/`.

- [ ] **Step 4:** Run the same command → PASS.

- [ ] **Step 5: Commit** `feat(api): E2E-only text creation, fragment-aware share URL parsing (SHS-13)`.

---

### Task 4: reveal Server Action

**Files:**
- Modify: `app/s/[token]/actions.ts`
- Test: `test/share-api.test.ts` (it already imports `revealShare`), `test/rate-limit-paths.test.ts` if it lists every reveal path

**Interfaces:**
- Consumes: `consumeE2eShare` (Task 2), `isWellFormedKey`, `fromBase64Url` (Task 1).
- Produces:
  - `type RevealFailure` = the three `ok: false` variants of `RevealResult` (extracted, `RevealResult` keeps its members).
  - `type E2eRevealResult = { ok: true; format: "e2e-v1"; ciphertext: string; iv: string } | RevealFailure` (base64url strings).
  - `revealE2eShare(linkId: string, linkProof: string, authKey = ""): Promise<E2eRevealResult>`.

- [ ] **Step 1: Write the failing tests** (create through `postE2e` or `createE2eShare`, derive with `deriveRevealProofs`):
  - right proofs → `ok: true`, `format: "e2e-v1"`; client `decryptText` returns the text; with `maxAccesses: 1` the next call gives `{ ok: false, status: 410 }`.
  - wrong `linkProof` → `{ ok: false, status: 404 }`; `failed_attempts` and `access_count` unchanged.
  - malformed `linkProof` (42 chars) → `{ ok: false, status: 404 }`; malformed non-empty `authKey` → `{ ok: false, status: 400 }`.
  - password share without `authKey` → `password-required`; wrong `authKey` → `wrong-password`, view not used.
  - legacy `revealShare(linkId)` on an E2E share → `{ ok: false, status: 404 }`, `access_count` 0.
  - rate limit: with the reveal limiter exhausted for the IP (pattern of `rate-limit-paths.test.ts`), `revealE2eShare` returns `rate-limited` before any lookup; with `authKey` the attempt limiter is also checked.

- [ ] **Step 2:** Run `npx vitest run test/share-api.test.ts test/rate-limit-paths.test.ts` → FAIL.

- [ ] **Step 3: Implement** `revealE2eShare` with the order of spec 5 "Apertura": `revealLimiter.check(ip)`; if `authKey !== ""` then `passwordAttemptLimiter.check(ip)`; `authKey` non-empty and not `isWellFormedKey` → 400; `linkProof` not `isWellFormedKey` → 404; `consumeE2eShare(appDb(), appBlobs(), linkId, Buffer.from(fromBase64Url(linkProof)), authKey ? Buffer.from(fromBase64Url(authKey)) : null, ip)`; opened → `{ ok: true, format: "e2e-v1", ciphertext: ciphertext.toString("base64url"), iv: iv.toString("base64url") }`; errors → `{ ok: false, status: e.status ?? 500 }`.

- [ ] **Step 4:** Run the same command → PASS.

- [ ] **Step 5: Commit** `feat(reveal): revealE2eShare server action with link proof before locks (SHS-13)`.

---

### Task 5: browser create and reveal UI

**Files:**
- Modify: `app/page.tsx` (`submit` :129-157, `LinkReady` :322-370)
- Modify: `app/s/[token]/page.tsx` (`readGateState` :29-39, render :59)
- Modify: `app/s/[token]/reveal-gate.tsx` (props :70-80, `reveal` :108-141, render)

**Interfaces:**
- Consumes: `encryptText`, `deriveRevealProofs`, `decryptText`, `isWellFormedKey` (Task 1); `ShareStatus.format/salt/kdfIterations` (Task 2); `revealE2eShare`, `E2eRevealResult` (Task 4); `isValidPassword` from `lib/share-options.ts`.
- Produces: `RevealGate` prop `e2e: { salt: string; kdfIterations: number } | null`.

- [ ] **Step 1: Create page.** For `kind === "text"`: if a password is set and `!isValidPassword(password)` show `Password must be ${MIN_PASSWORD_LENGTH} to ${MAX_PASSWORD_LENGTH} characters` and stop; `const upload = await encryptText(text, password)`; FormData per spec 5.2 (no `text`, no `password`); on success `url = \`${data.url}#${upload.fragmentKey}\``. File branch unchanged. `LinkReady` keeps copying `link.url` (now with fragment) and keeps `tokenFromShareUrl(link.url)` for revoke. Do not touch `const LEAD`.

- [ ] **Step 2: Reveal page.** `readGateState` passes `e2e = status.available && status.format === "e2e-v1" ? { salt, kdfIterations } : null`. In `RevealGate`, when `e2e !== null`: read `window.location.hash.slice(1)` in a `useEffect`; not `isWellFormedKey` → render an "incomplete link" envelope (`"This link is incomplete."` / `"Ask the sender for the full link, including everything after the #."`) with no reveal button and no server call. `reveal()` for E2E: same empty-password notice as legacy; show a "Unlocking..." loading phase (PBKDF2 can take ~1 s on mobile); `deriveRevealProofs(fragment, e2e.salt, e2e.kdfIterations, password)` → `revealE2eShare(token, linkProof, authKey)` → existing branches for `rate-limited`/`wrong-password`/`locked`/`password-required`/numeric; on `ok` → `decryptText` → `setResult({ ok: true, kind: "text", text })`; decrypt failure → `"This share could not be decrypted. The data may have been altered."`. Legacy path unchanged.

- [ ] **Step 3:** Run `npx vitest run test/create-layout.test.ts` → PASS. Run `npx tsc --noEmit` once for this task (UI has no unit tests; the types are the check).

- [ ] **Step 4: Commit** `feat(ui): encrypt text in the browser and open E2E links from the fragment (SHS-13)`.

---

### Task 6: product design, gates, browser check, deploy (controller)

**Files:**
- Modify: `docs/product-design.md` (flows, data model, invariants: E2E text, migration 5, legacy coexistence, files server-side)

- [ ] **Step 1:** Update `docs/product-design.md`; commit `docs(product): E2E text shares (SHS-13)`.
- [ ] **Step 2:** `gate-runner`: `npm run lint`, `npx tsc --noEmit`, `npm test`, `npm run build` → all green (baseline 156 passed, 2 skipped, plus the new tests).
- [ ] **Step 3:** Browser check through the `browser` agent on `npm run dev`: create a text share with and without password; the POST body has no plaintext, password or fragment; the link has `#<43 chars>`; opening it shows the text; wrong password keeps the view; the link without fragment shows "This link is incomplete."
- [ ] **Step 4:** Push the branch, open the PR, merge to `main` after the gates.
- [ ] **Step 5:** Deploy with the procedure in Archivist `production-deployment`: backup tagged `pre-shs13`, deploy, verify `PRAGMA user_version` = 5, smoke test on prod (create + open an E2E text share; an existing legacy share still opens).
